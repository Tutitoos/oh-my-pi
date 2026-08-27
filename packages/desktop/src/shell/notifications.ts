import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/**
 * Native notifications for the two moments worth interrupting someone.
 *
 * omp's own `desktop-notify.ts` is not reusable here: it is D-Bus plumbing for
 * Linux terminal emulators. Tauri's plugin is native and cross-platform.
 *
 * Nothing fires while the window has focus — a notification for something the
 * user is already looking at is pure noise.
 */

let permission: "granted" | "denied" | "unknown" = "unknown";

async function ensurePermission(): Promise<boolean> {
	if (permission === "granted") return true;
	if (permission === "denied") return false;

	const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
	permission = granted ? "granted" : "denied";
	return granted;
}

async function windowFocused(): Promise<boolean> {
	try {
		return await getCurrentWindow().isFocused();
	} catch {
		return true; // no window: assume focused and stay quiet
	}
}

export async function notify(title: string, body: string): Promise<void> {
	try {
		if (await windowFocused()) return;
		if (!(await ensurePermission())) return;
		sendNotification({ title, body });
	} catch {
		// A missing notification is never worth surfacing as an error.
	}
}

export function notifyTurnComplete(model: string | undefined): void {
	void notify("Turn complete", model ? `${model} finished working.` : "The agent finished working.");
}

export function notifyApprovalPending(what: string): void {
	void notify("Waiting for you", what);
}
