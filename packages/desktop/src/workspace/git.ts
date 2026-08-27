/**
 * Workspace inspection through the agent's own shell.
 *
 * Everything here runs via `bash` over RPC rather than spawning git from Rust.
 * Two reasons: the sidecar already has the session's working directory, so there
 * is no cwd to resolve or keep in sync; and `bash` is dispatched concurrently by
 * the RPC server, so a `git diff` never blocks a streaming turn.
 *
 * Commands are pinned with `-c core.pager=cat` and `--no-color` so a user's
 * global git config cannot inject pager escapes or ANSI into what we parse.
 */

import type { RpcBridge } from "../rpc/bridge";

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	truncated: boolean;
	workingDir?: string;
}

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "unknown";

export interface ChangedFile {
	path: string;
	/** Previous path for renames. */
	from?: string;
	status: ChangeStatus;
	staged: boolean;
	additions: number;
	deletions: number;
}

export interface DiffLine {
	kind: "add" | "del" | "ctx" | "meta";
	text: string;
	oldNo?: number;
	newNo?: number;
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export interface FileDiff {
	path: string;
	from?: string;
	binary: boolean;
	hunks: DiffHunk[];
}

async function run(bridge: RpcBridge, command: string): Promise<BashResult> {
	return (await bridge.bash(command)) as BashResult;
}

const GIT = "git -c core.pager=cat --no-optional-locks";

export async function isRepository(bridge: RpcBridge): Promise<boolean> {
	const result = await run(bridge, `${GIT} rev-parse --is-inside-work-tree 2>/dev/null`);
	return result.output.trim() === "true";
}

/**
 * Changed files with per-file line counts.
 *
 * `--porcelain=v1 -z` is the stable machine format: NUL-separated, so paths with
 * spaces, quotes or newlines survive intact. Renames emit two NUL-terminated
 * entries (new path, then old).
 */
export async function changedFiles(bridge: RpcBridge): Promise<ChangedFile[]> {
	const [statusResult, numstatResult] = await Promise.all([
		run(bridge, `${GIT} status --porcelain=v1 -z --untracked-files=all`),
		run(bridge, `${GIT} diff HEAD --numstat --no-color -z`),
	]);

	const counts = parseNumstat(numstatResult.output);
	const files: ChangedFile[] = [];

	for (const entry of splitStatus(statusResult.output)) {
		const count = counts.get(entry.path) ?? { additions: 0, deletions: 0 };
		files.push({ ...entry, ...count });
	}

	return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Unified diff for one file, or the whole tree when `path` is omitted. */
export async function fileDiff(bridge: RpcBridge, path?: string): Promise<FileDiff[]> {
	const target = path ? ` -- ${shellQuote(path)}` : "";
	// `--no-ext-diff` keeps a configured external difftool from replacing the
	// unified format we parse.
	const result = await run(bridge, `${GIT} diff HEAD --no-color --no-ext-diff --unified=3${target}`);
	const diffs = parseUnifiedDiff(result.output);

	// Untracked files never appear in `git diff`; show their contents as additions.
	if (path && diffs.length === 0) {
		const untracked = await run(bridge, `${GIT} ls-files --others --exclude-standard -- ${shellQuote(path)}`);
		if (untracked.output.trim()) {
			const body = await run(bridge, `cat ${shellQuote(path)}`);
			return [
				{
					path,
					binary: false,
					hunks: [
						{
							header: "@@ new file @@",
							lines: body.output.split("\n").map((text, index) => ({
								kind: "add" as const,
								text,
								newNo: index + 1,
							})),
						},
					],
				},
			];
		}
	}

	return diffs;
}

/** Tracked + untracked paths, for the file tree. */
export async function listFiles(bridge: RpcBridge, limit = 5000): Promise<string[]> {
	const result = await run(bridge, `${GIT} ls-files --cached --others --exclude-standard -z | head -c 2000000`);
	return result.output.split("\0").filter(Boolean).slice(0, limit).sort();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `XY <path>\0` records, with renames adding a second `<oldPath>\0`. */
function splitStatus(raw: string): Array<Omit<ChangedFile, "additions" | "deletions">> {
	const parts = raw.split("\0");
	const out: Array<Omit<ChangedFile, "additions" | "deletions">> = [];

	for (let i = 0; i < parts.length; i++) {
		const record = parts[i];
		if (record.length < 4) continue;

		const index = record[0];
		const worktree = record[1];
		const path = record.slice(3);
		const isRename = index === "R" || index === "C";

		out.push({
			path,
			from: isRename ? parts[++i] : undefined,
			status: statusOf(index, worktree),
			staged: index !== " " && index !== "?",
		});
	}
	return out;
}

function statusOf(index: string, worktree: string): ChangeStatus {
	if (index === "?" || worktree === "?") return "untracked";
	const code = index !== " " ? index : worktree;
	switch (code) {
		case "M":
			return "modified";
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
		case "C":
			return "renamed";
		default:
			return "unknown";
	}
}

/** `-z` numstat is `adds\tdels\t<path>\0`, and `-` means binary. */
function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
	const counts = new Map<string, { additions: number; deletions: number }>();
	for (const record of raw.split("\0")) {
		if (!record.trim()) continue;
		const [adds, dels, ...rest] = record.split("\t");
		const path = rest.join("\t");
		if (!path) continue;
		counts.set(path, {
			additions: adds === "-" ? 0 : Number(adds) || 0,
			deletions: dels === "-" ? 0 : Number(dels) || 0,
		});
	}
	return counts;
}

export function parseUnifiedDiff(raw: string): FileDiff[] {
	const files: FileDiff[] = [];
	let current: FileDiff | null = null;
	let hunk: DiffHunk | null = null;
	let oldNo = 0;
	let newNo = 0;

	// git diff output ends with a newline, so the split leaves a trailing empty
	// segment. Left in, it renders as a phantom context line at the end of the
	// last hunk and shifts the line numbers after it.
	const lines = raw.split("\n");
	if (lines.at(-1) === "") lines.pop();

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			current = { path: pathFromDiffHeader(line), binary: false, hunks: [] };
			files.push(current);
			hunk = null;
			continue;
		}
		if (!current) continue;

		if (line.startsWith("Binary files ")) {
			current.binary = true;
			continue;
		}
		if (line.startsWith("rename from ")) {
			current.from = line.slice("rename from ".length);
			continue;
		}
		if (line.startsWith("+++ b/")) {
			current.path = line.slice("+++ b/".length);
			continue;
		}
		if (line.startsWith("@@")) {
			const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			oldNo = match ? Number(match[1]) : 0;
			newNo = match ? Number(match[2]) : 0;
			hunk = { header: line, lines: [] };
			current.hunks.push(hunk);
			continue;
		}
		if (!hunk) continue;

		if (line.startsWith("+")) {
			hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
		} else if (line.startsWith("-")) {
			hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
		} else if (line.startsWith("\\")) {
			hunk.lines.push({ kind: "meta", text: line.slice(1).trim() });
		} else {
			hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
		}
	}

	return files;
}

function pathFromDiffHeader(line: string): string {
	// `diff --git a/x b/x`; the b/ side is authoritative and survives renames.
	const match = / b\/(.*)$/.exec(line);
	return match ? match[1] : line.slice("diff --git ".length);
}

/** Single-quote for POSIX sh, the only safe way to pass an arbitrary path. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
