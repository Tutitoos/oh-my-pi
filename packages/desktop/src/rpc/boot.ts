/**
 * The boot sequence a tab's process goes through, and the one fact a tab has to
 * remember across the processes that serve it.
 *
 * Lifted out of `useBridge` because every branch below decides whether
 * `switch_session` runs, and `switch_session` aborts the session. That is not a
 * decision to leave sealed inside a React hook, where nothing can reach it:
 * `test/session-boot.test.ts` drives this against a scripted transport.
 */

import type { RpcBridge } from "./bridge";

/**
 * Which session file each tab is on, keyed by tab id.
 *
 * A module rather than a field on `RpcBridge`, because it has to outlive one.
 * Leaving the session route unmounts every view, and coming back mints a fresh
 * bridge with an empty transcript and no state — so a bridge cannot be the thing
 * that remembers.
 *
 * Not every tab id is unique to one tab, which is why `forgetSession` exists: a
 * chat's is a UUID (`shell/ids.ts`), but a project's is `dir:<cwd>` and comes
 * back the moment that folder is opened again.
 */
const sessionFiles = new Map<string, string>();

/** Ignores an absent file: one `get_state` that omitted it must not erase this. */
export function rememberSession(tabId: string, sessionFile: string | undefined): void {
	if (sessionFile) sessionFiles.set(tabId, sessionFile);
}

export function rememberedSession(tabId: string): string | undefined {
	return sessionFiles.get(tabId);
}

/**
 * Forget a tab's session, for the one case that outlives the tab: the file was
 * deleted. `switch_session` does not fail on a path that is gone — the server
 * treats a missing file as a new session at that path and writes the header —
 * so a dead path left here would be handed to the next process a reused tab id
 * spawns, and the transcript the user deleted would come back as an empty one.
 */
export function forgetSession(tabId: string): void {
	sessionFiles.delete(tabId);
}

export interface ResumeInputs {
	/** The tab's replay instruction. Present only for a session opened from the list. */
	sessionPath?: string;
	/** Rust re-attached an existing process instead of spawning one. */
	resumed: boolean;
	/** The session this tab was last observed on, under an earlier process. */
	remembered?: string;
	/** The session the process is on now, by its own `get_state`. */
	current?: string;
}

/**
 * The session file a just-started process has to be pointed at, or null to leave
 * it where it is.
 *
 * `resumed` short-circuits everything, and that is the whole safety argument. A
 * re-attached process is the one this tab has been talking to all along, so
 * whatever session it is on is this tab's session — and switching would abort a
 * turn that is very likely running, since leaving the route and coming back
 * remounts the view and re-runs this sequence. A process that was *not* resumed
 * is a brand-new omp on a brand-new session, so nothing it is doing can be lost.
 *
 * `remembered` outranks `sessionPath`. `sessionPath` is fixed when the tab is
 * opened; `remembered` is where the tab was last actually seen. They agree until
 * the pool evicts the tab, and then only `remembered` knows anything at all: a
 * chat started in the app has no `sessionPath` — writing one would re-run this
 * boot on a live tab and abort it — so nothing pointed the respawned process at
 * the conversation on screen. It came back as a different, empty session under
 * the old transcript, and the next prompt went into another jsonl.
 */
export function resumeTarget({ sessionPath, resumed, remembered, current }: ResumeInputs): string | null {
	if (resumed) return null;
	if (remembered !== undefined && remembered !== current) return remembered;
	if (sessionPath !== undefined && sessionPath !== current) return sessionPath;
	return null;
}

/**
 * Boot steps report rather than vanish. Each is idempotent and non-fatal, so the
 * boot continues — but a swallowed failure here is how a tab ends up blank with
 * nothing anywhere saying why.
 *
 * It goes through the bridge's own error, not `console.warn`: the two steps that
 * use this are the ones that decide what the transcript shows, and a packaged
 * webview has no console anyone will ever open. A failed history reload over a
 * live session renders as a fresh empty chat, which is the one wrong answer the
 * user cannot tell from a right one.
 */
function reportBootFailure(bridge: RpcBridge, step: string) {
	return (cause: unknown): void => {
		console.warn(`omp: ${step} failed`, cause);
		bridge.reportError(new Error(`${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`));
	};
}

/** Bring this tab's process up, and put it on this tab's session. */
export async function bootSession(bridge: RpcBridge, options: { sessionPath?: string; cwd?: string }): Promise<void> {
	// Read before the spawn. The `get_state` below is answered by the new process
	// and describes whatever session it launched into — which is the thing this has
	// to be compared against, so reading it afterwards would compare a value with
	// itself and never switch.
	const remembered = rememberedSession(bridge.tabId);
	const handle = await bridge.start(options.cwd);
	// Run these on a resumed process too, not just a fresh one. The *process*
	// already answered them once, but this `RpcBridge` is a new object with an
	// empty TranscriptModel, no session state and no command list — and it is
	// new precisely because a reload or a remount discarded the old one. Gating
	// on `!handle.resumed` left a re-attached tab blank and, since the `ready`
	// frame is never re-sent either, permanently "starting". All four are
	// idempotent queries, so repeating them costs a round trip and nothing else.
	const state = await bridge.getState().catch(() => undefined);
	await bridge.getAvailableCommands().catch(() => {});
	await bridge.setSubagentSubscription("events").catch(() => {});

	const target = resumeTarget({
		sessionPath: options.sessionPath,
		resumed: handle?.resumed === true,
		remembered,
		current: state?.sessionFile,
	});
	if (target) {
		await bridge.switchSession(target).catch(reportBootFailure(bridge, "Opening this session"));
	} else if (handle?.resumed) {
		/*
		 * A re-attached process has a conversation and this bridge has an empty
		 * transcript, so it has to be re-read — otherwise the tab renders "Ask
		 * the agent something to get started" over a live session and the next
		 * thing typed lands where nobody can see it.
		 *
		 * `reloadMessages`, not `loadHistory`: the latter pages through
		 * `get_messages_page`, which the server refuses outright while the
		 * session is streaming or compacting (`session_busy`) — precisely the
		 * case this exists to cover. `get_messages` carries no such guard.
		 */
		await bridge.reloadMessages().catch(reportBootFailure(bridge, "Reloading this session's history"));
	}
	/*
	 * `target` even when the switch failed: the tab is on that session whatever
	 * the process managed to do, and recording the one it booted into instead
	 * would aim the next respawn at a throwaway.
	 */
	rememberSession(bridge.tabId, target ?? state?.sessionFile);
	// Last, and only now: `switch_session` aborts the session, which takes any
	// `bash` already in flight with it. The panels watch this rather than
	// `status`, so their first git command is not the one that gets killed.
	bridge.markBooted();
}
