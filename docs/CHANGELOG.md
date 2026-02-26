# Changelog

**Version Format:** `vYYYY-MM-DD build HHMMSS`

## v2026-02-26
- **Background task monitoring** - `execute` tool now supports `callback_session` parameter for async monitoring of long-running commands
- **`list_background_tasks` tool** - New tool to list all active background monitors
- **Quiet callback delivery** - waits 10s of inactivity on callback pane before sending, never interrupts user typing
- **Callback failure fallback** - if callback session unreachable, error is displayed in source terminal
- **Prompt-based completion** - `executeAndWait` now requires prompt detection (not just content stability) to mark command as completed, fixing false positives on commands like `sleep`

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
