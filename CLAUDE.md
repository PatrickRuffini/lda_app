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

The production database is a separately hosted PostgreSQL instance connected via `DATABASE_URL`. The `db-dump/` folder contains **CSV exports of the production data for reference only — these are NOT the database of record**. Use these files whenever you need to understand the shape of the data, inspect sample rows, or answer questions about what the data looks like.

### Reference files (`db-dump/`)

- `registrants.csv` — Lobbying firms/registrants
- `clients.csv` — Clients of registrants
- `filings.csv` — LDA filing records (income, expenses, filing period, etc.)
- `lobbying_activities.csv` — Issue areas and descriptions per filing
- `newsletters.csv` — Scraped Politico Influence newsletters (HTML + extracted text)
- `entities.csv` — Extracted named entities (people, organizations) with mention counts
- `entity_mentions.csv` — Per-newsletter entity mention records
- `relationships.csv` — Entity-to-entity relationships (co_mention, affiliation, lobbying_registration, lobbying_termination)

Additionally, `lda_filings.db` (SQLite) in the project root is an older local snapshot that can also be queried for reference.

Table schemas are defined in `server/models.py`.

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
