// Command execution: executeAndWait, tryWrite with safety and rate limiting

import { capturePane, sendCommand, sendKeys } from "./tmux.js";
import { isPromptLine, checkPaneSafety, contentFingerprint } from "./prompt.js";

// Rate limiting for write operations
const WRITE_COOLDOWN_MS = 10000; // 10 seconds
let lastWriteTime = 0;

// Write text to pane with safety check and rate limiting
export async function tryWrite(target: string, text: string): Promise<{
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

// Execute command and wait for completion
export async function executeAndWait(
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
        // Content stable for 200ms AND differs from initial
        // Also verify prompt is visible (last non-empty line is a prompt)
        let lastNonEmpty = "";
        for (let j = newContent.length - 1; j >= 0; j--) {
          if (newContent[j].trim() !== "") {
            lastNonEmpty = newContent[j];
            break;
          }
        }
        if (isPromptLine(lastNonEmpty)) {
          stableContent = true;
          currentContent = newContent;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
          console.error(`[MCP execute] Command COMPLETED in ${elapsed}s`);
          break;
        }
        // Content changed but no prompt yet - command still running, keep polling
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
