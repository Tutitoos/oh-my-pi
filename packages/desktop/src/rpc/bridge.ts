/**
 * Thin client for the omp RPC protocol.
 *
 * `RpcClient` in the coding-agent package is a far richer implementation, but
 * it is unusable here: its `start()` calls `ptree.spawn(["bun", cliPath, ...])`
 * and reads `Bun.env`, neither of which exists in a webview. So the process
 * lives in Rust and this replicates the protocol surface over a `Transport`.
 *
 * Two rules the protocol imposes, both load-bearing:
 *
 *   1. Responses MUST be matched on `id`, never on arrival order. `bash` and
 *      other commands are dispatched concurrently and docs/rpc.md is explicit
 *      that emission order is not guaranteed.
 *   2. A malformed line must never kill the reader. Frames come from a separate
 *      process that may be a different omp version.
 *
 * State is exposed as immutable snapshots for `useSyncExternalStore`, following
 * `collab-web/src/lib/client.ts`. Without that, every `message_update` delta
 * would re-render the whole transcript.
 */

import {
	type AvailableSlashCommand,
	BLOCKING_UI_METHODS,
	type ExtensionUiAnswer,
	type ExtensionUiRequestFrame,
	isAvailableCommandsUpdate,
	isExtensionUiRequest,
	isReadyFrame,
	isResponseFrame,
	type LoginProvider,
	type ReadyFrame,
	type ResponseFrame,
	type RpcSessionState,
	type ServerFrame,
	type SessionEventFrame,
	type SubagentProgress,
	type SubagentSnapshot,
} from "./protocol";
import { type TranscriptEntry, TranscriptModel } from "./transcript";
import type { AgentHandle, RelayEvent, Transport } from "./transport";

/** Cap the retained raw-event log so a long session cannot grow without bound. */
const MAX_RETAINED_EVENTS = 2000;
const MAX_RETAINED_STDERR = 200;

/** Default per-request timeout. Login needs far longer and passes its own. */
const DEFAULT_TIMEOUT_MS = 120_000;
const LOGIN_TIMEOUT_MS = 600_000;

/**
 * How long `starting` may last before the UI stops claiming the agent is on its
 * way. Comfortably past the ~3.8s a cold sidecar needs, short enough that a
 * process which will never answer is not presented as one that might.
 */
const DEFAULT_STALL_MS = 20_000;

/**
 * `suspended` is not a failure: the pool reclaimed the process to stay under its
 * live-session ceiling. The transcript survives and the session resumes when you
 * open it again.
 */
export type BridgeStatus = "idle" | "starting" | "ready" | "suspended" | "exited" | "error";

export interface BridgeSnapshot {
	status: BridgeStatus;
	/**
	 * `starting` has outlived its welcome. Not a status of its own: the child may
	 * genuinely still be coming up, and saying otherwise would be a guess. It is
	 * the cue to stop showing the optimistic text and show `stderr` instead.
	 */
	stalled: boolean;
	ready: ReadyFrame | null;
	pid: number | null;
	/** The spawn was skipped because a pre-warmed process was adopted. */
	prewarmed: boolean;
	state: RpcSessionState | null;
	commands: readonly AvailableSlashCommand[];
	/** Renderable messages and tool cards, in arrival order. */
	transcript: readonly TranscriptEntry[];
	/** Live subagent roster, newest activity last. */
	subagents: readonly SubagentSnapshot[];
	/** Oldest-first, capped. Raw frames, for the protocol probe view. */
	events: readonly SessionEventFrame[];
	/** UI request awaiting an answer, or null. Only blocking methods land here. */
	pendingUi: ExtensionUiRequestFrame | null;
	stderr: readonly string[];
	error: string | null;
	exit: { code: number | null; signal: number | null } | null;
}

const EMPTY_SNAPSHOT: BridgeSnapshot = {
	status: "idle",
	stalled: false,
	ready: null,
	pid: null,
	prewarmed: false,
	state: null,
	commands: [],
	transcript: [],
	subagents: [],
	events: [],
	pendingUi: null,
	stderr: [],
	error: null,
	exit: null,
};

