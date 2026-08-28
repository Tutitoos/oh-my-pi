/**
 * Turns the raw session event stream into renderable entries.
 *
 * Built against shapes captured from a live `omp --mode rpc-ui` turn rather
 * than from the docs, because one detail changes the whole design:
 * `message_update` carries the **complete current message**, not just a delta
 * (`{ assistantMessageEvent: {…}, message: { role, content, usage, … } }`).
 * So streaming is a whole-message replace, and there is no delta application
 * to get subtly wrong.
 *
 * Updated incrementally as frames arrive. Deriving it from the event log on
 * every render would be O(events) per frame, and a streaming turn produces
 * frames faster than React can paint.
 */

/**
 * Map every tool call in a replayed history to its arguments.
 *
 * A `toolResult` message carries `content`, `details`, `isError`, `toolCallId`
 * and `toolName` — and **no arguments at all**. They live on the assistant
 * message that asked for the call, in a `toolCall` content block. Building the
 * cards from results alone left every replayed tool with `args: undefined`, and
 * the renderers say so out loud: `bash.tsx` prints `…` for its command in
 * exactly that case, which is what a reopened session looked like.
 *
 * The trap that hid it: the live frame calls the field `args`, the stored block
 * calls it `arguments`. Same data, two names, and only one of them was read.
 *
 * `intent` rides along for the same reason — it is on the call, not the result.
 */
export function collectToolCalls(messages: readonly unknown[]): Map<string, { args: unknown; intent?: string }> {
	const calls = new Map<string, { args: unknown; intent?: string }>();
	for (const raw of messages) {
		if (!isRecord(raw) || raw.role !== "assistant" || !Array.isArray(raw.content)) continue;
		for (const block of raw.content) {
			if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
			calls.set(block.id, {
				args: block.arguments,
				intent: typeof block.intent === "string" ? block.intent : undefined,
			});
		}
	}
	return calls;
}

function numberOr(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	[key: string]: unknown;
}

export interface MessageEntry {
	kind: "message";
	id: string;
	role: string;
	content: ContentBlock[];
	/** Still streaming — no `message_end` seen yet. */
	streaming: boolean;
	/**
	 * When the server stamped the message. Stable across `message_start`,
	 * `message_update` and `message_end` — the only identity a message frame
	 * carries, and the one thing that survives a `hydrate`.
	 */
	timestamp?: number;
}

export interface ToolEntry {
	kind: "tool";
	id: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: unknown;
	partial?: unknown;
	running: boolean;
	isError?: boolean;
}

/**
 * A compaction that rewrote the history above it.
 *
 * The TUI draws this as a rule across the transcript, and it is the only record
 * of an operation that is otherwise invisible: the messages it replaced are
 * gone from the model's context, and nothing else says so.
 */
export interface CompactionEntry {
	kind: "compaction";
	id: string;
	tokensBefore?: number;
	tokensAfter?: number;
	/** `remote`, `soft`, `handoff`, `snapcompact`, `shake`. */
	method?: string;
	summary?: string;
	shortSummary?: string;
	/** A dead-end warning the engine stamped on the pass. */
	warning?: string;
}

export type TranscriptEntry = MessageEntry | ToolEntry | CompactionEntry;

/**
 * What a reload cannot see.
 *
 * The server appends an assistant message only at `message_end`, and a tool
 * only once its `toolResult` lands, so whatever is in flight when
 * `get_messages` answers is missing from the answer by construction. `hydrate`
 * used to drop it along with the handles the frames that follow need:
 * `#toolIndex` no longer knew the running call, so its `tool_execution_end`
 * was discarded and the card never came back.
 */
interface LiveTail {
	message: MessageEntry | null;
	tools: ToolEntry[];
}

/** Roles whose messages are rendered. Tool results render as tool cards. */
const RENDERED_ROLES = new Set(["user", "assistant"]);

