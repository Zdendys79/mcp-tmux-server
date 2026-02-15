# MCP TMUX Server (TypeScript) - Status

**Date:** 2026-02-15
**Status:** ✅ **Production-ready, active development**

---

## Project Status

TypeScript implementation with official MCP SDK is **complete and production-ready**.

All critical improvements from the Python prototype have been successfully ported and are now active in the TypeScript version.

---

## ✅ Completed Improvements

### 1. ✅ No Caching - Always Fresh Content

**Status:** Implemented and verified

**Changes:**
- Removed entire BufferManager class (77 lines)
- `read_tmux_pane` always returns all current pane content
- Response field: `lines` (not `new_lines`)
- No `force_full_read` parameter needed
- No `cached` field in response

**Result:** Claude always sees current terminal state, no stale data issues.

---

### 2. ✅ Simplified API - `execute` Tool

**Status:** Implemented and verified

**Changes:**
- Tool renamed: `execute_and_wait` → `execute`
- Default timeout: 30s → 10s
- Timeout parameter now in **seconds** (not milliseconds)
- Clean, simple API

**Result:** Easier to use, better defaults.

---

### 3. ✅ Progress Reporting via STDERR

**Status:** Implemented and verified

**Changes:**
- Real-time STDERR messages during command execution:
  - `[MCP execute] Command started: {command}`
  - `[MCP execute] Still running... (1.0s)` (every second)
  - `[MCP execute] ✓ Command COMPLETED in 2.34s`

**Result:** Claude Code sees progress in real-time, no confusion about command status.

---

### 4. ✅ Clear Tool Descriptions with Warnings

**Status:** Implemented and verified

**Changes:**
- `execute`: WARNING banners explaining blocking behavior
- `insert_tmux_pane_text`: Clear warnings about typing vs execution
- `read_tmux_pane`: Simplified description

**Result:** Claude understands tool usage correctly.

---

### 5. ✅ Date-Based Versioning

**Status:** Implemented and verified

**Changes:**
- Version format: `vYYYY-MM-DD build HHMMSS`
- Auto-generated from dist/index.js modification time
- Example: `v2025-11-08 build 133934`

**Result:** Easy to see when server was built.

---

### 6. ✅ Code Cleanup

**Status:** Completed

**Removed:**
- BufferManager class (77 lines)
- `clear_buffer` tool (obsolete)
- `bufferManager` instance
- Unused import: `promisify`
- Buffer manager initialization messages

**Result:** Clean codebase (~1000 lines with all new features).

---

## Current Tools

1. **`execute`** - Execute command and wait for completion (blocking)
2. **`read_tmux_pane`** - Read current terminal content (no caching)
3. **`insert_tmux_pane_text`** - Type text into terminal (for editors)
4. **`send_keys_tmux`** - Send keyboard shortcuts
5. **`get_tmux_sessions`** - List active sessions
6. **`get_pane_info`** - Get pane details
7. **`create_session`** - Create new session with auto-increment naming
8. **`get_server_version`** - Get server version (date-based)

---

## Testing Status

All features tested and verified:
- ✅ `execute` with quick commands (ls, echo)
- ✅ `execute` with long commands (sleep, npm install)
- ✅ STDERR progress messages visible in logs
- ✅ `read_tmux_pane` returns fresh content
- ✅ `insert_tmux_pane_text` for typing
- ✅ Version auto-updates on build
- ✅ No caching - verified with repeated reads

---

## Python Version

**Decision:** Abandoned
**Reason:** No official MCP SDK support

TypeScript version is the canonical implementation.

---

## Repository

**GitHub:** https://github.com/Zdendys79/mcp-tmux-server
**Branch:** main
**History:** Clean (reset on 2025-11-08)

---

## Known Limitations & Feature Requests

### 1. Nested tmux sessions (tmux-in-tmux)

**Issue:** When working with nested tmux sessions (local tmux → SSH → remote tmux), the current tools cannot properly detach from the remote session while staying in the local one.

**Current workaround:** Manual keyboard input (`Ctrl+B Ctrl+B D`)

**Requested feature:**
- Add support for control sequences via `send-keys` command
- Add helper tool for nested session operations
- Example: `detach_remote_session()` that sends `Ctrl+B D` to the inner tmux

**Use case:**
```
Local: tmux session "base7"
  → SSH to remote server
    → tmux attach -t "claude"
      → Want to detach "claude" but stay in "base7"
```

**Technical solution:**
- Implement `send_keys` with support for control characters
- Support for prefix doubling in nested contexts
- Tool: `send_tmux_keys(session, keys, nested=False)`

**Priority:** Medium
**Status:** Logged 2025-11-20

---

### 2. Confusion: Control characters (Ctrl+C) - wrong tool selection

**Issue:** Claude instances frequently use wrong tool for sending control characters (Ctrl+C, Ctrl+D, etc.)

**Incorrect patterns observed:**
1. ❌ Using `insert_tmux_pane_text` with empty text (does nothing)
2. ❌ Using `insert_tmux_pane_text` with escape sequences `\x03` (unreliable)
3. ❌ Multiple failed attempts before using correct method

