#!/bin/bash
# Auto-increment tmux session creator
# Usage: ./new-session.sh [prefix] [command]
# Example: ./new-session.sh monitoring "tail -f /var/log/syslog"

PREFIX="${1:-session}"
COMMAND="${2:-bash}"

# Get all existing sessions with this prefix
EXISTING=$(tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^${PREFIX}-[0-9]*$" | sort -V)

# Find next available number
NEXT_NUM=1
if [ -n "$EXISTING" ]; then
    LAST_SESSION=$(echo "$EXISTING" | tail -1)
    LAST_NUM=$(echo "$LAST_SESSION" | sed "s/${PREFIX}-//")
    NEXT_NUM=$((LAST_NUM + 1))
fi

SESSION_NAME="${PREFIX}-${NEXT_NUM}"

# Create and attach to new session
if [ "$COMMAND" = "bash" ]; then
    tmux new-session -s "$SESSION_NAME"
else
    tmux new-session -s "$SESSION_NAME" "$COMMAND"
fi
