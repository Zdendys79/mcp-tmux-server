# Changelog

**Version Format:** `vYYYY-MM-DD build HHMMSS`

## v2026-07-03
- **Split `execute` into `run_wait` and `run_background`** (unmistakable naming, requested after a
  consuming Claude session repeatedly used the blocking tool for multi-hour commands and appeared
  frozen for the whole duration): `run_wait` is the short, blocking tool -- HARD-CAPPED at 120s
  server-side regardless of the `timeout` argument, so a units mistake (seconds vs ms) or a
  misjudged duration can never turn it into an hours-long block. `run_background` is the
  non-blocking tool for long-running/never-returning commands -- `callback_session` is now
  REQUIRED (was optional on `execute`), and it always returns after a short `grace_seconds` window
  (default 10s) instead of only falling back to background monitoring after the full timeout.
- **Renamed for clarity/consistency:** `insert_tmux_pane_text` -> `type_text`, `send_keys_tmux` ->
  `send_key`.
- Consuming clients must reconnect (Claude Code: `/mcp` or restart) to see the new tool names --
  the old names no longer exist.

## v2026-06-22
- **Session prefix resolution** - All tools now accept session name prefix (e.g. `sudo` → `sudo-0`). Exact match wins; single prefix match is auto-resolved; multiple matches return error with candidates list.

## v2026-02-26
- **Module split** - Refactored monolithic `index.ts` (1282 lines) into 5 modules: `tmux.ts`, `prompt.ts`, `execute.ts`, `background.ts`, `index.ts`
- **Background task monitoring** - `execute` tool now supports `callback_session` parameter for async monitoring of long-running commands
- **`list_background_tasks` tool** - New tool to list all active background monitors
- **Quiet callback delivery** - waits 10s of inactivity on callback pane before sending, never interrupts user typing
- **Callback failure fallback** - if callback session unreachable, error is displayed in source terminal (with proper shell escaping)
- **Prompt-based completion** - `executeAndWait` now requires prompt detection (not just content stability) to mark command as completed, fixing false positives on commands like `sleep`
- **Git version check** - Compares local HEAD vs origin/main at startup, notifies about available updates in first tool response
- **Callback target fix** - Uses session name only (not `:0.0`) to support any tmux `base-index` configuration

## v2026-02-15
- **`send_keys_tmux` tool** - New MCP tool for sending keyboard shortcuts (Ctrl+C, arrows, function keys)
- **Rewritten `executeAndWait`** - Single poll loop with fingerprint-based change detection (last 5 non-empty lines), fixes false timeout on fast commands with (venv) prompt
- **100ms initial delay** after `sendCommand()` - fixes race condition where tmux hasn't processed keys yet
- **Root prompt fix** - `waitForStablePrompt` now filters trailing empty lines, fixing `#` prompt detection
- **Consistent prompt detection** - output extraction uses `isPromptLine()` instead of separate regex
- **Documentation cleanup** - Fixed tool name references, updated architecture info

## v2026-01-22
- **STABLE PROMPT DETECTION** - `execute` and `insert` now wait for prompt to be STABLE (unchanged for 2s) before sending commands
- Removed unreliable `pane_current_command` check - no more false BUSY errors when running `sudo bash`
- Prompt detection is now the ONLY method to determine if session is ready
- Max wait time: 10s before returning BUSY (with retry loop)
- Fixed: `tryWrite()` now properly blocks when safety check fails

## v2025-11-08
- Full TypeScript implementation with MCP SDK
- No caching - always returns fresh terminal content
- `execute` tool with STDERR progress reporting
- Date-based versioning (auto-generated from build time)
- Default timeout: 10s
- Clear WARNING banners in tool descriptions
- Clean codebase (829 lines, no dead code)
