import { memo, type ReactNode } from "react";
import type { BridgeSnapshot, RpcBridge } from "../rpc/bridge";

/**
 * The bottom line, laid out like a shell prompt: what you are working on at the
 * left, what it is costing at the right.
 *
 * Everything comes from a single `get_state` — `RpcSessionState` already carries
 * `contextUsage`, `tokensPerSecond`, `queuedMessageCount` and the fast-mode
 * flags — except `cost`, which lives in `get_session_stats` and is fetched only
 * when a turn settles.
 */
export const StatusBar = memo(function StatusBar({
	snapshot,
	bridge,
	cwd,
	cost,
	children,
}: {
	snapshot: BridgeSnapshot;
	bridge: RpcBridge;
	/** Working directory of this session, shown like the TUI's prompt line. */
	cwd?: string;
	cost?: number;
	/** Interactive controls (model, approval mode) render at the head of the bar. */
	children?: ReactNode;
}) {
	const { state, status } = snapshot;
	const usage = state?.contextUsage;

	return (
		<div className="omp-statusbar">
			{children ?? <span>{state?.model?.id ?? (status === "starting" ? "starting…" : "no model")}</span>}

			{state?.isStreaming && state.tokensPerSecond ? <span>{state.tokensPerSecond.toFixed(0)} tok/s</span> : null}

			{state?.isCompacting ? <span>compacting…</span> : null}

			{state && state.queuedMessageCount > 0 ? <span>{state.queuedMessageCount} queued</span> : null}

			{state?.fastModeActive ? <span>fast</span> : null}

			{snapshot.prewarmed ? <span title="Adopted a pre-warmed process">warm</span> : null}

			<span className="omp-statusbar__spacer" />

			{cwd ? (
				<span className="omp-statusbar__path" title={cwd}>
					{shortenPath(cwd)}
				</span>
			) : null}

			<ContextMeter usage={usage} cost={cost} />

			<button type="button" onClick={() => void bridge.compact().catch(() => {})}>
				compact
			</button>
		</div>
	);
});

function ContextMeter({
	usage,
	cost,
}: {
	usage: { tokens?: number; contextWindow?: number; percent?: number } | undefined;
	cost?: number;
}) {
	if (!usage) return null;
	const percent = typeof usage.percent === "number" ? usage.percent : null;
	const tokens = typeof usage.tokens === "number" ? usage.tokens : null;
	if (percent === null && tokens === null) return null;

	return (
		<span
			className="omp-statusbar__usage"
			title={
				usage.contextWindow
					? `${tokens?.toLocaleString() ?? "?"} of ${usage.contextWindow.toLocaleString()} tokens`
					: undefined
			}
		>
			{tokens !== null ? compactTokens(tokens) : null}
			{percent !== null ? (
				<>
					{" "}
					<span className="omp-meter">
						<span
							className="omp-meter__fill"
							style={{ width: `${Math.min(100, percent)}%` }}
							data-warn={percent >= 70 || undefined}
							data-critical={percent >= 90 || undefined}
						/>
					</span>{" "}
					{percent.toFixed(0)}%
				</>
			) : null}
			{typeof cost === "number" && cost > 0 ? ` · $${cost.toFixed(2)}` : null}
		</span>
	);
}

/** `17669` → `17.7K`, the way the TUI writes it. */
function compactTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	return `${(tokens / 1000).toFixed(1)}K`;
}

/** Home-relative, and only the tail when it is long — the bar is one line. */
function shortenPath(path: string): string {
	const home = path.match(/^\/Users\/[^/]+/)?.[0];
	const relative = home ? path.replace(home, "~") : path;
	const parts = relative.split("/");
	return parts.length > 4 ? `…/${parts.slice(-2).join("/")}` : relative;
}
