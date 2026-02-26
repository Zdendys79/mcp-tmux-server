// Prompt detection patterns, safety checks, content fingerprinting

import { capturePane, getPaneInfo } from "./tmux.js";

// Prompt patterns used for detection
export const PROMPT_PATTERNS = [
  /[$#]\s*$/,           // Standard $ or # prompt at end
  />\s*$/,              // > prompt (PowerShell, some shells)
  /\]\s*$/,             // ] prompt (some custom prompts)
  /bash-\d+\.\d+[$#]/,  // bash-X.Y$ format
];

// Dangerous interactive prompts that require user input
export const DANGER_PATTERNS = [
  /password:/i, /\[y\/n\]/i, /\[yes\/no\]/i, /Are you sure/i,
  /Do you want/i, /Continue\?/i, /sudo.*password/i
];

// Check if line looks like a shell prompt
export function isPromptLine(line: string): boolean {
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

// Check if line is a dangerous interactive prompt
export function isDangerousPrompt(line: string): boolean {
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

// Fingerprint: last N non-empty lines (robust against trailing empty line variations)
export function contentFingerprint(lines: string[]): string {
  return lines.filter(l => l.trim() !== "").slice(-5).join("\n");
}

// Wait for stable prompt - ensures prompt is visible AND unchanged for stabilityTime
// Returns immediately if dangerous prompt detected
// Retries for up to maxWaitTime if prompt keeps changing
export async function waitForStablePrompt(
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

// Safety check wrapper: detect interactive prompts and running processes before writing
export async function checkPaneSafety(target: string): Promise<{ safe: boolean; warning?: string; last_line?: string; running_process?: string }> {
  return await waitForStablePrompt(target, 2000, 10000, 200);
}
