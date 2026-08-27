import { invoke } from "@tauri-apps/api/core";
import type { RpcBridge } from "./bridge";

/** How long a throwaway process gets to boot, switch session and answer. */
const ONESHOT_TIMEOUT_MS = 60_000;

/**
 * Run one command against a session that nobody has open.
 *
 * Two rules, and both were paid for.
 *
 * **Never against a live session.** A second process on a session another
 * sidecar has open means two agents appending to one jsonl — measured once with
 * `lsof`, two `bun` processes on the same inode, both `w`. Callers resolve the
 * open tab first (`findOpenTab`) and use its bridge; this path is only for a
 * session with no process.
 *
 * **Never through the pool.** The pool is three live sidecars with LRU
 * eviction, so borrowing a slot to rename something could evict a session that
 * is mid-turn and cost it the turn. A child that is never registered evicts
 * nothing; it answers and dies.
 */
export async function oneshot<T>(cwd: string, sessionPath: string, command: Record<string, unknown>): Promise<T> {
	const switchId = `oneshot-switch-${crypto.randomUUID()}`;
	const runId = `oneshot-run-${crypto.randomUUID()}`;

	const line = await invoke<string>("agent_oneshot", {
		cwd,
		lines: [
			// `sessionPath`, not `path`. The server reads `command.sessionPath`
			// (rpc-types.ts declares it); sending `path` made it `undefined`, so the
			// throwaway never switched and every rename landed on the empty session
			// it had just created for itself — reporting success either way.
			JSON.stringify({ id: switchId, type: "switch_session", sessionPath }),
			JSON.stringify({ ...command, id: runId }),
		],
		expectId: runId,
		timeoutMs: ONESHOT_TIMEOUT_MS,
	});

	const frame = JSON.parse(line) as { success?: boolean; error?: string; data?: T };
	if (frame.success === false) throw new Error(frame.error ?? "the session refused the command");
	return frame.data as T;
}

/** Rename, wherever the session happens to live. */
export async function renameSession(
	target: { bridge?: RpcBridge; cwd: string; sessionPath: string },
	name: string,
): Promise<void> {
	if (target.bridge) return target.bridge.setSessionName(name);
	await oneshot(target.cwd, target.sessionPath, { type: "set_session_name", name });
}

/** Export, wherever the session happens to live. Answers with the file written. */
export async function exportSession(
	target: { bridge?: RpcBridge; cwd: string; sessionPath: string },
	outputPath: string,
): Promise<string> {
	if (target.bridge) return target.bridge.exportHtml(outputPath);
	const data = await oneshot<{ path: string }>(target.cwd, target.sessionPath, {
		type: "export_html",
		outputPath,
	});
	return data?.path ?? outputPath;
}