export class TranscriptModel {
	#entries: TranscriptEntry[] = [];
	#toolIndex = new Map<string, number>();
	/**
	 * `role:timestamp` of every message rendered, to the entry that renders it.
	 *
	 * A user message is emitted twice — once on `message_start`, once on
	 * `message_end`, both carrying the identical payload — so without this the
	 * transcript shows every prompt twice. Verified against a live turn.
	 *
	 * It keeps the index and not just the key because `hydrate` rebuilds the
	 * array: after a reload the position of the message being streamed into is
	 * gone, and identity is the only handle onto it that survives.
	 */
	#messageIndex = new Map<string, number>();
	/** Index of the assistant message currently streaming, if any. */
	#openMessage = -1;
	#seq = 0;
	#dirty = true;
	#snapshot: readonly TranscriptEntry[] = [];

	get entries(): readonly TranscriptEntry[] {
		if (this.#dirty) {
			this.#snapshot = [...this.#entries];
			this.#dirty = false;
		}
		return this.#snapshot;
	}

	clear(): void {
		this.#entries = [];
		this.#toolIndex.clear();
		this.#messageIndex.clear();
		this.#openMessage = -1;
		this.#dirty = true;
	}

	/**
	 * Replace the transcript with a page from `get_messages_page`.
	 *
	 * Opening a saved session replays nothing through the event stream — the
	 * server switches and goes quiet — so history has to be fetched and folded
	 * in explicitly, or the chat opens blank.
	 */
	hydrate(messages: readonly unknown[]): void {
		const live = this.#liveTail();
		this.clear();
		const calls = collectToolCalls(messages);

		for (const raw of messages) {
			if (!isRecord(raw)) continue;
			const role = typeof raw.role === "string" ? raw.role : "";
			const content = Array.isArray(raw.content) ? (raw.content as ContentBlock[]) : [];

			// A tool result is its own message; render it as the tool's card.
			if (role === "toolResult" || raw.toolCallId) {
				const id = String(raw.toolCallId ?? `t${++this.#seq}`);
				const call = calls.get(id);
				this.#toolIndex.set(id, this.#entries.length);
				this.#entries.push({
					kind: "tool",
					id,
					name: String(raw.toolName ?? "tool"),
					// From the call, never from the result: see `collectToolCalls`.
					args: call?.args,
					intent: call?.intent,
					result: { content, details: raw.details },
					isError: raw.isError === true,
					running: false,
				});
				continue;
			}

