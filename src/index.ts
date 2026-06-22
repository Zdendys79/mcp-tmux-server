#!/usr/bin/env node

// MCP Tmux Server - Entry point
// Tool schemas, handlers, and server startup

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

import { execTmux, capturePane, getPaneInfo, sendKeys, listSessions, createSessionWithAutoIncrement, resolveSession } from "./tmux.js";
import { tryWrite, executeAndWait } from "./execute.js";
import { BackgroundTask, backgroundTasks, nextTaskId, monitorAndNotify } from "./background.js";

const execFileAsync = promisify(execFile);

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const VERSION = packageJson.version || "unknown";

// Git version check - stores update notice for first tool call
let updateNotice: string | null = null;
let updateCheckDone = false;

async function checkGitVersion(): Promise<void> {
  const repoDir = join(__dirname, "..");
  try {
    // Fetch latest from remote (silent, timeout 10s)
    await execFileAsync("git", ["-C", repoDir, "fetch", "--quiet"], { timeout: 10000 });

    // Compare local HEAD vs origin/main
    const { stdout: localHash } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"]);
    const { stdout: remoteHash } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "origin/main"]);

    if (localHash.trim() !== remoteHash.trim()) {
      // Get remote commit info
      const { stdout: remoteLog } = await execFileAsync("git", ["-C", repoDir, "log", "--oneline", "HEAD..origin/main"]);
      const commitCount = remoteLog.trim().split("\n").filter(l => l).length;
      updateNotice = `[MCP tmux] UPDATE AVAILABLE: ${commitCount} new commit(s) on origin/main. Run: cd ${repoDir} && git pull && npm run build`;
      console.error(updateNotice);
    }
  } catch (_e) {
    // Git check failed silently - not critical
  }
  updateCheckDone = true;
}

// Inject update notice into first tool response if available
function consumeUpdateNotice(): string | null {
  if (updateNotice) {
    const notice = updateNotice;
    updateNotice = null;
    return notice;
  }
  return null;
}

