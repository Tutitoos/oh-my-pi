import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Who is allowed to hear Escape on `window`.
 *
 * `preventDefault` only suppresses listeners that run *after* it, and listeners
 * on one target fire in registration order. The turn's abort handler binds on
 * `window` the moment streaming starts — necessarily before any overlay exists —
 * so an overlay that also binds on `window` runs second, and by then the turn is
 * already dead. `document` is strictly earlier than `window` in the bubble path,
 * which is what makes an overlay's claim actually work.
 *
 * This has now bitten three separate overlays. It is a rule, not a preference,
 * so it gets a test rather than a comment.
 */
const SRC = new URL("../src", import.meta.url).pathname;

/** Files that legitimately listen at window scope, and why. */
const ALLOWED = new Set([
	// The app's own ⌘-shortcuts. They test for a modifier, so they never see a
	// bare Escape.
	"app.tsx",
	// The owner of Escape: it is what aborts the running turn, and it stands down
	// for `defaultPrevented` so an overlay bound on `document` beats it.
	"routes/session.tsx",
]);

function sources(dir: string, prefix = ""): string[] {
	return readdirSync(dir).flatMap(name => {
		const full = join(dir, name);
		const rel = prefix ? `${prefix}/${name}` : name;
		if (statSync(full).isDirectory()) return sources(full, rel);
		return /\.tsx?$/.test(name) ? [rel] : [];
	});
}

describe("Escape ownership", () => {
	test("only the turn's abort handler and the shortcut map listen on window", () => {
		const offenders = sources(SRC).filter(rel => {
			if (ALLOWED.has(rel)) return false;
			return readFileSync(join(SRC, rel), "utf8").includes('window.addEventListener("keydown"');
		});

		expect(offenders).toEqual([]);
	});

	test("every overlay that handles Escape binds on document", () => {
		// Named explicitly: each of these once lost, or could lose, the race.
		const overlays = [
			"components/ContextMenu.tsx",
			"components/composer/ComposerModal.tsx",
			"components/ApprovalDialog.tsx",
			"components/ModelPicker.tsx",
			"components/CompactDialog.tsx",
		];

		for (const rel of overlays) {
			const source = readFileSync(join(SRC, rel), "utf8");
			expect({ rel, onDocument: source.includes('document.addEventListener("keydown"') }).toMatchObject({
				onDocument: true,
			});
		}
	});
});
