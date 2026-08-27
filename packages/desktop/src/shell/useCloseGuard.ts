/**
 * Ask before closing while an agent is mid-turn.
 *
 * Sessions are appended to their jsonl continuously, so closing only ever loses
 * the turn in flight — but that turn can be ten minutes of work, which is worth
 * one dialog. When nothing is running the window closes immediately.
 *
 * Implemented on the JS side rather than in Rust: `onCloseRequested` can
 * `preventDefault`, and the decision needs UI anyway.
 */

import { useEffect } from "react";

export function useCloseGuard(isBusy: () => boolean, confirm: () => Promise<boolean>): void {
	useEffect(() => {
		let dispose: (() => void) | undefined;
		let cancelled = false;

		void (async () => {
			try {
				const { getCurrentWindow } = await import("@tauri-apps/api/window");
				const appWindow = getCurrentWindow();
				const unlisten = await appWindow.onCloseRequested(async event => {
					if (!isBusy()) return; // let it close
					event.preventDefault();
					if (await confirm()) await appWindow.destroy();
				});
				if (cancelled) unlisten();
				else dispose = unlisten;
			} catch {
				// Not running under Tauri — nothing to guard.
			}
		})();

		return () => {
			cancelled = true;
			dispose?.();
		};
	}, [isBusy, confirm]);
}
