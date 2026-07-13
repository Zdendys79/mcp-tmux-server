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

// Validate a required string argument before it reaches tmux/spawn. Without this,
// a missing arg (e.g. a malformed tool call) silently becomes the literal string
// "undefined" once it hits child_process.spawn's argv, which tmux then types into
// the pane as real keystrokes instead of failing loudly.
function requireStringArg(args: any, key: string, toolName: string): string {
  const value = args?.[key];
  if (typeof value !== "string") {
    throw new Error(`Missing required argument "${key}" for tool "${toolName}"`);
  }
  return value;
}

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
        name: "type_text",
        description: "⚠️ WARNING: This tool is for TYPING TEXT ONLY (like into vim/nano).\n⚠️ For executing commands (bash, SQL, Python), use run_wait (short, blocks for result) or run_background (long-running, notifies a callback session when done) instead!\n\nUse cases for this tool:\n- Typing text into an editor (vim, nano)\n- Entering input into interactive prompts\n- Sending text that should NOT be executed immediately",
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
        name: "send_key",
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
        name: "run_wait",
        description: "Run a SHORT command and WAIT (block) for it to finish, then return its output directly - DO NOT respond to user before this tool returns!\n\n⚠️ CRITICAL: This tool BLOCKS the whole call until the command completes OR `timeout` elapses (default 10s, HARD-CAPPED at 120s server-side no matter what you pass -- units are SECONDS, not ms).\n⚠️ ONLY for commands you expect to finish in well under a minute (ls, git status, a quick script, a quick test). If a command might run for MINUTES/HOURS or never returns a prompt (a server holder, a training/recording loop, anything with an infinite loop) -- use run_background instead, NEVER this tool. This tool WILL still be blocking at the 120s cap even for a command that runs for hours; it will not magically become non-blocking.\n⚠️ DO NOT write any response to the user until this tool returns with results! Just call it and wait silently, then report the output.",
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
              description: "Command to run",
            },
            timeout: {
              type: "number",
              description: "Timeout in SECONDS (default: 10). Hard-capped at 120 regardless of what you pass -- for anything that might take longer, use run_background instead.",
            },
          },
          required: ["session", "command"],
        },
      },
      {
        name: "run_background",
        description: "Run a LONG-RUNNING or NEVER-RETURNING command WITHOUT blocking: send it, wait a short grace period to catch immediate failures, then return control to you immediately. When the command actually finishes (even hours later), a notification with its output is sent into `callback_session` -- you do NOT need to poll; just continue other work and react when the notification arrives (or check in with read_tmux_pane / list_background_tasks any time).\n\n✅ Use this for: server holders that run forever, training/recording scripts, anything measured in minutes+ or with no guaranteed end. This is the tool that does NOT make you wait.\n⚠️ callback_session is REQUIRED -- pick the session where you (Claude) are actually running, so the 'done' notification reaches you.",
        inputSchema: {
          type: "object",
          properties: {
            session: {
              type: "string",
              description: "Tmux session name where the command will run",
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
              description: "Command to run",
            },
            callback_session: {
              type: "string",
              description: "REQUIRED: tmux session to notify when the command completes (e.g. your own Claude session, 'fa-claude-4'). The notification (with output) is delivered via send-keys when the command's prompt returns.",
            },
            grace_seconds: {
              type: "number",
              description: "Short initial blocking window in seconds to catch fast failures before switching to background monitoring (default: 10).",
            },
            max_monitor: {
              type: "number",
              description: "Max background monitoring time in seconds before giving up and notifying a timeout (default: 600 = 10 min; raise this for multi-hour jobs, e.g. 14400 = 4h).",
            },
          },
          required: ["session", "command", "callback_session"],
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

      case "type_text": {
        const session = await resolveSession((args as any).session);
        const window = (args as any).window || 0;
        const pane = (args as any).pane || 0;
        const text = requireStringArg(args, "text", "type_text");

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

      case "send_key": {
        const session = await resolveSession((args as any).session);
        const window = (args as any).window || 0;
        const pane = (args as any).pane || 0;
        const keys = requireStringArg(args, "keys", "send_key");

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

      case "run_wait": {
        const session = await resolveSession((args as any).session);
        const window = (args as any).window || 0;
        const pane = (args as any).pane || 0;
        const command = requireStringArg(args, "command", "run_wait");
        // HARD CAP at 120s no matter what's requested: run_wait must NEVER be able to block for
        // hours because of a units mistake (seconds vs ms) or a caller misjudging how long a
        // command will take. Anything that needs longer belongs in run_background.
        const requestedSeconds = (args as any).timeout || 10;
        const timeoutSeconds = Math.min(requestedSeconds, 120);
        const timeoutMs = timeoutSeconds * 1000;

        const target = `${session}:${window}.${pane}`;
        const result = await executeAndWait(target, command, { timeout: timeoutMs });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  command,
                  ...result,
                  ...(requestedSeconds > 120
                    ? { note: `timeout clamped from ${requestedSeconds}s to the 120s hard cap -- use run_background for anything longer` }
                    : {}),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "run_background": {
        const session = await resolveSession((args as any).session);
        const window = (args as any).window || 0;
        const pane = (args as any).pane || 0;
        const command = requireStringArg(args, "command", "run_background");
        const callbackSession = requireStringArg(args, "callback_session", "run_background");
        const graceSeconds = (args as any).grace_seconds || 10;
        const maxMonitorSeconds = (args as any).max_monitor || 600;

        const target = `${session}:${window}.${pane}`;
        // Short blocking grace period ONLY -- long enough to catch a command that fails
        // immediately (typo, missing file, instant error) so the caller doesn't have to wait for
        // a background notification just to learn the command never even started.
        const result = await executeAndWait(target, command, { timeout: graceSeconds * 1000 });

        // Finished (or errored) within the grace period -- no need for background monitoring.
        if (result.status === 'completed' || result.status === 'error') {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ target, command, ...result }, null, 2),
              },
            ],
          };
        }

        // Still running after the grace period -- hand off to background monitoring and return
        // control immediately. The notification (with output) lands in callback_session whenever
        // the command actually finishes, no matter how long that takes.
        const taskId = nextTaskId();
        const task: BackgroundTask = {
          id: taskId,
          target,
          command,
          callbackTarget: callbackSession,
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
                  callback_target: callbackSession,
                  max_monitor_seconds: maxMonitorSeconds,
                  message: `Command still running after ${graceSeconds}s. NOT blocking further -- monitoring in background, will notify ${callbackSession} when done (or after ${maxMonitorSeconds}s).`,
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
