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

/** Roles whose messages are rendered. Tool results render as tool cards. */
const RENDERED_ROLES = new Set(["user", "assistant"]);

export class TranscriptModel {
	#entries: TranscriptEntry[] = [];
	#toolIndex = new Map<string, number>();
	/**
	 * `role:timestamp` of every non-streaming message already rendered.
	 *
	 * A user message is emitted twice — once on `message_start`, once on
	 * `message_end`, both carrying the identical payload — so without this the
	 * transcript shows every prompt twice. Verified against a live turn.
	 */
	#seen = new Set<string>();
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
		this.#seen.clear();
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
			this.#entries.push({
				kind: "message",
				id: `m${++this.#seq}`,
				role,
				content,
				streaming: false,
			});
			if (typeof raw.timestamp === "number") this.#seen.add(`${role}:${raw.timestamp}`);
		}
		this.#dirty = true;
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

		// A user message is its own entry: never streamed, never replacing the
		// assistant message in flight. It arrives twice (start + end), so the
		// timestamp is what keeps one prompt from rendering as two bubbles.
		if (role === "user") {
			const key = `user:${typeof raw.timestamp === "number" ? raw.timestamp : messageDigest(content)}`;
			if (this.#seen.has(key)) return false;
			this.#seen.add(key);
			this.#entries.push({
				kind: "message",
				id: `m${++this.#seq}`,
				role,
				content,
				streaming: false,
			});
			this.#dirty = true;
			return true;
		}

		if (this.#openMessage >= 0) {
			const existing = this.#entries[this.#openMessage] as MessageEntry;
			this.#entries[this.#openMessage] = { ...existing, content, streaming: !final };
		} else {
			this.#entries.push({
				kind: "message",
				id: `m${++this.#seq}`,
				role,
				content,
				streaming: !final,
			});
			this.#openMessage = this.#entries.length - 1;
		}

		if (final) this.#openMessage = -1;
		this.#dirty = true;
		return true;
	}

	#onToolStart(frame: Record<string, unknown>): boolean {
		const id = String(frame.toolCallId ?? "");
		if (!id) return false;

		// A tool call ends the assistant message that requested it; anything the
		// model says afterwards belongs to a new bubble.
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
