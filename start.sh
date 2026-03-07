#!/bin/bash
# Start both the backend and frontend dev servers

# Install Python deps
pip install -r requirements.txt 2>/dev/null

# Start FastAPI backend on internal-only port
uvicorn server.app:app --host 127.0.0.1 --port 8001 --reload &
BACKEND_PID=$!

# Start Vite frontend dev server on port 8000 (maps to external port 80)
cd client && npm install && npm run dev -- --host 0.0.0.0 --port 8000 &
FRONTEND_PID=$!

echo "Backend: http://127.0.0.1:8001 (internal only)"
echo "Frontend: http://localhost:8000"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
