/**
 * Session listing for external hosts.
 *
 * `listAllSessions()` has always had everything a session picker needs — `cwd`,
 * `title`, `messageCount`, `modified` and a coarse `SessionStatus` — but no
 * command exposed it, so its only consumer was `gc-cli`. A GUI would otherwise
 * have to reimplement the on-disk parse and drift from it.
 *
 * Two fields are resolved here rather than by the caller, because the git
 * helpers already live in this package: `projectRoot` (the primary checkout, so
 * a session started inside a linked worktree groups under its real repo) and
 * `isWorktree`. Both come from pure on-disk walking, no subprocess.
 */

import * as path from "node:path";
import { listAllSessions, type SessionInfo } from "../session/session-listing";
import { repo } from "../utils/git";

export interface SessionListEntry {
	path: string;
	id: string;
	cwd: string;
	title?: string;
	created: string;
	modified: string;
	messageCount: number;
	size: number;
	firstMessage: string;
	status?: SessionInfo["status"];
	/** Primary checkout when `cwd` is a linked worktree; otherwise `cwd`. */
	projectRoot: string;
	isWorktree: boolean;
	/** Display name for the project — the folder's basename. */
	projectName: string;
}

export interface SessionsCommandFlags {
	json: boolean;
	limit?: number;
	project?: string;
}

/**
 * Resolve project grouping for a session's working directory.
 *
 * Cached per directory: a project with fifty sessions would otherwise repeat
 * the same `.git` walk fifty times.
 */
function makeProjectResolver() {
	const cache = new Map<string, { projectRoot: string; isWorktree: boolean }>();

	return (cwd: string): { projectRoot: string; isWorktree: boolean } => {
		if (!cwd) return { projectRoot: "", isWorktree: false };

		const cached = cache.get(cwd);
		if (cached) return cached;

		let resolved: { projectRoot: string; isWorktree: boolean };
		try {
			const linked = repo.linkedWorktreeSync(cwd);
			if (linked) {
				resolved = { projectRoot: linked.primaryRoot, isWorktree: true };
			} else {
				resolved = { projectRoot: repo.primaryRootSync(cwd) ?? cwd, isWorktree: false };
			}
		} catch {
			// A deleted or unreadable directory is not an error here — the session
			// still exists and should still be listed, just ungrouped.
			resolved = { projectRoot: cwd, isWorktree: false };
		}

		cache.set(cwd, resolved);
		return resolved;
	};
}

export async function collectSessions(flags: SessionsCommandFlags): Promise<SessionListEntry[]> {
	const sessions = await listAllSessions();
	const resolveProject = makeProjectResolver();

	let entries = sessions.map((session): SessionListEntry => {
		const { projectRoot, isWorktree } = resolveProject(session.cwd);
		return {
			path: session.path,
			id: session.id,
			cwd: session.cwd,
			title: session.title,
			created: session.created.toISOString(),
			modified: session.modified.toISOString(),
			messageCount: session.messageCount,
			size: session.size,
			firstMessage: session.firstMessage,
			status: session.status,
			projectRoot,
			isWorktree,
			projectName: projectRoot ? path.basename(projectRoot) : "(no project)",
		};
	});

	if (flags.project) {
		const wanted = path.resolve(flags.project);
		entries = entries.filter(entry => entry.projectRoot === wanted || entry.cwd === wanted);
	}

	if (flags.limit && flags.limit > 0) entries = entries.slice(0, flags.limit);

	return entries;
}

/** Human-readable listing, grouped the way a session picker would show it. */
export function formatSessions(entries: SessionListEntry[]): string {
	if (entries.length === 0) return "No sessions found.";

	const groups = new Map<string, SessionListEntry[]>();
	for (const entry of entries) {
		const key = entry.projectRoot || "(no project)";
		const bucket = groups.get(key);
		if (bucket) bucket.push(entry);
		else groups.set(key, [entry]);
	}

	const lines: string[] = [];
	for (const [projectRoot, sessions] of groups) {
		lines.push(`${projectRoot}  (${sessions.length})`);
		for (const session of sessions) {
			const title = session.title || session.firstMessage.slice(0, 60) || session.id;
			const marker = session.isWorktree ? "  ↳" : "  ·";
			lines.push(
				`${marker} ${session.modified.slice(0, 16).replace("T", " ")}  ` +
					`${(session.status ?? "unknown").padEnd(11)} ` +
					`${String(session.messageCount).padStart(4)} msg  ${title}`,
			);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
