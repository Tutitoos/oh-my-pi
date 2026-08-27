import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * A manual compaction announces itself.
 *
 * Until now only the automatic path emitted `auto_compaction_start` /
 * `auto_compaction_end`; a manual pass emitted nothing but a `notice` when it
 * changed method. Every client without a terminal was left reading the prose
 * the slash command prints — "Compaction complete. Tokens: A -> B (saved C)."
 * — to find out what had happened. The two paths are the same operation, and
 * `reason: "manual"` is what tells them apart.
 */
describe("AgentSession manual compaction lifecycle events", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
			session = undefined;
			authStorage = undefined;
			tempDir = undefined;
		}
	});

	async function createHarness(methodOrder: string[]): Promise<{
		session: AgentSession;
		activeModel: Model;
		events: AgentSessionEvent[];
	}> {
		const activeModel = getBundledModel("aimlapi", "alibaba/qwen3-coder-480b-a35b-instruct");
		if (!activeModel) throw new Error("Expected bundled text-only model");

		tempDir = TempDir.createSync("@pi-manual-compaction-events-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("aimlapi", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const agent = new Agent({
			initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const seed: Message[] = [
			{ role: "user", content: "first question", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				api: activeModel.api,
				provider: activeModel.provider,
				model: activeModel.id,
				stopReason: "stop",
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
			{ role: "user", content: "second question", timestamp: Date.now() },
		];
		for (const message of seed) sessionManager.appendMessage(message);

		const settings = Settings.isolated({
			"compaction.methodOrder": methodOrder,
			"compaction.keepRecentTokens": 1,
		});
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_start" || event.type === "auto_compaction_end") events.push(event);
		});

		return { session, activeModel, events };
	}

	it("brackets a successful pass with a manual start and an end carrying the result", async () => {
		const harness = await createHarness(["soft"]);
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "llm summary",
			shortSummary: "llm",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
		}));

		await harness.session.compact();

		expect(harness.events).toHaveLength(2);
		expect(harness.events[0]).toMatchObject({ type: "auto_compaction_start", reason: "manual", action: "soft" });
		expect(harness.events[1]).toMatchObject({
			type: "auto_compaction_end",
			action: "soft",
			aborted: false,
			willRetry: false,
		});
		const end = harness.events[1] as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>;
		expect(end.result?.summary).toBe("llm summary");
		expect(end.errorMessage).toBeUndefined();
	});

	it("marks both halves of the bracket manual, so a front-end can stand down on either", async () => {
		/*
		 * These events go out on the session bus, which reaches every front-end —
		 * not just the RPC client they were added for. The TUI's `/compact` owns its
		 * own status line and its own repaint, so it ignores `reason: "manual"`; it
		 * can only do that if the *end* carries the reason too. Pairing by arrival
		 * order is not something a bus with several consumers can offer.
		 */
		const harness = await createHarness(["soft"]);
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "s",
			shortSummary: "s",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 10,
		}));

		await harness.session.compact();

		expect(harness.events.map(event => (event as { reason?: string }).reason)).toEqual(["manual", "manual"]);
	});

	it("a failed manual pass still says it was manual", async () => {
		const harness = await createHarness(["soft"]);
		vi.spyOn(compactionModule, "compact").mockImplementation(async () => {
			throw new Error("no");
		});

		await harness.session.compact().catch(() => {});

		const end = harness.events.at(-1) as { type: string; reason?: string };
		expect(end.type).toBe("auto_compaction_end");
		expect(end.reason).toBe("manual");
	});

	it("reports a failure as an end, not as silence", async () => {
		const harness = await createHarness(["soft"]);
		vi.spyOn(compactionModule, "compact").mockImplementation(async () => {
			throw new Error("summarizer exploded");
		});

		await expect(harness.session.compact()).rejects.toThrow("summarizer exploded");

		expect(harness.events).toHaveLength(2);
		const end = harness.events[1] as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>;
		expect(end.type).toBe("auto_compaction_end");
		expect(end.result).toBeUndefined();
		expect(end.errorMessage).toBe("summarizer exploded");
	});

	/*
	 * The method the engine settles on is the one reported. A text-only model
	 * makes the resolver skip snapcompact for soft, and that must still read as
	 * one compaction — not as one that started and never finished, nor as two.
	 */
	it("a method the resolver skips still yields exactly one bracket", async () => {
		const harness = await createHarness(["snapcompact", "soft"]);
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "llm summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
		}));

		await harness.session.compact();

		expect(harness.events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		expect(harness.events.filter(event => event.type === "auto_compaction_end")).toHaveLength(1);
		expect(harness.events[0]).toMatchObject({ reason: "manual", action: "soft" });
	});

	it("a refusal before any method is chosen stays silent — nothing started", async () => {
		// `handoff` and `shake` are auto-only, so manual selection finds nothing.
		const harness = await createHarness(["handoff"]);

		await expect(harness.session.compact()).rejects.toThrow("No configured compaction method can run manually.");

		expect(harness.events).toHaveLength(0);
	});
});