// Create MCP server
const server = new Server(
  {
    name: "tmux-mcp-server",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "read_tmux_pane",
        description:
          "Read current content from tmux pane. Returns all visible lines in the terminal.",
        inputSchema: {
          type: "object",
          properties: {
            session: {
              type: "string",
              description: "Tmux session name",
            },
            window: {
              type: "number",
              description: "Window index (default: 0)",
            },
            pane: {
              type: "number",
              description: "Pane index (default: 0)",
            },
          },
          required: ["session"],
        },
      },
      {
        name: "insert_tmux_pane_text",
        description: "⚠️ WARNING: This tool is for TYPING TEXT ONLY (like into vim/nano).\n⚠️ For executing commands (bash, SQL, Python), use execute instead!\n\nUse cases for this tool:\n- Typing text into an editor (vim, nano)\n- Entering input into interactive prompts\n- Sending text that should NOT be executed immediately",
        inputSchema: {
          type: "object",
          properties: {
            session: {
              type: "string",
              description: "Tmux session name",
            },
            window: {
              type: "number",
              description: "Window index (default: 0)",
            },
            pane: {
              type: "number",
              description: "Pane index (default: 0)",
            },
            text: {
              type: "string",
              description: "Text to insert (use \\n for newline)",
            },
          },
          required: ["session", "text"],
        },
      },
      {
        name: "get_tmux_sessions",
        description: "List all active tmux sessions with status (idle/busy), running command, user@host, environment type (shell/venv/mysql/python/ssh...), and current working directory.\n\nIMPORTANT: Always call this BEFORE creating a new session or executing commands. Pick an existing idle session instead of creating new ones. Only create a new session if ALL existing sessions are busy.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_pane_info",
        description: "Get detailed information about a specific pane",
        inputSchema: {
          type: "object",
          properties: {
            session: {
              type: "string",
              description: "Tmux session name",
            },
            window: {
              type: "number",
              description: "Window index (default: 0)",
            },
            pane: {
              type: "number",
              description: "Pane index (default: 0)",
            },
          },
          required: ["session"],
        },
      },
      {
        name: "create_session",
        description: "Create new tmux session with auto-increment naming.\n\n⚠️ WARNING: Do NOT create new sessions if idle sessions already exist! Call get_tmux_sessions first and reuse an existing idle session. Only create a new session when ALL sessions are busy and you need a parallel workspace.",
        inputSchema: {
          type: "object",
          properties: {
            prefix: {
              type: "string",
              description: "Session name prefix (default: 'session')",
            },
            command: {
              type: "string",
              description: "Command to run in session (default: bash)",
            },
          },
        },
      },
      {
        name: "get_server_version",
        description: "Get MCP server version (based on file modification time)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "send_keys_tmux",
        description: "Send keyboard shortcuts to tmux pane. Use for Ctrl+C, Ctrl+D, arrows, function keys.\n\nSupported keys:\n- Control: C-c, C-u, C-k, C-w, C-a, C-e, C-l, C-d, C-z\n- Special: Enter, Escape, Tab, BSpace, Space\n- Arrows: Up, Down, Left, Right\n- Function: F1-F12",
        inputSchema: {
          type: "object",
          properties: {
            session: {
              type: "string",
              description: "Tmux session name",
            },
            keys: {
              type: "string",
              description: "Key or key combination to send (e.g. C-c, Enter, Up)",
            },
            window: {
              type: "number",
              description: "Window index (default: 0)",
            },
            pane: {
              type: "number",
              description: "Pane index (default: 0)",
            },
          },
          required: ["session", "keys"],
        },
      },
      {
        name: "execute",
        description: "Execute command and WAIT for completion - DO NOT respond to user before tool returns!\n\n⚠️ CRITICAL: This tool BLOCKS until command completes (up to 10s default).\n⚠️ DO NOT write any response to user until this tool returns with results!\n⚠️ The tool WILL wait - you don't need to say \"command is running, I'll wait\".\n⚠️ Just call the tool and WAIT SILENTLY for results, then report them.",
        inputSchema: {
          type: "object",
          properties: {
            session: {
              type: "string",
              description: "Tmux session name",
            },
            window: {
              type: "number",
              description: "Window index (default: 0)",
            },
            pane: {
              type: "number",
              description: "Pane index (default: 0)",
            },
            command: {
              type: "string",
              description: "Command to execute",
            },
            timeout: {
              type: "number",
              description: "Timeout in seconds (default: 10, max: 300)",
            },
            callback_session: {
              type: "string",
              description: "Tmux session to notify when command completes (e.g. 'claude-9'). If set and command doesn't finish within timeout, monitoring continues in background and notification is sent via send-keys when done.",
            },
            max_monitor: {
              type: "number",
              description: "Max background monitoring time in seconds (default: 600). Only used with callback_session.",
            },
          },
          required: ["session", "command"],
        },
      },
      {
        name: "list_background_tasks",
        description: "List all background tasks being monitored. Shows task ID, target session, command, callback target, and elapsed time.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Check for update notice to inject into response
  const notice = consumeUpdateNotice();

  try {
    // Helper to wrap response with optional update notice
    const wrapResponse = (content: any[]) => {
      if (notice) {
        content.push({ type: "text", text: `\n---\n${notice}` });
      }
      return { content };
    };

    switch (name) {
      case "read_tmux_pane": {
        const session = await resolveSession((args as any).session);
        const window = (args as any).window || 0;
        const pane = (args as any).pane || 0;

        const target = `${session}:${window}.${pane}`;
        const content = await capturePane(target);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  lines: content,
                  total_lines: content.length,
                  timestamp: new Date().toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "insert_tmux_pane_text": {
        const session = await resolveSession((args as any).session);
        const window = (args as any).window || 0;
        const pane = (args as any).pane || 0;
        const text = (args as any).text;

        const target = `${session}:${window}.${pane}`;
        const result = await tryWrite(target, text);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  text: text,
                  timestamp: new Date().toISOString(),
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_tmux_sessions": {
        const sessions = await listSessions();

        return wrapResponse([
          {
            type: "text",
            text: JSON.stringify(
              {
                sessions,
                count: sessions.length,
              },
              null,
              2
            ),
          },
        ]);
      }

      case "get_pane_info": {
        const session = await resolveSession((args as any).session);
        const window = (args as any).window || 0;
        const pane = (args as any).pane || 0;

        const target = `${session}:${window}.${pane}`;
        const info = await getPaneInfo(target);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  ...info,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "create_session": {
        const prefix = (args as any).prefix || "session";
        const command = (args as any).command;

        const result = await createSessionWithAutoIncrement(prefix, command);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...result,
                  message: `Created session: ${result.session_name}`,
                  attach_command: `tmux attach -t ${result.session_name}`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_server_version": {
        // Get modification time of index.js (the built file)
        const distPath = join(__dirname, 'index.js');
        const stats = statSync(distPath);

        // Format version as vYYYY-MM-DD build HHMMSS
        const buildDate = stats.mtime;
        const datePart = buildDate.toISOString().split('T')[0]; // YYYY-MM-DD
        const timePart = buildDate.toTimeString().split(' ')[0].replace(/:/g, ''); // HHMMSS
        const version = `v${datePart} build ${timePart}`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  version,
                  built_iso: stats.mtime.toISOString(),
                  file: distPath,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "send_keys_tmux": {
        const session = await resolveSession((args as any).session);
        const window = (args as any).window || 0;
        const pane = (args as any).pane || 0;
        const keys = (args as any).keys;

        const target = `${session}:${window}.${pane}`;
        await execTmux(["send-keys", "-t", target, keys]);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  keys,
                  timestamp: new Date().toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "execute": {
        const session = await resolveSession((args as any).session);
        const window = (args as any).window || 0;
        const pane = (args as any).pane || 0;
        const command = (args as any).command;
        const timeoutSeconds = (args as any).timeout || 10;
        const timeoutMs = timeoutSeconds * 1000;
        const callbackSession = (args as any).callback_session;
        const maxMonitorSeconds = (args as any).max_monitor || 600;

        const target = `${session}:${window}.${pane}`;
        const result = await executeAndWait(target, command, { timeout: timeoutMs });

        // If command didn't complete and callback_session is set, start background monitoring
        if (result.status !== 'completed' && result.status !== 'error' && callbackSession) {
          const taskId = nextTaskId();
          // Use just session name - tmux auto-selects active window/pane
          const callbackTarget = callbackSession;
          const task: BackgroundTask = {
            id: taskId,
            target,
            command,
            callbackTarget,
            startedAt: Date.now() - (result.execution_time_ms || 0),
            maxWaitMs: maxMonitorSeconds * 1000,
          };
          backgroundTasks.set(taskId, task);

          // Fire and forget - don't await
          monitorAndNotify(task).catch((err) => {
            console.error(`Background monitor error for ${taskId}:`, err);
            backgroundTasks.delete(taskId);
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    target,
                    command,
                    ...result,
                    status: "background",
                    task_id: taskId,
                    callback_target: callbackTarget,
                    max_monitor_seconds: maxMonitorSeconds,
                    message: `Command still running. Monitoring in background. Will notify ${callbackSession} when done.`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  command,
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "list_background_tasks": {
        const tasks = Array.from(backgroundTasks.values()).map((t) => ({
          id: t.id,
          target: t.target,
          command: t.command,
          callback_target: t.callbackTarget,
          started_at: new Date(t.startedAt).toISOString(),
          running_for_seconds: Math.round((Date.now() - t.startedAt) / 1000),
          max_wait_seconds: Math.round(t.maxWaitMs / 1000),
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  tasks,
                  count: tasks.length,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Tmux MCP server running on stdio");

  // Check for updates in background (non-blocking)
  checkGitVersion().catch(() => {});
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
