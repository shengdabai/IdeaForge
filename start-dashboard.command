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
echo "IdeaForge starting… http://127.0.0.1:$PORT/"
# open the browser after the server is up
( sleep 1.5; open "http://127.0.0.1:$PORT/" ) &
exec node engine/forge.mjs serve --port=$PORT
