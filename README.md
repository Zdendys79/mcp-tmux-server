# MCP Tmux Server

MCP (Model Context Protocol) server for real-time tmux terminal interaction. Enables AI assistants like Claude Code to execute commands and read terminal output.

## Features

### ✅ Command Execution
- **Synchronous execution** - blocks until command completes (up to 10s default)
- **Progress reporting** - real-time STDERR updates during execution
- **Output capture** - returns all command output
- **Prompt detection** - automatically detects when command finishes

### ✅ Real-Time Terminal Reading
- **NO CACHING** - always returns fresh, current terminal state
- **Multiple sessions** - monitor multiple tmux sessions simultaneously
- **Session management** - list and inspect active tmux sessions

### ✅ Advanced Controls
- **Keyboard shortcuts** - send Ctrl+C, Ctrl+D, arrows, function keys
- **Text input** - type text into interactive programs (editors, prompts)
- **Session whitelist** - restrict access to specific tmux sessions

## Installation

```bash
# Clone repository
cd ~/mcp-servers
git clone git@github.com:Zdendys79/mcp-tmux-server.git tmux
cd tmux

# Install dependencies and build
npm install
npm run build

# Configure Claude Code MCP
# Add to ~/.claude.json:
{
  "mcpServers": {
    "tmux": {
      "command": "node",
      "args": ["/home/zdendys/mcp-servers/tmux/dist/index.js"]
    }
  }
}

# Enable write mode (required for command execution)
# Create config file: ~/.config/mcp-tmux/config.json
{
  "version": "auto",
  "write_enabled": true,
  "allowed_sessions": [],
  "buffer_size": 1000,
  "auth_token": null
}
```

## MCP Tools Reference

### `execute` - Execute command and wait for completion

**CRITICAL:** This tool BLOCKS until command completes. Do NOT respond to user before tool returns!

**Description:**
Executes command in tmux pane and waits synchronously for completion (up to 10 seconds by default). Returns all command output. Progress is reported to STDERR during execution.

**Parameters:**
- `session` (string, required) - Tmux session name
- `command` (string, required) - Command to execute
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index
- `timeout` (int, default: 10, max: 300) - Timeout in seconds

**Returns:**
```json
{
  "target": "session-1:0.0",
  "command": "ls -la",
  "completed": true,
  "timeout_occurred": false,
  "elapsed_seconds": 0.52,
  "output_lines": [
    "total 48",
    "drwxrwxr-x 3 user user 4096 Nov  8 12:00 .",
    "drwxrwxr-x 9 user user 4096 Nov  8 11:00 .."
  ],
  "timestamp": "2025-11-08T12:34:56.789"
}
```

**STDERR Progress Messages:**
```
[MCP execute] Command started: ls -la
[MCP execute] ✓ Command COMPLETED in 0.52s
```

**Example:**
```typescript
// ✅ CORRECT - call tool, wait silently, then report results
const result = await execute({session: "work", command: "npm install"});
console.log(`Installation completed in ${result.elapsed_seconds}s`);

// ❌ WRONG - don't say "waiting" - tool already waits!
execute({session: "work", command: "npm install"});
console.log("Command is running, waiting for completion...");  // NO!
```

---

### `read_tmux_pane` - Read current pane content

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

**Example:**
```typescript
// Read current terminal state
const content = await read_tmux_pane({session: "monitoring"});
const lastLine = content.lines[content.lines.length - 1];
console.log(`Current prompt: ${lastLine}`);
```

---

### `insert_tmux_pane_text` - Type text into pane

**⚠️ WARNING:** This tool is for TYPING TEXT ONLY (like into vim/nano). For executing commands, use `execute` instead!

**Description:**
Simulates typing text into tmux pane. Does NOT wait for completion or capture output. Use only for interactive text input (editors, prompts), NOT for command execution.

**Parameters:**
- `session` (string, required) - Tmux session name
- `text` (string, required) - Text to type
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index

**Returns:**
```json
{
  "target": "session-1:0.0",
  "sent": "Hello World\n",
  "timestamp": "2025-11-08T12:34:56.789"
}
```

**Use cases:**
- Typing into text editors (vim, nano)
- Entering input at interactive prompts
- Sending text that should NOT be executed

**Example:**
```typescript
// ✅ CORRECT - typing into vim
await insert_tmux_pane_text({session: "edit", text: "i"});  // Enter insert mode
await insert_tmux_pane_text({session: "edit", text: "Hello World"});  // Type text

// ❌ WRONG - use execute for commands!
await insert_tmux_pane_text({session: "work", text: "ls -la\n"});  // NO! Use execute instead
```

