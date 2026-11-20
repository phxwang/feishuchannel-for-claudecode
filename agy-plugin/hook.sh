#!/bin/sh
# Feishu router bridge for agy lifecycle hooks.
#
# Only active inside tmux sessions the Feishu router spawned: the router sets
# FEISHU_AGY_SIGNAL_DIR on those sessions and nowhere else, so for any other
# agy use this exits immediately with an empty (no-op) response.
#
# Writes the hook payload agy sends on stdin to $FEISHU_AGY_SIGNAL_DIR/<Event>.json
# and last.json, atomically (write to a temp file, then rename). The router
# watches Stop.json's mtime as its turn-completion signal and reads the
# conversation id from last.json.
#
# Never registered for PreToolUse: agy treats a PreToolUse hook that returns
# an empty object as "deny".
dir="$FEISHU_AGY_SIGNAL_DIR"
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  cat >/dev/null
  echo '{}'
  exit 0
fi

event="$1"
case "$event" in
  SessionStart|PostToolUse|Stop) ;;
  *) cat >/dev/null; echo '{}'; exit 0 ;;
esac

tmp="$dir/.$event.$$"
if cat > "$tmp"; then
  cp "$tmp" "$dir/.last.$$" && mv -f "$dir/.last.$$" "$dir/last.json"
  mv -f "$tmp" "$dir/$event.json"
else
  rm -f "$tmp"
fi
echo '{}'
