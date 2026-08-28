/**
 * Does the packaged app come up healthy?
 *
 * Nothing covered this, and the gap was expensive: a capability that granted a
 * command with no scope, a plugin whose Rust half was never registered, and a
 * content security policy tightened without anything to say whether it broke the
 * window — all of them shipped, and all of them are invisible to `bun test`,
 * which never launches anything.
 *
 * This does not click. It answers the narrower question that has been going
 * unasked: launch the real bundle, and see whether the process stays up, the
 * webview loads, the relay spawns a sidecar, and nothing in the output says
 * something was refused. A plugin config key that `deny_unknown_fields` rejects,
 * a capability Tauri cannot parse, or a CSP that blocks the bundle all surface
 * here as a dead window or a refusal line.
 *
 *   bun run smoke            # against the existing debug bundle
 *   bun run smoke --build    # build it first
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const APP = path.join(ROOT, "src-tauri/target/debug/bundle/macos/omp Desktop.app/Contents/MacOS/omp-desktop");

/** Long enough for a sidecar to reach `ready`, which was measured at ~3.8s. */
const BOOT_BUDGET_MS = 45_000;
const SETTLE_MS = 4_000;

/**
 * Lines that mean something was refused rather than merely logged. Deliberately
 * broad: silence is the failure mode this exists to break, so a false positive
 * that makes someone read the output is cheaper than a miss.
 */
const REFUSALS = [
	/Content Security Policy/i,
	/Refused to (load|execute|connect|apply)/i,
	/\bForbiddenPath\b/,
	/\bForbiddenUrl\b/,
	/unknown field/i,
	/failed to (parse|deserialize|initialize)/i,
	/not allowed by the scope/i,
	/panicked at/,
];

function run(command: string, args: string[]): Promise<number> {
	return new Promise(resolve => {
		spawn(command, args, { cwd: ROOT, stdio: "inherit" }).on("exit", code => resolve(code ?? 1));
	});
}

async function sidecarCount(): Promise<number> {
	// `pgrep -c` is a GNU flag; macOS rejects it and prints usage to stderr, which
	// silently counted as zero and failed this check every time. Count the lines.
	const proc = Bun.spawn(["pgrep", "-f", "mode rpc-ui"], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(proc.stdout).text();
	return out.split("\n").filter(line => line.trim()).length;
}

function fail(message: string, detail?: string): never {
	console.error(`\n✗ ${message}`);
	if (detail) console.error(detail);
	process.exit(1);
}

const shouldBuild = process.argv.includes("--build");
if (shouldBuild) {
	console.log("building the debug bundle…");
	if ((await run("bun", ["run", "tauri", "build", "--debug"])) !== 0) fail("the bundle did not build");
}

if (!(await fs.exists(APP))) {
	fail("no debug bundle found", `Expected ${APP}\nRun with --build, or \`bun run tauri build --debug\` first.`);
}

// Only sidecars this run spawns should be counted; the dev app may be running.
const before = await sidecarCount();

console.log("launching the packaged app…");
const child = spawn(APP, [], { cwd: ROOT });
let output = "";
child.stdout.on("data", chunk => {
	output += chunk;
});
child.stderr.on("data", chunk => {
	output += chunk;
});

let exited: number | null = null;
child.on("exit", code => {
	exited = code ?? 0;
});

const deadline = Date.now() + BOOT_BUDGET_MS;
let spawned = false;
while (Date.now() < deadline && exited === null) {
	await Bun.sleep(1_000);
	if ((await sidecarCount()) > before) {
		spawned = true;
		break;
	}
}

// Let anything that was going to go wrong go wrong.
if (exited === null) await Bun.sleep(SETTLE_MS);

const refusal = REFUSALS.map(pattern => output.match(pattern)).find(Boolean);
const alive = exited === null;
if (alive) child.kill();

if (exited !== null) fail(`the app exited on its own with code ${exited}`, output.trim() || "(no output)");
if (!spawned) {
	fail(
		"no sidecar appeared, so the webview never reached the relay",
		"That is a dead window: the page failed to load, or `agent_start` was refused.\n" +
			(output.trim() || "(no output)"),
	);
}
if (refusal) fail(`something was refused: ${refusal[0]}`, output.trim());

console.log("\n✓ the packaged app starts, loads, and reaches a sidecar with nothing refused");
