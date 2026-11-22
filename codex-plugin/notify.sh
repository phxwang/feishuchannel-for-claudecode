#!/bin/sh
# Feishu router bridge for Codex's `notify` program (tmux/profiles/codex.ts).
#
# Codex runs this with one argument, a compact JSON object, after each agent
# turn completes:
#   {"type":"agent-turn-complete","thread-id":"…","turn-id":"…","cwd":"…",
#    "client":"codex-tui","input-messages":[…],"last-assistant-message":"…"}
#
# The router passes it with `-c notify=[...]` only on the tmux sessions it
# spawns, and also sets FEISHU_CODEX_SIGNAL_DIR on them. Without that dir
# this exits immediately, so it never acts on the user's own Codex use.
#
# Writes the payload to $FEISHU_CODEX_SIGNAL_DIR/notify-<thread-id>.json and
# last.json, atomically (temp file, then rename). One file per thread because
# Codex also notifies for its internal helper threads (for example the
# task-title generator), and those must never be mistaken for the session's
# own thread. The router uses these files only to learn the session id;
# the end of a turn is read from the rollout transcript.
dir="$FEISHU_CODEX_SIGNAL_DIR"
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  exit 0
fi

payload="$1"
# Thread ids are UUIDs. Anything else (or none) is rejected, which also
# rules out path traversal through the file name.
tid=$(printf '%s' "$payload" | sed -n 's/.*"thread-id":"\([0-9A-Fa-f-]\{1,64\}\)".*/\1/p')
if [ -z "$tid" ]; then
  exit 0
fi

tmp="$dir/.notify.$$"
if printf '%s' "$payload" > "$tmp"; then
  cp "$tmp" "$dir/.last.$$" && mv -f "$dir/.last.$$" "$dir/last.json"
  mv -f "$tmp" "$dir/notify-$tid.json"
else
  rm -f "$tmp"
fi
exit 0
