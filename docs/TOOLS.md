# MCP Tools Reference

Complete reference for all tools provided by the MCP Tmux Server.

## `run_wait` - Run a SHORT command and block for the result

**CRITICAL:** This tool BLOCKS until the command completes or the timeout elapses. Do NOT respond to user before tool returns! Timeout is HARD-CAPPED at 120s server-side no matter what you pass -- it can never block for hours because of a units mistake or misjudged duration. If a command might take longer than ~1 minute, or never returns a prompt (a server holder, an infinite loop), use `run_background` instead.

**Description:**
Runs a command in a tmux pane and waits synchronously for completion (up to 10 seconds by default, 120s hard cap). Returns all command output. Progress is reported to STDERR during execution.

**Parameters:**
- `session` (string, required) - Tmux session name
- `command` (string, required) - Command to run
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index
- `timeout` (int, default: 10, HARD CAP 120) - Timeout in seconds

**Returns:**
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

**Example:**
```typescript
const result = await run_wait({session: "work", command: "ls -la"});
```

---

## `run_background` - Run a LONG-RUNNING command WITHOUT blocking

**Description:**
Sends a command, waits a short grace period (default 10s) to catch immediate failures, then returns control immediately either way -- it does NOT wait for the command to finish. `callback_session` is REQUIRED: when the command's prompt actually returns (even hours later), a notification with its output is delivered there via `tmux send-keys`. Use this for server holders, training/recording loops, or anything that runs for minutes+ or never returns on its own.

**Parameters:**
- `session` (string, required) - Tmux session name where the command will run
- `command` (string, required) - Command to run
- `callback_session` (string, **required**) - Tmux session to notify when the command completes (e.g. `claude-9`)
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index
- `grace_seconds` (int, default: 10) - Short initial blocking window to catch fast failures
- `max_monitor` (int, default: 600) - Max background monitoring time in seconds before giving up (raise for multi-hour jobs, e.g. 14400 = 4h)

**Returns (finished within the grace period):** same shape as `run_wait`'s result.

**Returns (still running after the grace period):**
```json
{
  "target": "base7-19:0.0",
  "command": "sudo apt upgrade -y",
  "status": "background",
  "task_id": "bg-1",
  "callback_target": "claude-9",
  "max_monitor_seconds": 600,
  "message": "Command still running after 10s. NOT blocking further -- monitoring in background, will notify claude-9 when done (or after 600s)."
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
const result = await run_background({
  session: "base7",
  command: "sudo apt upgrade -y",
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

## `type_text` - Type text into pane

**WARNING:** This tool is for TYPING TEXT ONLY (like into vim/nano). For running commands, use `run_wait` (short, blocks for result) or `run_background` (long-running, notifies when done) instead!

**Description:**
Simulates typing text into tmux pane. Does NOT wait for completion or capture output. Use only for interactive text input (editors, prompts), NOT for command execution.

**Parameters:**
- `session` (string, required) - Tmux session name
- `text` (string, required) - Text to type
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index

---

## `send_key` - Send keyboard shortcuts

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
      "callback_target": "claude-9",
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
