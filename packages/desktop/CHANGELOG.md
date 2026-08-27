# Changelog

## [Unreleased]

### Added

- omp Desktop: a native app for driving omp, with a session list grouped by git checkout, a streaming transcript that renders omp's own tool cards, a read-only diff and file tree, a task panel, live subagents, and screens for settings, plugins and MCP servers.
- The transcript uses omp's `titanium` theme and ships MesloLGM Nerd Font, so it looks like the same session does in a terminal.
- A context menu on every surface: sessions can be renamed, exported to HTML, revealed in Finder, stopped or deleted from it.
- Plan mode is usable from the app, and its approval dialog shows the plan rather than asking you to approve a title.
- Compaction confirms before it runs, reports progress, can be cancelled, and leaves a record in the transcript.
- Starting a chat asks which project, listing the ones already in the sidebar.

### Fixed

- Opening a file in the editor, revealing it in Finder and the OAuth login now work; they were rejected by a missing permission scope and did nothing at all.
- Renaming or exporting a session that is not open now acts on that session instead of on an empty one, while reporting success.
- Pressing Escape to dismiss a menu or the expanded composer no longer aborts the running turn.
- The file tree's context menu now opens.
- Cut and paste in the text menu now act on the field you opened the menu in.
- Returning to a session after visiting Settings no longer aborts the turn that was running.
- Re-attaching to a session already in progress now shows its conversation instead of an empty transcript.
- Starting a chat in a folder used earlier in the same run no longer silently re-attaches to that earlier chat.
- Clicking your own chat's row no longer opens a second process on the same session file.
- A session you have just started now appears in the sidebar without restarting the app.
- The task panel now renders tasks, distinguishes blocked and abandoned ones, and shows why a task is blocked.
- Reopened sessions show each tool's arguments instead of an ellipsis.
- Diff and file-tree paths work for a session running in a subdirectory of the repository.
- A failed tool no longer draws the same marker as one that succeeded.
- The composer grows with its text and the Send button no longer stretches with it.
