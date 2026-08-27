import { ToolView } from "@oh-my-pi/collab-web/src/tool-render";
import { memo } from "react";
import type { ToolEntry } from "../rpc/transcript";

/**
 * Adapter between an RPC `tool_execution_*` entry and omp's shared renderer.
 *
 * `collab-web/src/components/transcript/ToolCard.tsx` does the same job for
 * wire-typed frames; this is the RPC-shaped twin. The renderers themselves are
 * declared host-agnostic — plain JSON in, tolerant of malformed args — so no
 * translation is needed beyond naming.
 */
export const ToolCard = memo(function ToolCard({ entry }: { entry: ToolEntry }) {
	return (
		<ToolView
			name={entry.name}
			args={entry.args}
			result={entry.result as never}
			running={entry.running}
			intent={entry.intent}
			partial={partialText(entry.partial)}
		/>
	);
});

/** `partialResult` streams as `{ content: [{ type: "text", text }], details }`. */
function partialText(partial: unknown): string | undefined {
	if (!partial || typeof partial !== "object") return undefined;
	const content = (partial as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map(block =>
			block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
				? (block as { text: string }).text
				: "",
		)
		.join("");
	return text || undefined;
}
