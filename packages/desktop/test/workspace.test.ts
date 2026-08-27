import { describe, expect, test } from "bun:test";
import { buildTree } from "../src/components/FileTree";
import { parseUnifiedDiff, shellQuote } from "../src/workspace/git";

describe("unified diff parsing", () => {
	test("tracks line numbers across a hunk", () => {
		const raw = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 1111111..2222222 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -10,4 +10,5 @@ function x() {",
			" const a = 1;",
			"-const b = 2;",
			"+const b = 3;",
			"+const c = 4;",
			" return a;",
			"",
		].join("\n");

		const [file] = parseUnifiedDiff(raw);
		expect(file.path).toBe("src/a.ts");
		expect(file.hunks).toHaveLength(1);

		const kinds = file.hunks[0].lines.map(l => l.kind);
		expect(kinds).toEqual(["ctx", "del", "add", "add", "ctx"]);

		// Deletions advance only the old counter, additions only the new one.
		const [ctx, del, add1, add2, tail] = file.hunks[0].lines;
		expect([ctx.oldNo, ctx.newNo]).toEqual([10, 10]);
		expect([del.oldNo, del.newNo]).toEqual([11, undefined]);
		expect([add1.oldNo, add1.newNo]).toEqual([undefined, 11]);
		expect([add2.oldNo, add2.newNo]).toEqual([undefined, 12]);
		expect([tail.oldNo, tail.newNo]).toEqual([12, 13]);
	});

	test("takes the path from the b/ side so renames land on the new name", () => {
		const raw = [
			"diff --git a/old.ts b/new.ts",
			"similarity index 90%",
			"rename from old.ts",
			"rename to new.ts",
			"--- a/old.ts",
			"+++ b/new.ts",
			"@@ -1 +1 @@",
			"-x",
			"+y",
		].join("\n");

		const [file] = parseUnifiedDiff(raw);
		expect(file.path).toBe("new.ts");
		expect(file.from).toBe("old.ts");
	});

	test("flags binary files instead of inventing hunks", () => {
		const raw = [
			"diff --git a/logo.png b/logo.png",
			"index 111..222 100644",
			"Binary files a/logo.png and b/logo.png differ",
		].join("\n");

		const [file] = parseUnifiedDiff(raw);
		expect(file.binary).toBe(true);
		expect(file.hunks).toHaveLength(0);
	});

	test("handles several files in one diff", () => {
		const raw = [
			"diff --git a/one.ts b/one.ts",
			"+++ b/one.ts",
			"@@ -1 +1 @@",
			"-a",
			"+b",
			"diff --git a/two.ts b/two.ts",
			"+++ b/two.ts",
			"@@ -5 +5 @@",
			"-c",
			"+d",
		].join("\n");

		const files = parseUnifiedDiff(raw);
		expect(files.map(f => f.path)).toEqual(["one.ts", "two.ts"]);
		expect(files[1].hunks[0].lines[0].oldNo).toBe(5);
	});

	test("keeps the no-newline marker out of the content", () => {
		const raw = [
			"diff --git a/a.txt b/a.txt",
			"+++ b/a.txt",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"\\ No newline at end of file",
		].join("\n");

		const [file] = parseUnifiedDiff(raw);
		const last = file.hunks[0].lines.at(-1);
		expect(last?.kind).toBe("meta");
		expect(last?.text).toBe("No newline at end of file");
	});

	test("empty input yields no files rather than a phantom entry", () => {
		expect(parseUnifiedDiff("")).toEqual([]);
	});
});

describe("shell quoting", () => {
	test("survives spaces, quotes and shell metacharacters", () => {
		expect(shellQuote("simple.ts")).toBe("'simple.ts'");
		expect(shellQuote("with space.ts")).toBe("'with space.ts'");
		expect(shellQuote("a;rm -rf /")).toBe("'a;rm -rf /'");
		// A single quote must close the quote, escape one, then reopen.
		expect(shellQuote("it's.ts")).toBe(`'it'\\''s.ts'`);
	});
});

describe("file tree", () => {
	test("nests paths into directories", () => {
		const root = buildTree(["src/a.ts", "src/nested/b.ts", "README.md"]);
		expect([...root.children.keys()].sort()).toEqual(["README.md", "src"]);

		const src = root.children.get("src");
		expect([...(src?.children.keys() ?? [])].sort()).toEqual(["a.ts", "nested"]);
		expect(src?.children.get("nested")?.children.get("b.ts")?.path).toBe("src/nested/b.ts");
	});

	test("a file and a directory can share a prefix without colliding", () => {
		const root = buildTree(["lib", "lib/x.ts"]);
		// `lib` is created once and gains a child; it must not appear twice.
		expect([...root.children.keys()]).toEqual(["lib"]);
		expect(root.children.get("lib")?.children.size).toBe(1);
	});

	test("empty input yields an empty root", () => {
		expect(buildTree([]).children.size).toBe(0);
	});
});
