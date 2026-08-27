import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcBridge } from "../rpc/bridge";
import type { AvailableSlashCommand } from "../rpc/protocol";
import { fieldsFor, type SchemaField, TRANSPORTS, type Transport } from "./mcp-schema";

/**
 * MCP server management.
 *
 * Unlike settings and plugins, this does NOT go through the CLI: `/mcp` is a
 * slash command, so it runs over the same RPC session the agent is using and
 * its output lands in the transcript.
 *
 * The subcommand list is read from `getAvailableCommands` rather than hardcoded
 * — a live install reports 17 of them (add, list, remove, test, reauth, unauth,
 * enable, disable, smithery-search, …), well beyond the four the docs name.
 */
export function McpScreen({ bridge, commands }: { bridge: RpcBridge; commands: readonly AvailableSlashCommand[] }) {
	const [transport, setTransport] = useState<Transport>("stdio");
	const [values, setValues] = useState<Record<string, string>>({});
	const [name, setName] = useState("");
	const [sent, setSent] = useState<string | null>(null);

	const mcp = useMemo(() => commands.find(command => command.name === "mcp"), [commands]);
	const fields = useMemo(() => fieldsFor(transport), [transport]);

	// Switching transport must not carry over fields the new one does not have.
	useEffect(() => setValues({}), [transport]);

	const missing = fields.filter(field => field.required && !values[field.name]?.trim());
	const canSubmit = name.trim().length > 0 && missing.length === 0;

	const submit = useCallback(async () => {
		const config: Record<string, unknown> = { type: transport };
		for (const field of fields) {
			const raw = values[field.name]?.trim();
			if (!raw) continue;
			config[field.name] = coerce(field, raw);
		}

		// `/mcp add` takes the server name and a JSON blob; going through the
		// prompt channel means omp validates it against its own schema, so a bad
		// value produces a real error instead of a silently broken config file.
		const line = `/mcp add ${name.trim()} ${JSON.stringify(config)}`;
		setSent(line);
		await bridge.prompt(line).catch(() => {});
	}, [bridge, fields, name, transport, values]);

	return (
		<div className="omp-screen">
			<header className="omp-screen__head">
				<h1 className="omp-screen__title">MCP servers</h1>
				<p className="omp-screen__lede">
					Runs through the session's <code>/mcp</code> command, so results appear in the transcript.
				</p>
			</header>

			<div className="omp-screen__row">
				{["list", "test", "reconnect"].map(action => (
					<button
						key={action}
						type="button"
						data-component="button"
						data-variant="ghost"
						data-size="normal"
						disabled={!hasSubcommand(mcp, action)}
						title={hasSubcommand(mcp, action) ? undefined : `This omp build has no /mcp ${action}`}
						onClick={() => void bridge.prompt(`/mcp ${action}`).catch(() => {})}
					>
						/mcp {action}
					</button>
				))}
			</div>

			<section className="omp-settings__group">
				<h2 className="omp-settings__group-title">Add a server</h2>
				<p className="omp-settings__group-desc">
					Fields come from omp's own <code>mcp-schema.json</code>, so they track the schema rather than a copy of
					it.
				</p>

				<div className="omp-setting">
					<div className="omp-setting__label">
						<span>Name</span>
						<code className="omp-setting__key">required</code>
					</div>
					<div className="omp-setting__control">
						<input
							className="omp-input"
							value={name}
							onChange={event => setName(event.target.value)}
							placeholder="my-server"
						/>
					</div>
				</div>

				<div className="omp-setting">
					<div className="omp-setting__label">
						<span>Transport</span>
					</div>
					<div className="omp-setting__control">
						<select value={transport} onChange={event => setTransport(event.target.value as Transport)}>
							{TRANSPORTS.map(option => (
								<option key={option} value={option}>
									{option}
								</option>
							))}
						</select>
					</div>
				</div>

				{fields.map(field => (
					<div className="omp-setting" key={field.name}>
						<div className="omp-setting__label">
							<span>{field.name}</span>
							<code className="omp-setting__key">
								{field.type}
								{field.required ? " · required" : ""}
							</code>
							{field.description ? <p className="omp-setting__desc">{field.description}</p> : null}
						</div>
						<div className="omp-setting__control">
							{field.type === "boolean" ? (
								<input
									type="checkbox"
									checked={values[field.name] === "true"}
									onChange={event =>
										setValues(current => ({ ...current, [field.name]: String(event.target.checked) }))
									}
								/>
							) : (
								<input
									className="omp-input"
									type={field.type === "number" ? "number" : "text"}
									placeholder={placeholderFor(field)}
									value={values[field.name] ?? ""}
									onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))}
								/>
							)}
						</div>
					</div>
				))}

				<div className="omp-screen__row">
					<button
						type="button"
						data-component="button"
						data-variant="primary"
						data-size="normal"
						disabled={!canSubmit}
						onClick={() => void submit()}
					>
						Add server
					</button>
					{missing.length > 0 ? (
						<span className="omp-setting__desc">Missing: {missing.map(f => f.name).join(", ")}</span>
					) : null}
				</div>

				{sent ? <pre className="omp-screen__log">{sent}</pre> : null}
			</section>
		</div>
	);
}

function hasSubcommand(command: AvailableSlashCommand | undefined, name: string): boolean {
	return Boolean(command?.subcommands?.some(sub => sub.name === name));
}

/** Turn a text input back into the type the schema declares. */
function coerce(field: SchemaField, raw: string): unknown {
	switch (field.type) {
		case "number":
			return Number(raw);
		case "boolean":
			return raw === "true";
		case "array":
			// Args are whitespace-separated in every real-world example.
			return raw.split(/\s+/).filter(Boolean);
		case "record":
			try {
				return JSON.parse(raw);
			} catch {
				// KEY=value pairs are friendlier than demanding JSON for env vars.
				return Object.fromEntries(
					raw
						.split(/\s+/)
						.filter(Boolean)
						.map(pair => {
							const index = pair.indexOf("=");
							return index === -1 ? [pair, ""] : [pair.slice(0, index), pair.slice(index + 1)];
						}),
				);
			}
		default:
			return raw;
	}
}

function placeholderFor(field: SchemaField): string {
	if (field.name === "args") return "--flag value";
	if (field.name === "env" || field.name === "headers") return "KEY=value OTHER=value";
	if (field.name === "url") return "https://example.com/mcp";
	if (field.name === "command") return "npx";
	return "";
}
