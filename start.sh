#!/bin/bash
# Start both the backend and frontend dev servers

# Install Python deps
pip install -r requirements.txt 2>/dev/null

# Start FastAPI backend
uvicorn server.app:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

# Start Vite frontend dev server
cd client && npm run dev -- --host 0.0.0.0 --port 5173 &
FRONTEND_PID=$!

echo "Backend: http://localhost:8000"
echo "Frontend: http://localhost:5173"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
