import { memo, useEffect, useLayoutEffect, useRef } from "react";
import type { TranscriptEntry } from "../rpc/transcript";
import { messageText, thinkingText } from "../rpc/transcript";
import { ToolCard } from "./ToolCard";

/**
 * Not virtualized, deliberately. collab-web renders full transcripts the same
 * way and holds up; virtualizing breaks the browser's own find-in-page and
 * complicates auto-scroll. Revisit with a measurement, not a hunch.
 */
export const Transcript = memo(function Transcript({
	entries,
	streaming,
}: {
	entries: readonly TranscriptEntry[];
	streaming?: boolean;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);

	// Only follow the tail while the user is already at the bottom, so reading
	// scrollback is not yanked away by a streaming turn.
	useEffect(() => {
		const node = scroller.current;
		if (!node) return;
		const onScroll = () => {
			const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
			pinned.current = distance < 80;
		};
		node.addEventListener("scroll", onScroll, { passive: true });
		return () => node.removeEventListener("scroll", onScroll);
	}, []);

	useLayoutEffect(() => {
		const node = scroller.current;
		if (node && pinned.current) node.scrollTop = node.scrollHeight;
	}, [entries, streaming]);

	/*
	 * Re-pin when the transcript itself is resized. `.omp-main` is
	 * `grid-template-rows: 1fr auto`, so a growing composer shrinks this pane —
	 * and the browser preserves `scrollTop`, which means the conversation slides
	 * up and away while you type. The effect above only fires on new entries.
	 *
	 * Setting `scrollTop` resizes nothing, so observing the same node we write to
	 * is not a loop. This also fixes the same drift on window resize.
	 */
	useEffect(() => {
		const node = scroller.current;
		if (!node) return;
		const observer = new ResizeObserver(() => {
			if (pinned.current) node.scrollTop = node.scrollHeight;
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	if (entries.length === 0 && !streaming) {
		return (
			<div className="omp-transcript" ref={scroller}>
				<div className="omp-empty">Ask the agent something to get started.</div>
			</div>
		);
	}

	// An assistant bubble with no text yet renders nothing, so a turn that opens
	// with a long thinking phase looked frozen. Show the agent is alive whenever
	// it is streaming and has not produced visible output for the last entry.
	const tail = entries.at(-1);
	const awaitingOutput =
		streaming &&
		(!tail ||
			(tail.kind === "message" && tail.role === "user") ||
			(tail.kind === "message" && tail.streaming && !messageText(tail.content) && !thinkingText(tail.content)));

	return (
		<div className="omp-transcript" ref={scroller}>
			{entries.map(entry =>
				entry.kind === "tool" ? (
					<div className="omp-entry omp-entry--tool" key={entry.id}>
						<ToolCard entry={entry} />
					</div>
				) : (
					<MessageBubble key={entry.id} entry={entry} />
				),
			)}

			{awaitingOutput ? <WorkingIndicator /> : null}
		</div>
	);
});

/** Three dots is the smallest honest "it is alive" signal. */
function WorkingIndicator() {
	return (
		<div className="omp-entry omp-entry--working" aria-live="polite">
			<div className="omp-entry__role">assistant</div>
			<div className="omp-working">
				<span />
				<span />
				<span />
			</div>
		</div>
	);
}

const MessageBubble = memo(function MessageBubble({ entry }: { entry: Extract<TranscriptEntry, { kind: "message" }> }) {
	const thinking = thinkingText(entry.content);
	const text = messageText(entry.content);
	if (!thinking && !text) return null;

	return (
		<>
			{thinking ? (
				<div className="omp-entry omp-entry--thinking">
					<div className="omp-entry__role">thinking</div>
					<div className="omp-entry__body">{thinking}</div>
				</div>
			) : null}
			{text ? (
				<div className={`omp-entry omp-entry--${entry.role}`}>
					<div className="omp-entry__role">{entry.role}</div>
					<div className="omp-entry__body">{text}</div>
				</div>
			) : null}
		</>
	);
});
