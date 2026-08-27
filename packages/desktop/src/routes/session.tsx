import { useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import type { OpenTab, ShellContext } from "../app";
import { ApprovalDialog } from "../components/ApprovalDialog";
import { ApprovalModeBadge } from "../components/ApprovalModeBadge";
import { Composer } from "../components/Composer";
import { ComposerModal } from "../components/composer/ComposerModal";
import { useComposerDraft } from "../components/composer/useComposerDraft";
import { ModelPicker } from "../components/ModelPicker";
import { RightPanel } from "../components/RightPanel";
import { StatusBar } from "../components/StatusBar";
import { Transcript } from "../components/Transcript";
import { isTauri, onWindowDrop } from "../rpc/transport";
import { useBridge } from "../rpc/useBridge";
import { setTabActivity } from "../shell/activity";
import { notifyApprovalPending, notifyTurnComplete } from "../shell/notifications";

/**
 * Every open tab is rendered, not just the visible one.
 *
 * Hiding rather than unmounting is deliberate: a background tab's bridge has to
 * keep consuming its stream, or a turn started in one tab would stall the moment
 * you looked at another. The Rust pool bounds the cost — at most three sidecars
 * live at once, LRU-evicted — so "all tabs mounted" is not "all tabs resident".
 */
export function SessionRoute() {
	const { tabs, activeTabId, panelOpen } = useOutletContext<ShellContext>();

	return (
		<>
			{tabs.map(tab => (
				<SessionView key={tab.tabId} tab={tab} visible={tab.tabId === activeTabId} panelOpen={panelOpen} />
			))}
		</>
	);
}

function SessionView({ tab, visible, panelOpen }: { tab: OpenTab; visible: boolean; panelOpen: boolean }) {
	// A session boots the first time it is looked at and stays running after
	// that, so switching away does not tear it down mid-turn.
	const started = useRef(false);
	if (visible) started.current = true;

	const { bridge, snapshot, restart } = useBridge(tab.tabId, {
		autoStart: started.current,
		sessionPath: tab.sessionPath,
		cwd: tab.cwd,
		onOpenUrl: async url => {
			const { openUrl } = await import("@tauri-apps/plugin-opener");
			await openUrl(url);
		},
	});

	const streaming = snapshot.state?.isStreaming === true;
	const failed = snapshot.status === "exited" || snapshot.status === "error";
	/*
	 * Coming up, with nothing to read yet. Previously the transcript's "Ask the
	 * agent something to get started." rendered right below the "Starting the
	 * agent…" banner: one told you to wait, the other to type, and the composer
	 * honoured the second — `agent_send` rejects with "no live session", the
	 * draft is cleared before the send, and the message is gone with no trace.
	 *
	 * Entries already on screen keep the transcript: content never disappears
	 * behind a spinner.
	 */
	const booting = snapshot.status === "starting" && snapshot.transcript.length === 0;
	const [cost, setCost] = useState<number | undefined>(undefined);

	// One draft per session, owned here so the inline row and the expanded modal
	// edit the same text rather than each keeping a copy.
	const composer = useComposerDraft({ bridge, commands: snapshot.commands, streaming });
	// One condition, read by both the row and the overlay, so they can never
	// disagree about whether the expanded editor exists.
	const modalOpen = visible && composer.expanded && !snapshot.pendingUi;

	// Publish what this session is doing: the sidebar is the only place it shows,
	// and the close guard reads the same store.
	useEffect(() => {
		setTabActivity(tab.tabId, { streaming, attention: Boolean(snapshot.pendingUi) });
	}, [tab.tabId, streaming, snapshot.pendingUi]);

	// Deliberately no cleanup: a session stays in the store while it is open, and
	// nothing closes sessions any more.

	// Notify only on the falling edge: entering idle is the moment worth
	// interrupting someone, not every render where streaming happens to be false.
	// The same edge refreshes the cost, which lives in `get_session_stats` rather
	// than the session state and is not worth polling for mid-turn.
	const wasStreaming = useRef(false);
	useEffect(() => {
		if (wasStreaming.current && !streaming) {
			notifyTurnComplete(snapshot.state?.model?.id);
			void bridge
				.getSessionStats()
				.then(stats => setCost(typeof stats?.cost === "number" ? stats.cost : undefined))
				.catch(() => {});
		}
		wasStreaming.current = streaming;
	}, [streaming, snapshot.state?.model?.id, bridge]);

	const pendingUiId = snapshot.pendingUi?.id;
	useEffect(() => {
		if (pendingUiId) notifyApprovalPending("The agent is waiting for your approval.");
	}, [pendingUiId]);

	// The pool reclaims background processes by design. Resume on the way back in,
	// rather than leaving a session that silently accepts nothing.
	useEffect(() => {
		if (visible && snapshot.status === "suspended") void restart().catch(() => {});
	}, [visible, snapshot.status, restart]);

	/*
	 * Window drops belong to Tauri, not to the webview.
	 *
	 * `dragDropEnabled` defaults to true, which switches the webview's own HTML5
	 * drag-and-drop off — so the composer's `onDrop` never fired in the packaged
	 * app, and dragging a file onto the window did nothing at all. Tauri reports
	 * paths instead, at window scope, so this listener belongs to whichever
	 * session is on screen rather than to any one element.
	 */
	useEffect(() => {
		if (!visible || !isTauri()) return;
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void onWindowDrop({
			over: () => composer.setDropping(true),
			leave: () => composer.setDropping(false),
			drop: paths => {
				composer.setDropping(false);
				void composer.addDroppedPaths(paths);
			},
		}).then(stop => {
			if (cancelled) stop();
			else unlisten = stop;
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [visible, composer.setDropping, composer.addDroppedPaths]);

	// Esc aborts the turn — but only in the tab you are looking at, and not while
	// a dialog owns the key.
	useEffect(() => {
		if (!visible) return;
		const onKey = (event: KeyboardEvent) => {
			// `defaultPrevented` is how an overlay claims the key. React's
			// `stopPropagation` cannot help here: React dispatches at its root
			// container and the native event still reaches `window`. Without this,
			// closing the ⌘K palette or the model menu mid-turn also killed the turn.
			if (event.key !== "Escape" || !streaming || snapshot.pendingUi || event.defaultPrevented) return;
			event.preventDefault();
			void bridge.abort().catch(() => {});
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [bridge, streaming, snapshot.pendingUi, visible]);

	return (
		<>
			<main className="omp-main" hidden={!visible}>
				{/*
				 * One wrapper, so `.omp-main` always has exactly three children. The
				 * grid is `auto 1fr auto`; with four independent conditionals the row a
				 * child landed in depended on how many banners happened to be up, and
				 * the first one took the flexible row and stretched to fill the pane.
				 */}
				<div className="omp-main__banners">
					{snapshot.status === "exited" ? (
						<div className="omp-banner omp-banner--error">
							<span>
								The agent process exited
								{snapshot.exit?.code !== null && snapshot.exit !== null ? ` (code ${snapshot.exit.code})` : ""}.
								Its transcript is safe on disk.
							</span>
							<button
								type="button"
								data-component="button"
								data-variant="primary"
								data-size="normal"
								onClick={() => void restart()}
							>
								Restart
							</button>
						</div>
					) : null}

					{snapshot.status === "suspended" && visible ? (
						<div className="omp-banner omp-banner--info">Resuming this session…</div>
					) : null}

					{snapshot.status === "error" && snapshot.error ? (
						<div className="omp-banner omp-banner--error">{snapshot.error}</div>
					) : null}

					{/*
					 * The reason it died, next to the fact that it died. This is captured
					 * on every session but used to be rendered only by the probe route,
					 * which runs its own separate sidecar — so it never showed the output
					 * of the session that actually failed.
					 */}
					{failed && snapshot.stderr.length > 0 ? (
						<pre className="omp-stall__log">{snapshot.stderr.join("\n")}</pre>
					) : null}
				</div>

				{booting ? (
					<div className="omp-transcript">
						<div className="omp-empty">
							{snapshot.stalled ? (
								<div className="omp-stall">
									<span>
										The agent has not answered yet. It may still be coming up, or it may have failed to start.
									</span>
									{snapshot.stderr.length > 0 ? (
										<pre className="omp-stall__log">{snapshot.stderr.join("\n")}</pre>
									) : null}
									<button
										type="button"
										data-component="button"
										data-variant="primary"
										data-size="normal"
										onClick={() => void restart()}
									>
										Restart
									</button>
								</div>
							) : (
								"Starting the agent… first launch takes a few seconds."
							)}
						</div>
					</div>
				) : (
					<Transcript entries={snapshot.transcript} streaming={streaming} />
				)}

				<div>
					<Composer bridge={bridge} composer={composer} modalOpen={modalOpen} disabled={booting} />
					<div className="omp-statusbar__wrap">
						<StatusBar snapshot={snapshot} bridge={bridge} cwd={tab.cwd} cost={cost}>
							<ModelPicker bridge={bridge} state={snapshot.state} />
							<ApprovalModeBadge />
						</StatusBar>
					</div>
				</div>
			</main>

			{visible && panelOpen ? (
				<RightPanel
					bridge={bridge}
					ready={snapshot.status === "ready"}
					todoPhases={snapshot.state?.todoPhases ?? []}
					subagentCount={snapshot.subagents.length}
				/>
			) : null}

			{/*
			 * Sibling of `<main>`, never a portal — a portal would escape the
			 * `hidden` that keeps background sessions off screen, and every one of
			 * them would paint its modal over this one. `!pendingUi` keeps it from
			 * fighting the approval dialog for Escape; the draft survives either way
			 * because it lives in the hook, not in the modal.
			 */}
			{modalOpen ? <ComposerModal composer={composer} /> : null}

			{visible && snapshot.pendingUi ? <ApprovalDialog request={snapshot.pendingUi} bridge={bridge} /> : null}
		</>
	);
}
