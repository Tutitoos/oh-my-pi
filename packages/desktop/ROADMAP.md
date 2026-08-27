# Roadmap

What is not built yet, what is built but owed something, and what is deliberately
out of scope. Everything here is a known item, not a wish: each one is either a
measurement taken while building the app or a decision recorded when it was made.

## Next

**Ship it.** The app builds a DMG today, but distribution is wired in
documentation rather than in code. It needs a signing identity and notarization
(`docs/macos-signing-notarization.md` covers the mechanics), an updater keypair —
Tauri validates the public key at build time, so a placeholder breaks the build
instead of degrading — and a release endpoint. Each release must also embed a
real omp binary: `sync:sidecar` currently generates a shim that execs an
installed `omp`, and `scripts/release.ts` refuses to package with it unless you
pass `--allow-shim`, because the failure would otherwise be silent.

**Windows and Linux.** macOS first was deliberate — it bounds where WebKit and
Chromium disagree. The relay and the protocol client are platform-agnostic; the
title bar is not (it is built around macOS's overlay traffic lights), and
`externalBin` needs a target-triple binary per platform.

**The Plan tab shows the plan file.** Plan mode is usable and its approval dialog
renders the plan, but the side panel does not yet show the plan document while
you are writing it. The file is locatable without help — `sessionFile` is in the
RPC state and the plan is `<sessionFile minus .jsonl>/local/<slug>-plan.md` — but
reading it from the app means either a new RPC command or a `bash` call, and see
the context-cost item below before choosing the second.

## Known debt

**`handoff` still holds the serialized command queue.** `compact` and `bash` are
dispatched in the background so `abort` and `get_state` keep answering while they
run; `handoff` is not, and it can block for minutes. Same defect, same fix, not
yet applied.

**Pending UI requests are only cancelled when the client disconnects.** An
`abort` does not clear them, so a compaction started while an `ask` dialog is
open waits on a request only the client can answer. The TUI does not hit this
because its abort tears down its own overlay.

**Plan mode has two implementations.** `AgentSession.setPlanMode()` was added for
the RPC path, but the TUI's `#enterPlanMode` was not refactored to call it. They
agree today and nothing keeps them agreeing.

**The app's own shell commands land in your session's context.** The diff and
file panels run `git` through the session's `bash`, and those calls are recorded
in the transcript: one session measured 69 `bashExecution` records, roughly 9.8K
tokens of the app talking to itself. A side channel that does not write to the
session would fix it.

**The `compact` response carries no `sessionId`.** A failure arriving after a
`switch_session` cannot be attributed to the session it came from.

**Clipboard paste is unverified on WKWebView.** The clipboard plugin was chosen
precisely so this does not depend on what the engine allows, but only the real
window can confirm it.

**No tab closing.** Sessions opened this run stay open; Rust reclaims the
processes with LRU eviction once more than three are live. That is a deliberate
model, but there is no way to say "I am done with this one" short of deleting it.

**Transcripts are not virtualized.** collab-web renders a full transcript without
windowing and copes, so this waits on a measurement with a session of several
hundred messages rather than on a guess. Virtualizing breaks the browser's own
find and complicates auto-scroll, so it needs to be worth it.

## Deliberately not doing

**Editing the agent's task list.** `set_todos` exists in the protocol and stays
unused: the plan has one owner, and two writers on a list the agent rewrites
wholesale is a race with no upside.

**A theme picker.** The transcript uses `titanium` because that is the theme the
CLI defaults to. The generator is written so a second theme is a one-line change,
but importing all 100 is a feature nobody asked for.

**A second front-end for configuration.** Settings, plugins and MCP are managed
through omp's own CLI and slash commands. The app curates them; it does not
become a second place where that state lives.

**An embedded editor.** The diff is read-only and editing opens your system
editor. Syntax highlighting, LSP and reconciling edits against the agent writing
to the same files concurrently is a different product.

**Collab.** Reachable by slash command; not a surface of its own.
