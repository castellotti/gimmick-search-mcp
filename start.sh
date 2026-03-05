#!/usr/bin/env bash
set -e

echo "[gimmick] Starting Xvfb on :99..."
Xvfb :99 -screen 0 1280x900x24 -ac &
sleep 1

echo "[gimmick] Starting fluxbox..."
DISPLAY=:99 fluxbox &
sleep 0.5

echo "[gimmick] Starting x11vnc..."
x11vnc -display :99 -nopw -forever -rfbport 5900 -shared -bg -q
sleep 0.5

echo "[gimmick] Starting websockify/noVNC on port 6080..."
websockify --web /usr/share/novnc 6080 localhost:5900 --daemon
sleep 0.5

echo "[gimmick] Starting MCP server (HTTP panel on 6081, stdio MCP)..."
exec node /app/build/index.js
