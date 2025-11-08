#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { promisify } from "util";
import { readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Buffer manager for diff tracking
class BufferManager {
  private buffers: Map<string, string[]> = new Map();
  private maxLines: number;

  constructor(maxLines: number = 1000) {
    this.maxLines = maxLines;
  }

  getNewLines(target: string, currentContent: string[]): string[] {
    if (!this.buffers.has(target)) {
      // First read - all content is new
      this.buffers.set(target, currentContent.slice(-this.maxLines));
      return currentContent;
    }

    const oldLines = this.buffers.get(target)!;

    // No change
    if (JSON.stringify(oldLines) === JSON.stringify(currentContent)) {
      return [];
    }

    // Simple append case - old is prefix of new
    if (
      currentContent.length >= oldLines.length &&
      JSON.stringify(currentContent.slice(0, oldLines.length)) ===
        JSON.stringify(oldLines)
    ) {
      const newLines = currentContent.slice(oldLines.length);
      this.buffers.set(target, currentContent.slice(-this.maxLines));
      return newLines;
    }

    // Cleared screen or scrolled - return all new content
    if (currentContent.length < oldLines.length) {
      this.buffers.set(target, currentContent.slice(-this.maxLines));
      return currentContent;
    }

    // Find common suffix (scrolling case)
    let commonSuffixLen = 0;
    const maxCheck = Math.min(oldLines.length, currentContent.length);

    for (let i = 1; i <= maxCheck; i++) {
      if (
        oldLines[oldLines.length - i] ===
        currentContent[currentContent.length - i]
      ) {
        commonSuffixLen = i;
      } else {
        break;
      }
    }

    // Return lines after common suffix
    const newLines =
      commonSuffixLen > 0
        ? currentContent.slice(currentContent.length - commonSuffixLen + commonSuffixLen)
        : currentContent;

    this.buffers.set(target, currentContent.slice(-this.maxLines));
    return newLines;
  }

  clearBuffer(target: string): void {
    this.buffers.delete(target);
  }

  clearAll(): void {
    this.buffers.clear();
  }

  getBufferCount(): number {
    return this.buffers.size;
  }
}

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

// Safety check: detect interactive prompts before writing
async function checkPaneSafety(target: string): Promise<{ safe: boolean; warning?: string; last_line?: string }> {
  try {
    const content = await capturePane(target);
    const lastLine = content[content.length - 1] || "";

    const dangerPatterns = [
      /password:/i, /\[y\/n\]/i, /\[yes\/no\]/i, /Are you sure/i,
      /Do you want/i, /Continue\?/i, /^\s*>/, /sudo.*password/i
    ];

    for (const pattern of dangerPatterns) {
      if (pattern.test(lastLine)) {
        return { safe: false, warning: `Interactive prompt: "${lastLine.trim()}"`, last_line: lastLine.trim() };
      }
    }

    if (lastLine.trim() !== "" && !lastLine.includes("$") && !lastLine.includes("#")) {
      return { safe: false, warning: "Command may be running (no prompt)", last_line: lastLine.trim() };
    }

    return { safe: true };
  } catch (error) {
    return { safe: false, warning: `Cannot verify: ${error}` };
  }
}

async function tryWrite(target: string, text: string): Promise<{
  success: boolean;
  executed?: boolean;
  rate_limited?: boolean;
  retry_after_seconds?: number;
  safety_check: any;
}> {
  // Safety check first
  const safetyCheck = await checkPaneSafety(target);

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

  // Execute write
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

// Execute command and wait for completion
async function executeAndWait(
  target: string,
  command: string,
  options: {
    timeout?: number;
    firstResponseTimeout?: number;
    promptPattern?: RegExp;
    pollInterval?: number;
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
  const timeout = options.timeout || 10000; // 10s default (changed from 30s)
  const firstResponseTimeout = options.firstResponseTimeout || 2000; // 2s for first response
  const pollInterval = options.pollInterval || 200; // 200ms
  const promptPattern = options.promptPattern || /[$#]\s*$/;

  const startTime = Date.now();

  try {
    // Safety check
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

    // Get initial content before command
    const initialContent = await capturePane(target);

    // Send command with Enter key
    await sendCommand(target, command);
    lastWriteTime = Date.now();
    console.error(`[MCP execute] Command started: ${command}`);

    // Wait for first response (command started executing)
    let firstResponse = false;
    let waitAttempts = 0;
    const firstResponseDeadline = startTime + firstResponseTimeout;

    while (Date.now() < firstResponseDeadline && !firstResponse) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      const content = await capturePane(target);
      waitAttempts++;

      // Check if content changed from initial (command executed)
      if (JSON.stringify(content) !== JSON.stringify(initialContent)) {
        firstResponse = true;
        const responseTime = Date.now() - startTime;
        console.error(`[ExecuteAndWait] First response after ${responseTime}ms (${waitAttempts} polls)`);
      }
    }

    if (!firstResponse) {
      const elapsedTime = Date.now() - startTime;
      return {
        success: false,
        output: [],
        status: 'timeout',
        execution_time_ms: elapsedTime,
        prompt_detected: false,
        error: `No output within ${firstResponseTimeout}ms`,
      };
    }

    // Now wait for output to stabilize (idle detection)
    // Keep checking every 100ms until no new lines appear
    const idleTimeout = 100; // 100ms idle = command finished
    let currentContent = await capturePane(target);
    let stableContent = false;
    let attempts = 0;
    let hitTimeout = false;
    let lastProgressReport = Date.now();
    const progressReportInterval = 1000; // Report every 1s

    while (Date.now() - startTime < timeout && !stableContent) {
      await new Promise(resolve => setTimeout(resolve, idleTimeout));
      const newContent = await capturePane(target);
      attempts++;

      // Report progress every 1s
      const now = Date.now();
      if (now - lastProgressReport >= progressReportInterval) {
        const elapsedSeconds = ((now - startTime) / 1000).toFixed(1);
        console.error(`[MCP execute] Still running... (${elapsedSeconds}s)`);
        lastProgressReport = now;
      }

      // Compare content
      if (JSON.stringify(currentContent) === JSON.stringify(newContent)) {
        // No change for 100ms = command finished
        stableContent = true;
        const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[MCP execute] ✓ Command COMPLETED in ${elapsedSeconds}s`);
      } else {
        // Content changed, keep waiting
        currentContent = newContent;
      }
    }

    // Check if we hit timeout while content was still changing
    if (!stableContent && Date.now() - startTime >= timeout) {
      hitTimeout = true;
      // Get final content
      currentContent = await capturePane(target);
      const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
      console.error(`[MCP execute] ⚠ Timeout reached after ${elapsedSeconds}s, command still producing output`);
    }

    // Extract output: find where new content starts
    let outputStartIndex = 0;
    for (let i = 0; i < Math.min(initialContent.length, currentContent.length); i++) {
      if (initialContent[i] !== currentContent[i]) {
        outputStartIndex = i;
        break;
      }
    }

    // If no difference found in common part, start from where old content ended
    if (outputStartIndex === 0 && currentContent.length > initialContent.length) {
      outputStartIndex = initialContent.length;
    }

    // Get new lines (skip command echo line, skip final prompt line)
    let outputLines = currentContent.slice(outputStartIndex);

    // Remove first line if it's the command echo
    if (outputLines.length > 0 && outputLines[0].includes(command)) {
      outputLines = outputLines.slice(1);
    }

    // Remove last line if it's the prompt
    if (outputLines.length > 0 && promptPattern.test(outputLines[outputLines.length - 1].trim())) {
      outputLines = outputLines.slice(0, -1);
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
    } else if (hitTimeout) {
      return {
        success: false,
        output: outputLines,
        status: 'incomplete',
        execution_time_ms: executionTime,
        prompt_detected: false,
        warning: `Output incomplete - command still running after ${timeout}ms`,
      };
    } else {
      return {
        success: false,
        output: outputLines,
        status: 'timeout',
        execution_time_ms: executionTime,
        prompt_detected: false,
        error: `Command did not stabilize within ${timeout}ms (${attempts} checks)`,
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

// Create buffer manager
const bufferManager = new BufferManager(1000);

// Create MCP server
const server = new Server(
  {
    name: "tmux-mcp-server",
    version: "1.0.0",
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
          "Read FRESH content from tmux pane - NO CACHING, always returns current state. Use this to check terminal output at any time.",
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
        name: "clear_buffer",
        description: "Clear diff tracking buffer for a pane or all panes",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description:
                'Target pane (e.g., "session:0.0") or omit to clear all',
            },
          },
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

        // ALWAYS return fresh content - no caching!
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  lines: content,
                  total_lines: content.length,
                  cached: false,
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

      case "clear_buffer": {
        const target = (args as any).target;

        if (target) {
          bufferManager.clearBuffer(target);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ cleared: target }),
              },
            ],
          };
        } else {
          bufferManager.clearAll();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ cleared: "all" }),
              },
            ],
          };
        }
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
  console.error(`Buffer manager initialized (max ${1000} lines per pane)`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
