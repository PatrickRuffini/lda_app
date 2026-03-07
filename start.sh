#!/bin/bash
# Start both the backend and frontend dev servers

export PATH="/home/runner/workspace/.pythonlibs/bin:$PATH"

# Install Python deps (skip if pip unavailable — deps pre-installed in .pythonlibs)
pip install -r requirements.txt 2>/dev/null || true

# Set LD_LIBRARY_PATH for Playwright Chromium (libgbm)
for dir in /nix/store/*mesa-libgbm*/lib; do
  if [ -f "$dir/libgbm.so.1" ]; then
    export LD_LIBRARY_PATH="$dir:${LD_LIBRARY_PATH:-}"
    break
  fi
done

# Start FastAPI backend on internal-only port
uvicorn server.app:app --host 127.0.0.1 --port 8001 --reload &
BACKEND_PID=$!

# Wait for backend to be ready before starting frontend
echo "Waiting for backend..."
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:8001/api/stats > /dev/null 2>&1; then
    echo "Backend ready."
    break
  fi
  sleep 1
done

# Start Vite frontend dev server on port 8000 (maps to external port 80)
cd client && npm install && npm run dev -- --host 0.0.0.0 --port 8000 &
FRONTEND_PID=$!

echo "Backend: http://127.0.0.1:8001 (internal only)"
echo "Frontend: http://localhost:8000"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