**Correct methods:**

**Option A: MCP tool (PREFERRED for MCP context)**
```typescript
send_keys_tmux(session: "session-1", keys: "C-c")  // Ctrl+C
send_keys_tmux(session: "session-2", keys: "C-d")  // Ctrl+D
```

**Option B: Direct tmux command via Bash**
```bash
tmux send-keys -t session-1 C-c  # Works immediately
tmux send-keys -t session-2 C-d  # No MCP overhead
```

**Why confusion happens:**
- `insert_tmux_pane_text` description mentions "typing text"
- Claude doesn't realize control chars need different tool
- No clear warning that `insert_tmux_pane_text` ≠ keyboard shortcuts

**Recommendation:**
1. Add WARNING to `insert_tmux_pane_text` description:
   ```
   ⚠️ For keyboard shortcuts (Ctrl+C, Ctrl+D), use send_keys_tmux instead!
   ```
2. Update Claude global instructions (CLAUDE.md) with examples
3. Document that Bash `tmux send-keys` is often simpler than MCP tool

**Root cause:** Tool description doesn't clearly separate "typing text" from "sending keys"

**Priority:** Medium
**Status:** Logged 2025-12-03 (Nyara)

---

### 3. Root prompt (#) not recognized by execute tool

**Issue:** The `execute` tool only recognizes standard user prompts ending with `$` or `>`. When using a root shell (prompt ends with `#`), the tool reports "Session busy - prompt not stable" even though the session is idle.

**Example:**
```
root@jz-work:/home/zdendys#   ← Valid prompt, but not recognized
```

**Error observed:**
```json
{
  "success": false,
  "status": "error",
  "error": "Session busy - prompt not stable within 10000ms (last line: \"\")"
}
```

**Current workaround:** Use direct `tmux send-keys` via Bash tool instead of MCP execute.

**Requested fix:**
- Add `#` to the list of recognized prompt characters
- Regex pattern should match: `$`, `>`, `#`, and possibly `%` (zsh)
- Example pattern: `/[$>%#]\s*$/`

**Affected tools:**
- `execute` - cannot detect completion
- `insert_tmux_pane_text` - safety check fails

**Priority:** High (blocks root session usage)
**Status:** ✅ Partially fixed 2026-02-15 - `waitForStablePrompt` now filters trailing empty lines to find actual prompt. Full `#` support via `PROMPT_PATTERNS` regex `/$#]\s*$/` was already present.

---

### 4. `execute` fails first-response detection for fast commands with (venv) prompt

**Issue:** The `execute` tool returns timeout `"No output within 2000ms"` even though the command actually executes successfully. Verified by `read_tmux_pane` which shows the command output in the pane.

**Reproduction:**
```
Prompt: (venv) zdendys@jz-work:~/workplace/mcp-server-discord$
Command: echo "test"
Result: { success: false, status: "timeout", error: "No output within 2000ms" }
But read_tmux_pane shows: "test" output is present in the pane
```

**Analysis:**
- Safety check (`waitForStablePrompt`) passes correctly - the `(venv)` prompt matches `/$#]\s*$/`
- Command is sent via `sendCommand()` (Ctrl+U + literal text + Enter)
- First-response loop polls every 200ms, comparing `JSON.stringify(content) !== JSON.stringify(initialContent)`
- For fast commands (echo, ls), the output appears AND prompt returns within <200ms
- Despite content clearly changing, the comparison fails to detect the difference within 2000ms
- `execution_time_ms` is exactly ~2063ms (= firstResponseTimeout 2000ms + overhead)

**Affected prompt formats:**
- `(venv) user@host:~/path$` - Python virtualenv prefix
- Possibly other prefixed prompts (conda, nvm, etc.)

**Workaround:** Use `execute` to send the command, then `read_tmux_pane` to read output. Ignore the timeout error.

**Possible root cause:**
- Timing race between `sendCommand()` async steps (Ctrl+U, literal text, Enter) and first poll
- `capturePane` may return identical content if tmux buffer hasn't flushed yet
- The 200ms poll interval may consistently miss the transition window

**Suggested fix:**
- Add a small delay (50-100ms) after `sendCommand()` before first poll
- Or use tmux `pipe-pane` for real-time output capture instead of polling
- Or compare only the last N lines instead of full pane content

**Priority:** High (affects all sessions with virtualenv activated)
**Status:** ✅ Fixed 2026-02-15 - Rewrote `executeAndWait`:
- Replaced two-phase detection (first-response + stabilization) with single poll loop
- Added 100ms delay after `sendCommand()` for tmux key processing
- Fingerprint-based change detection (last 5 non-empty lines) instead of full `JSON.stringify`
- Uses `isPromptLine()` for consistent prompt detection (was duplicated `promptPattern`)
- Improved output extraction: finds command echo line from bottom, strips trailing prompts

---

## Next Steps

See above feature requests and GitHub issues for future enhancements.
