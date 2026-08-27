import { describe, expect, test } from "bun:test";
import { RpcBridge } from "../src/rpc/bridge";
import type { AgentHandle, PoolStatus, RelayEvent, Transport } from "../src/rpc/transport";

/**
 * Scriptable stand-in for the Rust relay. Captures what the bridge writes and
 * lets a test push frames back at whatever time and order it likes.
 */
class MockTransport implements Transport {
	sent: string[] = [];
	killed: string[] = [];
	suspended: string[] = [];
	#emit: ((event: RelayEvent) => void) | null = null;
	#tabId = "";

	async start(tabId: string, onEvent: (event: RelayEvent) => void): Promise<AgentHandle> {
		this.#tabId = tabId;
		this.#emit = onEvent;
		return { pid: 4242, resumed: false, prewarmed: false };
	}

	async send(_tabId: string, line: string): Promise<void> {
		this.sent.push(line);
	}

	async suspend(tabId: string): Promise<void> {
		this.suspended.push(tabId);
	}

	async kill(tabId: string): Promise<void> {
		this.killed.push(tabId);
	}

	async poolStatus(): Promise<PoolStatus> {
		return { live: 1, maxLive: 3, prewarmReady: true, tabs: [this.#tabId] };
	}

	// -- test helpers --

	/** Push raw stdout lines, exactly as the relay batches them. */
	lines(...lines: string[]): void {
		this.#emit?.({ event: "frames", data: { tabId: this.#tabId, lines } });
	}

	frames(...frames: object[]): void {
		this.lines(...frames.map(f => JSON.stringify(f)));
	}

	stderr(...lines: string[]): void {
		this.#emit?.({ event: "stderr", data: { tabId: this.#tabId, lines } });
	}

	exit(code: number | null = 1, signal: number | null = null): void {
		this.#emit?.({ event: "exited", data: { tabId: this.#tabId, code, signal } });
	}

	fault(message: string): void {
		this.#emit?.({ event: "fault", data: { tabId: this.#tabId, message } });
	}

	/** The `id` the bridge minted for the Nth command it sent. */
	idOf(index: number): string {
		return JSON.parse(this.sent[index]).id;
	}

	typeOf(index: number): string {
		return JSON.parse(this.sent[index]).type;
	}
}

async function connected(options?: ConstructorParameters<typeof RpcBridge>[2]) {
	const transport = new MockTransport();
	const bridge = new RpcBridge("tab-1", transport, options);
	await bridge.start();
	transport.frames({ type: "ready", protocolVersion: 1, maxFrameBytes: 1048576 });
	return { transport, bridge };
}

/** Let queued microtasks (snapshot notifications) run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("RpcBridge — correlation", () => {
	test("matches responses by id, not arrival order", async () => {
		const { transport, bridge } = await connected();

		const first = bridge.request<{ tag: string }>({ type: "get_state" });
		const second = bridge.request<{ tag: string }>({ type: "get_session_stats" });
		const third = bridge.request<{ tag: string }>({ type: "get_available_commands" });
		await settle();

		const [id1, id2, id3] = [transport.idOf(0), transport.idOf(1), transport.idOf(2)];
		expect(new Set([id1, id2, id3]).size).toBe(3);

		// Answer in reverse order — the protocol explicitly permits this.
		transport.frames(
			{ type: "response", id: id3, data: { tag: "third" } },
			{ type: "response", id: id1, data: { tag: "first" } },
			{ type: "response", id: id2, data: { tag: "second" } },
		);

		expect(await first).toEqual({ tag: "first" });
		expect(await second).toEqual({ tag: "second" });
		expect(await third).toEqual({ tag: "third" });
	});

	test("a response for an unknown id is ignored, not thrown", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_state" });
		await settle();

		transport.frames({ type: "response", id: "not-ours", data: { nope: true } });
		transport.frames({ type: "response", id: transport.idOf(0), data: { ok: true } });

		expect(await pending).toEqual({ ok: true });
	});

	test("ids are never reused, so a late response cannot resolve a newer request", async () => {
		const { transport, bridge } = await connected();

		const first = bridge.request({ type: "get_state" }, 20);
		await settle();
		const staleId = transport.idOf(0);
		await expect(first).rejects.toThrow(/timed out/);

		const second = bridge.request<{ which: string }>({ type: "get_state" });
		await settle();
		expect(transport.idOf(1)).not.toBe(staleId);

		// The late response to the abandoned request must not settle the new one.
		transport.frames({ type: "response", id: staleId, data: { which: "stale" } });
		transport.frames({ type: "response", id: transport.idOf(1), data: { which: "fresh" } });

		expect(await second).toEqual({ which: "fresh" });
	});

	test("surfaces error responses with their machine-readable code", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_messages_page" });
		await settle();

		transport.frames({
			type: "response",
			id: transport.idOf(0),
			success: false,
			error: "session is streaming",
			code: "session_busy",
		});

		await expect(pending).rejects.toMatchObject({
			message: "session is streaming",
			code: "session_busy",
		});
	});
});

describe("RpcBridge — resilience", () => {
	test("a malformed line does not stop the stream", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_state" });
		await settle();

		transport.lines("{ this is not json", "", "   ");
		transport.frames({ type: "response", id: transport.idOf(0), data: { survived: true } });

		expect(await pending).toEqual({ survived: true });
		expect(bridge.getSnapshot().stderr.some(l => l.includes("unparseable"))).toBe(true);
	});

	test("a frame without a string type is skipped", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_state" });
		await settle();

		transport.frames({ notAType: 1 }, { type: 42 });
		transport.frames({ type: "response", id: transport.idOf(0), data: { ok: 1 } });

		expect(await pending).toEqual({ ok: 1 });
	});

	test("process death rejects everything in flight", async () => {
		const { transport, bridge } = await connected();
		const a = bridge.request({ type: "get_state" });
		const b = bridge.request({ type: "get_session_stats" });
		await settle();

		transport.exit(1, null);

		await expect(a).rejects.toThrow(/exited/);
		await expect(b).rejects.toThrow(/exited/);
		expect(bridge.getSnapshot().status).toBe("exited");
		expect(bridge.getSnapshot().exit).toEqual({ code: 1, signal: null });
	});

	test("a relay fault rejects in-flight requests and records the message", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_state" });
		await settle();

		transport.fault("sidecar not found");

		await expect(pending).rejects.toThrow(/sidecar not found/);
		expect(bridge.getSnapshot().status).toBe("error");
		expect(bridge.getSnapshot().error).toBe("sidecar not found");
	});
});

describe("RpcBridge — extension UI", () => {
	test("non-blocking requests never surface as a dialog", async () => {
		const notices: string[] = [];
		const { transport, bridge } = await connected({
			onNotice: request => notices.push(request.method),
		});

		transport.frames(
			{ type: "extension_ui_request", id: "u1", method: "setWidget", widgetKey: "autoresearch" },
			{ type: "extension_ui_request", id: "u2", method: "setStatus", message: "working" },
		);
		await settle();

		expect(bridge.getSnapshot().pendingUi).toBeNull();
		expect(notices).toEqual(["setWidget", "setStatus"]);
	});

	test("blocking requests surface and can be answered", async () => {
		const { transport, bridge } = await connected();

		transport.frames({
			type: "extension_ui_request",
			id: "u9",
			method: "confirm",
			title: "Confirm",
			message: "Run rm -rf?",
		});
		await settle();

		expect(bridge.getSnapshot().pendingUi?.id).toBe("u9");

		bridge.answerUi({ id: "u9", confirmed: false });
		await settle();

		expect(bridge.getSnapshot().pendingUi).toBeNull();
		const last = JSON.parse(transport.sent.at(-1)!);
		expect(last).toEqual({ type: "extension_ui_response", id: "u9", confirmed: false });
	});

	test("open_url is routed to the host instead of blocking", async () => {
		const opened: string[] = [];
		const { transport, bridge } = await connected({
			onOpenUrl: url => opened.push(url),
		});

		transport.frames({
			type: "extension_ui_request",
			id: "u3",
			method: "open_url",
			url: "https://example.test/oauth",
			launchUrl: "http://127.0.0.1:1/launch",
		});
		await settle();

		expect(opened).toEqual(["https://example.test/oauth"]);
		expect(bridge.getSnapshot().pendingUi).toBeNull();
	});
});

describe("RpcBridge — snapshots", () => {
	test("getSnapshot is referentially stable until something changes", async () => {
		const { transport, bridge } = await connected();
		await settle();

		const first = bridge.getSnapshot();
		expect(bridge.getSnapshot()).toBe(first); // same reference — no re-render

		transport.frames({ type: "notice", text: "hello" });
		await settle();

		const second = bridge.getSnapshot();
		expect(second).not.toBe(first);
		expect(second.events.length).toBe(1);
	});

	test("a burst of frames notifies subscribers once", async () => {
		const { transport, bridge } = await connected();
		await settle();

		let notifications = 0;
		bridge.subscribe(() => notifications++);

		transport.frames(
			{ type: "message_update", delta: "a" },
			{ type: "message_update", delta: "b" },
			{ type: "message_update", delta: "c" },
			{ type: "message_update", delta: "d" },
		);
		await settle();

		expect(bridge.getSnapshot().events.length).toBe(4);
		expect(notifications).toBe(1);
	});

	test("the ready frame lands in the snapshot", async () => {
		const { bridge } = await connected();
		await settle();

		const snapshot = bridge.getSnapshot();
		expect(snapshot.status).toBe("ready");
		expect(snapshot.ready?.protocolVersion).toBe(1);
		expect(snapshot.ready?.maxFrameBytes).toBe(1048576);
		expect(snapshot.pid).toBe(4242);
	});

	test("available_commands_update replaces the command list", async () => {
		const { transport, bridge } = await connected();

		transport.frames({
			type: "available_commands_update",
			commands: [
				{ name: "mcp", source: "builtin", subcommands: [{ name: "add" }, { name: "list" }] },
				{ name: "review", source: "builtin" },
			],
		});
		await settle();

		const { commands } = bridge.getSnapshot();
		expect(commands.map(c => c.name)).toEqual(["mcp", "review"]);
		expect(commands[0].subcommands).toHaveLength(2);
	});
});

describe("RpcBridge — lifecycle", () => {
	test("suspend kills the process and fails pending work", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_state" });
		await settle();

		await bridge.suspend();

		expect(transport.suspended).toEqual(["tab-1"]);
		await expect(pending).rejects.toThrow(/suspended/);
	});

	test("commands are written as one JSON line each", async () => {
		const { transport, bridge } = await connected();
		void bridge.prompt("hello");
		await settle();

		expect(transport.sent).toHaveLength(1);
		expect(transport.sent[0]).not.toContain("\n");
		expect(transport.typeOf(0)).toBe("prompt");
		expect(JSON.parse(transport.sent[0]).message).toBe("hello");
	});
});

/** A relay whose session is already up — what a reload or a remount sees. */
class ResumingTransport extends MockTransport {
	override async start(tabId: string, onEvent: (event: RelayEvent) => void): Promise<AgentHandle> {
		await super.start(tabId, onEvent);
		return { pid: 4242, resumed: true, prewarmed: false };
	}
}

/** A relay that cannot spawn at all — missing binary, bad cwd, poisoned mutex. */
class UnspawnableTransport extends MockTransport {
	override async start(): Promise<AgentHandle> {
		throw new Error("program not found");
	}
}

/**
 * The sidecar writes `ready` once, as it enters its protocol loop. A bridge that
 * attaches later — after a webview reload, a route change, or the `"scratch"`
 * tabId being handed between the session view and onboarding — will never see
 * it: the Rust relay replays buffered output only while the sink is still
 * unadopted, and re-adopting a live one replays nothing. Waiting for that frame
 * was a permanent "Starting the agent…".
 */
describe("RpcBridge — attaching to a session that is already up", () => {
	test("reaches ready on the first reply, with no second `ready` frame", async () => {
		const transport = new ResumingTransport();
		const bridge = new RpcBridge("tab-1", transport);
		await bridge.start();
		expect(bridge.getSnapshot().status).toBe("starting");

		const pending = bridge.request({ type: "get_state" });
		await settle();
		transport.frames({ type: "response", id: transport.idOf(0), data: { tag: "state" } });
		await pending;

		expect(bridge.getSnapshot().status).toBe("ready");
	});

	test("a failure reply counts too — it still came back from a live loop", async () => {
		const transport = new ResumingTransport();
		const bridge = new RpcBridge("tab-1", transport);
		await bridge.start();

		const pending = bridge.request({ type: "get_state" });
		await settle();
		transport.frames({ type: "response", id: transport.idOf(0), success: false, error: "session_busy" });
		await expect(pending).rejects.toThrow(/session_busy/);

		expect(bridge.getSnapshot().status).toBe("ready");
	});

	test("a rejected spawn reports the reason instead of pretending to start", async () => {
		const bridge = new RpcBridge("tab-1", new UnspawnableTransport());

		await expect(bridge.start()).rejects.toThrow(/program not found/);

		const snapshot = bridge.getSnapshot();
		expect(snapshot.status).toBe("error");
		expect(snapshot.error).toBe("program not found");
	});
});

describe("RpcBridge — stall watchdog", () => {
	test("flags a startup that never answers", async () => {
		const bridge = new RpcBridge("tab-1", new ResumingTransport(), { stallAfterMs: 5 });
		await bridge.start();
		expect(bridge.getSnapshot().stalled).toBe(false);

		await new Promise(resolve => setTimeout(resolve, 25));

		// Still `starting`: the child may genuinely be slow. The flag says only that
		// the optimistic message has outlived its usefulness.
		expect(bridge.getSnapshot().status).toBe("starting");
		expect(bridge.getSnapshot().stalled).toBe(true);
	});

	test("a session that comes up is never flagged", async () => {
		const transport = new MockTransport();
		const bridge = new RpcBridge("tab-1", transport, { stallAfterMs: 5 });
		await bridge.start();
		transport.frames({ type: "ready", protocolVersion: 1, maxFrameBytes: 1048576 });

		await new Promise(resolve => setTimeout(resolve, 25));

		expect(bridge.getSnapshot().status).toBe("ready");
		expect(bridge.getSnapshot().stalled).toBe(false);
	});

	test("the flag clears when the session later exits", async () => {
		const transport = new ResumingTransport();
		const bridge = new RpcBridge("tab-1", transport, { stallAfterMs: 5 });
		await bridge.start();
		await new Promise(resolve => setTimeout(resolve, 25));
		expect(bridge.getSnapshot().stalled).toBe(true);

		transport.exit(127);
		await settle();

		expect(bridge.getSnapshot().status).toBe("exited");
		expect(bridge.getSnapshot().stalled).toBe(false);
	});
});
