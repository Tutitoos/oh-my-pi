import { describe, expect, test } from "bun:test";
import { collectToolCalls, TranscriptModel } from "../src/rpc/transcript";

/**
 * Shapes taken from a real session file, not from the docs — the difference
 * between them is the whole bug. A `toolResult` message carries no arguments;
 * they are on the assistant's `toolCall` block, under `arguments`, while the
 * live frame calls the same field `args`.
 *
 * Reopening a session built its cards from results alone, so every tool showed
 * `…` where its command should be.
 */
const HISTORY = [
	{ role: "user", content: [{ type: "text", text: "lista los ficheros" }] },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "voy a mirar" },
			{
				type: "toolCall",
				id: "toolu_01UwNZ7X",
				name: "bash",
				arguments: { command: "ls -la", i: "List the workspace" },
				intent: "List the workspace",
			},
		],
	},
	{
		role: "toolResult",
		toolCallId: "toolu_01UwNZ7X",
		toolName: "bash",
		content: [{ type: "text", text: "total 8" }],
		details: { exitCode: 0 },
		isError: false,
		timestamp: 1787408802204,
	},
];

describe("collectToolCalls", () => {
	test("finds arguments under `arguments`, which is where they are stored", () => {
		const calls = collectToolCalls(HISTORY);
		expect(calls.get("toolu_01UwNZ7X")?.args).toEqual({ command: "ls -la", i: "List the workspace" });
	});

	test("carries the intent, which is also only on the call", () => {
		expect(collectToolCalls(HISTORY).get("toolu_01UwNZ7X")?.intent).toBe("List the workspace");
	});

	test("ignores blocks that are not tool calls", () => {
		expect(collectToolCalls(HISTORY).size).toBe(1);
	});

	test("survives malformed history rather than throwing", () => {
		// Old sessions and partial writes both produce shapes like these.
		expect(collectToolCalls([null, 7, "x", { role: "assistant" }, { role: "assistant", content: "no" }]).size).toBe(
			0,
		);
		expect(collectToolCalls([{ role: "assistant", content: [{ type: "toolCall" }] }]).size).toBe(0);
	});
});

describe("a replayed tool card", () => {
	const model = new TranscriptModel();
	model.hydrate(HISTORY);
	const entries = model.entries;
	const tool = entries.find(e => e.kind === "tool");

	test("knows its command — the regression", () => {
		// `bash.tsx` renders "…" for its command when args.command is undefined,
		// which is exactly what a reopened session used to show.
		expect(tool).toBeDefined();
		expect((tool as { args?: { command?: string } }).args?.command).toBe("ls -la");
	});

	test("keeps its intent and its result", () => {
		expect((tool as { intent?: string }).intent).toBe("List the workspace");
		expect((tool as { result?: { details?: unknown } }).result?.details).toEqual({ exitCode: 0 });
	});

	test("renders the user turn and the assistant turn around it", () => {
		expect(entries.map(e => e.kind)).toEqual(["message", "message", "tool"]);
	});
});
