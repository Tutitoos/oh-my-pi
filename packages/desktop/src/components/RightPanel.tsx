import { useState } from "react";
import type { RpcBridge } from "../rpc/bridge";
import { AgentsPanel } from "./AgentsPanel";
import { DiffPanel } from "./DiffPanel";
import { FileTree } from "./FileTree";
import { TodoPanel } from "./TodoPanel";

type Tab = "changes" | "files" | "todos" | "agents";

const TABS: Array<{ id: Tab; label: string }> = [
	{ id: "changes", label: "Changes" },
	{ id: "files", label: "Files" },
	{ id: "todos", label: "Plan" },
	{ id: "agents", label: "Agents" },
];

export function RightPanel({
	bridge,
	ready,
	todoPhases,
	subagentCount,
}: {
	bridge: RpcBridge;
	ready: boolean;
	todoPhases: readonly unknown[];
	subagentCount: number;
}) {
	const [tab, setTab] = useState<Tab>("changes");

	return (
		<aside className="omp-panel">
			<div className="omp-panel__tabs" role="tablist">
				{TABS.map(entry => (
					<button
						className="omp-panel__tab"
						key={entry.id}
						type="button"
						role="tab"
						aria-selected={tab === entry.id}
						onClick={() => setTab(entry.id)}
					>
						{entry.label}
						{entry.id === "todos" && todoPhases.length > 0 ? ` ${todoPhases.length}` : ""}
						{entry.id === "agents" && subagentCount > 0 ? ` ${subagentCount}` : ""}
					</button>
				))}
			</div>

			<div className="omp-panel__body" role="tabpanel">
				{/*
				 * Panels stay mounted across tab switches only where remounting is
				 * cheap. Diff and tree each cost a shell round trip, so they unmount
				 * — the data is re-fetched on demand rather than kept warm.
				 */}
				{tab === "changes" ? <DiffPanel bridge={bridge} ready={ready} /> : null}
				{tab === "files" ? <FileTree bridge={bridge} ready={ready} /> : null}
				{tab === "todos" ? <TodoPanel phases={todoPhases} /> : null}
				{tab === "agents" ? <AgentsPanel bridge={bridge} /> : null}
			</div>
		</aside>
	);
}
