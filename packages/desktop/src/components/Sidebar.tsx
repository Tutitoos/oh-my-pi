import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { buildProjects, filterProjects, loadSessions, type ProjectNode, type SessionNode } from "../projects/discover";
import { isTauri } from "../rpc/transport";
import { getSnapshot, subscribe, type TabState } from "../shell/activity";

export function Sidebar({
	activeSessionPath,
	onOpenSession,
}: {
	activeSessionPath?: string;
	onOpenSession(session: SessionNode): void;
}) {
	const [sessions, setSessions] = useState<SessionNode[]>([]);
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const states = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	useEffect(() => {
		if (!isTauri()) return;
		loadSessions()
			.then(setSessions)
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	}, []);

	const projects = useMemo(() => filterProjects(buildProjects(sessions), query), [sessions, query]);

	// A search should reveal what it matched, not hide it behind a collapsed row.
	const effectiveCollapsed = query.trim() ? new Set<string>() : collapsed;

	return (
		<aside className="omp-sidebar">
			{/* The header moved to the title bar, so the filter is the column's top. */}
			<div className="omp-sidebar__filter">
				<input
					className="omp-filter"
					type="search"
					placeholder="Filter sessions…"
					value={query}
					onChange={event => setQuery(event.target.value)}
				/>
			</div>

			<div className="omp-sidebar__scroll">
				{error ? <div className="omp-banner omp-banner--error">{error}</div> : null}

				{projects.length === 0 ? (
					<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
						{sessions.length === 0 ? "No sessions yet." : "Nothing matches."}
					</div>
				) : null}

				{projects.map(project => (
					<ProjectRow
						key={project.root}
						project={project}
						collapsed={effectiveCollapsed.has(project.root)}
						activeSessionPath={activeSessionPath}
						states={states}
						onToggle={() =>
							setCollapsed(current => {
								const next = new Set(current);
								if (!next.delete(project.root)) next.add(project.root);
								return next;
							})
						}
						onOpenSession={onOpenSession}
					/>
				))}
			</div>
		</aside>
	);
}

function ProjectRow({
	project,
	collapsed,
	activeSessionPath,
	states,
	onToggle,
	onOpenSession,
}: {
	project: ProjectNode;
	collapsed: boolean;
	activeSessionPath?: string;
	states: ReadonlyMap<string, TabState>;
	onToggle(): void;
	onOpenSession(session: SessionNode): void;
}) {
	return (
		<div className="omp-project">
			<button className="omp-project__head" type="button" onClick={onToggle} title={project.root}>
				<span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
				<span className="omp-project__name">{project.name}</span>
				<span className="omp-project__count">{project.total}</span>
			</button>

			{collapsed ? null : (
				<>
					{project.sessions.map(session => (
						<SessionRow
							key={session.path}
							session={session}
							active={session.path === activeSessionPath}
							state={states.get(session.id) ?? "idle"}
							onOpen={onOpenSession}
						/>
					))}

					{project.worktrees.map(worktree => (
						<div key={worktree.root}>
							{/* A sub-heading, not a row you can open — it was styled as a session,
							    which promised a click it never honoured. */}
							<div className="omp-worktree" title={worktree.root}>
								<span aria-hidden="true">↳</span>
								<span className="omp-worktree__name">{worktree.name}</span>
							</div>
							{worktree.sessions.map(session => (
								<SessionRow
									key={session.path}
									session={session}
									active={session.path === activeSessionPath}
									worktree
									state={states.get(session.id) ?? "idle"}
									onOpen={onOpenSession}
								/>
							))}
						</div>
					))}
				</>
			)}
		</div>
	);
}

function SessionRow({
	session,
	active,
	worktree,
	state,
	onOpen,
}: {
	session: SessionNode;
	active: boolean;
	worktree?: boolean;
	/** Live state of the session, not the status recorded on disk. */
	state: TabState;
	onOpen(session: SessionNode): void;
}) {
	const label = session.title || session.firstMessage.slice(0, 60) || session.id.slice(0, 8);
	const age = shortAge(session.modified);
	return (
		<button
			className={`omp-session${worktree ? " omp-session--worktree" : ""}`}
			type="button"
			aria-current={active}
			title={`${label}\n${session.messageCount} messages · ${STATE_LABEL[state]}`}
			onClick={() => onOpen(session)}
		>
			<span className={`omp-dot omp-dot--${state}`} aria-label={STATE_LABEL[state]} />
			<span className="omp-session__title">{label}</span>
			{/*
			 * Titles repeat — three sessions called "hola" is normal — and nothing on
			 * the row told them apart. This is the cheapest thing that does, and it
			 * fills the dead space on the right instead of taking room from the title.
			 */}
			{age ? <span className="omp-session__age">{age}</span> : null}
		</button>
	);
}

/** Coarse on purpose: a disambiguator, not a clock. */
export function shortAge(modified: string): string {
	const then = Date.parse(modified);
	if (!Number.isFinite(then)) return "";
	const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d`;
	const weeks = Math.round(days / 7);
	if (weeks < 5) return `${weeks}w`;
	return `${Math.round(days / 30)}mo`;
}

const STATE_LABEL: Record<TabState, string> = {
	working: "working",
	attention: "needs your attention",
	done: "finished",
	idle: "idle",
};
