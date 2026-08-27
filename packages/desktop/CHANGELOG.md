# Changelog

## [Unreleased]

### Added

- omp Desktop: a native desktop app for driving omp, with a session list grouped
  by git checkout, a streaming transcript that renders omp's own tool cards, a
  read-only diff and file tree, a task panel, live subagents, and screens for
  settings, plugins and MCP servers.
- The transcript column now uses omp's `titanium` theme, generated from the
  theme's own definition rather than transcribed, and ships MesloLGM Nerd Font so
  the tool renderers' glyphs draw instead of falling back to boxes.
- A context menu on every surface — sessions, projects, messages, tool cards,
  changed files, the file tree and text fields. Sessions can be renamed,
  exported to HTML, revealed in Finder, stopped or deleted from it.
- Plan mode is usable from the app: a badge and toggle in the status bar, and an
  approval dialog that shows the plan itself rather than asking you to approve a
  title and two buttons.
- Compaction is a visible operation: it confirms before running, reports
  progress, can be cancelled, and leaves a rule in the transcript recording the
  before and after.
- Starting a chat asks which project, listing the ones already in the sidebar.

### Fixed

- Starting a chat in a folder you had used before reloading the window silently
  re-attached to that chat's process and rendered an empty transcript over a live
  conversation — anything typed went into it. Chat ids no longer derive from
  anything the webview owns.
- Clicking your own chat's row in the sidebar opened a second sidecar onto the
  same session file, leaving two agents appending to one transcript.
- The sidebar read its session list once at startup, so a session you had just
  started never appeared in it. It now refreshes when a turn ends and when the
  window regains focus.
- Releasing a drag-and-drop listener could raise an unhandled rejection and take
  the window down with a full-screen error.
- The task panel read the wrong field and had therefore never rendered a single
  task; blocked and abandoned tasks are now distinguishable, and a blocked task
  shows why.
- Reopened sessions showed `bash …` and `read …` in place of every tool's
  arguments, because the replay read them from the result rather than the call.
- Diff and file-tree paths are anchored to the repository root, so a session
  running in a subdirectory no longer produces empty diffs and failed opens.
- A failed tool drew the same status marker as a successful one.
- The composer grows with its text instead of staying one line tall, and the
  Send button no longer stretches with it.
- Escape while the command palette or a menu is open no longer aborts the
  running turn as well as closing it.
