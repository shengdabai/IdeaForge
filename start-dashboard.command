#!/bin/bash
# Double-click to launch IdeaForge: start the local server + open the dashboard.
# 双击启动 IdeaForge:起本地服务并打开 dashboard。Close the terminal window to stop.
cd "$(dirname "$0")" || exit 1
PORT=8765
# if the port is busy, warn and let the server pick the next free one — never kill
# unrelated processes. 端口被占时只提示,不强杀其它进程。
if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "Port $PORT is busy; trying $((PORT+1)) instead."
  PORT=$((PORT+1))
fi
echo "IdeaForge starting…"
# The server emits a one-time Dashboard URL containing an auth token in its
# fragment. Wait for that exact URL rather than opening the unauthenticated root.
# Server output goes to this terminal and, via tee, to a temp file read below.
LOG_FILE="$(mktemp -t ideaforge-dashboard)" || exit 1
trap 'rm -f "$LOG_FILE"' EXIT
node engine/forge.mjs serve --port=$PORT 2>&1 | tee "$LOG_FILE" &
# PID of tee, which exits when the server closes its output.
SERVER_PID=$!

for _ in $(seq 1 50); do
  DASHBOARD_URL="$(awk '/^IdeaForge serving at / { sub(/^IdeaForge serving at /, ""); print; exit }' "$LOG_FILE")"
  if [ -n "$DASHBOARD_URL" ]; then
    echo "Dashboard URL: $DASHBOARD_URL"
    echo "Reopen this URL if a refreshed Dashboard asks for its token. 刷新后缺令牌时，请重新打开上面这条链接。"
    open "$DASHBOARD_URL"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if [ -z "$DASHBOARD_URL" ]; then
  echo "IdeaForge failed to start; see the server output above."
fi
wait "$SERVER_PID"
