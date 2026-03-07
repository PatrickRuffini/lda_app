# LDA Tracker

A full-stack app for tracking Senate Lobbying Disclosure Act filings and mapping DC influence networks from Politico's Influence newsletter.

## Features

### LDA Filings Search
- **Sync** filings from the [Senate LDA API](https://lda.senate.gov/api/) into a local SQLite database
- **Full-text search** across registrants, clients, lobbyists, issue areas, and specific lobbying issues (powered by FTS5)
- **Filter** by year, quarter, issue code, registrant name, client name, income, and expenses
- **Browse by issue area** to see which topics are drawing the most lobbying activity
- **Filing detail view** with lobbying activities, government entities contacted, and lobbyist names
- **Top registrants and clients** ranked by filing volume

### Politico Influence Network Map
- **Scrape** the [Politico Influence](https://www.politico.com/newsletters/politico-influence) newsletter — daily editions and back issues
- **Extract bolded entities** (people and organizations) from newsletter HTML
- **Detect professional affiliations** from patterns like:
  - "**John Smith** of **Akin Gump**" → person affiliated with organization
  - "**Goldman Sachs**'s **Jane Doe**" → person affiliated with organization
- **Build a relationship graph** from paragraph co-occurrences — two bolded entities in the same paragraph indicates a relationship
- **Interactive network visualization** — force-directed graph rendered on canvas with:
  - Color-coded nodes (indigo = person, amber = organization)
  - Node size scaled by mention count
  - Edge weight by co-occurrence frequency
  - Zoom, pan, drag, and click-through to entity detail
  - Filters for minimum connection strength, max nodes, and entity type
- **Entity detail pages** showing affiliations, co-mentions with context snippets, and newsletter appearance history

## Setup

### Prerequisites
- Python 3.10+
- Node.js 18+

### API Key (optional)
Register for a Senate LDA API key at https://lda.senate.gov/api/register/ for higher rate limits. Without a key, anonymous access works but is throttled more aggressively.

```bash
cp .env.example .env
# Edit .env and add your API key
```

### Install & Run

```bash
# Install Python dependencies
pip install -r requirements.txt

# Install frontend dependencies and build
cd client && npm install && npm run build && cd ..

# Start the server
uvicorn server.app:app --host 0.0.0.0 --port 8000
```

Or use the dev script to run both backend and frontend dev servers:

```bash
./start.sh
```

- Backend: http://localhost:8000
- Frontend dev server: http://localhost:5173

## Architecture

```
lda_app/
├── server/
│   ├── app.py          # FastAPI routes for filings, influence, and network
│   ├── models.py       # SQLAlchemy models (filings + Politico Influence)
│   ├── sync.py         # Senate LDA API sync service
│   └── influence.py    # Politico Influence scraper and entity extraction
├── client/
│   └── src/
│       ├── App.tsx          # Main app with all pages
│       ├── api.ts           # API client and TypeScript types
│       └── NetworkGraph.tsx # Canvas-based force-directed graph
├── requirements.txt
├── .env.example
└── start.sh
```

### Backend
- **FastAPI** with background task support for long-running syncs and scrapes
- **SQLite** with FTS5 for full-text search
- **SQLAlchemy** ORM with models for filings, registrants, clients, lobbying activities, newsletters, entities, mentions, and relationships
- **BeautifulSoup** for HTML parsing and bold entity extraction

### Frontend
- **React 19** + TypeScript + Vite
- **Tailwind CSS v4** for styling
- **Canvas API** for the network graph (no charting library dependency)
- **date-fns** for date formatting
- **lucide-react** for icons

## API Endpoints

### LDA Filings
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sync` | Trigger background sync from Senate LDA API |
| GET | `/api/sync/status` | Check sync progress |
| GET | `/api/filings?q=&filing_year=&issue_code=` | Search filings with filters |
| GET | `/api/filings/{uuid}` | Filing detail with lobbying activities |
| GET | `/api/issues` | Issue areas with filing counts |
| GET | `/api/issues/{code}/filings` | Filings for a specific issue |
| GET | `/api/top-registrants` | Top registrants by filing count |
| GET | `/api/top-clients` | Top clients by filing count |
| GET | `/api/stats` | Database statistics |

### Politico Influence
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/influence/scrape` | Trigger newsletter scrape |
| GET | `/api/influence/scrape/status` | Check scrape progress |
| GET | `/api/influence/newsletters` | List scraped newsletters |
| GET | `/api/influence/newsletters/{id}` | Full newsletter with extracted entities |
| GET | `/api/influence/entities?q=&entity_type=` | Search entities |
| GET | `/api/influence/entities/{id}` | Entity detail with connections |
| GET | `/api/influence/network?min_weight=&max_nodes=` | Network graph data |
| GET | `/api/influence/stats` | Influence feature statistics |

## Data Model

### Filings
Filings are synced from the Senate LDA API and stored with their associated registrant, client, and lobbying activities. Each lobbying activity includes the general issue code, specific issues text, government entities contacted, and lobbyists involved.

### Influence Network
The network is built incrementally as newsletters are scraped:
1. **Newsletters** store the full text and HTML of each edition
2. **Entities** are extracted from `<strong>`/`<b>` tags, with skip patterns filtering out non-entity bold text (section headers, days of week, etc.)
3. **Entity Mentions** link each entity to the specific newsletter and paragraph where it appeared
4. **Relationships** connect entity pairs that co-occur in the same paragraph, with weights that accumulate over time. Affiliations detected from "X of Y" or "Y's X" patterns are stored as a distinct relationship type.
