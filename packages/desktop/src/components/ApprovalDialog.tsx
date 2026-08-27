import { useEffect, useState } from "react";
import type { RpcBridge } from "../rpc/bridge";
import type { ExtensionUiRequestFrame } from "../rpc/protocol";

/**
 * Renders the blocking half of the Extension UI sub-protocol.
 *
 * Only `confirm`, `select`, `input` and `editor` reach here — the bridge routes
 * `open_url` to the system browser and drops the fire-and-forget methods
 * (`setWidget`, `setStatus`, `notify`, …), which was verified safe: an
 * unanswered `setWidget` did not wedge the server.
 *
 * Note that with omp's default `yolo` approval mode this dialog rarely fires;
 * it takes a non-yolo mode, an explicit per-tool `prompt` policy, or a provider
 * safety check.
 */
export function ApprovalDialog({ request, bridge }: { request: ExtensionUiRequestFrame; bridge: RpcBridge }) {
	const [draft, setDraft] = useState("");

	// A fresh request must not inherit the previous one's draft.
	useEffect(() => setDraft(""), [request.id]);

	// The server resolves to a default when its own timeout fires, so Escape
	// only needs to communicate intent, not race it.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Claiming the key matters even though session.tsx already stands down
			// for `pendingUi`: it is what stops any other Escape consumer added
			// later from acting on the same press.
			event.preventDefault();
			bridge.answerUi({ id: request.id, cancelled: true });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [bridge, request.id]);

	const title = request.title ?? defaultTitle(request.method);

	return (
		<div className="omp-backdrop" role="dialog" aria-modal="true" aria-label={title}>
			<div className="omp-modal">
				<h2 className="omp-modal__title">{title}</h2>
				{request.message ? <p className="omp-modal__message">{request.message}</p> : null}

				{request.method === "select" ? (
					<div className="omp-modal__options">
						{(request.options ?? []).map((option, index) => (
							<button
								key={option}
								type="button"
								data-component="button"
								data-size="normal"
								data-variant="ghost"
								onClick={() => bridge.answerUi({ id: request.id, value: option })}
							>
								{option}
								{request.optionDetails?.[index]?.description ? (
									<span className="omp-slash__desc">
										{" — "}
										{request.optionDetails[index].description}
									</span>
								) : null}
							</button>
						))}
					</div>
				) : null}

				{request.method === "input" || request.method === "editor" ? (
					<textarea
						className="omp-input"
						autoFocus
						rows={request.method === "editor" ? 8 : 2}
						placeholder={request.placeholder}
						value={draft}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter" && !event.shiftKey && request.method === "input") {
								event.preventDefault();
								bridge.answerUi({ id: request.id, value: draft });
							}
						}}
					/>
				) : null}

				<div className="omp-modal__actions">
					<button
						type="button"
						data-component="button"
						data-size="normal"
						data-variant="ghost"
						onClick={() => bridge.answerUi({ id: request.id, cancelled: true })}
					>
						Cancel
					</button>

					{request.method === "confirm" ? (
						<>
							<button
								type="button"
								data-component="button"
								data-size="normal"
								data-variant="ghost"
								onClick={() => bridge.answerUi({ id: request.id, confirmed: false })}
							>
								No
							</button>
							<button
								type="button"
								data-component="button"
								data-size="normal"
								data-variant="primary"
								onClick={() => bridge.answerUi({ id: request.id, confirmed: true })}
							>
								Yes
							</button>
						</>
					) : null}

					{request.method === "input" || request.method === "editor" ? (
						<button
							type="button"
							data-component="button"
							data-size="normal"
							data-variant="primary"
							onClick={() => bridge.answerUi({ id: request.id, value: draft })}
						>
							Submit
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}

function defaultTitle(method: string): string {
	switch (method) {
		case "confirm":
			return "Confirm";
		case "select":
			return "Choose an option";
		case "editor":
			return "Edit";
		default:
			return "Input";
	}
}