interface Pending {
	resolve(data: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	type: string;
}

export interface RpcBridgeOptions {
	/** Answer non-blocking UI requests (notify/setStatus/…) — default: ignore. */
	onNotice?(request: ExtensionUiRequestFrame): void;
	/** Called for `open_url`; the host should open it in the system browser. */
	onOpenUrl?(url: string, instructions?: string, launchUrl?: string): void;
	/** How long `starting` may last before `stalled` flips. Tests pass a small one. */
	stallAfterMs?: number;
}

export class RpcBridge {
	readonly tabId: string;
	#transport: Transport;
	#options: RpcBridgeOptions;

	#seq = 0;
	#pending = new Map<string, Pending>();
	#listeners = new Set<() => void>();

	// Mutable interior; `#snapshot` is rebuilt lazily on read.
	#status: BridgeStatus = "idle";
	#stalled = false;
	#stallTimer: ReturnType<typeof setTimeout> | null = null;
	#ready: ReadyFrame | null = null;
	#pid: number | null = null;
	#prewarmed = false;
	#state: RpcSessionState | null = null;
	#commands: AvailableSlashCommand[] = [];
	#transcript = new TranscriptModel();
	#subagents = new Map<string, SubagentSnapshot>();
	#subagentList: SubagentSnapshot[] = [];
	#events: SessionEventFrame[] = [];
	#pendingUi: ExtensionUiRequestFrame | null = null;
	#stderr: string[] = [];
	#error: string | null = null;
	#exit: { code: number | null; signal: number | null } | null = null;

	/**
	 * An eviction kills the child, so a `exited` always trails `evicted`.
	 * Without this the tab would flip from "suspended" to "the agent crashed" a
	 * few milliseconds later.
	 */
	#exitExpected = false;

	#snapshot: BridgeSnapshot = EMPTY_SNAPSHOT;
	#dirty = false;
	#notifyQueued = false;

	#stallAfterMs: number;

	constructor(tabId: string, transport: Transport, options: RpcBridgeOptions = {}) {
		this.tabId = tabId;
		this.#transport = transport;
		this.#options = options;
		this.#stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_MS;
	}

	/**
	 * The only writer of `#status`, so the stall watchdog cannot drift away from
	 * the state it is watching: every exit from `starting` disarms it, and every
	 * entry re-arms it.
	 */
	#setStatus(next: BridgeStatus): void {
		this.#status = next;
		this.#stalled = false;
		if (this.#stallTimer !== null) {
			clearTimeout(this.#stallTimer);
			this.#stallTimer = null;
		}
		if (next !== "starting") return;
		this.#stallTimer = setTimeout(() => {
			this.#stallTimer = null;
			if (this.#status !== "starting") return;
			this.#stalled = true;
			this.#touch();
		}, this.#stallAfterMs);
	}

