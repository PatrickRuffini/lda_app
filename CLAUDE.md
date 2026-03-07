# CLAUDE.md

## Project Overview

LDA Filings Search & Politico Influence Tracker — a full-stack app for browsing U.S. Senate Lobbying Disclosure Act filings and tracking Politico Influence newsletter entities/relationships.

## Architecture

- **Backend**: Python 3.11, FastAPI, SQLAlchemy (`server/`)
- **Frontend**: React 19, TypeScript, Vite 7, Tailwind CSS v4 (`client/`)
- **Database**: PostgreSQL (hosted separately, via `DATABASE_URL` env var)
- **Ports**: Frontend on `0.0.0.0:8000`, Backend on `127.0.0.1:8001`, Vite proxies `/api` to backend
- **Start command**: `bash start.sh`

## Database Reference

The file `lda_filings.db` (SQLite) in the project root is a **local dump/snapshot for reference only — it is NOT the database of record**. The production database is a separately hosted PostgreSQL instance connected via `DATABASE_URL`.

When you need to understand the shape of the data, inspect table schemas, or look at sample data to answer questions about what the data looks like, refer to `lda_filings.db`. Key tables defined in `server/models.py`:

- `registrants` — Lobbying firms/registrants
- `clients` — Clients of registrants
- `filings` — LDA filing records (income, expenses, filing period, etc.)
- `lobbying_activities` — Issue areas and descriptions per filing
- `newsletters` — Scraped Politico Influence newsletters (HTML + extracted text)
- `entities` — Extracted named entities (people, organizations) with mention counts
- `entity_mentions` — Per-newsletter entity mention records
- `relationships` — Entity-to-entity relationships (co_mention, affiliation, lobbying_registration, lobbying_termination)

## Key Files

- `server/app.py` — FastAPI routes and API endpoints
- `server/models.py` — SQLAlchemy models (all table definitions)
- `server/influence.py` — Newsletter scraping, entity extraction, relationship building
- `client/src/App.tsx` — Main React app with all page components
- `client/src/NetworkGraph.tsx` — Canvas-based force-directed network graph with eigenvector centrality
- `client/src/api.ts` — TypeScript API client and type definitions
- `replit.md` — Detailed architecture docs, entity extraction rules, and coding conventions

## Conventions

- Tailwind v4 syntax: `@import "tailwindcss"` (not `@tailwind` directives)
- All buttons need `cursor-pointer` class
- CSS uses `@theme` block for custom values (not `theme.extend`)
- Entity types: `person`, `organization`, `unknown`
- Relationship types: `co_mention`, `affiliation`, `lobbying_registration`, `lobbying_termination`
