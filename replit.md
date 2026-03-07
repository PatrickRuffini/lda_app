# LDA Tracker — replit.md

## Overview

LDA Tracker is a full-stack web application for tracking U.S. Senate Lobbying Disclosure Act (LDA) filings and mapping DC influence networks from Politico's Influence newsletter.

**Two main feature areas:**
1. **LDA Filings** — syncs filing data from the Senate LDA API into a local SQLite database, then provides full-text search, filtering, and browsing across registrants, clients, lobbyists, and issue areas.
2. **Influence Network** — scrapes the Politico Influence newsletter, extracts bolded entities (people and organizations), builds a relationship graph from paragraph co-occurrences, and renders an interactive force-directed network visualization.

The backend is a Python FastAPI server. The frontend is a React + TypeScript SPA built with Vite. The backend serves both the API and the compiled frontend static files.

---

## User Preferences

Preferred communication style: Simple, everyday language.

---

## System Architecture

### Backend (Python / FastAPI)

- **Framework:** FastAPI with Uvicorn as the ASGI server.
- **Location:** `server/` directory as a Python package.
- **Key modules:**
  - `server/app.py` — main FastAPI app, route definitions, CORS middleware, serves static frontend files via `StaticFiles`.
  - `server/models.py` — SQLAlchemy ORM models (declarative base). Tables: `registrants`, `clients`, `filings` (includes `added_to_db` timestamp), `lobbying_activities`, `entities`, `entity_mentions`, `newsletters`, `relationships`. Connects to PostgreSQL via `DATABASE_URL`.
  - `server/sync.py` — fetches filings from the Senate LDA API (`https://lda.senate.gov/api/v1`) with pagination, retry logic, and optional API key auth. Supports two modes: **incremental** (grabs newest filings, stops at duplicates) and **backfill** (year-by-year from present to 1999, skips years already complete). Thread-safe progress tracking via `get_sync_progress()`. Stores results into PostgreSQL with `added_to_db` timestamp.
  - `server/influence.py` — scrapes Politico Influence newsletter using Playwright headless Chromium (to bypass Cloudflare), extracts bold entities, detects person↔organization affiliations via regex patterns, builds co-occurrence relationships, stores to PostgreSQL. Requires `LD_LIBRARY_PATH` set for `libgbm` (handled in `start.sh`).
- **Full-text search:** PostgreSQL `to_tsvector`/`to_tsquery` for full-text search across registrant names, client names, and filing fields.
- **Database:** PostgreSQL via Replit's built-in database. Connected through `DATABASE_URL` environment variable.
- **Auth:** Optional Senate LDA API key via `LDA_API_KEY` environment variable (falls back to anonymous access).
- **CORS:** Wildcard allowed origins for development simplicity.
- **Static file serving:** The compiled Vite frontend (`client/dist`) is mounted and served by FastAPI directly, so there's only one server process in production.
- **Dev port layout:** FastAPI runs on `127.0.0.1:8001` (internal only). Vite dev server runs on `0.0.0.0:8000` (externally accessible via Replit's port 80 mapping). Vite proxies `/api` requests to the backend. The `.replit` file maps `localPort 8000 → externalPort 80`.

### Frontend (React / TypeScript / Vite)

- **Framework:** React 19 with TypeScript.
- **Build tool:** Vite 7 with `@vitejs/plugin-react`.
- **Styling:** Tailwind CSS v4 (via `@tailwindcss/vite` plugin).
- **Routing:** `wouter` (lightweight client-side router).
- **Icons:** `lucide-react`.
- **Date formatting:** `date-fns`.
- **Key files:**
  - `client/src/App.tsx` — main app shell, nav, and all page-level components.
  - `client/src/NetworkGraph.tsx` — Canvas-based force-directed graph simulation (custom, no D3). Supports zoom, pan, drag, hover, and click.
  - `client/src/api.ts` — typed fetch helpers and all TypeScript interfaces for API responses.
  - `client/src/index.css` — Tailwind import and global base styles.
- **Dev proxy:** Vite proxies `/api/*` to `http://localhost:8001` during development so frontend and backend can run separately without CORS issues.

### Data Flow

```
Senate LDA API ──► sync.py ──► SQLite (lda_filings.db)
                                      │
Politico HTML ──► influence.py ───────┘
                                      │
                               FastAPI (app.py)
                                      │
                           React SPA (App.tsx / api.ts)
                                      │
                           NetworkGraph.tsx (Canvas)
```

### Pages / Routes (frontend state machine)

| Page | Purpose |
|---|---|
| `dashboard` | Stats overview, top registrants/clients, sync controls |
| `search` | Full-text + filtered filing search |
| `issues` | Browse by issue area / issue code |
| `filing` | Individual filing detail |
| `influence` | Newsletter list and scrape controls |
| `network` | Interactive force-directed graph of entities |
| `entity` | Entity detail (affiliations, co-mentions, newsletter history) |

Navigation is managed via a `Page` type union and `useState` in `App.tsx` (not URL-based routing for most transitions).

---

## External Dependencies

### APIs
- **Senate LDA API** (`https://lda.senate.gov/api/v1`) — paginated REST API for lobbying disclosure filings. Optional API key for higher rate limits. Registered at `https://lda.senate.gov/api/register/`.
- **Politico Influence Newsletter** (`https://www.politico.com/newsletters/politico-influence`) — scraped via HTTP requests + BeautifulSoup HTML parsing. No API key; uses a browser-like User-Agent header. Respects 429 rate limit responses with exponential backoff.

### Python Libraries
| Library | Purpose |
|---|---|
| `fastapi` | Web framework and API routing |
| `uvicorn` | ASGI server |
| `sqlalchemy` | ORM and database access (SQLite) |
| `pydantic` | Request/response data validation |
| `requests` | HTTP client for API and scraping |
| `beautifulsoup4` + `lxml` | HTML parsing for newsletter scraper |
| `playwright` | Headless Chromium browser for Cloudflare bypass |
| `python-dotenv` | `.env` file loading for config |

### Node / Frontend Libraries
| Library | Purpose |
|---|---|
| `react` + `react-dom` | UI framework |
| `vite` + `@vitejs/plugin-react` | Build tooling and dev server |
| `tailwindcss` + `@tailwindcss/vite` | Utility-first styling |
| `wouter` | Lightweight client-side routing |
| `lucide-react` | Icon set |
| `date-fns` | Date formatting utilities |
| `typescript` | Static typing |

### Environment Variables
| Variable | Purpose | Default |
|---|---|---|
| `LDA_API_KEY` | Senate LDA API auth token | (empty = anonymous) |
| `DATABASE_URL` | PostgreSQL connection string | (set by Replit) |

### Database is PostgreSQL provided by Replit's built-in database service.