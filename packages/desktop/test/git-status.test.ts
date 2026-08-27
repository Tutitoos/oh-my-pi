import { describe, expect, test } from "bun:test";
import { parseNumstat, splitStatus } from "../src/workspace/git";

/**
 * These parsers had no tests, which is how the bug reached a screenshot: the
 * status list rendered as a single row whose path read
 * `…/icons/128x128.png?? packages/desktop/…` — a status code sitting in the
 * middle of a filename, because every record had run together.
 *
 * The cause was the transport, not the parser. Measured against a live
 * `--mode rpc-ui` sidecar, `printf 'AAA\0BBB\0CCC'` returns `"AAABBBCCC"`: NUL
 * is dropped. The commands now pipe through `tr` in the shell, so what these
 * parse is newline-separated.
 */
describe("status records", () => {
	test("one entry per line", () => {
		const parsed = splitStatus("M  src/a.ts\n?? src/b.ts\n D src/c.ts\n");
		expect(parsed.map(entry => entry.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
		expect(parsed.map(entry => entry.status)).toEqual(["modified", "untracked", "deleted"]);
	});

	test("the regression: records must not run together", () => {
		// What the broken transport produced. A parser that split on NUL saw one
		// record and handed the UI a path with `??` inside it.
		const glued = "M  packages/desktop/icons/128x128.png?? packages/desktop/other.png";
		const parsed = splitStatus(glued);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].path).toContain("??");

		// Separated, the same bytes are two files and neither path contains a code.
		const fixed = splitStatus("M  packages/desktop/icons/128x128.png\n?? packages/desktop/other.png");
		expect(fixed).toHaveLength(2);
		for (const entry of fixed) expect(entry.path).not.toContain("??");
	});

	test("paths with spaces and quotes survive, which is what -z was for", () => {
		const parsed = splitStatus(`M  src/a file.ts\n?? src/it's "quoted".md`);
		expect(parsed.map(entry => entry.path)).toEqual(["src/a file.ts", `src/it's "quoted".md`]);
	});

	test("a rename consumes the following line as the old path", () => {
		const parsed = splitStatus("R  new/name.ts\nold/name.ts\nM  other.ts");
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toMatchObject({ path: "new/name.ts", from: "old/name.ts", status: "renamed" });
		expect(parsed[1].path).toBe("other.ts");
	});

	test("staged is read from the index column, not the worktree one", () => {
		expect(splitStatus("M  a.ts")[0].staged).toBe(true);
		expect(splitStatus(" M a.ts")[0].staged).toBe(false);
		expect(splitStatus("?? a.ts")[0].staged).toBe(false);
	});

	test("blank and short records are skipped rather than yielding empty paths", () => {
		expect(splitStatus("\n\nM  a.ts\n\n")).toHaveLength(1);
		expect(splitStatus("")).toEqual([]);
	});
});

describe("numstat", () => {
	test("counts land on their path", () => {
		const counts = parseNumstat("3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n");
		expect(counts.get("src/a.ts")).toEqual({ additions: 3, deletions: 1 });
		expect(counts.get("src/b.ts")).toEqual({ additions: 10, deletions: 0 });
	});

	test("binary files report zero rather than NaN", () => {
		// git writes `-` for both columns on a binary file; `Number("-")` is NaN,
		// which would render as "+NaN" in the badge.
		expect(parseNumstat("-\t-\tlogo.png")[Symbol.iterator] && parseNumstat("-\t-\tlogo.png").get("logo.png")).toEqual(
			{
				additions: 0,
				deletions: 0,
			},
		);
	});

	test("a path containing a tab keeps its tabs", () => {
		// Tabs survive the transport and are also the field separator, so the
		// path is everything after the second one.
		const counts = parseNumstat("1\t2\tweird\tname.ts");
		expect(counts.get("weird\tname.ts")).toEqual({ additions: 1, deletions: 2 });
	});

	test("empty input yields no counts", () => {
		expect(parseNumstat("").size).toBe(0);
	});
});
