import { memo } from "react";

/**
 * The agent's task list, straight out of `RpcSessionState.todoPhases`.
 *
 * The shape is owned by omp's `todo` tool and is typed loosely on our side, so
 * every field is read defensively — a phase that gains a field should render,
 * not crash.
 */
export const TodoPanel = memo(function TodoPanel({ phases }: { phases: readonly unknown[] }) {
	if (phases.length === 0) {
		return <div className="omp-empty">No plan yet. The agent adds one with the todo tool.</div>;
	}

	return (
		<div className="omp-todo">
			{phases.map((raw, index) => {
				const phase = asRecord(raw);
				const items = Array.isArray(phase.items) ? phase.items : Array.isArray(phase.todos) ? phase.todos : [];
				return (
					<section className="omp-todo__phase" key={String(phase.id ?? phase.name ?? index)}>
						<h3 className="omp-todo__title">{String(phase.name ?? phase.title ?? `Phase ${index + 1}`)}</h3>
						<ul className="omp-todo__list">
							{items.map((item, itemIndex) => {
								const todo = asRecord(item);
								const status = String(todo.status ?? todo.state ?? "pending");
								return (
									<li
										className="omp-todo__item"
										data-status={status}
										key={String(todo.id ?? todo.content ?? itemIndex)}
									>
										<span className="omp-todo__mark" aria-hidden="true">
											{mark(status)}
										</span>
										<span>{String(todo.content ?? todo.text ?? todo.title ?? "")}</span>
									</li>
								);
							})}
						</ul>
					</section>
				);
			})}
		</div>
	);
});

function mark(status: string): string {
	if (status.startsWith("comple") || status === "done") return "✓";
	if (status.startsWith("in_") || status === "active" || status === "running") return "◐";
	if (status.startsWith("cancel") || status === "skipped") return "×";
	return "○";
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
