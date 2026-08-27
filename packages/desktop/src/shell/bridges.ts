import type { RpcBridge } from "../rpc/bridge";
import { isTauri, TauriTransport } from "../rpc/transport";

/**
 * Which tab's bridge is which, for the parts of the app that are not inside a
 * session view.
 *
 * The sidebar's context menu needs it: renaming a session that is open must go
 * through the process that already has it, because a second process on a live
 * jsonl is two agents appending to one file. `activity.ts` established this
 * shape — a module-level registry the views publish into.
 */
const bridges = new Map<string, RpcBridge>();

export function registerBridge(tabId: string, bridge: RpcBridge): () => void {
	bridges.set(tabId, bridge);
	return () => {
		// Only if it is still ours: a remount registers the new one first.
		if (bridges.get(tabId) === bridge) bridges.delete(tabId);
	};
}

export function bridgeFor(tabId: string | undefined): RpcBridge | undefined {
	return tabId ? bridges.get(tabId) : undefined;
}

/**
 * The bridge for a tab that genuinely has a process behind it.
 *
 * `bridgeFor` answers for any mounted session view, and a view stays mounted
 * with its bridge sitting at `idle` when it is not the visible tab — its boot is
 * gated on `autoStart`. So "has a bridge" and even "the bridge says ready" both
 * mean less than they look: after any route change every background tab reports
 * idle while its sidecar is alive in the pool.
 *
 * Rust owns the processes, so Rust is asked. This matters beyond a greyed menu
 * item: a caller that wrongly concludes "no process" falls through to the
 * throwaway path, and that puts a second agent on a live session's jsonl.
 */
export async function liveBridgeFor(tabId: string | undefined): Promise<RpcBridge | undefined> {
	if (!tabId || !isTauri()) return undefined;
	const bridge = bridges.get(tabId);
	if (!bridge) return undefined;
	const status = await new TauriTransport().poolStatus().catch(() => null);
	return status?.tabs.includes(tabId) ? bridge : undefined;
}

/** Tab ids the Rust pool currently has a process for. */
export async function liveTabs(): Promise<Set<string>> {
	if (!isTauri()) return new Set();
	const status = await new TauriTransport().poolStatus().catch(() => null);
	return new Set(status?.tabs ?? []);
}
