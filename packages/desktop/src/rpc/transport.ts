/**
 * Transport seam between `RpcBridge` and the Rust relay.
 *
 * The bridge holds a `Transport`, never Tauri APIs directly, so the protocol
 * logic — the only part with real complexity — is testable under plain
 * `bun test` with no window, no webview and no child process.
 */

/** Events the Rust relay pushes up the Channel. Mirrors `AgentEvent` in lib.rs. */
export type RelayEvent =
	| { event: "frames"; data: { tabId: string; lines: string[] } }
	| { event: "stderr"; data: { tabId: string; lines: string[] } }
	| { event: "fault"; data: { tabId: string; message: string } }
	| { event: "exited"; data: { tabId: string; code: number | null; signal: number | null } }
	/** The pool reclaimed this session's process; an `exited` follows. */
	| { event: "evicted"; data: { tabId: string } };

export interface AgentHandle {
	pid: number;
	/** An existing process was re-attached (StrictMode double-mount, HMR reload). */
	resumed: boolean;
	/** A pre-warmed process was adopted, so the ~3.8s spawn was skipped. */
	prewarmed: boolean;
}

export interface PoolStatus {
	live: number;
	maxLive: number;
	prewarmReady: boolean;
	tabs: string[];
}

export interface Transport {
	/** `cwd` fixes the sidecar's working directory; it cannot change after spawn. */
	start(tabId: string, onEvent: (event: RelayEvent) => void, cwd?: string): Promise<AgentHandle>;
	send(tabId: string, line: string): Promise<void>;
	suspend(tabId: string): Promise<void>;
	kill(tabId: string): Promise<void>;
	poolStatus(): Promise<PoolStatus>;
}

/**
 * Real transport over Tauri IPC.
 *
 * Uses `Channel` rather than `emit`/`listen` deliberately: `listen()` returns a
 * promise, so frames emitted between spawn and subscription would be dropped.
 * A Channel is constructed synchronously and its id rides the same `invoke`
 * that starts the stream, so nothing can precede the listener.
 */
export class TauriTransport implements Transport {
	async start(tabId: string, onEvent: (event: RelayEvent) => void, cwd?: string): Promise<AgentHandle> {
		const { Channel, invoke } = await import("@tauri-apps/api/core");
		const channel = new Channel<RelayEvent>();
		channel.onmessage = onEvent;
		// Rust names the arguments `on_event` / `cwd`; Tauri camelCases across IPC.
		return invoke<AgentHandle>("agent_start", { tabId, cwd: cwd ?? null, onEvent: channel });
	}

	async send(tabId: string, line: string): Promise<void> {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("agent_send", { tabId, line });
	}

	async suspend(tabId: string): Promise<void> {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("agent_suspend", { tabId });
	}

	async kill(tabId: string): Promise<void> {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("agent_kill", { tabId });
	}

	async poolStatus(): Promise<PoolStatus> {
		const { invoke } = await import("@tauri-apps/api/core");
		return invoke<PoolStatus>("agent_pool_status");
	}
}

export interface DroppedImage {
	name: string;
	mimeType: string;
	/** Base64, the shape `prompt(message, images)` wants. */
	data: string;
}

/**
 * Read an image the user dropped on the window.
 *
 * Tauri intercepts window drops and reports paths, not `File` objects, so the
 * webview has nothing to read — which is why HTML5 drag-and-drop appeared to do
 * nothing in the packaged app. Rust reads it instead, images only.
 */
export async function readDroppedImage(path: string): Promise<DroppedImage> {
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<DroppedImage>("read_dropped_image", { path });
}

/**
 * Subscribe to Tauri's own drag-and-drop events.
 *
 * `dragDropEnabled` defaults to true, which turns the webview's HTML5 drop off
 * and routes drops through here instead. Window-scoped, not per-element, so the
 * caller has to decide which session owns the drop.
 */
export async function onWindowDrop(handler: {
	over(): void;
	leave(): void;
	drop(paths: readonly string[]): void;
}): Promise<() => void> {
	const { getCurrentWebview } = await import("@tauri-apps/api/webview");
	return getCurrentWebview().onDragDropEvent(event => {
		if (event.payload.type === "over") handler.over();
		else if (event.payload.type === "leave") handler.leave();
		else if (event.payload.type === "drop") handler.drop(event.payload.paths);
	});
}

/** True when running inside a Tauri webview rather than a plain browser tab. */
export function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
