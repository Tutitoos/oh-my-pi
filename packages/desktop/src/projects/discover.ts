/**
 * Turns `omp sessions --json` into the sidebar's two-level tree.
 *
 * The grouping already exists on disk — `~/.omp/agent/sessions/` has one bucket
 * per working directory — but the bucket name is the path slugified with `-`,
 * which is ambiguous for any folder that contains a hyphen. `SessionInfo.cwd`
 * carries the real absolute path, and the CLI resolves `projectRoot` through
 * git's common-dir so a session started in a linked worktree groups under its
 * parent repo instead of appearing as a separate project.
 */

import type { SessionInfo } from "../rpc/protocol";

export interface SessionNode extends SessionInfo {
	projectName: string;
}

export interface WorktreeGroup {
	root: string;
	name: string;
	sessions: SessionNode[];
}

export interface ProjectNode {
	root: string;
	name: string;
	/** Sessions in the primary checkout. */
	sessions: SessionNode[];
	/** Sessions in linked worktrees, nested under this project. */
	worktrees: WorktreeGroup[];
	/** Everything under this project, for the header count. */
	total: number;
	/** Most recent activity anywhere in the project, for ordering. */
	modified: string;
}

/** Sessions whose `cwd` was never recorded (old sessions write an empty string). */
export const UNGROUPED = "(no project)";

export async function loadSessions(): Promise<SessionNode[]> {
	const { invoke } = await import("@tauri-apps/api/core");
	const raw = await invoke<string>("omp_cli", { args: ["sessions", "--json"] });
	const parsed = JSON.parse(raw) as SessionNode[];
	return Array.isArray(parsed) ? parsed : [];
}

export function buildProjects(sessions: readonly SessionNode[]): ProjectNode[] {
	const byRoot = new Map<string, ProjectNode>();

	for (const session of sessions) {
		const root = session.projectRoot || UNGROUPED;
		let project = byRoot.get(root);
		if (!project) {
			project = {
				root,
				name: session.projectName || basename(root),
				sessions: [],
				worktrees: [],
				total: 0,
				modified: session.modified,
			};
			byRoot.set(root, project);
		}

		if (session.isWorktree && session.cwd && session.cwd !== root) {
			let worktree = project.worktrees.find(w => w.root === session.cwd);
			if (!worktree) {
				worktree = { root: session.cwd, name: basename(session.cwd), sessions: [] };
				project.worktrees.push(worktree);
			}
			worktree.sessions.push(session);
		} else {
			project.sessions.push(session);
		}

		project.total += 1;
		if (session.modified > project.modified) project.modified = session.modified;
	}

	const projects = [...byRoot.values()];
	for (const project of projects) {
		project.sessions.sort(byModifiedDesc);
		project.worktrees.sort((a, b) => a.name.localeCompare(b.name));
		for (const worktree of project.worktrees) worktree.sessions.sort(byModifiedDesc);
	}

	// Most recently touched project first; the ungrouped bucket always last.
	return projects.sort((a, b) => {
		if (a.root === UNGROUPED) return 1;
		if (b.root === UNGROUPED) return -1;
		return b.modified.localeCompare(a.modified);
	});
}

/**
 * Incremental filter over what is already loaded — title, project and folder.
 *
 * Deliberately not full-text: `SessionInfo` does expose `allMessagesText`, but
 * obtaining it requires the full-content directory scan that `getRecentSessions`
 * avoids on purpose, described in its own comments as multi-hundred-ms with
 * thousands of sessions.
 */
export function filterProjects(projects: readonly ProjectNode[], query: string): ProjectNode[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...projects];

	const matches = (session: SessionNode, projectName: string): boolean =>
		(session.title ?? "").toLowerCase().includes(needle) ||
		session.firstMessage.toLowerCase().includes(needle) ||
		projectName.toLowerCase().includes(needle) ||
		session.cwd.toLowerCase().includes(needle);

	const result: ProjectNode[] = [];
	for (const project of projects) {
		const sessions = project.sessions.filter(s => matches(s, project.name));
		const worktrees = project.worktrees
			.map(w => ({ ...w, sessions: w.sessions.filter(s => matches(s, project.name)) }))
			.filter(w => w.sessions.length > 0);

		if (sessions.length || worktrees.length) {
			result.push({
				...project,
				sessions,
				worktrees,
				total: sessions.length + worktrees.reduce((n, w) => n + w.sessions.length, 0),
			});
		}
	}
	return result;
}

function byModifiedDesc(a: SessionNode, b: SessionNode): number {
	return b.modified.localeCompare(a.modified);
}

function basename(p: string): string {
	if (!p || p === UNGROUPED) return UNGROUPED;
	const parts = p.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] ?? p;
}