---

### `send_keys_tmux` - Send keyboard shortcuts

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

**Returns:**
```json
{
  "target": "session-1:0.0",
  "keys": "C-c",
  "timestamp": "2025-11-08T12:34:56.789"
}
```

**Examples:**
```typescript
// Interrupt running process
await send_keys_tmux({session: "work", keys: "C-c"});

// Clear current line
await send_keys_tmux({session: "work", keys: "C-u"});

// Clear screen
await send_keys_tmux({session: "work", keys: "C-l"});

// Navigate command history
await send_keys_tmux({session: "work", keys: "Up"});
```

---

### `get_tmux_sessions` - List active tmux sessions

**Description:**
Returns list of all active tmux sessions. Filtered by `allowed_sessions` config if set.

**Parameters:** None

**Returns:**
```json
{
  "sessions": [
    {
      "name": "work",
      "windows": 3,
      "panes": 1
    },
    {
      "name": "monitoring",
      "windows": 1,
      "panes": 1
    }
  ],
  "count": 2
}
```

**Example:**
```typescript
const sessions = await get_tmux_sessions();
for (const session of sessions.sessions) {
  console.log(`Session: ${session.name} (${session.windows} windows)`);
}
```

---

### `get_pane_info` - Get detailed pane information

**Description:**
Returns detailed information about specific tmux pane including dimensions, running command, and prompt detection.

**Parameters:**
- `session` (string, required) - Tmux session name
- `window` (int, default: 0) - Window index
- `pane` (int, default: 0) - Pane index

**Returns:**
```json
{
  "target": "session-1:0.0",
  "width": 120,
  "height": 40,
  "command": "bash",
  "active": true
}
```

**Example:**
```typescript
const info = await get_pane_info({session: "work"});
console.log(`Pane size: ${info.width}x${info.height}`);
console.log(`Running: ${info.command}`);
```

---

### `get_server_version` - Get server version and status

**Description:**
Returns MCP server version, capabilities, and current configuration.

**Parameters:** None

**Returns:**
```json
{
  "version": "v2025-11-08 build 125023",
  "write_enabled": true,
  "tmux_available": true,
  "config_path": "/home/user/.config/mcp-tmux/config.json"
}
```

---

## Configuration

**Config file location:** `~/.config/mcp-tmux/config.json`

**Default configuration:**
```json
{
  "version": "auto",
  "write_enabled": false,
  "allowed_sessions": [],
  "buffer_size": 1000,
  "auth_token": null
}
```

**Configuration options:**

- `write_enabled` (bool) - Enable command execution and text input (default: false)
- `allowed_sessions` (array) - Whitelist of allowed session names (empty = allow all)
- `buffer_size` (int) - Reserved for future use (buffering should be disabled)
- `auth_token` (string) - Reserved for future authentication

**Example with restrictions:**
```json
{
  "version": "auto",
  "write_enabled": true,
  "allowed_sessions": ["work", "monitoring", "dev"],
  "buffer_size": 1000,
  "auth_token": null
}
```

---

## Usage Examples

### Basic command execution

```typescript
// Execute command and get output
const result = await execute({session: "work", command: "ls -la"});
console.log(`Files: ${result.output_lines.length} lines`);
console.log(`Completed in ${result.elapsed_seconds}s`);
```

### Monitor long-running process

```typescript
// Start long process
await execute({session: "build", command: "npm run build", timeout: 300});

// Check progress
const content = await read_tmux_pane({session: "build"});
console.log(content.lines.slice(-5));  // Last 5 lines
```

### Interactive session

```typescript
// Start Python REPL
await execute({session: "repl", command: "python3"});

// Type code (not execute - just typing!)
await insert_tmux_pane_text({session: "repl", text: "import sys\n"});
await insert_tmux_pane_text({session: "repl", text: "print(sys.version)\n"});

// Read output
const content = await read_tmux_pane({session: "repl"});
```

### Error handling

```typescript
// Execute with timeout
const result = await execute({session: "work", command: "sleep 20", timeout: 5});

if (result.timeout_occurred) {
  console.log("Command timed out!");
  await send_keys_tmux({session: "work", keys: "C-c"});  // Interrupt
} else {
  console.log("Command completed successfully");
}
```

---

## Architecture Details

### File Structure
```
tmux/
├── src/
│   └── index.ts            # Main MCP server (~1000 lines, single file)
├── dist/
│   └── index.js           # Compiled JavaScript
├── tools/
│   └── new-session.sh     # Helper script for session creation
├── package.json
├── tsconfig.json
├── README.md
├── STATUS.md              # Project status and completed improvements
└── .gitignore
```

