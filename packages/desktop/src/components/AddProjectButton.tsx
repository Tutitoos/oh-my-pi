import { useCallback, useState } from "react";
import { isTauri } from "../rpc/transport";
import { FolderPlusIcon } from "./Icons";

/**
 * Native folder picker, so a session can start somewhere omp has never run.
 *
 * Without this the sidebar can only ever show projects that already have
 * sessions on disk, which makes the app useless for a new repository until you
 * open a terminal — exactly the dependency it exists to remove.
 *
 * The picker is a Rust-side plugin call; the webview cannot open one itself.
 */
export function AddProjectButton({ onPick }: { onPick(directory: string): void }) {
	const [busy, setBusy] = useState(false);

	const pick = useCallback(async () => {
		if (!isTauri()) return;
		setBusy(true);
		try {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const selected = await open({ directory: true, multiple: false, title: "Choose a folder" });
			// `open` resolves to null when cancelled, and to string[] if multiple
			// were ever allowed — narrow both rather than trusting the happy path.
			const directory = Array.isArray(selected) ? selected[0] : selected;
			if (typeof directory === "string" && directory) onPick(directory);
		} finally {
			setBusy(false);
		}
	}, [onPick]);

	if (!isTauri()) return null;

	return (
		<button
			className="omp-titlebar__button"
			type="button"
			disabled={busy}
			title="Add a project folder"
			onClick={() => void pick()}
		>
			<FolderPlusIcon />
		</button>
	);
}
