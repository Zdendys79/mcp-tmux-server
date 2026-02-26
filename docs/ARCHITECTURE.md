# Architecture

## File Structure

```
tmux/
├── src/
│   └── index.ts            # Main MCP server (~1150 lines, single file)
├── dist/
│   └── index.js           # Compiled JavaScript
├── docs/
│   ├── TOOLS.md           # MCP tools reference
│   ├── ARCHITECTURE.md    # This file
│   └── CHANGELOG.md       # Version history
├── tools/
│   └── new-session.sh     # Helper script for session creation
├── package.json
├── tsconfig.json
├── README.md              # Main documentation
├── STATUS.md              # Project status
└── .gitignore
```

## Components

**MCP Server (`index.ts`)**
- MCP protocol handler using `@modelcontextprotocol/sdk`
- Stdio communication (reads stdin, writes stdout)
- Tool registration and routing
- Tmux command execution (inline, no separate manager)
- Background task monitoring with callback notifications
- Configuration management
- Session whitelist enforcement
- Progress reporting via STDERR

## Data Flow

```
AI calls execute(session="foo", command="ls", callback_session="claude-9")
    |
MCP Server execute handler
    |-- waitForStablePrompt() - waits for prompt to be unchanged for 2s
    |   |-- Reads last line every 200ms
    |   |-- If prompt detected and stable for 2s -> proceed
    |   |-- If prompt keeps changing -> retry (up to 10s total)
    |   +-- After 10s without stable prompt -> return BUSY error
    |-- Sends command to tmux (only if prompt stable!)
    |-- Polls every 100ms for output + prompt detection
    |-- Writes progress to STDERR
    |-- If completed within timeout -> returns output to AI
    +-- If timeout AND callback_session set:
        |-- Returns {status: "background"} immediately
        +-- Starts monitorAndNotify() (fire-and-forget):
            |-- Polls target pane every 2s for prompt
            |-- On completion: waitForQuietCallback(10s) -> sendKeys notification
            |-- On timeout: same with timeout message
            +-- On delivery failure: echo error in source terminal
    |
AI receives results (sync or background) and continues working
```

## Stable Prompt Detection

The `waitForStablePrompt()` function ensures commands are only sent when the terminal is truly ready:

1. **Reads last line** of pane content
2. **Checks for prompt** patterns: `$`, `#`, `>`, `]`, `bash-X.Y$`
3. **Waits 2 seconds** - if prompt unchanged, session is SAFE
4. **Retries up to 10s** - if prompt keeps changing (user typing, output scrolling)
5. **Returns BUSY** - if no stable prompt within 10s

This prevents:
- Interrupting user input (typing in terminal)
- Sending commands while another command is running
- False BUSY errors from `pane_current_command` (e.g., "sudo" when `sudo bash` is idle)

## Background Callback Flow

When `execute` is called with `callback_session` and the command exceeds timeout:

1. `executeAndWait()` returns with `status: "incomplete"`
2. A `BackgroundTask` is created and stored in memory
3. `monitorAndNotify()` starts as fire-and-forget async function
4. Every 2s, it reads the target pane and checks for prompt
5. When prompt detected (command finished):
   - `waitForQuietCallback()` monitors callback pane for 10s of silence
   - This ensures user is not actively typing
   - Notification is sent via `sendKeys()` with Enter
6. If callback delivery fails (session doesn't exist):
   - Error message is echoed in the source terminal where command ran
   - User sees: `[MCP tmux] CALLBACK FAILED: ... Run Claude Code in tmux!`

## Progress Reporting (STDERR)

Execute function writes to STDERR during execution:
```
[MCP execute] Command started: npm install
[MCP execute] Still running... (1.0s)
[MCP execute] Still running... (2.0s)
[MCP execute] Command COMPLETED in 2.34s
```

## Security

- **Read-only by default** - Write mode must be explicitly enabled
- **Session whitelist** - Restrict access to specific tmux sessions
- **No shell injection** - All commands use subprocess with array args (never `shell: true`)
- **Timeout limits** - Maximum 300s timeout to prevent indefinite blocking
- **No credential exposure** - Never logs or returns passwords/tokens

## Configuration

**Config file location:** `~/.config/mcp-tmux/config.json`

```json
{
  "version": "auto",
  "write_enabled": true,
  "allowed_sessions": [],
  "buffer_size": 1000,
  "auth_token": null
}
```

- `write_enabled` (bool) - Enable command execution and text input (default: false)
- `allowed_sessions` (array) - Whitelist of allowed session names (empty = allow all)
- `buffer_size` (int) - Reserved for future use
- `auth_token` (string) - Reserved for future authentication
