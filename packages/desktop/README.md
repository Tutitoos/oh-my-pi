# @oh-my-pi/desktop

omp Desktop — a native desktop app that drives omp over the RPC protocol, with
opencode's design system ported across.

```sh
bun run sync:sidecar   # put an omp executable where Tauri expects it
bun run app:dev        # Tauri window + Bun dev server on :1420
bun test               # RpcBridge and protocol conformance
```

## Why a sidecar

omp cannot be embedded in a Node process. It is deeply Bun-coupled — 264
`Bun.file`, 45 `bun:sqlite` imports, `bun:ffi`, `bun:jsc` — and ships as a
`bun build --compile` binary. That closes the door opencode walked through when
it moved to Electron to host its server in-process, and it is why Tauri is a
reasonable choice here: since the process is external either way, Electron's
main advantage disappears and its ~150 MB of Chromium does not.

## Architecture

```
Tauri (Rust)          owns every `omp --mode rpc-ui` child, relays stdio
   │  Channel IPC     (no protocol logic lives in Rust — it moves bytes)
Webview (React)       RpcBridge: id correlation, snapshots, transcript
```

`src-tauri/src/lib.rs` is the relay. `src/rpc/bridge.ts` is the protocol client.
Everything else is UI.

### Why `--mode rpc-ui`, not `--mode rpc`

Only `rpc-ui` sets `hasUI = true`. Under plain `rpc` the flows that need an
interactive host fail closed — approvals, the `ask` tool, computer-use safety
checks all report *"no interactive UI is available"*.

### Why a thin client instead of `RpcClient`

`packages/coding-agent/src/modes/rpc/rpc-client.ts` is a complete, typed client,
but its `start()` calls `ptree.spawn(["bun", cliPath, …])` and reads `Bun.env`.
Neither exists in a webview and it accepts no transport injection. `bridge.ts`
replicates its surface over Tauri IPC; treat `rpc-client.ts` as the reference
spec for any method added here.

## Measurements that shaped the design

Taken against a real sidecar, not estimated:

| | |
|---|---|
| Time to `ready` | ~3.8s (min 3.2, max 4.5 over 5 runs) |
| RSS per idle sidecar | ~285 MB |

`--no-extensions` does not help; the cost splits into ~1.5s of module loading
and ~2.3s of session init. That is why sessions are **pooled** rather than one
per tab forever: `MAX_LIVE_SESSIONS` (3) run at once, the least-recently-used is
evicted, and one spare is kept pre-warmed so opening a tab is instant. Suspended
tabs stay in the UI and replay through `switch_session` when reselected.

## Vendored design system

`src/styles/vendor/opencode/` is a copy of opencode's stylesheets (MIT, see
`THIRD-PARTY-NOTICES.txt`). They are plain CSS with cascade layers — no Tailwind,
no framework coupling — so they apply from React by using the same class and
`data-*` attributes. Buttons need all three: `data-component="button"`,
`data-variant`, `data-size`; without the last there is no height or padding.

`src/styles/tv-bridge.css` points omp's 30 tool renderers at that palette. It
defines the host-side names the renderers already read (`--fg`, `--accent`,
`--bg-raised`, …) rather than overriding `--tv-*`, because that fallback chain is
the seam they were designed around.

Local overrides go in `src/styles/app.css`, which sits in a later cascade layer.
Do not edit vendored files.

## Development notes

- Building omp from source needs the pi-natives addon, which needs nightly Rust.
  `sync:sidecar` falls back to a shim that execs an installed `omp`, which is
  equivalent for driving the UI. Ship a real binary with `--from <path>`.
- `agent_start` is idempotent per tab, which is what makes React StrictMode's
  double-mount and HMR reloads safe. The `useBridge` effect deliberately does not
  kill on cleanup.

## Packaging

```sh
bun run scripts/release.ts --sidecar /path/to/compiled/omp
```

The script refuses to build without a compiled sidecar unless you pass
`--allow-shim`. That guard exists because the failure is silent otherwise: the
dev shim execs an `omp` on *this* machine's PATH, so a shipped build launches
fine and then cannot find its agent.

Artifacts land in `src-tauri/target/release/bundle/{dmg,macos}/`.

### Signing and notarization

Tauri reads these from the environment; the release script prints which are set
so an unsigned build is not mistaken for a finished one.

| Variable | Purpose |
|---|---|
| `APPLE_SIGNING_IDENTITY` | Developer ID Application certificate |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarization via app-specific password |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` | Notarization via App Store Connect key |

The repo's [macos-signing-notarization.md](../../docs/macos-signing-notarization.md)
documents the certificate and notarization pipeline omp already uses.

An unsigned build still runs locally, but Gatekeeper blocks it for anyone else
and the updater refuses unsigned bundles.

### Updater

Not enabled. Tauri's updater requires a keypair and a release endpoint, and it
validates the public key at build time — a placeholder would break the build
rather than degrade gracefully. To turn it on:

```sh
bunx @tauri-apps/cli signer generate -w ~/.tauri/omp-desktop.key
```

then add `tauri-plugin-updater`, a `plugins.updater` block with the generated
`pubkey` and your release endpoint, and set `TAURI_SIGNING_PRIVATE_KEY` in CI.

### Cross-platform

The bundle targets macOS only today, matching the v1 scope. Linux and Windows
need their own sidecar binaries (`omp-x86_64-unknown-linux-gnu`,
`omp-x86_64-pc-windows-msvc.exe`) and their own signing setup. Windows would use
WebView2 rather than WebKit, so the ported CSS should be *closer* to opencode's
Chromium rendering there, not further.
