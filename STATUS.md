# MCP TMUX Server (TypeScript) - Status

**Date:** 2025-11-08
**Status:** ✅ **All improvements implemented and tested**

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

**Result:** Clean codebase, 829 lines (down from 955).

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

## Next Steps

See above feature requests and GitHub issues for future enhancements.
