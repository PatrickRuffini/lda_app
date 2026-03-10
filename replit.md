# LDA Filings Search & Politico Influence Tracker

## Overview

A full-stack application for searching and browsing U.S. Senate Lobbying Disclosure Act (LDA) filings, combined with a Politico Influence newsletter scraping and entity extraction system. The app syncs data from the Senate LDA API into PostgreSQL, scrapes Politico Influence newsletters using headless Chromium, extracts named entities (people and organizations), detects relationships via co-mentions and affiliations, and presents everything through an interactive React frontend with a force-directed network graph.

## Architecture

### Port Configuration
- **Frontend (Vite)**: `0.0.0.0:8000` — externally accessible via Replit's webview
- **Backend (FastAPI)**: `127.0.0.1:8001` — internal only, proxied by Vite
- **Vite proxy**: `/api` requests are forwarded to `http://localhost:8001`
- **Workflow command**: `bash start.sh` (NOT `npm run dev`)

### Tech Stack
- **Backend**: Python 3.11, FastAPI, SQLAlchemy, curl_cffi (with Playwright fallback), BeautifulSoup, lxml
- **Frontend**: React 19, TypeScript, Vite 7, Tailwind CSS v4, Lucide icons, date-fns
- **Database**: PostgreSQL (via `DATABASE_URL` environment variable)
- **CSS**: Tailwind v4 — uses `@import "tailwindcss"` syntax (NOT `@tailwind base/components/utilities`)

### Environment Variables
- `DATABASE_URL` — PostgreSQL connection string (required)
- `LDA_API_KEY` — Senate LDA API authentication token
- `SESSION_SECRET` — Session secret (available but not currently used)

## File Structure

```
├── start.sh                       # Startup script: launches both backend and frontend
├── requirements.txt               # Python dependencies
├── server/
│   ├── app.py                     # FastAPI application — all API routes (887 lines)
│   ├── models.py                  # SQLAlchemy ORM models (165 lines)
│   ├── sync.py                    # Senate LDA API sync service (528 lines)
│   └── influence.py               # Politico Influence scraper & entity extraction (960 lines)
├── client/
│   ├── index.html                 # HTML entry point
│   ├── package.json               # Frontend dependencies
│   ├── vite.config.ts             # Vite config: proxy, allowedHosts, Tailwind plugin
│   └── src/
│       ├── main.tsx               # React entry point
│       ├── index.css              # Tailwind v4 import + base styles
│       ├── App.tsx                # All UI components and pages (1590 lines)
│       ├── api.ts                 # API client with TypeScript types (291 lines)
│       └── NetworkGraph.tsx       # Canvas-based force-directed graph (288 lines)
```

## Database Schema

### LDA Filing Models
- **Registrant** — Lobbying firms (senate_id, name, description, address, country, state)
- **Client** — Clients of lobbying firms (senate_id, name, description, country, state)
- **Filing** — Individual LDA filings (filing_uuid, type, year, period, date, income, expenses, url)
- **LobbyingActivity** — Activities within a filing (issue_code, description, specific_issues, government_entities as JSON, lobbyists as JSON)

### Politico Influence Models
- **Newsletter** — Scraped newsletter editions (url unique, title, published_date, body_text, body_html, entities_extracted flag)
- **Entity** — Extracted named entities (name unique, entity_type: person/organization/unknown, display_name, mention_count, user_override flag)
- **EntityMention** — Links entities to newsletters with context (entity_id, newsletter_id, paragraph_index, context_text, section_heading)
- **Relationship** — Entity pairs with relationship metadata (entity_a_id, entity_b_id unique pair, relationship_type: co_mention/affiliation/lobbying_registration, weight, context_snippets as JSON array)

### Key Constraints
- Relationship pairs: `entity_a_id` is always < `entity_b_id` (canonical ordering)
- Registration pairs: `paragraph_index = 9000` (sentinel value for registration/termination section entries)
- `user_override = True` on Entity persists the entity_type through reprocessing

## API Endpoints

### LDA Filing Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/filings` | Search filings with full-text search (PostgreSQL `to_tsvector`) and filters (year, period, type, issue_code, registrant, client, min_income, min_expenses) |
| GET | `/api/filings/{uuid}` | Get full filing detail with lobbying activities |
| GET | `/api/issues` | List all issue codes with filing counts |
| GET | `/api/issues/{code}/filings` | Filings for a specific issue code |
| GET | `/api/top-registrants` | Top registrants by filing count (cached 30s) |
| GET | `/api/top-clients` | Top clients by filing count (cached 30s) |
| GET | `/api/stats` | Overall database statistics (cached 30s) |

### Sync Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sync` | Trigger sync: mode=incremental (new filings), backfill (all years 1999–present), or specific filing_year |
| POST | `/api/sync/cancel` | Cancel a running sync |
| GET | `/api/sync/status` | Current sync progress |
| GET | `/api/sync/coverage` | Year-by-year filing counts |

