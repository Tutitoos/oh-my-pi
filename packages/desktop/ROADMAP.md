# Roadmap

What is broken, what is owed, and what is deliberately out of scope. Every item
is a known one: each was either measured while building the app or confirmed by
an adversarial review that had to survive a refuter.

## Broken right now

These are not gaps in the plan — they are things the app claims to do and does
not. They come before anything below.

**Opening a file fails for anything under a dot-directory.** The `opener`
capability now carries a scope, which fixed the case where *every* path was
refused. It is still half-wrong: Tauri defaults `require_literal_leading_dot` to
`true` on unix — its own comment says "dotfiles are not supposed to be exposed by
default" — so the `**` glob matches no path component beginning with a dot. A
project checked out under `.claude/worktrees/` cannot open a single file, and
revealing its folder fails too. Needs `plugins.opener.requireLiteralLeadingDot:
false` in `tauri.conf.json`, or a scope narrowed to real project roots.

**Session liveness is read from the wrong side, and it can put two agents on one
transcript.** The sidebar decides whether a session has a process by asking its
webview bridge. A background tab never starts its bridge, so after any route
change every non-active session reports idle while its sidecar is alive in the
Rust pool — and renaming or exporting one then takes the throwaway-process path,
which is exactly the two-agents-on-one-jsonl hazard that path exists to avoid.
The pool is the only honest source: ask Rust.

**Native notifications cannot fire.** `notifications.ts` calls
`@tauri-apps/plugin-notification`, which is not in `Cargo.toml`, not registered
in `lib.rs`, and not in the capability set. Turn-complete and approval-pending
notifications have never worked.

**Two of the three MCP actions cannot succeed**, and none of the three report a
result anywhere in the app.

**The transcript re-renders on every keystroke.** The error reporter is passed
as a fresh arrow each render, which defeats `memo` on `Transcript`,
`MessageBubble` and `ToolCard`.

Plus sixteen more confirmed defects — a manual compaction that can announce a
start with no end, `plan_review` errors emitted with no id (so every client
discards them), a settings enum missing the agent's own default, and a set of
style ones including a `--wide` modifier that declares exactly the base width and
an indicator whose dots the flattener squares.

## Next

**Ship it.** The app builds a DMG, but distribution is wired in documentation
rather than in code. It needs a signing identity and notarization
(`docs/macos-signing-notarization.md` has the mechanics), an updater keypair —
Tauri validates the public key at build time, so a placeholder breaks the build
instead of degrading — and a release endpoint. Each release must embed a real omp
binary: `sync:sidecar` generates a shim that execs an installed `omp`, and
`scripts/release.ts` refuses to package with it unless forced, because that
failure would otherwise be silent.

**A way to drive the app in tests.** Three fixes in the last batch could not be
verified because the dev binary is not a registered macOS application, so nothing
can click it. That is why a scope bug survived a fix that was *about* that scope:
the check that was run proved the permission reached the runtime, not that it
permitted anything. Until the app can be driven, every permission, clipboard and
drag-drop fix is an argument rather than a result.

**Windows and Linux.** macOS first was deliberate — it bounds where WebKit and
Chromium disagree. The relay and the protocol client are platform-agnostic; the
title bar is not, and `externalBin` needs a target-triple binary per platform.

**The Plan tab shows the plan file.** Plan mode works and its approval dialog
renders the plan, but the side panel does not show the plan document while you
are writing it. The file is locatable — `sessionFile` is in the RPC state and the
plan is `<sessionFile minus .jsonl>/local/<slug>-plan.md` — but reading it needs
either a new RPC command or a `bash` call, and see the context-cost item below
before choosing the second.

## Known debt

**`handoff` still holds the serialized command queue.** `compact` and `bash` are
dispatched in the background so `abort` and `get_state` keep answering while they
run; `handoff` is not, and it can block for minutes. Same defect, same fix, not
yet applied.

**Plan mode has two implementations.** `AgentSession.setPlanMode()` was added for
the RPC path and the TUI's `#enterPlanMode` was not refactored onto it. They
agree today and nothing keeps them agreeing.

**The app's own shell commands land in your session's context.** The diff and
file panels run `git` through the session's `bash`, and those calls are recorded
in the transcript: one session measured 69 `bashExecution` records, roughly 9.8K
tokens of the app talking to itself. A side channel that does not write to the
session would fix it.

**The `compact` response carries no `sessionId`,** so a failure arriving after a
`switch_session` cannot be attributed.

**Clipboard paste is unverified on WKWebView.** The plugin was chosen so this
does not depend on what the engine allows, but only a driveable app can confirm
it.

**Closing a session is not a thing you can ask for.** Deleting one closes its
tab; there is no other way. Sessions opened this run stay open and Rust reclaims
their processes by LRU once more than three are live.

**Transcripts are not virtualized.** collab-web renders a full transcript without
windowing and copes, so this waits on a measurement with several hundred messages
rather than a guess — virtualizing breaks the browser's own find and complicates
auto-scroll.

## Deliberately not doing

**Editing the agent's task list.** `set_todos` exists in the protocol and stays
unused: the plan has one owner, and two writers on a list the agent rewrites
wholesale is a race with no upside.

**A theme picker.** The transcript uses `titanium` because that is the CLI's
default. The generator is written so a second theme is a one-line change, but
importing all 100 is a feature nobody asked for.

**A second front-end for configuration.** Settings, plugins and MCP are managed
through omp's own CLI and slash commands. The app curates them; it does not
become a second place where that state lives.

**An embedded editor.** The diff is read-only and editing opens your system
editor. Syntax highlighting, LSP and reconciling edits against an agent writing
to the same files is a different product.

**Collab.** Reachable by slash command; not a surface of its own.
