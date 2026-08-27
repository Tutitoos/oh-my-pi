import type { RpcBridge } from "../rpc/bridge";

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