			/*
			 * After a compaction the server replaces every message above the cut
			 * with a single one of these, carrying the before/after counts and the
			 * summary. It is not in `RENDERED_ROLES`, so reopening a compacted
			 * session used to show the rewrite as an unexplained gap.
			 */
			if (role === "compactionSummary") {
				this.#entries.push({
					kind: "compaction",
					id: `c${++this.#seq}`,
					tokensBefore: numberOr(raw.tokensBefore),
					tokensAfter: numberOr(raw.tokensAfter),
					method: typeof raw.method === "string" ? raw.method : undefined,
					summary: typeof raw.summary === "string" ? raw.summary : undefined,
					shortSummary: typeof raw.shortSummary === "string" ? raw.shortSummary : undefined,
					warning: typeof raw.warning === "string" ? raw.warning : undefined,
				});
				continue;
			}

			if (!RENDERED_ROLES.has(role)) continue;
			const timestamp = numberOr(raw.timestamp);
			// Only a stamped message has an identity a live frame can match. The
			// digest fallback is a guess: every assistant message whose content is
			// nothing but tool calls digests to the same empty string, and a live
			// frame that hashed to it would be written into that old bubble.
			if (timestamp !== undefined) {
				this.#messageIndex.set(messageKey(role, timestamp, content), this.#entries.length);
			}
			this.#entries.push({
				kind: "message",
				id: `m${++this.#seq}`,
				role,
				content,
				streaming: false,
				timestamp,
			});
		}
		this.#restoreLiveTail(live);
		this.#dirty = true;
	}

	/** The entries a `get_messages` snapshot cannot contain — see `LiveTail`. */
	#liveTail(): LiveTail {
		return {
			message: this.#openMessage >= 0 ? (this.#entries[this.#openMessage] as MessageEntry) : null,
			tools: this.#entries.filter((entry): entry is ToolEntry => entry.kind === "tool" && entry.running),
		};
	}

	/** Put the in-flight tail back on the end of the freshly rebuilt history. */
	#restoreLiveTail(live: LiveTail): void {
		for (const tool of live.tools) {
			// A call whose result landed between the snapshot and here is already
			// rebuilt from its persisted `toolResult`; re-appending would draw the
			// same call twice, once finished and once still spinning.
			if (this.#toolIndex.has(tool.id)) continue;
			this.#toolIndex.set(tool.id, this.#entries.length);
			this.#entries.push(tool);
		}

		if (!live.message) return;
		const key = messageKey(live.message.role, live.message.timestamp, live.message.content);
		// Already in the answer: `message_end` reached the server before the
		// snapshot was taken, so this one is finished, not in flight. Adopting it
		// as the open message pointed `#openMessage` at a settled bubble, and the
		// next turn's first frame — a different message, so no identity match —
		// fell back to that index and overwrote it, above its own prompt.
		if (this.#messageIndex.has(key)) return;
		this.#messageIndex.set(key, this.#entries.length);
		this.#entries.push(live.message);
		this.#openMessage = this.#entries.length - 1;
	}

	/**
	 * Feed one session event. Returns true when the transcript changed, so the
	 * caller can skip notifying subscribers for events it does not render.
	 */
	apply(frame: Record<string, unknown>): boolean {
		switch (frame.type) {
			case "message_start":
				return this.#onMessage(frame.message, false);
			case "message_update":
				return this.#onMessage(frame.message, false);
			case "message_end":
				return this.#onMessage(frame.message, true);
			case "tool_execution_start":
				return this.#onToolStart(frame);
			case "tool_execution_update":
				return this.#onToolUpdate(frame);
			case "tool_execution_end":
				return this.#onToolEnd(frame);
			case "auto_compaction_end":
				return this.#onCompactionEnd(frame);
			case "agent_end":
				// A run can settle without a final message_end.
				if (this.#openMessage >= 0) {
					const entry = this.#entries[this.#openMessage] as MessageEntry;
					this.#entries[this.#openMessage] = { ...entry, streaming: false };
					this.#openMessage = -1;
					this.#dirty = true;
					return true;
				}
				return false;
			default:
				return false;
		}
	}

	/**
	 * The live counterpart to the `compactionSummary` message that `hydrate`
	 * reads. Both produce the same entry; only the source differs.
	 *
	 * A pass that was cancelled, skipped or failed rewrote nothing, so it leaves
	 * no boundary — the row means "everything above here was replaced", and
	 * drawing it otherwise would be a lie about the transcript.
	 */
	#onCompactionEnd(frame: Record<string, unknown>): boolean {
		if (frame.aborted === true || frame.skipped === true) return false;
		const result = isRecord(frame.result) ? frame.result : null;
		if (!result) return false;
		this.#entries.push({
			kind: "compaction",
			id: `c${++this.#seq}`,
			tokensBefore: typeof result.tokensBefore === "number" ? result.tokensBefore : undefined,
			tokensAfter: typeof frame.tokensAfter === "number" ? frame.tokensAfter : undefined,
			method: typeof frame.action === "string" ? frame.action : undefined,
			summary: typeof result.summary === "string" ? result.summary : undefined,
			shortSummary: typeof result.shortSummary === "string" ? result.shortSummary : undefined,
		});
		this.#dirty = true;
		return true;
	}

	#onMessage(raw: unknown, final: boolean): boolean {
		if (!isRecord(raw)) return false;
		const role = typeof raw.role === "string" ? raw.role : "assistant";
		if (!RENDERED_ROLES.has(role)) return false;

		const content = Array.isArray(raw.content) ? (raw.content as ContentBlock[]) : [];

		const timestamp = numberOr(raw.timestamp);
		const key = messageKey(role, timestamp, content);

		// A user message is its own entry: never streamed, never replacing the
		// assistant message in flight. It arrives twice (start + end), so the
		// timestamp is what keeps one prompt from rendering as two bubbles.
		if (role === "user") {
			if (this.#messageIndex.has(key)) return false;
			this.#messageIndex.set(key, this.#entries.length);
			this.#entries.push({
				kind: "message",
				id: `m${++this.#seq}`,
				role,
				content,
				streaming: false,
				timestamp,
			});
			// A prompt ends whatever the model was writing: a turn that died without
			// its `message_end` — an abort, a killed sidecar — used to leave
			// `#openMessage` on a bubble that the next reply then overwrote, above
			// this prompt.
			this.#openMessage = -1;
			this.#dirty = true;
			return true;
		}

		/*
		 * Identity before position. `#openMessage` indexes an array `hydrate`
		 * throws away, so a reload during a live turn — the case `reloadMessages`
		 * exists to serve, since `get_messages` has no busy guard — left the
		 * message still being written with no open index, and the next frame for
		 * it opened a second bubble. The stamp is minted once when the stream is
		 * created and never restamped, so it survives the rebuild.
		 */
		const index = this.#messageIndex.get(key) ?? this.#openMessage;
		if (index >= 0) {
			const existing = this.#entries[index] as MessageEntry;
			this.#entries[index] = { ...existing, content, streaming: !final, timestamp };
			if (final) this.#messageIndex.delete(key);
			this.#openMessage = final ? -1 : index;
		} else {
			// A finished message takes no further frame, so it keeps no identity: a
			// leftover key is a trap for the next message stamped the same
			// millisecond, which would be written into the older bubble.
			if (!final) this.#messageIndex.set(key, this.#entries.length);
			this.#entries.push({
				kind: "message",
				id: `m${++this.#seq}`,
				role,
				content,
				streaming: !final,
				timestamp,
			});
			this.#openMessage = final ? -1 : this.#entries.length - 1;
		}

		this.#dirty = true;
		return true;
	}

	#onToolStart(frame: Record<string, unknown>): boolean {
		const id = String(frame.toolCallId ?? "");
		if (!id) return false;

		// A tool call ends the assistant message that requested it; anything the
		// model says afterwards belongs to a new bubble. Its identity goes with it
		// — the server closes the message first, so this only fires for one it
		// never closed, and leaving the key would let the next frame reopen it.
		if (this.#openMessage >= 0) {
			const open = this.#entries[this.#openMessage] as MessageEntry;
			this.#messageIndex.delete(messageKey(open.role, open.timestamp, open.content));
		}
		this.#openMessage = -1;

		this.#toolIndex.set(id, this.#entries.length);
		this.#entries.push({
			kind: "tool",
			id,
			name: String(frame.toolName ?? "unknown"),
			args: frame.args,
			intent: typeof frame.intent === "string" ? frame.intent : undefined,
			running: true,
		});
		this.#dirty = true;
		return true;
	}

	#onToolUpdate(frame: Record<string, unknown>): boolean {
		const index = this.#toolIndex.get(String(frame.toolCallId ?? ""));
		if (index === undefined) return false;
		const entry = this.#entries[index] as ToolEntry;
		this.#entries[index] = { ...entry, args: frame.args ?? entry.args, partial: frame.partialResult };
		this.#dirty = true;
		return true;
	}

	#onToolEnd(frame: Record<string, unknown>): boolean {
		const index = this.#toolIndex.get(String(frame.toolCallId ?? ""));
		if (index === undefined) return false;
		const entry = this.#entries[index] as ToolEntry;
		this.#entries[index] = {
			...entry,
			result: frame.result,
			isError: frame.isError === true,
			running: false,
			partial: undefined,
		};
		this.#dirty = true;
		return true;
	}
}

/** The identity a message frame carries, and the one an entry keeps. */
function messageKey(role: string, timestamp: number | undefined, content: readonly ContentBlock[]): string {
	return `${role}:${timestamp ?? messageDigest(content)}`;
}

/** Fallback identity for a message with no timestamp. */
function messageDigest(content: readonly ContentBlock[]): string {
	return content
		.map(block => block.text ?? block.thinking ?? "")
		.join("")
		.slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Flatten a message's content blocks into displayable text. */
export function messageText(content: readonly ContentBlock[]): string {
	return content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("");
}

/** Thinking blocks, kept separate so they can render muted. */
export function thinkingText(content: readonly ContentBlock[]): string {
	return content
		.filter(block => block.type === "thinking")
		.map(block => block.thinking ?? "")
		.join("");
}
