import { useCallback, useEffect, useRef, useState } from "react";
import { readConfig, writeConfig } from "../manage/cli";

const MODES = [
	{ value: "always-ask", label: "Always ask", hint: "Auto-approves reads only" },
	{ value: "write", label: "Write", hint: "Prompts before running commands" },
	{ value: "yolo", label: "Yolo", hint: "Approves everything" },
] as const;

/**
 * Shows the configured tool-approval mode, and lets it be changed.
 *
 * Deliberately explicit about a limitation: there is no RPC command for approval
 * mode and `get_state` does not report it, so this reads and writes
 * `tools.approvalMode` through the CLI. A running sidecar already resolved its
 * own mode at startup, so a change here lands on the **next** session — the menu
 * says so rather than implying it took effect.
 *
 * It matters because omp's default is `yolo`, which auto-approves shell commands
 * without asking. Someone should be able to see that without opening a file.
 */
export function ApprovalModeBadge() {
	const [mode, setMode] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [saved, setSaved] = useState<string | null>(null);
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		readConfig()
			.then(config => setMode(String(config["tools.approvalMode"]?.value ?? "")))
			// Outside Tauri, or if the CLI is unavailable, just render nothing.
			.catch(() => setMode(null));
	}, []);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const choose = useCallback(async (next: string) => {
		try {
			await writeConfig("tools.approvalMode", next);
			setMode(next);
			setSaved(next);
		} catch {
			/* the settings screen surfaces write failures properly */
		}
	}, []);

	if (!mode) return null;

	return (
		<div className="omp-picker" ref={root}>
			<button
				className="omp-picker__trigger"
				type="button"
				data-warn={mode === "yolo" || undefined}
				onClick={() => setOpen(value => !value)}
				title="Tool approval mode"
			>
				{mode}
			</button>

			{open ? (
				<div className="omp-picker__menu omp-picker__menu--narrow">
					{MODES.map(entry => (
						<button
							className="omp-slash__item"
							key={entry.value}
							type="button"
							data-active={entry.value === mode || undefined}
							onClick={() => void choose(entry.value)}
						>
							<span className="omp-slash__name">{entry.label}</span>
							<span className="omp-slash__desc">{entry.hint}</span>
						</button>
					))}
					<p className="omp-picker__note">
						{saved
							? `Saved. Applies to sessions started from now on — this one keeps its current mode.`
							: `Changing this affects new sessions; a running one keeps the mode it started with.`}
					</p>
				</div>
			) : null}
		</div>
	);
}
