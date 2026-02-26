# Architecture

## File Structure

```
tmux/
├── src/
│   ├── index.ts          # MCP server entry point: tool schemas, handlers, startup (~560 lines)
│   ├── tmux.ts           # Low-level tmux operations: exec, capture, sessions, keys (~270 lines)
│   ├── prompt.ts         # Prompt detection patterns, safety checks, fingerprinting (~130 lines)
│   ├── execute.ts        # executeAndWait, tryWrite with safety and rate limiting (~240 lines)
│   └── background.ts     # Background task monitoring with async callbacks (~130 lines)
├── dist/                 # Compiled JavaScript
├── docs/
│   ├── TOOLS.md          # MCP tools reference
│   ├── ARCHITECTURE.md   # This file
│   └── CHANGELOG.md      # Version history
├── tools/
│   └── version-generator.js  # Auto-generates version from git
├── package.json
├── tsconfig.json
├── README.md             # Main documentation
└── .gitignore
```

## Modules

**`index.ts`** - MCP Server entry point
- MCP protocol handler using `@modelcontextprotocol/sdk`
- Stdio communication (reads stdin, writes stdout)
- Tool registration (ListTools) and routing (CallTool)
- Git version check at startup (compares local HEAD vs origin/main)
- Progress reporting via STDERR

**`tmux.ts`** - Low-level tmux operations
- `execTmux()` - spawn tmux process
- `capturePane()` - capture pane content
- `sendKeys()` / `sendCommand()` - send text/commands to panes
- `listSessions()` - list sessions with enriched info (status, environment, user@host)
- `createSessionWithAutoIncrement()` - auto-numbered session creation

**`prompt.ts`** - Prompt detection and safety
- Prompt patterns (`$`, `#`, `>`, `]`, `bash-X.Y$`)
- Danger patterns (password prompts, confirmations)
- `waitForStablePrompt()` - ensures 2s stability before sending commands
- `contentFingerprint()` - last 5 non-empty lines for change detection

**`execute.ts`** - Command execution
- `executeAndWait()` - send command, poll for completion with fingerprint + prompt detection
- `tryWrite()` - safe text input with rate limiting (10s cooldown)

**`background.ts`** - Background task monitoring
- `monitorAndNotify()` - poll every 2s, detect prompt, deliver callback
- `waitForQuietCallback()` - wait 10s of silence before delivering
- `deliverCallback()` - send via sendKeys, fallback to source pane on failure

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
