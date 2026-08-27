import { memo, useCallback, useEffect, useState } from "react";
import type { RpcBridge } from "../rpc/bridge";
import { type ChangedFile, changedFiles, type FileDiff, fileDiff, isRepository } from "../workspace/git";

/**
 * Read-only view of what the session changed.
 *
 * Editing opens the file in the system editor rather than embedding one: a real
 * editor drags in highlighting, LSP and — the hard part — reconciling your edits
 * with the agent writing the same file underneath you.
 */
export function DiffPanel({ bridge, ready }: { bridge: RpcBridge; ready: boolean }) {
	const [files, setFiles] = useState<ChangedFile[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [diff, setDiff] = useState<FileDiff[]>([]);
	const [repo, setRepo] = useState<boolean | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		if (!ready) return;
		setBusy(true);
		setError(null);
		try {
			const inRepo = await isRepository(bridge);
			setRepo(inRepo);
			setFiles(inRepo ? await changedFiles(bridge) : []);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}, [bridge, ready]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!selected) {
			setDiff([]);
			return;
		}
		let cancelled = false;
		fileDiff(bridge, selected)
			.then(result => {
				if (!cancelled) setDiff(result);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [bridge, selected]);

	const openInEditor = useCallback(async (path: string) => {
		const { openPath } = await import("@tauri-apps/plugin-opener");
		await openPath(path).catch(() => {});
	}, []);

	if (repo === false) {
		return <div className="omp-empty">Not a git repository.</div>;
	}

	return (
		<div className="omp-diff">
			<div className="omp-diff__head">
				<span>
					{files.length} changed file{files.length === 1 ? "" : "s"}
				</span>
				<button
					type="button"
					data-component="button"
					data-variant="ghost"
					data-size="normal"
					onClick={() => void refresh()}
					disabled={busy}
				>
					{busy ? "…" : "Refresh"}
				</button>
			</div>

			{error ? <div className="omp-banner omp-banner--error">{error}</div> : null}

			<div className="omp-diff__files">
				{files.length === 0 && !busy ? (
					<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
						No uncommitted changes.
					</div>
				) : null}

				{files.map(file => (
					<button
						className="omp-diff__file"
						key={file.path}
						type="button"
						aria-current={file.path === selected}
						title={file.from ? `${file.from} → ${file.path}` : file.path}
						onClick={() => setSelected(file.path === selected ? null : file.path)}
						onDoubleClick={() => void openInEditor(file.path)}
					>
						<span className={`omp-diff__status omp-diff__status--${file.status}`}>
							{statusLetter(file.status)}
						</span>
						<span className="omp-diff__path">{file.path}</span>
						<ChangeBars additions={file.additions} deletions={file.deletions} />
					</button>
				))}
			</div>

			{selected ? (
				<div className="omp-diff__body">
					{diff.length === 0 ? (
						<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
							No textual diff.
						</div>
					) : (
						diff.map(file => <FileDiffView key={file.path} file={file} />)
					)}
				</div>
			) : null}
		</div>
	);
}

/** opencode's +N/−N badge. */
const ChangeBars = memo(function ChangeBars({ additions, deletions }: { additions: number; deletions: number }) {
	if (!additions && !deletions) return null;
	return (
		<span data-component="diff-changes" data-variant="bars">
			<span data-slot="diff-changes-additions">+{additions}</span>
			<span data-slot="diff-changes-deletions">−{deletions}</span>
		</span>
	);
});

const FileDiffView = memo(function FileDiffView({ file }: { file: FileDiff }) {
	if (file.binary) {
		return <div className="omp-diff__binary">{file.path} — binary file</div>;
	}
	return (
		<div className="omp-diff__file-diff">
			{file.hunks.map(hunk => (
				<div className="omp-hunk" key={hunk.header}>
					<div className="omp-hunk__header">{hunk.header}</div>
					{hunk.lines.map((line, index) => (
						<div
							// Diff lines have no stable identity; index is the honest key here
							// and the list is fully replaced on every refresh.
							key={`${hunk.header}:${index}`}
							className={`omp-hunk__line omp-hunk__line--${line.kind}`}
						>
							<span className="omp-hunk__no">{line.oldNo ?? ""}</span>
							<span className="omp-hunk__no">{line.newNo ?? ""}</span>
							<span className="omp-hunk__sign">{sign(line.kind)}</span>
							<span className="omp-hunk__text">{line.text}</span>
						</div>
					))}
				</div>
			))}
		</div>
	);
});

function sign(kind: string): string {
	if (kind === "add") return "+";
	if (kind === "del") return "−";
	return " ";
}

function statusLetter(status: ChangedFile["status"]): string {
	switch (status) {
		case "modified":
			return "M";
		case "added":
			return "A";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		case "untracked":
			return "?";
		default:
			return "•";
	}
}
