import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type Attachment,
	type DraftContents,
	type DraftSink,
	sendDraft,
} from "../src/components/composer/useComposerDraft";

/**
 * The complaint these answer: the composer cleared the draft, revoked every
 * preview and swallowed the rejection *before* the send had landed. A send
 * refused because the sidecar was still coming up â or evicted mid-flight to
 * free a pool slot â took the message with it and said nothing at all.
 */
function attachment(id: string): Attachment {
	return { id, name: `${id}.png`, mimeType: "image/png", data: "AA==", previewUrl: `blob:${id}` };
}

function contents(overrides: Partial<DraftContents> = {}): DraftContents {
	return { draft: "ship it", attachments: [attachment("a1")], references: ["/tmp/notes.md"], ...overrides };
}

function recorder(send: DraftSink["send"]) {
	const cleared: DraftContents[] = [];
	const reported: unknown[] = [];
	const sink: DraftSink = { send, clear: sent => cleared.push(sent), reportError: cause => reported.push(cause) };
	return { sink, cleared, reported };
}

describe("sendDraft", () => {
	test("does not give the draft up until the send has landed", async () => {
		const gate = Promise.withResolvers<void>();
		const { sink, cleared } = recorder(() => gate.promise);
		const draft = contents();

		const done = sendDraft("ship it", draft, sink);
		await Promise.resolve();
		// The whole defect in one assertion: the message is still in the composer
		// while it is on the wire.
		expect(cleared).toHaveLength(0);

		gate.resolve();
		await done;
		expect(cleared).toEqual([draft]);
	});

	test("a rejected send keeps the message and says why", async () => {
		const { sink, cleared, reported } = recorder(() => Promise.reject(new Error("session suspended to free a slot")));

		await sendDraft("ship it", contents(), sink);

		// Nothing was cleared, so nothing was revoked either: the chips keep their
		// previews and the draft is where the user left it.
		expect(cleared).toHaveLength(0);
		expect(reported).toHaveLength(1);
		expect(String(reported[0])).toContain("session suspended to free a slot");
		expect(String(reported[0])).toContain("still in the composer");
	});

	test("hands attachments over as image content, and omits them when there are none", async () => {
		const seen: unknown[] = [];
		const { sink } = recorder(async (_message, images) => {
			seen.push(images);
		});

		await sendDraft("ship it", contents(), sink);
		await sendDraft("ship it", contents({ attachments: [] }), sink);

		expect(seen[0]).toEqual([{ type: "image", data: "AA==", mimeType: "image/png" }]);
		expect(seen[1]).toBeUndefined();
	});
});

/*
 * `sendDraft` can keep its order perfectly while the hook stops calling it, and
 * the pressure that produced this bug — "the box should empty the instant you
 * press Enter" — acts on the hook, not on the helper. Inside a hook the send
 * path is only reachable through a real React tree, which this package has no
 * test environment for, so the rule is asserted against the source the way
 * `escape-ownership.test.ts` asserts its own.
 */
describe("the hook's submit", () => {
	const source = readFileSync(
		new URL("../src/components/composer/useComposerDraft.ts", import.meta.url).pathname,
		"utf8",
	);
	const start = source.indexOf("const submit = useCallback");
	const body = source.slice(start, source.indexOf("const applyCompletion", start));

	test("gives the draft up only through the send's own clear", () => {
		expect(start).toBeGreaterThan(-1);
		expect(body).toContain("sendDraft(");
		// The three lines that used to sit above the await. Each one on its own
		// was a message the user never got back.
		expect(body).not.toContain('setDraft("")');
		expect(body).not.toContain("setAttachments([])");
		expect(body).not.toContain("setReferences([])");
	});
});
