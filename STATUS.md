# MCP TMUX Server (TypeScript) - Required Changes

**Date:** 2025-11-08
**Status:** Active development - migration from Python version

## Background

Python version was developed with improvements but lacks MCP protocol support. TypeScript version has proper MCP SDK integration but needs feature updates from Python version.

## Required Changes (Priority Order)

### 1. ✅ CRITICAL: Remove caching - always return fresh content

**Problem:** Buffer manager caches pane content causing Claude to see stale data even when commands finish.

**Solution:**
- Remove diff tracking from `read_tmux_pane`
- Always return ALL current pane content (not just new lines)
- Change response from `new_lines` to `lines`
- Remove `force_full_read` parameter (no longer needed)

**Impact:** Critical - causes false "waiting" behavior in Claude

---

### 2. ✅ CRITICAL: Rename `execute_and_wait` → `execute`

**Problem:** Name too long and redundant (tool always waits).

**Solution:**
- Rename tool from `execute_and_wait` to `execute`
- Update all documentation
- Default timeout 30s → 10s

---

### 3. ✅ HIGH: Add STDERR progress reporting to `execute`

**Problem:** Claude doesn't know command is still running vs finished.

**Solution:** Write progress messages to STDERR during execution:
```
[MCP execute] Command started: {command}
[MCP execute] Still running... (1.0s)
[MCP execute] Still running... (2.0s)
[MCP execute] ✓ Command COMPLETED in 2.34s
```

**Why:** Allows Claude to see real-time progress without polling.

---

### 4. ✅ MEDIUM: Change default `force_full_read` to `true`

**Problem (if caching remains):** 95% of calls use `force_full_read=true`, causing wasted API calls.

**Note:** If we remove caching entirely (change #1), this becomes obsolete.

---

### 5. ✅ MEDIUM: Improve tool descriptions with WARNING banners

**Problem:** Claude confuses `insert_tmux_pane_text` with command execution.

**Solution:** Update docstrings:

```typescript
// insert_tmux_pane_text
description: `⚠️ WARNING: This tool is for TYPING TEXT ONLY (like into vim/nano).
⚠️ For executing commands (bash, SQL, Python), use execute instead!

Use cases for this tool:
- Typing text into an editor (vim, nano)
- Entering input into interactive prompts
- Sending text that should NOT be executed immediately`

// execute
description: `Execute command and WAIT for completion - DO NOT respond to user before tool returns!

⚠️ CRITICAL: This tool BLOCKS until command completes (up to 10s default).
⚠️ DO NOT write any response to user until this tool returns with results!
⚠️ The tool WILL wait - you don't need to say "command is running, I'll wait".
⚠️ Just call the tool and WAIT SILENTLY for results, then report them.`
```

---

### 6. ✅ LOW: Date-based versioning

**Problem:** Semantic versioning doesn't reflect actual build date/time.

**Solution:**
- Change version format to `vYYYY-MM-DD build HHMMSS`
- Auto-generate from file modification time
- Example: `v2025-11-08 build 125347`

---

## Implementation Priority

1. **Remove caching** (most critical - fixes stale data)
2. **Add progress reporting** (critical - fixes "waiting" confusion)
3. **Rename execute_and_wait → execute** (high priority - API simplification)
4. **Improve descriptions** (medium - better UX)
5. **Date versioning** (low - cosmetic)

---

## Testing Requirements

After changes:
1. Test `execute` with various commands (quick & long-running)
2. Verify STDERR progress appears in Claude Code logs
3. Test `read_tmux_pane` returns fresh content always
4. Test `insert_tmux_pane_text` for typing into editors
5. Verify version auto-updates on build

---

## Python Version Status

**Decision:** Abandon Python version, use TypeScript version exclusively.

**Reason:**
- TypeScript has official MCP SDK (`@modelcontextprotocol/sdk`)
- Python lacks MCP protocol support (no `initialize` handshake)
- Claude Code requires full MCP protocol

**Action:** Port improvements from Python to TypeScript, archive Python version.
