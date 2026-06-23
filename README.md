# MCP Tmux Server

MCP (Model Context Protocol) server for real-time tmux terminal interaction. Enables AI assistants like Claude Code to execute commands and read terminal output.

## Prerequisites

**IMPORTANT:** Claude Code (or any MCP client) **must run inside a tmux session** to use the background callback feature. The callback notification is delivered via `tmux send-keys` to the client's session.

```bash
# Start Claude Code in a tmux session
tmux new -s claude
claude   # start Claude Code inside the tmux session
```

Without tmux, the `execute` tool still works for short commands (synchronous mode), but background monitoring callbacks cannot be delivered. If callback delivery fails, an error message is printed in the source tmux session where the command was running.

## Features

- **Session prefix resolution** - use short prefix instead of full name (e.g. `sudo` → `sudo-0`); ambiguous prefix returns error with candidates
- **Synchronous execution** - blocks until command completes (up to 10s default)
- **Background monitoring with callback** - long-running commands are monitored asynchronously; notification sent when done
- **Quiet callback delivery** - waits 10s of inactivity before sending, never interrupts user typing
- **Real-time terminal reading** - NO CACHING, always fresh content
- **Keyboard shortcuts** - send Ctrl+C, Ctrl+D, arrows, function keys
- **Text input** - type text into interactive programs (editors, prompts)
- **Session management** - list, inspect, and create tmux sessions
- **Security** - read-only by default, session whitelist support

## Installation

```bash
cd ~/mcp-servers
git clone git@github.com:Zdendys79/mcp-tmux-server.git tmux
cd tmux
npm install
npm run build
```

Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "tmux": {
      "command": "node",
      "args": ["/home/zdendys/mcp-servers/tmux/dist/index.js"]
    }
  }
}
```

Enable write mode in `~/.config/mcp-tmux/config.json`:
```json
{
  "version": "auto",
  "write_enabled": true,
  "allowed_sessions": [],
  "buffer_size": 1000,
  "auth_token": null
}
```

## Quick Start

```typescript
// Short command - synchronous
const result = await execute({session: "work", command: "ls -la"});

// Long command - background monitoring with callback
const result = await execute({
  session: "base7",
  command: "sudo apt upgrade -y",
  timeout: 10,
  callback_session: "claude-9",
  max_monitor: 600
});
// Returns immediately with status: "background"
// Notification sent to claude-9 session when done
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `execute` | Execute command and wait (sync) or monitor (async with callback) |
| `read_tmux_pane` | Read current terminal content (always fresh) |
| `insert_tmux_pane_text` | Type text into editors/prompts (NOT for commands) |
| `send_keys_tmux` | Send keyboard shortcuts (Ctrl+C, arrows, etc.) |
| `get_tmux_sessions` | List all active tmux sessions with status |
| `get_pane_info` | Get pane dimensions, running command |
| `list_background_tasks` | List active background task monitors |
| `get_server_version` | Get server version |
| `create_session` | Create new tmux session with auto-increment naming |

## Documentation

- **[Tools Reference](https://github.com/Zdendys79/mcp-tmux-server/blob/main/docs/TOOLS.md)** - Full parameter and return value documentation for all tools
- **[Architecture](https://github.com/Zdendys79/mcp-tmux-server/blob/main/docs/ARCHITECTURE.md)** - Data flow, prompt detection, background callback, security, configuration
- **[Changelog](https://github.com/Zdendys79/mcp-tmux-server/blob/main/docs/CHANGELOG.md)** - Version history and release notes

## Troubleshooting

**MCP server not starting:**
```bash
tmux -V          # Check tmux is installed
node dist/index.js  # Test server manually
```

**Commands not executing:**
- Check `write_enabled: true` in config
- Verify session exists: `tmux list-sessions`
- Check `allowed_sessions` whitelist if set

**Callback not delivered:**
- Ensure Claude Code runs inside tmux: `tmux new -s claude`
- Check `list_background_tasks` for active monitors
- Error message appears in source terminal if delivery fails

## Development

```bash
npm install      # Install dependencies
npm run build    # Build TypeScript
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js  # Test
```

## License

MIT License

## Author

Created by Zdendys & Nyara for Claude Code integration

## Links

- **GitHub:** https://github.com/Zdendys79/mcp-tmux-server
- **MCP Protocol:** https://modelcontextprotocol.io/
- **MCP SDK:** https://github.com/modelcontextprotocol/typescript-sdk
