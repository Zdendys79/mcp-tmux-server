// Low-level tmux operations: exec, capture, sessions, keys, pane info

import { spawn } from "child_process";

// Execute tmux command and return stdout
export async function execTmux(args: string[]): Promise<string> {
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

// Capture current pane content
export async function capturePane(target: string): Promise<string[]> {
  const output = await execTmux(["capture-pane", "-p", "-t", target]);
  const lines = output.split("\n");
  // Remove trailing empty line
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// Get detailed pane information
export async function getPaneInfo(
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

// Send text literally to pane (handles newlines, semicolons)
export async function sendKeys(target: string, text: string): Promise<void> {
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

// Send command: clear line + type + enter
export async function sendCommand(target: string, command: string): Promise<void> {
  // 1. Clear line with Ctrl+U
  await execTmux(["send-keys", "-t", target, "C-u"]);

  // 2. Send command text literally
  await execTmux(["send-keys", "-t", target, "-l", command]);

  // 3. Press Enter
  await execTmux(["send-keys", "-t", target, "Enter"]);
}

// Detect environment type from command and prompt
export function detectEnvironment(command: string, lastLine: string): string {
  // Check process command first
  switch (command) {
    case "python3": case "python": return "python";
    case "mysql": case "mariadb": return "mysql";
    case "node": return "node";
    case "ssh": case "sshd": return "ssh";
    case "vim": case "nvim": case "nano": return "editor";
    case "htop": case "top": case "btop": return "monitor";
    case "docker": return "docker";
    case "less": case "more": case "man": return "pager";
  }
  // Check prompt prefix for virtual environments
  const venvMatch = lastLine.match(/^\(([^)]+)\)\s/);
  if (venvMatch) {
    const envName = venvMatch[1];
    if (envName === "venv" || envName === ".venv" || envName.includes("env")) return "venv";
    if (envName.startsWith("conda")) return "conda";
    return "venv:" + envName;
  }
  return "shell";
}

// Parse user@host from prompt line
export function parseUserHost(lastLine: string): string {
  // Match patterns: user@host:, user@host $, (venv) user@host:
  const match = lastLine.match(/(?:\([^)]+\)\s+)?(\w+@[\w.-]+)/);
  return match ? match[1] : "";
}

// Session info returned by listSessions
export interface SessionInfo {
  name: string;
  windows: number;
  panes: number;
  status: "idle" | "busy";
  command: string;
  cwd: string;
  user_host: string;
  environment: string;
  last_activity: string;
  last_activity_ago: string;
  last_line: string;
}

// List all active tmux sessions with enriched info
export async function listSessions(): Promise<SessionInfo[]> {
  // Import isPromptLine lazily to avoid circular dependency
  const { isPromptLine } = await import("./prompt.js");

  try {
    // Get all panes in one call: session|window|pane|command|path|activity
    const allPanes = await execTmux([
      "list-panes", "-a", "-F",
      "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{session_activity}",
    ]);

    // Group by session
    const sessionMap = new Map<string, {
      windows: Set<string>;
      paneCount: number;
      command: string;
      cwd: string;
      activity: number;
    }>();

    for (const line of allPanes.trim().split("\n").filter(l => l)) {
      const [name, winIdx, _paneIdx, command, cwd, activity] = line.split("\t");
      if (!sessionMap.has(name)) {
        sessionMap.set(name, {
          windows: new Set(),
          paneCount: 0,
          command: command || "bash",
          cwd: cwd || "",
          activity: parseInt(activity) || 0,
        });
      }
      const s = sessionMap.get(name)!;
      s.windows.add(winIdx);
      s.paneCount++;
    }

    // Read last line of each session's primary pane (in parallel)
    const sessionNames = Array.from(sessionMap.keys());
    const paneContents = await Promise.all(
      sessionNames.map(name => capturePane(`${name}:0.0`).catch(() => [""]))
    );

    const sessions: SessionInfo[] = [];
    for (let i = 0; i < sessionNames.length; i++) {
      const name = sessionNames[i];
      const info = sessionMap.get(name)!;
      const content = paneContents[i];
      const lastLine = content.filter(l => l.trim() !== "").pop() || "";

      const idle = isPromptLine(lastLine);
      const environment = detectEnvironment(info.command, lastLine);
      const userHost = parseUserHost(lastLine);

      // Format activity timestamp
      const activityDate = new Date(info.activity * 1000);
      const agoSeconds = Math.floor((Date.now() - activityDate.getTime()) / 1000);
      let agoStr: string;
      if (agoSeconds < 60) agoStr = `${agoSeconds}s ago`;
      else if (agoSeconds < 3600) agoStr = `${Math.floor(agoSeconds / 60)}m ago`;
      else if (agoSeconds < 86400) agoStr = `${Math.floor(agoSeconds / 3600)}h ago`;
      else agoStr = `${Math.floor(agoSeconds / 86400)}d ago`;

      sessions.push({
        name,
        windows: info.windows.size,
        panes: info.paneCount,
        status: idle ? "idle" : "busy",
        command: info.command,
        cwd: info.cwd,
        user_host: userHost,
        environment,
        last_activity: activityDate.toISOString(),
        last_activity_ago: agoStr,
        last_line: lastLine.trim(),
      });
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

// Resolve session name from exact match or unambiguous prefix (e.g. "sudo" → "sudo-0")
export async function resolveSession(nameOrPrefix: string): Promise<string> {
  const sessions = await listSessions();
  const names = sessions.map(s => s.name);

  // Exact match wins immediately
  if (names.includes(nameOrPrefix)) return nameOrPrefix;

  // Prefix match: names starting with the given prefix
  const matches = names.filter(n => n.startsWith(nameOrPrefix));

  if (matches.length === 0) {
    const available = names.length ? names.join(", ") : "(no sessions)";
    throw new Error(`Session "${nameOrPrefix}" not found. Available: ${available}`);
  }
  if (matches.length === 1) return matches[0];

  throw new Error(`Ambiguous prefix "${nameOrPrefix}" matches: ${matches.join(", ")}. Use the full session name.`);
}

// Create new tmux session with auto-increment naming
export async function createSessionWithAutoIncrement(
  prefix: string = "session",
  command?: string
): Promise<{ session_name: string; number: number }> {
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

  if (command) {
    await execTmux(["new-session", "-d", "-s", sessionName, command]);
  } else {
    await execTmux(["new-session", "-d", "-s", sessionName]);
  }

  return { session_name: sessionName, number: nextNum };
}
