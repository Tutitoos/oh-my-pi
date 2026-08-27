import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { RpcBridge } from "../rpc/bridge";
import { listFiles } from "../workspace/git";

interface TreeNode {
	name: string;
	path: string;
	children: Map<string, TreeNode>;
}

/**
 * Workspace file tree, built from `git ls-files` so it honours `.gitignore`
 * for free — no ignore parsing, and no walking into `node_modules` or `target`.
 */
export function FileTree({ bridge, ready }: { bridge: RpcBridge; ready: boolean }) {
	const [paths, setPaths] = useState<string[]>([]);
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!ready) return;
		listFiles(bridge)
			.then(setPaths)
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	}, [bridge, ready]);

	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return needle ? paths.filter(path => path.toLowerCase().includes(needle)) : paths;
	}, [paths, query]);

	const root = useMemo(() => buildTree(visible), [visible]);

	const open = useCallback(async (path: string) => {
		const { openPath } = await import("@tauri-apps/plugin-opener");
		await openPath(path).catch(() => {});
	}, []);

	const toggle = useCallback((path: string) => {
		setExpanded(current => {
			const next = new Set(current);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	}, []);

	// A filter should reveal matches, not leave them behind collapsed folders.
	const filtering = query.trim().length > 0;

	return (
		<div className="omp-tree">
			<input
				className="omp-filter"
				type="search"
				placeholder="Filter files…"
				value={query}
				onChange={event => setQuery(event.target.value)}
			/>

			{error ? <div className="omp-banner omp-banner--error">{error}</div> : null}

			<div className="omp-tree__scroll">
				{paths.length === 0 && !error ? (
					<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
						No files.
					</div>
				) : null}
				<TreeLevel
					node={root}
					depth={0}
					expanded={expanded}
					forceOpen={filtering}
					onToggle={toggle}
					onOpen={open}
				/>
			</div>
		</div>
	);
}

const TreeLevel = memo(function TreeLevel({
	node,
	depth,
	expanded,
	forceOpen,
	onToggle,
	onOpen,
}: {
	node: TreeNode;
	depth: number;
	expanded: Set<string>;
	forceOpen: boolean;
	onToggle(path: string): void;
	onOpen(path: string): void;
}) {
	const children = [...node.children.values()].sort(directoriesFirst);

	return (
		<>
			{children.map(child => {
				const isDirectory = child.children.size > 0;
				const isOpen = forceOpen || expanded.has(child.path);

				return (
					<div key={child.path}>
						<button
							className="omp-tree__row"
							type="button"
							style={{ paddingLeft: 8 + depth * 12 }}
							title={child.path}
							onClick={() => (isDirectory ? onToggle(child.path) : onOpen(child.path))}
						>
							<span className="omp-tree__twisty" aria-hidden="true">
								{isDirectory ? (isOpen ? "▾" : "▸") : ""}
							</span>
							<span className="omp-tree__name">{child.name}</span>
						</button>

						{isDirectory && isOpen ? (
							<TreeLevel
								node={child}
								depth={depth + 1}
								expanded={expanded}
								forceOpen={forceOpen}
								onToggle={onToggle}
								onOpen={onOpen}
							/>
						) : null}
					</div>
				);
			})}
		</>
	);
});

function directoriesFirst(a: TreeNode, b: TreeNode): number {
	const aDir = a.children.size > 0;
	const bDir = b.children.size > 0;
	if (aDir !== bDir) return aDir ? -1 : 1;
	return a.name.localeCompare(b.name);
}

export function buildTree(paths: readonly string[]): TreeNode {
	const root: TreeNode = { name: "", path: "", children: new Map() };

	for (const path of paths) {
		let node = root;
		const segments = path.split("/");
		for (let i = 0; i < segments.length; i++) {
			const name = segments[i];
			const full = segments.slice(0, i + 1).join("/");
			let child = node.children.get(name);
			if (!child) {
				child = { name, path: full, children: new Map() };
				node.children.set(name, child);
			}
			node = child;
		}
	}

	return root;
}