	// -- store ---------------------------------------------------------------

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): BridgeSnapshot => {
		if (this.#dirty) {
			this.#snapshot = {
				status: this.#status,
				stalled: this.#stalled,
				ready: this.#ready,
				pid: this.#pid,
				prewarmed: this.#prewarmed,
				state: this.#state,
				commands: this.#commands,
				transcript: this.#transcript.entries,
				subagents: this.#subagentList,
				events: this.#events,
				pendingUi: this.#pendingUi,
				stderr: this.#stderr,
				error: this.#error,
				exit: this.#exit,
			};
			this.#dirty = false;
		}
		return this.#snapshot;
	};

	/**
	 * Mark dirty and notify once per microtask. A streaming turn produces
	 * hundreds of frames per second; without coalescing each one would be a
	 * separate React render.
	 */
	#touch(): void {
		this.#dirty = true;
		if (this.#notifyQueued) return;
		this.#notifyQueued = true;
		queueMicrotask(() => {
			this.#notifyQueued = false;
			for (const listener of this.#listeners) listener();
		});
	}

	// -- lifecycle -----------------------------------------------------------

	async start(cwd?: string): Promise<AgentHandle> {
		this.#setStatus("starting");
		this.#error = null;
		this.#exit = null;
		this.#exitExpected = false;
		this.#touch();

		let handle: AgentHandle;
		try {
			handle = await this.#transport.start(this.tabId, event => this.#onRelayEvent(event), cwd);
		} catch (cause) {
			// A rejected `agent_start` is a missing binary, a bad cwd, a poisoned
			// mutex — none of which will ever produce a frame. Leaving the status on
			// `starting` made every one of them look like a slow launch, forever.
			this.#setStatus("error");
			this.#error = cause instanceof Error ? cause.message : String(cause);
			this.#touch();
			throw cause;
		}
		this.#pid = handle.pid;
		this.#prewarmed = handle.prewarmed;
		this.#touch();
		return handle;
	}

	/** Kill the process and fail everything still in flight. */
	async stop(): Promise<void> {
		await this.#transport.kill(this.tabId);
		this.#failPending(new Error("session stopped"));
	}

	/** Kill the process but keep the tab; the transcript lives in the jsonl. */
	async suspend(): Promise<void> {
		await this.#transport.suspend(this.tabId);
		this.#failPending(new Error("session suspended"));
	}

	#failPending(error: Error): void {
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
	}

	// -- inbound -------------------------------------------------------------

	#onRelayEvent(event: RelayEvent): void {
		switch (event.event) {
			case "frames":
				for (const line of event.data.lines) this.#onLine(line);
				break;
			case "stderr":
				this.#stderr = [...this.#stderr, ...event.data.lines].slice(-MAX_RETAINED_STDERR);
				this.#touch();
				break;
			case "fault":
				this.#setStatus("error");
				this.#error = event.data.message;
				this.#failPending(new Error(event.data.message));
				this.#touch();
				break;
			case "evicted":
				this.#setStatus("suspended");
				this.#exitExpected = true;
				this.#failPending(new Error("session suspended to free a slot"));
				this.#touch();
				break;
			case "exited":
				if (this.#exitExpected) {
					// The eviction already reported this; stay suspended.
					this.#exitExpected = false;
					break;
				}
				this.#setStatus("exited");
				this.#exit = { code: event.data.code, signal: event.data.signal };
				this.#failPending(new Error(`sidecar exited (code ${event.data.code ?? "?"})`));
				this.#touch();
				break;
		}
	}

	/**
	 * One newline-delimited JSON frame. A parse failure is recorded and skipped
	 * — never thrown — because one bad line must not stop the stream.
	 */
	#onLine(line: string): void {
		if (!line.trim()) return;

		let frame: ServerFrame;
		try {
			frame = JSON.parse(line) as ServerFrame;
		} catch {
			this.#stderr = [...this.#stderr, `[unparseable frame] ${line.slice(0, 200)}`].slice(-MAX_RETAINED_STDERR);
			this.#touch();
			return;
		}
		if (typeof frame?.type !== "string") return;

		if (isReadyFrame(frame)) {
			this.#ready = frame;
			this.#setStatus("ready");
			this.#touch();
			return;
		}

		if (isResponseFrame(frame)) {
			this.#settle(frame);
			return;
		}

		if (isAvailableCommandsUpdate(frame)) {
			this.#commands = frame.commands;
			this.#touch();
			return;
		}

		if (isExtensionUiRequest(frame)) {
			this.#onUiRequest(frame);
			return;
		}

		if (
			frame.type === "subagent_lifecycle" ||
			frame.type === "subagent_progress" ||
			frame.type === "subagent_event"
		) {
			this.#onSubagentFrame(frame);
			return;
		}

		this.#onSessionEvent(frame);
	}

	#settle(frame: ResponseFrame): void {
		const entry = this.#pending.get(frame.id);
		if (!entry) return; // late response to a timed-out or abandoned request
		this.#pending.delete(frame.id);
		clearTimeout(entry.timer);

		// A correlated reply proves the sidecar is serving *this* webview, which
		// the `ready` frame cannot after a re-attach: it is emitted once, at
		// startup, into a channel that a reload or a route change threw away. A
		// failure reply counts too — it still came back from a live protocol loop.
		if (this.#status === "starting") {
			this.#setStatus("ready");
			this.#touch();
		}

		if (frame.success === false) {
			const error = new Error(frame.error ?? `${entry.type} failed`);
			if (frame.code) (error as Error & { code?: string }).code = frame.code;
			entry.reject(error);
			return;
		}
		entry.resolve(frame.data);
	}

	#onUiRequest(frame: ExtensionUiRequestFrame): void {
		if (frame.method === "open_url") {
			this.#options.onOpenUrl?.(String(frame.url ?? ""), frame.instructions, frame.launchUrl);
			return;
		}

		// Non-blocking methods (notify, setStatus, setWidget, setTitle, …) need
		// no reply. Verified: an unanswered `setWidget` did not wedge the server.
		if (!BLOCKING_UI_METHODS.has(frame.method)) {
			this.#options.onNotice?.(frame);
			return;
		}

		this.#pendingUi = frame;
		this.#touch();
	}

	/** Answer the outstanding blocking UI request. */
	answerUi(response: ExtensionUiAnswer): void {
		const pending = this.#pendingUi;
		if (!pending) return;
		this.#pendingUi = null;
		this.#touch();
		void this.#write({ type: "extension_ui_response", ...response });
	}

	/**
	 * Fold a subagent frame into the roster.
	 *
	 * All three frame types carry a `payload` keyed by subagent id, so they merge
	 * into one map rather than three parallel structures. The list is rebuilt on
	 * change so the snapshot stays immutable.
	 */
	#onSubagentFrame(frame: SessionEventFrame): void {
		const payload = frame.payload;
		if (typeof payload !== "object" || payload === null) return;

		const record = payload as Partial<SubagentSnapshot> & { progress?: SubagentProgress };
		const id = typeof record.id === "string" ? record.id : record.progress?.id;
		if (!id) return;

		const existing = this.#subagents.get(id);
		const merged: SubagentSnapshot = {
			...existing,
			...record,
			id,
			index: record.index ?? existing?.index ?? this.#subagents.size,
			agent: record.agent ?? record.progress?.agent ?? existing?.agent ?? "subagent",
			status: record.status ?? record.progress?.status ?? existing?.status ?? "pending",
			lastUpdate: record.lastUpdate ?? Date.now(),
			progress: record.progress ?? existing?.progress,
		};

		this.#subagents.set(id, merged);
		this.#subagentList = [...this.#subagents.values()].sort((a, b) => a.index - b.index);
		this.#touch();
	}

	#onSessionEvent(frame: SessionEventFrame): void {
		this.#transcript.apply(frame as Record<string, unknown>);

		this.#events =
			this.#events.length >= MAX_RETAINED_EVENTS ? [...this.#events.slice(1), frame] : [...this.#events, frame];

		// Cheap local mirror so the status bar does not need a get_state round
		// trip on every turn boundary.
		if (frame.type === "model_changed" || frame.type === "thinking_level_changed") {
			void this.getState().catch(() => {});
		}
		this.#touch();
	}

	// -- outbound ------------------------------------------------------------

	async #write(payload: object): Promise<void> {
		await this.#transport.send(this.tabId, JSON.stringify(payload));
	}

	/**
	 * Send a command and await its response, correlated by `id`.
	 *
	 * The id is minted here and never reused, so a late response to a timed-out
	 * request cannot resolve a newer one.
	 */
	request<T = unknown>(command: { type: string; [key: string]: unknown }, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
		const id = `d${++this.#seq}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();

		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`${command.type} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		this.#pending.set(id, { resolve, reject, timer, type: command.type });

		// Deliberately NOT `async`: the caller's handler must attach to `promise`
		// synchronously. An `await` before returning it leaves a window where the
		// sidecar can die and reject an unhandled promise.
		this.#write({ ...command, id }).catch((error: unknown) => {
			this.#pending.delete(id);
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});

		return promise as Promise<T>;
	}

	// -- typed surface, mirroring RpcClient ----------------------------------

	async prompt(message: string, images?: unknown[]): Promise<void> {
		await this.request({ type: "prompt", message, images });
	}

	async steer(message: string, images?: unknown[]): Promise<void> {
		await this.request({ type: "steer", message, images });
	}

	async followUp(message: string, images?: unknown[]): Promise<void> {
		await this.request({ type: "follow_up", message, images });
	}

	async abort(): Promise<void> {
		await this.request({ type: "abort" });
	}

	async getState(): Promise<RpcSessionState> {
		const state = await this.request<RpcSessionState>({ type: "get_state" });
		this.#state = state;
		this.#touch();
		return state;
	}

	async getAvailableCommands(): Promise<AvailableSlashCommand[]> {
		const data = await this.request<{ commands: AvailableSlashCommand[] }>({
			type: "get_available_commands",
		});
		this.#commands = data.commands ?? [];
		this.#touch();
		return this.#commands;
	}

	async getAvailableModels(): Promise<Array<{ provider: string; id: string }>> {
		const data = await this.request<{ models: Array<{ provider: string; id: string }> }>({
			type: "get_available_models",
		});
		return data.models ?? [];
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.request({ type: "set_model", provider, modelId });
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.request({ type: "set_thinking_level", level });
	}

	async compact(customInstructions?: string): Promise<unknown> {
		return this.request({ type: "compact", customInstructions });
	}

	async setSubagentSubscription(level: "off" | "progress" | "events"): Promise<void> {
		await this.request({ type: "set_subagent_subscription", level });
	}

	async getSubagents(): Promise<SubagentSnapshot[]> {
		const data = await this.request<{ subagents?: SubagentSnapshot[] } | SubagentSnapshot[]>({
			type: "get_subagents",
		});
		// The command has been observed returning both a bare array and an
		// envelope; accept either rather than depending on which.
		const list = Array.isArray(data) ? data : (data?.subagents ?? []);
		for (const entry of list) this.#subagents.set(entry.id, entry);
		this.#subagentList = [...this.#subagents.values()].sort((a, b) => a.index - b.index);
		this.#touch();
		return this.#subagentList;
	}

	async getSubagentMessages(selector: { subagentId?: string; sessionFile?: string; fromByte?: number }) {
		return this.request({ type: "get_subagent_messages", ...selector });
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const result = await this.request<{ cancelled: boolean }>({
			type: "switch_session",
			sessionPath,
		});
		if (!result?.cancelled) {
			this.#transcript.clear();
			this.#events = [];
			this.#touch();
			// Switching replays NOTHING through the event stream — the server just
			// goes quiet on the new session — so the history has to be pulled in,
			// or the chat opens blank.
			await this.loadHistory().catch(() => {});
		}
		return result;
	}

	/**
	 * Fill the transcript from the session file.
	 *
	 * Paging is capped server-side at 256 messages per page and refuses to start
	 * while the session is streaming or compacting (`session_busy`), so this is
	 * best-effort: a failure leaves the transcript empty rather than throwing at
	 * a caller that only wanted to open a tab.
	 */
	async loadHistory(limit = 200): Promise<number> {
		const page = await this.request<{ messages?: unknown[] }>({
			type: "get_messages_page",
			limit,
		});
		const messages = page?.messages ?? [];
		this.#transcript.hydrate(messages);
		this.#touch();
		return messages.length;
	}

	async getMessagesPage(cursor?: string, limit?: number): Promise<unknown> {
		return this.request({ type: "get_messages_page", cursor, limit });
	}

	async bash(command: string): Promise<unknown> {
		return this.request({ type: "bash", command });
	}

	/**
	 * Token totals and spend for the session.
	 *
	 * Separate from `get_state` on purpose: `cost` and the per-kind token counts
	 * live here, so the status bar fetches this when a turn settles rather than
	 * polling it while one is streaming.
	 */
	async getSessionStats(): Promise<{ cost?: number; tokens?: Record<string, number> }> {
		return this.request({ type: "get_session_stats" });
	}

	async getLoginProviders(): Promise<LoginProvider[]> {
		const data = await this.request<{ providers: LoginProvider[] }>({
			type: "get_login_providers",
		});
		return data.providers ?? [];
	}

	async login(providerId: string): Promise<{ providerId: string }> {
		return this.request({ type: "login", providerId }, LOGIN_TIMEOUT_MS);
	}
}