### Politico Influence Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/influence/scrape` | Trigger newsletter scraping (max_newsletters, max_discovery_pages) |
| GET | `/api/influence/scrape/status` | Scrape progress |
| GET | `/api/influence/newsletters` | List newsletters, supports `q` param for title/body search |
| GET | `/api/influence/newsletters/{id}` | Full newsletter with entity mentions |
| GET | `/api/influence/entities` | List entities with filters (q, entity_type, sort, pagination) |
| GET | `/api/influence/entities/{id}` | Entity detail with connections and deduplicated newsletter mentions (max 20) |
| PATCH | `/api/influence/entities/{id}` | Update entity type (sets user_override=True) |
| POST | `/api/influence/reprocess` | Re-extract all entities from stored HTML (preserves user overrides) |
| GET | `/api/influence/network` | Network graph data (min_weight, max_nodes, entity_type, center_entity_id filters) |
| GET | `/api/influence/stats` | Influence section statistics (cached 30s) |

## Frontend Pages

1. **Dashboard** — Filing stats, sync controls (incremental/backfill/cancel), recent filings, top registrants/clients
2. **Search** — Full-text search with filters (year, period, issue code, registrant name, client name)
3. **Issues** — Browse filings by issue area (two-panel layout)
4. **Filing Detail** — Full filing info with registrant/client details and lobbying activities
5. **Influence** — Newsletter list, search (entities + newsletters simultaneously), stats cards, top entities sidebar, scrape button
6. **Newsletter Reader** — Annotated newsletter text with inline entity badges (indigo for people, amber for organizations), section heading detection (FIRST IN PI, etc.)
7. **Network Map** — Canvas-based force-directed graph with drag, zoom, hover, click-to-navigate. Configurable min connections, max nodes, entity type filter
8. **Entity Detail** — Entity info with type override selector, affiliations, lobbying registrations, co-mentions, newsletter appearances (deduplicated)
9. **Entity Leaderboard** — Ranked list of people or organizations by mention count

## Key Implementation Details

### Entity Extraction (server/influence.py)
- Extracts bold-tagged text from newsletter HTML as entity names
- Merges consecutive bold tags (e.g., `<b>Donald</b> <b>Trump</b>` → "Donald Trump")
- Strips possessive suffixes (`'s`) except for known brands: Lowe's, McDonald's, Arby's, Macy's, Campbell's, Hellmann's
- Classifies entities using context-based heuristics (title patterns for people, suffix patterns for organizations)
- Detects affiliations from "Person of Company" and "Company's Person" patterns
- Extracts registration pairs from "New Lobbying Registrations/Terminations" sections (splits on LAST colon via `rfind`)
- Section headings identified by uppercase patterns and excluded from entity creation
- Known section headings: JOBS REPORT, NEW LOBBYING REGISTRATIONS/TERMINATIONS, NEW JOINT FUNDRAISERS, NEW PACS, SPOTTED, etc.
- Ad filtering: paragraphs inside HTML elements with `intext-ad` class are skipped during entity extraction
- Boilerplate stripping removes bylines and pre-content text

### Newsletter Reader (frontend)
- Paragraphs starting with "A message from" are treated as ad blocks, grouped with all following paragraphs until the next section heading
- Ad blocks render inside a labeled "Ad" box with muted styling, no entity badges
- Entity badges: inline clickable badges (indigo for people, amber for organizations) with icons

### Network Graph (client/src/NetworkGraph.tsx)
- Custom canvas-based force simulation (no D3 dependency)
- Three forces: center attraction, node repulsion (charge), edge attraction (spring)
- Node size scaled by mention_count; color by entity_type (indigo=person, amber=organization, slate=unknown)
- Edge color: amber for affiliations, slate for co-mentions
- Supports drag-to-move, scroll-to-zoom, click-to-navigate

### Caching
- `_cached(key, fn)` in app.py with 30-second TTL
- Cache invalidated after sync and reprocess operations

### Newsletter Scraping
- Tries Playwright headless Chromium first; falls back to curl_cffi (impersonating Chrome) if browser unavailable
- curl_cffi requires no system libraries and works reliably in Replit's nix environment
- Discovers newsletter URLs from archive pages (`/newsletters/politico-influence/archive`)
- Supports `cutoff_date` parameter to stop at a specific date
- Entity extraction runs immediately after each newsletter is stored
- After scraping, runs duplicate entity merge, LDA record linking, and lobbyist linking

## Git Notes

- Good reference commit: `a245dd4` ("Prevent duplicate newsletter appearances in entity details") — last stable commit with all features
- Restore commit: `32f141fb` — contains the full restored codebase
- Current data: 267 newsletters (Jan 20, 2025 – Mar 6, 2026), 25,936 entities, 51,947 mentions, 90,258 relationships in PostgreSQL
