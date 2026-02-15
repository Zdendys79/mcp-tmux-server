#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Tmux command execution
async function execTmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tmux", args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tmux command failed: ${stderr || "unknown error"}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to execute tmux: ${err.message}`));
    });
  });
}

// Tmux operations
async function capturePane(target: string): Promise<string[]> {
  const output = await execTmux(["capture-pane", "-p", "-t", target]);
  const lines = output.split("\n");
  // Remove trailing empty line
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

async function listSessions(): Promise<
  Array<{ name: string; windows: number; panes: number }>
> {
  try {
    const sessionNames = await execTmux([
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);

    const sessions = [];
    for (const name of sessionNames.trim().split("\n").filter((n) => n)) {
      const windowsOutput = await execTmux([
        "list-windows",
        "-t",
        name,
        "-F",
        "#{window_index}",
      ]);
      const windowCount = windowsOutput.trim().split("\n").filter((w) => w)
        .length;

      const panesOutput = await execTmux([
        "list-panes",
        "-t",
        name,
        "-F",
        "#{pane_index}",
      ]);
      const paneCount = panesOutput.trim().split("\n").filter((p) => p).length;

      sessions.push({ name, windows: windowCount, panes: paneCount });
    }

    return sessions;
  } catch (error) {
    // No server running
    if ((error as Error).message.includes("no server running")) {
      return [];
    }
    throw error;
  }
}

async function getPaneInfo(
  target: string
): Promise<{ width: number; height: number; command: string; active: boolean }> {
  const output = await execTmux([
    "display-message",
    "-t",
    target,
    "-p",
    "#{pane_width},#{pane_height},#{pane_current_command},#{pane_active}",
  ]);

  const parts = output.trim().split(",");
  if (parts.length !== 4) {
    throw new Error(`Unexpected tmux output format: ${output}`);
  }

  return {
    width: parseInt(parts[0]),
    height: parseInt(parts[1]),
    command: parts[2],
    active: parts[3] === "1",
  };
}

async function sendKeys(target: string, text: string): Promise<void> {
  // Check if text ends with newline
  const hasNewline = text.endsWith('\n') || text.endsWith('\r\n');

  // Remove newline from text if present
  let cleanText = hasNewline ? text.replace(/[\r\n]+$/, '') : text;

  // WORKAROUND: tmux send-keys strips trailing semicolons even with -l flag!
  // Solution: If text ends with semicolon, send it separately
  const hasSemicolon = cleanText.endsWith(';');
  if (hasSemicolon) {
    cleanText = cleanText.slice(0, -1); // Remove trailing semicolon
  }

  // Send text literally (without interpreting special characters)
  await execTmux(["send-keys", "-t", target, "-l", cleanText]);

  // Send semicolon separately if needed (WITHOUT -l flag to avoid tmux stripping it)
  if (hasSemicolon) {
    await execTmux(["send-keys", "-t", target, "\\;"]);
  }

  // If original text had newline, send Enter key separately
  if (hasNewline) {
    await execTmux(["send-keys", "-t", target, "Enter"]);
  }
}

async function sendCommand(target: string, command: string): Promise<void> {
  // Simple approach: clear line, send text literally, press Enter

  // 1. Clear line with Ctrl+U
  await execTmux(["send-keys", "-t", target, "C-u"]);

  // 2. Send command text literally
  await execTmux(["send-keys", "-t", target, "-l", command]);

  // 3. Press Enter
  await execTmux(["send-keys", "-t", target, "Enter"]);
}

async function createSessionWithAutoIncrement(
  prefix: string = "session",
  command?: string
): Promise<{ session_name: string; number: number }> {
  // Get all sessions with this prefix
  const allSessions = await listSessions();
  const regex = new RegExp(`^${prefix}-(\\d+)$`);

  let maxNum = 0;
  for (const session of allSessions) {
    const match = session.name.match(regex);
    if (match) {
      const num = parseInt(match[1]);
      if (num > maxNum) maxNum = num;
    }
  }

  const nextNum = maxNum + 1;
  const sessionName = `${prefix}-${nextNum}`;

  // Create session
  if (command) {
    await execTmux(["new-session", "-d", "-s", sessionName, command]);
  } else {
    await execTmux(["new-session", "-d", "-s", sessionName]);
  }

  return { session_name: sessionName, number: nextNum };
}

// Rate limiting for write operations
const WRITE_COOLDOWN_MS = 10000; // 10 seconds
let lastWriteTime = 0;

// Prompt patterns used for detection
const PROMPT_PATTERNS = [
  /[$#]\s*$/,           // Standard $ or # prompt at end
  />\s*$/,              // > prompt (PowerShell, some shells)
  /\]\s*$/,             // ] prompt (some custom prompts)
  /bash-\d+\.\d+[$#]/,  // bash-X.Y$ format
];

// Dangerous interactive prompts that require user input
const DANGER_PATTERNS = [
  /password:/i, /\[y\/n\]/i, /\[yes\/no\]/i, /Are you sure/i,
  /Do you want/i, /Continue\?/i, /sudo.*password/i
];

// Check if line looks like a shell prompt
function isPromptLine(line: string): boolean {
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

// Check if line is a dangerous interactive prompt
function isDangerousPrompt(line: string): boolean {
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

// Wait for stable prompt - ensures prompt is visible AND unchanged for stabilityTime
// Returns immediately if dangerous prompt detected
// Retries for up to maxWaitTime if prompt keeps changing
async function waitForStablePrompt(
  target: string,
  stabilityTime: number = 2000,  // 2s stability required
  maxWaitTime: number = 10000,   // 10s max wait
  pollInterval: number = 200     // Check every 200ms
): Promise<{
  safe: boolean;
  warning?: string;
  last_line?: string;
  running_process?: string;
  waited_ms?: number;
}> {
  const startTime = Date.now();
  let lastLine = "";
  let lastLineTime = 0;

  try {
    // Get pane info for informational purposes
    const paneInfo = await getPaneInfo(target);
    const runningCommand = paneInfo.command;

    while (Date.now() - startTime < maxWaitTime) {
      const content = await capturePane(target);
      // Filter out trailing empty lines to find actual prompt (fixes root prompt detection)
      const currentLine = content.filter(l => l.trim() !== "").pop() || "";

      // Check for dangerous prompts - fail immediately
      if (isDangerousPrompt(currentLine)) {
        return {
          safe: false,
          warning: `Interactive prompt: "${currentLine.trim()}"`,
          last_line: currentLine.trim(),
          running_process: runningCommand,
          waited_ms: Date.now() - startTime
        };
      }

      // Check if this is a prompt line
      if (isPromptLine(currentLine)) {
        // If same as last time, check stability
        if (currentLine === lastLine) {
          const stableFor = Date.now() - lastLineTime;
          if (stableFor >= stabilityTime) {
            // Prompt has been stable for required time - SAFE!
            return {
              safe: true,
              running_process: runningCommand,
              last_line: currentLine.trim(),
              waited_ms: Date.now() - startTime
            };
          }
        } else {
          // Prompt changed, reset stability timer
          lastLine = currentLine;
          lastLineTime = Date.now();
        }
      } else {
        // Not a prompt line - reset
        lastLine = currentLine;
        lastLineTime = Date.now();
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout - could not get stable prompt within maxWaitTime
    return {
      safe: false,
      warning: `Session busy - prompt not stable within ${maxWaitTime}ms (last line: "${lastLine.trim()}")`,
      last_line: lastLine.trim(),
      running_process: (await getPaneInfo(target)).command,
      waited_ms: Date.now() - startTime
    };
  } catch (error) {
    return {
      safe: false,
      warning: `Cannot verify: ${error}`,
      waited_ms: Date.now() - startTime
    };
  }
}

// Safety check: detect interactive prompts and running processes before writing
// IMPORTANT: This function waits for STABLE prompt (unchanged for 2s)
// If prompt keeps changing, retries for up to 10s before returning BUSY
async function checkPaneSafety(target: string): Promise<{ safe: boolean; warning?: string; last_line?: string; running_process?: string }> {
  return await waitForStablePrompt(target, 2000, 10000, 200);
}

async function tryWrite(target: string, text: string): Promise<{
  success: boolean;
  executed?: boolean;
  rate_limited?: boolean;
  retry_after_seconds?: number;
  safety_check: any;
  error?: string;
}> {
  // Safety check first - waits for stable prompt (2s stability, 10s max)
  const safetyCheck = await checkPaneSafety(target);

  // If not safe, DO NOT send text!
  if (!safetyCheck.safe) {
    console.error(`[Write] BLOCKED for ${target}: ${safetyCheck.warning}`);
    return {
      success: false,
      executed: false,
      safety_check: safetyCheck,
      error: safetyCheck.warning,
    };
  }

  const now = Date.now();
  const timeSinceLastWrite = now - lastWriteTime;

  // Check rate limit
  if (timeSinceLastWrite < WRITE_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((WRITE_COOLDOWN_MS - timeSinceLastWrite) / 1000);
    console.error(`[Write] Rate limited for ${target}, retry in ${waitSeconds}s`);
    return {
      success: false,
      rate_limited: true,
      retry_after_seconds: waitSeconds,
      safety_check: safetyCheck,
    };
  }

  // Execute write - only if safe!
  // Un-escape \n and \r sequences that come as literal strings from JSON
  const unescapedText = text.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  await sendKeys(target, unescapedText);
  lastWriteTime = Date.now();
  console.error(`[Write] Executed for ${target}`);

  return {
    success: true,
    executed: true,
    safety_check: safetyCheck,
  };
}

// Fingerprint: last N non-empty lines (robust against trailing empty line variations)
function contentFingerprint(lines: string[]): string {
  return lines.filter(l => l.trim() !== "").slice(-5).join("\n");
}

// Execute command and wait for completion
async function executeAndWait(
  target: string,
  command: string,
  options: {
    timeout?: number;
  } = {}
): Promise<{
  success: boolean;
  output: string[];
  status: 'completed' | 'timeout' | 'error' | 'incomplete';
  execution_time_ms: number;
  prompt_detected: boolean;
  warning?: string;
  error?: string;
}> {
  const timeout = options.timeout || 10000; // 10s default
  const startTime = Date.now();

  try {
    // Safety check - waits for stable prompt (2s stability, 10s max)
    const safetyCheck = await checkPaneSafety(target);
    if (!safetyCheck.safe) {
      return {
        success: false,
        output: [],
        status: 'error',
        execution_time_ms: Date.now() - startTime,
        prompt_detected: false,
        error: safetyCheck.warning,
      };
    }

    // Capture initial content for output extraction later
    const initialContent = await capturePane(target);
    const initialFP = contentFingerprint(initialContent);

    // Send command
    await sendCommand(target, command);
    lastWriteTime = Date.now();
    console.error(`[MCP execute] Command started: ${command}`);

    // Wait for tmux to process keys (fixes race condition with fast commands)
    await new Promise(resolve => setTimeout(resolve, 100));

    // Single poll loop: detect content change + wait for stabilization
    // Completes when: fingerprint differs from initial AND content stable for 200ms
    let currentContent = await capturePane(target);
    let lastFP = contentFingerprint(currentContent);
    let lastChangeTime = Date.now();
    let stableContent = false;
    let lastProgressReport = Date.now();

    while (Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const newContent = await capturePane(target);
      const newFP = contentFingerprint(newContent);

      if (newFP !== lastFP) {
        // Content still changing - reset stability timer
        lastFP = newFP;
        lastChangeTime = Date.now();
        currentContent = newContent;
      } else if (Date.now() - lastChangeTime >= 200 && newFP !== initialFP) {
        // Content stable for 200ms AND differs from initial = command completed
        stableContent = true;
        currentContent = newContent;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[MCP execute] Command COMPLETED in ${elapsed}s`);
        break;
      }

      // Progress reporting every 1s
      const now = Date.now();
      if (now - lastProgressReport >= 1000) {
        const elapsed = ((now - startTime) / 1000).toFixed(1);
        console.error(`[MCP execute] Still running... (${elapsed}s)`);
        lastProgressReport = now;
      }
    }

    if (!stableContent) {
      currentContent = await capturePane(target);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.error(`[MCP execute] Timeout after ${elapsed}s, command may still be running`);
    }

    // --- Output extraction ---
    // Strategy: find command echo line, take everything after it until prompt
    let outputLines: string[] = [];

    // Find the command echo line (search from bottom for most recent match)
    // Use first 40 chars of command to handle long/wrapped commands
    const cmdSearch = command.substring(0, Math.min(command.length, 40));
    let cmdLineIndex = -1;
    for (let i = currentContent.length - 1; i >= 0; i--) {
      if (currentContent[i].includes(cmdSearch)) {
        cmdLineIndex = i;
        break;
      }
    }

    if (cmdLineIndex >= 0) {
      // Everything after command echo
      outputLines = currentContent.slice(cmdLineIndex + 1);
    } else {
      // Fallback: diff-based extraction (find where initial and current diverge)
      let outputStartIndex = 0;
      for (let i = 0; i < Math.min(initialContent.length, currentContent.length); i++) {
        if (initialContent[i] !== currentContent[i]) {
          outputStartIndex = i;
          break;
        }
      }
      if (outputStartIndex === 0 && currentContent.length > initialContent.length) {
        outputStartIndex = initialContent.length;
      }
      outputLines = currentContent.slice(outputStartIndex);
      // Remove command echo if present at start
      if (outputLines.length > 0 && outputLines[0].includes(cmdSearch)) {
        outputLines = outputLines.slice(1);
      }
    }

    // Remove trailing prompt lines and empty lines
    while (outputLines.length > 0) {
      const lastLine = outputLines[outputLines.length - 1];
      if (lastLine.trim() === "" || isPromptLine(lastLine)) {
        outputLines.pop();
      } else {
        break;
      }
    }

    const executionTime = Date.now() - startTime;

    if (stableContent) {
      return {
        success: true,
        output: outputLines,
        status: 'completed',
        execution_time_ms: executionTime,
        prompt_detected: true,
      };
    } else {
      return {
        success: false,
        output: outputLines,
        status: 'incomplete',
        execution_time_ms: executionTime,
        prompt_detected: false,
        warning: `Command may still be running after ${timeout}ms`,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: [],
      status: 'error',
      execution_time_ms: Date.now() - startTime,
      prompt_detected: false,
      error: errorMessage,
    };
  }
}

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const VERSION = packageJson.version || "unknown";

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
        description: "List all active tmux sessions",
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
        description: "Create new tmux session with auto-increment naming",
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
          },
          required: ["session", "command"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "read_tmux_pane": {
        const session = (args as any).session;
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
        const session = (args as any).session;
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

        return {
          content: [
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
          ],
        };
      }

      case "get_pane_info": {
        const session = (args as any).session;
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
        // Get __dirname equivalent in ES modules
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);

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
        const session = (args as any).session;
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
        const session = (args as any).session;
        const window = (args as any).window || 0;
        const pane = (args as any).pane || 0;
        const command = (args as any).command;
        const timeoutSeconds = (args as any).timeout || 10;
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
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