### Components

**MCP Server (`index.ts`)**
- MCP protocol handler using `@modelcontextprotocol/sdk`
- Stdio communication (reads stdin, writes stdout)
- Tool registration and routing
- Tmux command execution (inline, no separate manager)
- Configuration management
- Session whitelist enforcement
- Progress reporting via STDERR

### Data Flow

```
User types in tmux → command finishes
    ↓
AI calls execute(session="foo", command="ls")
    ↓
MCP Server execute handler
    ├─ waitForStablePrompt() - waits for prompt to be unchanged for 2s
    │   ├─ Reads last line every 200ms
    │   ├─ If prompt detected and stable for 2s → proceed
    │   ├─ If prompt keeps changing → retry (up to 10s total)
    │   └─ After 10s without stable prompt → return BUSY error
    ├─ Sends command to tmux (only if prompt stable!)
    ├─ Polls every 100ms for output
    ├─ Writes progress to STDERR
    ├─ Detects prompt return (command finished)
    └─ Returns output to AI
    ↓
AI receives results and reports to user
```

### Stable Prompt Detection

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

### Progress Reporting (STDERR)

Execute function should write to STDERR during execution:
```
[MCP execute] Command started: npm install
[MCP execute] Still running... (1.0s)
[MCP execute] Still running... (2.0s)
[MCP execute] ✓ Command COMPLETED in 2.34s
```

This allows Claude Code to see real-time progress without needing to poll.

---

## Security

- **Read-only by default** - Write mode must be explicitly enabled
- **Session whitelist** - Restrict access to specific tmux sessions
- **No shell injection** - All commands use subprocess with array args (never `shell: true`)
- **Timeout limits** - Maximum 300s timeout to prevent indefinite blocking
- **No credential exposure** - Never logs or returns passwords/tokens

---

## Troubleshooting

### MCP server not starting
```bash
# Check tmux is installed
tmux -V

# Test server manually
cd ~/mcp-servers/tmux
node dist/index.js
```

### Commands not executing
- Check `write_enabled: true` in `~/.config/mcp-tmux/config.json`
- Verify session exists: `tmux list-sessions`
- Check session is in `allowed_sessions` if whitelist is set

### Output issues
- Server always returns fresh content (no caching)
- If issues persist, try reconnecting MCP server or restart Claude Code

---

## Version History

**Version Format:** `vYYYY-MM-DD build HHMMSS`

### Current Version (v2026-02-15)
- **`send_keys_tmux` tool** - New MCP tool for sending keyboard shortcuts (Ctrl+C, arrows, function keys)
- **Rewritten `executeAndWait`** - Single poll loop with fingerprint-based change detection (last 5 non-empty lines), fixes false timeout on fast commands with (venv) prompt
- **100ms initial delay** after `sendCommand()` - fixes race condition where tmux hasn't processed keys yet
- **Root prompt fix** - `waitForStablePrompt` now filters trailing empty lines, fixing `#` prompt detection
- **Consistent prompt detection** - output extraction uses `isPromptLine()` instead of separate regex
- **Documentation cleanup** - Fixed tool name references, updated architecture info

### v2026-01-22
- **STABLE PROMPT DETECTION** - `execute` and `insert` now wait for prompt to be STABLE (unchanged for 2s) before sending commands
- Removed unreliable `pane_current_command` check - no more false BUSY errors when running `sudo bash`
- Prompt detection is now the ONLY method to determine if session is ready
- Max wait time: 10s before returning BUSY (with retry loop)
- Fixed: `tryWrite()` now properly blocks when safety check fails

### v2025-11-08
- Full TypeScript implementation with MCP SDK
- No caching - always returns fresh terminal content
- `execute` tool with STDERR progress reporting
- Date-based versioning (auto-generated from build time)
- Default timeout: 10s
- Clear WARNING banners in tool descriptions
- Clean codebase (829 lines, no dead code)

### Features
- Execute commands with automatic completion detection
- **Stable prompt detection** - waits for prompt to be unchanged for 2s before sending
- Real-time progress reporting via STDERR
- Read fresh terminal content (no caching)
- Type text into interactive programs
- Send keyboard shortcuts (Ctrl+C, arrows, etc.)
- Session management with auto-increment naming
- Security: read-only by default, session whitelist support

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test manually
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js
```

---

## License

MIT License

## Author

Created by Zdendys & Nyara for Claude Code integration

## Links

- **GitHub:** https://github.com/Zdendys79/mcp-tmux-server
- **MCP Protocol:** https://modelcontextprotocol.io/
- **MCP SDK:** https://github.com/modelcontextprotocol/typescript-sdk
