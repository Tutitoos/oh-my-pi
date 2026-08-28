import { invoke } from "@tauri-apps/api/core";
import type { RpcBridge } from "./bridge";

/** How long a throwaway process gets to boot, switch session and answer. */
const ONESHOT_TIMEOUT_MS = 60_000;

/**
 * Who may speak for a session right now.
 *
 * Three states, because two of them used to be one. A missing bridge meant both
 * "nothing is running, the throwaway below is safe" and "something is running and
 * this webview cannot reach it", and every caller read it as the first — which is
 * how a rename from Settings put a second agent on a live jsonl. The dangerous
 * state is now spelled out, and it has no value that can be mistaken for the safe
 * one.
 */
export type SessionProcess =
	/** Nothing has this session open. */
	| { kind: "none" }
	/** A mounted view holds the handle; its process does the work. */
	| { kind: "mounted"; bridge: RpcBridge }
	/** A sidecar owns the session and nothing in this webview can talk to it. */
	| { kind: "detached" };

/**
 * Why a detached session refuses — in the menu's `disabled` and in the banner.
 * One string, so the greyed entry and the failure cannot disagree.
 */
export const SESSION_DETACHED = "Open this session first — its process has the file open";

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
	target: { process: SessionProcess; cwd: string; sessionPath: string },
	name: string,
): Promise<void> {
	switch (target.process.kind) {
		case "mounted":
			return target.process.bridge.setSessionName(name);
		case "detached":
			throw new Error(SESSION_DETACHED);
		case "none":
			await oneshot(target.cwd, target.sessionPath, { type: "set_session_name", name });
	}
}

/** Export, wherever the session happens to live. Answers with the file written. */
export async function exportSession(
	target: { process: SessionProcess; cwd: string; sessionPath: string },
	outputPath: string,
): Promise<string> {
	switch (target.process.kind) {
		case "mounted":
			return target.process.bridge.exportHtml(outputPath);
		case "detached":
			// That the export itself only reads is beside the point: the throwaway
			// gets there through `switch_session`, which loads the jsonl into a
			// second live agent.
			throw new Error(SESSION_DETACHED);
		case "none": {
			const data = await oneshot<{ path: string }>(target.cwd, target.sessionPath, {
				type: "export_html",
				outputPath,
			});
			return data?.path ?? outputPath;
		}
	}
}
