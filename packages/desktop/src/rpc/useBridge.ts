/**
 * React binding for `RpcBridge`.
 *
 * `agent_start` is idempotent on the Rust side — a second call for the same tab
 * swaps in the fresh Channel and returns the live pid — which is what makes
 * StrictMode's double-mount and HMR reloads safe. That is also why the effect
 * cleanup deliberately does NOT kill the process: in StrictMode the sequence is
 * mount → spawn → cleanup → remount, and killing there would leave a dead tab.
 * Killing is an explicit user action plus the Rust window/exit hooks.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { type BridgeSnapshot, RpcBridge, type RpcBridgeOptions } from "./bridge";
import { isTauri, TauriTransport, type Transport } from "./transport";

export interface UseBridgeResult {
	bridge: RpcBridge;
	snapshot: BridgeSnapshot;
	/** Re-spawn after a crash and replay the session. */
	restart(): Promise<void>;
}

export function useBridge(
	tabId: string,
	options: {
		transport?: Transport;
		sessionPath?: string;
		cwd?: string;
		/** Spawn the sidecar. Pass false for a session nobody is looking at. */
		autoStart?: boolean;
	} & RpcBridgeOptions = {},
): UseBridgeResult {
	const { transport: injected, sessionPath, cwd, autoStart = true, ...bridgeOptions } = options;

	// Keep callbacks fresh without re-creating the bridge on every render.
	const optionsRef = useRef(bridgeOptions);
	optionsRef.current = bridgeOptions;

	const bridge = useMemo(() => {
		const transport = injected ?? new TauriTransport();
		return new RpcBridge(tabId, transport, {
			onNotice: request => optionsRef.current.onNotice?.(request),
			onOpenUrl: (url, instructions, launchUrl) => optionsRef.current.onOpenUrl?.(url, instructions, launchUrl),
			stallAfterMs: optionsRef.current.stallAfterMs,
		});
	}, [tabId, injected]);

	const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);

	const boot = useCallback(async () => {
		if (!isTauri() && !injected) return; // browser preview: nothing to spawn
		const handle = await bridge.start(cwd);
		// Run these on a resumed process too, not just a fresh one. The *process*
		// already answered them once, but this `RpcBridge` is a new object with an
		// empty TranscriptModel, no session state and no command list — and it is
		// new precisely because a reload or a remount discarded the old one. Gating
		// on `!handle.resumed` left a re-attached tab blank and, since the `ready`
		// frame is never re-sent either, permanently "starting". All four are
		// idempotent queries, so repeating them costs a round trip and nothing else.
		await bridge.getState().catch(() => {});
		await bridge.getAvailableCommands().catch(() => {});
		await bridge.setSubagentSubscription("events").catch(() => {});
		// switchSession pulls the history itself; a tab with no session file is
		// a fresh one and has none.
		if (sessionPath) await bridge.switchSession(sessionPath).catch(() => {});
		/*
		 * A re-attached process, on the other hand, has a conversation and no file
		 * to replay it from — the tab never knew one. Without this it renders "Ask
		 * the agent something to get started" over a live session, and the next
		 * thing typed lands in a transcript nobody can see.
		 *
		 * A tab id is unique per chat now, so this should only happen when a
		 * webview reload finds its sidecars still in the Rust pool. Belt and
		 * braces: silence is the failure mode that hid this for hours.
		 */ else if (handle?.resumed) await bridge.loadHistory().catch(() => {});
		// Last, and only now: `switch_session` aborts the session, which takes any
		// `bash` already in flight with it. The panels watch this rather than
		// `status`, so their first git command is not the one that gets killed.
		bridge.markBooted();
	}, [bridge, injected, sessionPath, cwd]);

	// Start only what someone is looking at. Sessions stay open forever, so
	// booting every one on mount would spawn a sidecar per session — each ~4s —
	// and they would evict one another before any of them was useful.
	useEffect(() => {
		if (!autoStart) return;
		void boot().catch(() => {
			// Surfaced through snapshot.error — RpcBridge.start sets it before it
			// rethrows, so there is nothing left to report from here.
		});
		// No kill on cleanup — see the note at the top of this file.
	}, [autoStart, boot]);

	const restart = useCallback(async () => {
		await bridge.stop().catch(() => {});
		await boot();
	}, [bridge, boot]);

	return { bridge, snapshot, restart };
}
