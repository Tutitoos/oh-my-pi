import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RpcBridge } from "../../rpc/bridge";
import type { AvailableSlashCommand } from "../../rpc/protocol";
import { readDroppedImage } from "../../rpc/transport";
import { composeMessage } from "./keymap";

export interface Attachment {
	id: string;
	name: string;
	mimeType: string;
	/** Base64 payload, as `prompt(message, images)` expects. */
	data: string;
	previewUrl: string;
}

/**
 * `file.name + size` collided for the same file dropped twice, which gave two
 * chips one id: React warned about the duplicate key, and removing either chip
 * removed both. A counter cannot collide.
 */
let attachmentSeq = 0;

export type ComposerDraft = ReturnType<typeof useComposerDraft>;

/**
 * Everything the composer knows, owned in one place.
 *
 * It lives here rather than inside `Composer` because the draft is now edited
 * from two places — the inline row and the expanded modal — and two components
 * each holding their own copy of the text is the bug this shape exists to make
 * impossible. Only one `<textarea>` is ever mounted; this is what it reads and
 * writes.
 *
 * Called once per session in `SessionView`, so each tab keeps its own draft the
 * way it always has.
 */
export function useComposerDraft({
	bridge,
	commands,
	streaming,
}: {
	bridge: RpcBridge;
	commands: readonly AvailableSlashCommand[];
	streaming: boolean;
}) {
	const [draft, setDraft] = useState("");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	/**
	 * Files the agent should read, held apart from the draft.
	 *
	 * They used to be written into the text as `@"/very/long/path"`, which is
	 * what the agent needs but not what anyone wants to look at — two absolute
	 * iCloud paths filled the editor before a word had been typed. The mention is
	 * assembled at send time instead, so the editor stays prose and these show as
	 * tags.
	 */
	const [references, setReferences] = useState<string[]>([]);
	const [dropping, setDropping] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [expanded, setExpanded] = useState(false);
	const [slashDismissed, setSlashDismissed] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	/** The one mounted textarea, whichever surface is rendering it. */
	const editorRef = useRef<HTMLTextAreaElement>(null);
	/** Survives the editor unmounting when it moves between surfaces. */
	const selection = useRef({ start: 0, end: 0 });
	/** Where to put the caret after a programmatic insert, applied on next paint. */
	const pendingCaret = useRef<number | null>(null);
	/**
	 * Bumped whenever the current draft stops being the one on screen. Reads of
	 * dropped files are async, so a paste that is still being decoded when the
	 * message goes out would otherwise reappear attached to the *next* message.
	 */
	const generation = useRef(0);
	/** Unique per composer, so N open sessions do not share element ids. */
	const slashListId = useId();

	/**
	 * The slash menu opens only when `/` starts the draft — mid-sentence slashes
	 * are just text. `getAvailableCommands` returned 79 commands on a stock
	 * install, so the list is filtered, not dumped.
	 *
	 * It also closes as soon as the draft has a newline, which means it is
	 * effectively single-line-only: in the expanded modal it shows while you are
	 * still on the first line and then gets out of the way. That is the right
	 * trade — a command and a multi-paragraph prompt are different things.
	 */
	const slashQuery = !slashDismissed && draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1) : null;

	const matches = useMemo(() => {
		if (slashQuery === null) return [];
		const query = slashQuery.toLowerCase().split(" ")[0];
		return commands
			.filter(
				command =>
					command.name.toLowerCase().startsWith(query) ||
					command.aliases?.some(alias => alias.toLowerCase().startsWith(query)),
			)
			.slice(0, 12);
	}, [commands, slashQuery]);

	/**
	 * The command list is replaced whenever an `available_commands_update` frame
	 * arrives, which can happen mid-keystroke. Without this, `highlight` outlives
	 * a shrinking list and accepting the completion reads `undefined.name`.
	 */
	useEffect(() => {
		setHighlight(current => (current < matches.length ? current : 0));
	}, [matches.length]);

	/**
	 * Object URLs are revoked on send and on removing a chip, but nothing covered
	 * unmount — every preview leaked for the life of the window. Navigating to
	 * Settings unmounts every session, so this was not a rare path.
	 */
	const attachmentsRef = useRef(attachments);
	attachmentsRef.current = attachments;
	useEffect(() => {
		return () => {
			generation.current++; // anything still decoding must not attach itself
			for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl);
		};
	}, []);

	const addImages = useCallback(async (files: readonly File[]) => {
		const mine = generation.current;
		const images = files.filter(file => file.type.startsWith("image/"));

		// Silence was the old behaviour: drop a PDF and nothing happened at all.
		// Only images can be sent as content — see `addFileReferences`.
		if (images.length === 0) {
			if (files.length > 0) setNotice("Only images can be attached. Use “Reference a file” for anything else.");
			return;
		}
		if (images.length < files.length) setNotice("Skipped the non-image files. Use “Reference a file” for those.");
		else setNotice(null);

		// `allSettled`, not `all`: a file that becomes unreadable between the drop
		// and the read — moved, or on a volume that went away — would reject the
		// whole batch and strand the object URLs already created for its siblings.
		const settled = await Promise.allSettled(
			images.map(async file => {
				const buffer = await file.arrayBuffer();
				const bytes = new Uint8Array(buffer);
				let binary = "";
				for (const byte of bytes) binary += String.fromCharCode(byte);
				return {
					id: `attachment-${++attachmentSeq}`,
					name: file.name || "pasted image",
					mimeType: file.type,
					data: btoa(binary),
					previewUrl: URL.createObjectURL(file),
				} satisfies Attachment;
			}),
		);
		const next = settled.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));
		if (next.length < images.length) setNotice("Could not read every image.");

		// The message these belong to was sent, or the session went away, while we
		// were decoding. Attaching them now would put them on the wrong message.
		if (generation.current !== mine) {
			for (const attachment of next) URL.revokeObjectURL(attachment.previewUrl);
			return;
		}
		setAttachments(current => [...current, ...next]);
	}, []);

	const removeAttachment = useCallback((id: string) => {
		setAttachments(current => {
			for (const attachment of current) if (attachment.id === id) URL.revokeObjectURL(attachment.previewUrl);
			return current.filter(attachment => attachment.id !== id);
		});
	}, []);

	/**
	 * Non-image files cannot be sent as content — the RPC prompt carries
	 * `images?: ImageContent[]` and nothing else. What omp *does* support is
	 * reading `@path` out of the message text, so a "file attachment" here is a
	 * mention the agent resolves on its side.
	 */
	const addReferences = useCallback((paths: readonly string[]) => {
		const wanted = paths.filter(Boolean);
		if (wanted.length === 0) return;
		setNotice(null);
		setReferences(current => [...current, ...wanted.filter(path => !current.includes(path))]);
	}, []);

	const removeReference = useCallback((path: string) => {
		setReferences(current => current.filter(entry => entry !== path));
	}, []);

	/**
	 * Files dropped on the window, which arrive as paths rather than `File`s.
	 *
	 * Images are read through Rust so they can be sent as content and shown with
	 * a thumbnail — the same result as picking them, so a drop and a pick are not
	 * two different features. Everything else becomes a reference.
	 */
	const addDroppedPaths = useCallback(
		async (paths: readonly string[]) => {
			const mine = generation.current;
			const images: Attachment[] = [];
			const others: string[] = [];
			let failed = 0;

			for (const path of paths) {
				if (!/\.(?:png|jpe?g|gif|webp)$/i.test(path)) {
					others.push(path);
					continue;
				}
				try {
					const image = await readDroppedImage(path);
					images.push({
						id: `attachment-${++attachmentSeq}`,
						name: image.name,
						mimeType: image.mimeType,
						data: image.data,
						// A data URL, because there is no `File` to make an object URL
						// from — and nothing to revoke later, which is one less leak.
						previewUrl: `data:${image.mimeType};base64,${image.data}`,
					});
				} catch {
					failed++;
				}
			}

			if (generation.current !== mine) return;
			if (failed > 0) setNotice("Could not read every image.");
			else if (images.length > 0 || others.length > 0) setNotice(null);
			if (images.length > 0) setAttachments(current => [...current, ...images]);
			if (others.length > 0) addReferences(others);
		},
		[addReferences],
	);

	const submit = useCallback(async () => {
		const message = composeMessage(draft, references);
		if (!message && attachments.length === 0) return;

		const images = attachments.map(a => ({ type: "image", data: a.data, mimeType: a.mimeType }));
		generation.current++; // this draft is gone; late reads belong to nothing
		for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);

		setDraft("");
		setAttachments([]);
		setReferences([]);
		setNotice(null);
		setExpanded(false);

		// While a turn is running, `steer` injects into it; `prompt` would queue.
		const send = streaming ? bridge.steer.bind(bridge) : bridge.prompt.bind(bridge);
		await send(message, images.length ? images : undefined).catch(() => {});
	}, [attachments, bridge, draft, references, streaming]);

	/**
	 * Swap the command token for the chosen one and keep whatever came after it.
	 *
	 * It used to replace the entire draft, which was survivable while Tab was the
	 * only way to trigger it and the draft was one line. It is not survivable in
	 * an editor people write paragraphs in — `/plan` plus three sentences became
	 * `/plan ` and the sentences were gone.
	 */
	const applyCompletion = useCallback((command: AvailableSlashCommand) => {
		const node = editorRef.current;
		const rest = (node?.value ?? "").replace(/^\/\S*\s?/, "");
		const head = `/${command.name} `;
		pendingCaret.current = head.length;
		setDraft(head + rest);
		setHighlight(0);
		node?.focus();
	}, []);

	const changeDraft = useCallback((value: string) => {
		setDraft(value);
		setHighlight(0);
		setSlashDismissed(false);
	}, []);

	return {
		draft,
		changeDraft,
		attachments,
		references,
		notice,
		dismissNotice: useCallback(() => setNotice(null), []),
		dropping,
		setDropping,
		expanded,
		setExpanded,
		matches,
		slashListId,
		highlight,
		setHighlight,
		dismissSlash: useCallback(() => setSlashDismissed(true), []),
		applyCompletion,
		addImages,
		addDroppedPaths,
		addReferences,
		removeAttachment,
		removeReference,
		submit,
		streaming,
		editorRef,
		selection,
		pendingCaret,
	};
}
