import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useNavigate } from "react-router";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { ResizeHandle } from "./components/ResizeHandle";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import type { SessionNode } from "./projects/discover";
import { anyTabBusy, busyTabs, markViewed } from "./shell/activity";
import { useCloseGuard } from "./shell/useCloseGuard";
import { usePanelWidths } from "./shell/usePanelWidths";

export interface OpenTab {
	tabId: string;
	title: string;
	/** Session file to replay via `switch_session`; absent for a fresh session. */
	sessionPath?: string;
	/** Working directory for the sidecar. Fixed at spawn — see the Rust relay. */
	cwd?: string;
}

export interface ShellContext {
	/**
	 * Every session opened this run. Nothing closes them: the sidebar is the
	 * session list, and Rust reclaims background processes on its own once more
	 * than `MAX_LIVE_SESSIONS` are live.
	 */
	tabs: readonly OpenTab[];
	activeTabId: string;
	panelOpen: boolean;
}

const SCRATCH: OpenTab = { tabId: "scratch", title: "New session" };

export function App() {
	const navigate = useNavigate();
	const [tabs, setTabs] = useState<OpenTab[]>([SCRATCH]);
	const [activeTabId, setActiveTabId] = useState(SCRATCH.tabId);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [panelOpen, setPanelOpen] = useState(true);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [closePrompt, setClosePrompt] = useState<((confirmed: boolean) => void) | null>(null);
	const widths = usePanelWidths({ sidebarOpen, panelOpen });

	const activeTab = tabs.find(tab => tab.tabId === activeTabId) ?? tabs[0];

	const activate = useCallback((tabId: string) => {
		setActiveTabId(tabId);
		markViewed(tabId); // clears the unread "finished" mark
	}, []);

	const openTab = useCallback(
		(tab: OpenTab) => {
			// One entry per session id: re-opening a session re-attaches to its live
			// process rather than spawning a second one, and opening a new session
			// never closes the one you were in.
			setTabs(current => (current.some(t => t.tabId === tab.tabId) ? current : [...current, tab]));
			activate(tab.tabId);
			void navigate("/");
		},
		[activate, navigate],
	);

	const openSession = useCallback(
		(session: SessionNode) =>
			openTab({
				tabId: session.id,
				sessionPath: session.path,
				cwd: session.cwd || undefined,
				title: session.title || session.firstMessage.slice(0, 40) || session.id.slice(0, 8),
			}),
		[openTab],
	);

	const newTab = useCallback(
		(cwd?: string) => {
			// A stable id per directory keeps "add the same folder twice" from
			// stacking duplicate tabs and duplicate sidecars.
			const tabId = cwd ? `dir:${cwd}` : `new:${tabs.length}:${activeTabId}`;
			openTab({ tabId, cwd, title: cwd ? baseName(cwd) : "New session" });
		},
		[activeTabId, openTab, tabs.length],
	);

	const actions: PaletteAction[] = useMemo(
		() => [
			{ id: "new", label: "New session", hint: "⌘T", run: () => newTab() },
			{ id: "settings", label: "Settings", hint: "⌘,", run: () => void navigate("/manage") },
			{ id: "providers", label: "Connect a provider", run: () => void navigate("/onboarding") },
			{ id: "probe", label: "Protocol probe", run: () => void navigate("/probe") },
			{
				id: "sidebar",
				label: sidebarOpen ? "Hide sessions" : "Show sessions",
				hint: "⌘B",
				run: () => setSidebarOpen(open => !open),
			},
			{
				id: "panel",
				label: panelOpen ? "Hide side panel" : "Show side panel",
				hint: "⌘⌥B",
				run: () => setPanelOpen(open => !open),
			},
		],
		[navigate, newTab, panelOpen, sidebarOpen],
	);

	// Desktop conventions rather than omp's terminal keybindings: those are built
	// for a TTY and collide with what a native app is expected to do.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const mod = event.metaKey || event.ctrlKey;
			if (!mod) return;
			const key = event.key.toLowerCase();

			if (key === "b") {
				event.preventDefault();
				if (event.altKey) setPanelOpen(open => !open);
				else setSidebarOpen(open => !open);
			} else if (key === "k") {
				event.preventDefault();
				setPaletteOpen(open => !open);
			} else if (key === "t" || key === "n") {
				event.preventDefault();
				newTab();
			} else if (key === ",") {
				event.preventDefault();
				void navigate("/manage");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [navigate, newTab]);

	// Closing mid-turn loses only the turn in flight — the transcript is already
	// on disk — but that turn can be a lot of work.
	useCloseGuard(
		anyTabBusy,
		useCallback(() => new Promise<boolean>(resolve => setClosePrompt(() => resolve)), []),
	);

	const context: ShellContext = {
		tabs,
		activeTabId: activeTab?.tabId ?? SCRATCH.tabId,
		panelOpen,
	};

	return (
		<div
			className="omp-shell"
			data-panel={panelOpen}
			data-sidebar={sidebarOpen}
			/*
			 * The grid reads its side columns from these, so a drag is one custom
			 * property away from the layout instead of a re-render of the tracks.
			 */
			style={{ "--omp-sidebar-w": `${widths.sidebar}px`, "--omp-panel-w": `${widths.panel}px` } as CSSProperties}
		>
			<TitleBar
				sidebarOpen={sidebarOpen}
				panelOpen={panelOpen}
				project={activeTab?.cwd ? baseName(activeTab.cwd) : undefined}
				title={activeTab?.title ?? SCRATCH.title}
				onToggleSidebar={() => setSidebarOpen(open => !open)}
				onTogglePanel={() => setPanelOpen(open => !open)}
				onNewSession={() => newTab()}
				onAddProject={newTab}
			/>

			{/*
			 * The columns. The title bar is a row above them, so the grid that used
			 * to live on `.omp-shell` moved down here unchanged — same tracks, same
			 * four sidebar/panel combinations, just no longer sharing a box with the
			 * area macOS draws its traffic lights over.
			 */}
			<div className="omp-shell__body">
				{sidebarOpen ? <Sidebar activeSessionPath={activeTab?.sessionPath} onOpenSession={openSession} /> : null}

				<Outlet context={context} />

				{/*
				 * Floating over the column boundary rather than sitting in the grid as
				 * a track of its own: a real track would have to be added and removed
				 * with each panel, and every one of the four column declarations would
				 * have to agree about it.
				 */}
				{sidebarOpen ? (
					<ResizeHandle
						side="left"
						width={widths.sidebar}
						label="Resize the session list"
						onResize={widths.setSidebar}
						onReset={widths.resetSidebar}
					/>
				) : null}

				{panelOpen ? (
					<ResizeHandle
						side="right"
						width={widths.panel}
						label="Resize the side panel"
						onResize={widths.setPanel}
						onReset={widths.resetPanel}
					/>
				) : null}
			</div>

			<CommandPalette actions={actions} open={paletteOpen} onClose={() => setPaletteOpen(false)} />

			{closePrompt ? (
				<div className="omp-backdrop" role="dialog" aria-modal="true" aria-label="Quit omp Desktop">
					<div className="omp-modal">
						<h2 className="omp-modal__title">An agent is still working</h2>
						<p className="omp-modal__message">
							{busyTabs().length === 1
								? "One session is mid-turn."
								: `${busyTabs().length} sessions are mid-turn.`}{" "}
							Transcripts are saved continuously, so only the turn in flight is lost.
						</p>
						<div className="omp-modal__actions">
							<button
								type="button"
								data-component="button"
								data-variant="ghost"
								data-size="normal"
								onClick={() => {
									closePrompt(false);
									setClosePrompt(null);
								}}
							>
								Keep working
							</button>
							<button
								type="button"
								data-component="button"
								data-variant="primary"
								data-size="normal"
								onClick={() => {
									closePrompt(true);
									setClosePrompt(null);
								}}
							>
								Quit anyway
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

function baseName(directory: string): string {
	const parts = directory.split(/[/\\]/).filter(Boolean);
	return parts.at(-1) ?? directory;
}
