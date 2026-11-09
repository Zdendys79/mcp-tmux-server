// Background task monitoring with async callbacks to Claude session

import { capturePane, getCursor, sendKeys, sendCommand } from "./tmux.js";
import { contentFingerprint, claudeInputState, commandFinished } from "./prompt.js";

// Background task definition
export interface BackgroundTask {
  id: string;
  target: string;
  command: string;
  callbackTarget: string;
  startedAt: number;
  maxWaitMs: number;
  baselineCommand?: string; // foreground process before the command (see commandFinished)
}

// Active background tasks
export const backgroundTasks = new Map<string, BackgroundTask>();
export let taskCounter = 0;

// Increment task counter and return new value
export function nextTaskId(): string {
  return `bg-${++taskCounter}`;
}

// Format timestamp for notifications (HH:MM:SS)
export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Wait until callback pane is quiet (no typing) for at least quietMs
// This prevents interrupting user while they're typing a prompt.
// Quiet alone is NOT enough (2026-10-23, Zdendys live-caught): pausing for 10s
// mid-sentence let a notification get appended to his half-written Claude Code prompt
// and its trailing Enter submitted the merged text. So in a Claude Code pane we also
// require the input box to be empty -- a draft keeps the notification waiting until
// the user submits or clears it (notifications are never urgent; a hijacked prompt is
// worse than a late one). Panes without a Claude input box keep the old quiet-only rule.
export async function waitForQuietCallback(callbackTarget: string, quietMs: number = 10000): Promise<void> {
  let lastFP = "";
  let lastChangeTime = Date.now();

  while (true) {
    try {
      const lines = await capturePane(callbackTarget);
      const fp = contentFingerprint(lines);

      if (fp !== lastFP) {
        // Content changed - someone is typing or Claude is outputting
        lastFP = fp;
        lastChangeTime = Date.now();
      } else if (Date.now() - lastChangeTime >= quietMs) {
        // Quiet for long enough - safe to send, unless the user has a draft typed
        const cursor = await getCursor(callbackTarget).catch(() => undefined);
        if (claudeInputState(lines, cursor) !== "draft") return;
      }
    } catch (_e) {
      // Can't read pane - send anyway
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Deliver callback notification to Claude session. If delivery fails
// (session doesn't exist, not running in tmux), write error to the
// SOURCE tmux pane (where the command ran) so the user can see it.
export async function deliverCallback(callbackTarget: string, msg: string, sourceTarget?: string): Promise<void> {
  try {
    await waitForQuietCallback(callbackTarget);
    // sendKeys' -l (literal) mode still sends EMBEDDED newlines in `msg` as literal
    // Enter keystrokes, so a multi-line notification gets typed into the target pane as
    // several separate Enter-terminated "commands", not one blob. If any line contains
    // an unmatched quote (very common in captured command output, e.g. Python dict repr
    // like {'iron-plate': 140}), bash starts an open quote/continuation and the pane gets
    // stuck at a "> " prompt until someone notices and sends Ctrl+C. Prefixing every line
    // with "# " makes each one an independent, harmless shell comment regardless of its
    // content, so this can never happen (observed live repeatedly, 2026-07-03).
    const commented = msg.split("\n").map((line) => `# ${line}`).join("\n");
    await sendKeys(callbackTarget, commented + "\n");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Escape single quotes for safe echo in bash
    const safeErr = errMsg.replace(/'/g, "'\\''");
    const failMsg = `echo '[MCP tmux] CALLBACK FAILED: Could not deliver to "${callbackTarget}" (${safeErr}). Run Claude Code in tmux! (tmux new -s claude)'`;
    // Try to show error in the source pane where command was running
    if (sourceTarget) {
      try {
        await sendCommand(sourceTarget, failMsg);
      } catch (_e) {
        // Both targets unreachable - nothing we can do
      }
    }
  }
}

// Monitor background task and notify callback session when done
export async function monitorAndNotify(task: BackgroundTask): Promise<void> {
  const pollIntervalMs = 2000; // Check every 2s
  const startTime = task.startedAt;
  let finishedPolls = 0;

  while (true) {
    const elapsed = Date.now() - startTime;

    // Timeout check
    if (elapsed >= task.maxWaitMs) {
      const lines = await capturePane(task.target).catch(() => [] as string[]);
      const lastLines = lines.slice(-5).join("\n");
      const msg = `[tmux:${task.target}:timeout] Command: "${task.command}" timed out after ${Math.round(elapsed / 1000)}s | Started: ${fmtTime(startTime)} | Timeout: ${fmtTime(Date.now())}\nLast output:\n${lastLines}`;
      await deliverCallback(task.callbackTarget, msg, task.target);
      backgroundTasks.delete(task.id);
      return;
    }

    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const lines = await capturePane(task.target);
      // Find last non-empty line
      let lastNonEmpty = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() !== "") {
          lastNonEmpty = lines[i];
          break;
        }
      }

      // Finished only when the foreground process is back (commandFinished) AND that
      // holds for two polls in a row, so a single lucky snapshot can't end monitoring.
      if (!(await commandFinished(task.target, lastNonEmpty, task.baselineCommand))) {
        finishedPolls = 0;
      } else if (++finishedPolls >= 2) {
        // Command finished - deliver notification
        const duration = Math.round((Date.now() - startTime) / 1000);
        const lastLines = lines.slice(-10).filter((l: string) => l.trim() !== "").slice(-5).join("\n");
        const now = Date.now();
        const msg = `[tmux:${task.target}:done] Command: "${task.command}" finished in ${duration}s | Started: ${fmtTime(startTime)} | Finished: ${fmtTime(now)}\nOutput:\n${lastLines}`;
        await deliverCallback(task.callbackTarget, msg, task.target);
        backgroundTasks.delete(task.id);
        return;
      }
    } catch (_e) {
      // Pane read failed - session might be gone
      const msg = `[tmux:${task.target}:error] Lost connection to session while monitoring "${task.command}"`;
      await deliverCallback(task.callbackTarget, msg, task.target);
      backgroundTasks.delete(task.id);
      return;
    }
  }
}
