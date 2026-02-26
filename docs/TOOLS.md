# MCP Tools Reference

Complete reference for all tools provided by the MCP Tmux Server.

## `execute` - Execute command and wait for completion

**CRITICAL:** This tool BLOCKS until command completes. Do NOT respond to user before tool returns!

**Description:**
Executes command in tmux pane and waits synchronously for completion (up to 10 seconds by default). Returns all command output. Progress is reported to STDERR during execution. If `callback_session` is set and command exceeds timeout, monitoring continues in background.

**Parameters:**
- `session` (string, required) - Tmux session name
- `command` (string, required) - Command to execute
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index
- `timeout` (int, default: 10, max: 300) - Timeout in seconds
- `callback_session` (string, optional) - Tmux session to notify when command completes (e.g. `claude-9`). If set and command doesn't finish within timeout, monitoring continues in background and notification is sent via `tmux send-keys` when done.
- `max_monitor` (int, default: 600) - Max background monitoring time in seconds. Only used with `callback_session`.

**Returns (completed):**
```json
{
  "target": "session-1:0.0",
  "command": "ls -la",
  "status": "completed",
  "success": true,
  "output": ["total 48", "drwxrwxr-x 3 user user 4096 ..."],
  "execution_time_ms": 520,
  "prompt_detected": true
}
```

**Returns (background - command still running):**
```json
{
  "target": "base7-19:0.0",
  "command": "sudo apt upgrade -y",
  "status": "background",
  "task_id": "bg-1",
  "callback_target": "claude-9:0.0",
  "max_monitor_seconds": 600,
  "message": "Command still running. Monitoring in background. Will notify claude-9 when done."
}
```

**Callback notification format (sent to Claude's tmux session):**
```
[tmux:base7-19:0.0:done] Command: "sudo apt upgrade -y" finished in 125s | Started: 14:32:05 | Finished: 14:34:10
Output:
(last 5 lines of output)
```

**Quiet detection:** Before sending the callback, the server waits for 10s of inactivity on the callback pane. This prevents interrupting the user while typing.

**Example:**
```typescript
// Short command - synchronous, blocks until done
const result = await execute({session: "work", command: "ls -la"});

// Long command - returns immediately, notifies when done
const result = await execute({
  session: "base7",
  command: "sudo apt upgrade -y",
  timeout: 10,
  callback_session: "claude-9",
  max_monitor: 600
});
// result.status === "background" - Claude continues working
// When done, notification appears in claude-9 session
```

---

## `read_tmux_pane` - Read current pane content

**Description:**
Reads FRESH content from tmux pane - NO CACHING, always returns current state. Use this to check terminal output at any time.

**Parameters:**
- `session` (string, required) - Tmux session name
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index

**Returns:**
```json
{
  "target": "session-1:0.0",
  "lines": [
    "user@host:~/project$ ls",
    "file1.txt  file2.txt  README.md",
    "user@host:~/project$ "
  ],
  "total_lines": 3,
  "timestamp": "2025-11-08T12:34:56.789"
}
```

---

## `insert_tmux_pane_text` - Type text into pane

**WARNING:** This tool is for TYPING TEXT ONLY (like into vim/nano). For executing commands, use `execute` instead!

**Description:**
Simulates typing text into tmux pane. Does NOT wait for completion or capture output. Use only for interactive text input (editors, prompts), NOT for command execution.

**Parameters:**
- `session` (string, required) - Tmux session name
- `text` (string, required) - Text to type
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index

---

## `send_keys_tmux` - Send keyboard shortcuts

**Description:**
Sends special keys and keyboard shortcuts to tmux pane. Use for control keys, arrows, function keys.

**Parameters:**
- `session` (string, required) - Tmux session name
- `keys` (string, required) - Key or key combination to send
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index

**Supported keys:**
- **Control keys:** `C-c` (Ctrl+C), `C-u`, `C-k`, `C-w`, `C-a`, `C-e`, `C-l`, `C-d`, `C-z`
- **Special keys:** `Enter`, `Escape`, `Tab`, `BSpace`, `Space`
- **Arrow keys:** `Up`, `Down`, `Left`, `Right`
- **Function keys:** `F1` through `F12`

---

## `get_tmux_sessions` - List active tmux sessions

**Description:**
Returns list of all active tmux sessions with status (idle/busy), running command, user@host, environment type, and current working directory. Filtered by `allowed_sessions` config if set.

**Parameters:** None

---

## `get_pane_info` - Get detailed pane information

**Description:**
Returns detailed information about specific tmux pane including dimensions, running command, and active state.

**Parameters:**
- `session` (string, required) - Tmux session name
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index

---

## `list_background_tasks` - List monitored background tasks

**Description:**
Lists all currently monitored background tasks (commands waiting for completion with callback). Shows task ID, target session, command, callback target, and elapsed time.

**Parameters:** None

**Returns:**
```json
{
  "tasks": [
    {
      "id": "bg-1",
      "target": "base7-19:0.0",
      "command": "sudo apt upgrade -y",
      "callback_target": "claude-9:0.0",
      "started_at": "2026-02-26T14:32:05.000Z",
      "running_for_seconds": 45,
      "max_wait_seconds": 600
    }
  ],
  "count": 1
}
```

---

## `get_server_version` - Get server version

**Description:**
Returns MCP server version based on file modification time.

**Parameters:** None
