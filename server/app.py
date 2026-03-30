"""FastAPI application for LDA filings search and browsing."""
import json
import logging
import os
import re
import threading
import time
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, Query, Body, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import text, func, desc

from .models import (
    Filing, LobbyingActivity, Registrant, Client,
    Entity, EntityMention, Newsletter, Relationship,
    ChatConversation, ChatMessage,
    AdCapture, AdCampaign,
    get_engine, get_session, init_db, run_migrations,
)
from .sync import sync_filings, sync_incremental, sync_backfill, sync_backfill_chunk, sync_complete_years, sync_year, sync_date_range, get_sync_progress, _update_progress
from .influence import scrape_and_store, reprocess_all_entities, get_scrape_progress, get_reprocess_progress, link_entities_to_lda, link_lobbyists_to_entities, merge_duplicate_entities, _normalize_org_aggressive
from .ad_scraper import scrape_ads, get_ad_scrape_progress
from .ai import generate_entity_summary, chat as ai_chat

logger = logging.getLogger(__name__)

DB_URL = os.environ.get("DATABASE_URL")

app = FastAPI(title="LDA Filings Search", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


_cache = {}
CACHE_TTL = 30

def _cached(key, fn):
    now = time.time()
    entry = _cache.get(key)
    if entry and now - entry[1] < CACHE_TTL:
        return entry[0]
    result = fn()
    _cache[key] = (result, now)
    return result

def _invalidate_cache(*keys):
    for k in keys:
        _cache.pop(k, None)


def _dedup_firms(rows: list[dict], name_key: str = "name") -> list[dict]:
    """Merge rows that share the same normalized firm name.

    Keeps the display name from the row with the most filings.
    Sums numeric fields (filing_count, unique_clients, total_income/total_revenue, lobbyist_count).
    Unions set fields (lobbyist_names).
    """
    groups: dict[str, dict] = {}
    for row in rows:
        raw_name = row.get(name_key) or ""
        if not raw_name:
            continue
        key = _normalize_org_aggressive(raw_name)
        if key in groups:
            g = groups[key]
            for field in ("filing_count", "unique_clients", "total_income", "total_revenue"):
                if field in row and field in g:
                    g[field] = (g[field] or 0) + (row[field] or 0)
            if "lobbyist_names" in row and "lobbyist_names" in g:
                g["lobbyist_names"] = g["lobbyist_names"] | row["lobbyist_names"]
            # Keep display name from the entry with more filings
            if row.get("filing_count", 0) > g.get("_best_filings", 0):
                g[name_key] = row[name_key]
                g["_best_filings"] = row.get("filing_count", 0)
                if "senate_id" in row:
                    g["senate_id"] = row["senate_id"]
                if "id" in row:
                    g["id"] = row["id"]
        else:
            groups[key] = {**row, "_best_filings": row.get("filing_count", 0)}
    # Strip internal field
    for g in groups.values():
        g.pop("_best_filings", None)
    return list(groups.values())



_engine = None

def _get_engine():
    global _engine
    if _engine is None:
        _engine = init_db(DB_URL)
    return _engine

def _get_session():
    return get_session(_get_engine())


@app.on_event("startup")
def _run_startup_migrations():
    engine = _get_engine()
    applied = run_migrations(engine)
    if applied:
        logger.info(f"Migrations applied: {applied}")
        # Only reprocess if entity extraction logic changed (role migration)
        if "role_to_booleans" in applied:
            logger.info("Role migration applied — triggering full entity reprocess...")
            try:
                result = reprocess_all_entities(DB_URL)
                logger.info(f"Startup reprocess complete: {result}")
            except Exception as e:
                logger.error(f"Startup reprocess failed: {e}")

    # Kick off background auto-sync (LDA filings + newsletters)
    def _auto_sync():
        global _auto_sync_status
        _auto_sync_status = {"status": "running", "phase": "lda_sync", "lda": None, "newsletters": None, "error": None}
        try:
            # 1. Incremental LDA filing sync
            logger.info("Auto-sync: starting incremental LDA sync...")
            lda_result = sync_incremental(db_url=DB_URL, max_pages=200)
            _auto_sync_status["lda"] = lda_result
            _auto_sync_status["phase"] = "newsletter_scrape"
            logger.info(f"Auto-sync: LDA sync complete — {lda_result}")

            # 2. Newsletter scrape
            logger.info("Auto-sync: starting newsletter scrape...")
            nl_result = scrape_and_store(max_newsletters=50, max_discovery_pages=5, db_url=DB_URL)
            _auto_sync_status["newsletters"] = nl_result
            _auto_sync_status["phase"] = "done"
            _auto_sync_status["status"] = "completed"
            logger.info(f"Auto-sync: newsletter scrape complete — {nl_result}")
        except Exception as e:
            logger.error(f"Auto-sync error: {e}")
            _auto_sync_status["status"] = "error"
            _auto_sync_status["error"] = str(e)
        finally:
            _invalidate_cache("stats", "top_registrants_10", "top_registrants_20", "top_clients_10", "top_clients_20")

    thread = threading.Thread(target=_auto_sync, daemon=True)
    thread.start()


_auto_sync_status: dict = {"status": "idle"}


@app.get("/api/auto-sync/status")
def auto_sync_status():
    """Get the status of the startup auto-sync."""
    return _auto_sync_status


# ---------- Pydantic schemas ----------

class SyncRequest(BaseModel):
    mode: str = "incremental"
    filing_year: Optional[int] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    max_pages: int = 200


# ---------- Sync endpoints ----------

@app.post("/api/sync")
def trigger_sync(req: SyncRequest):
    """Trigger a background sync from the Senate LDA API.

    mode: "incremental" grabs new filings, "backfill" grabs all historical data.
    Runs in a separate thread so it doesn't block the server.
    """
    progress = get_sync_progress()
    if progress.get("status") == "running":
        return {"status": "already_running", **progress}

    def _run():
        try:
            if req.mode == "date_range" and req.start_date and req.end_date:
                from datetime import datetime as dt
                _update_progress(
                    status="running", mode="date_range",
                    stored=0, skipped=0, duplicates=0, pages=0,
                    current_year=None, years_completed=[], error=None,
                    started_at=dt.utcnow().isoformat(), finished_at=None,
                )
                result = sync_date_range(req.start_date, req.end_date, db_url=DB_URL, max_pages=req.max_pages)
                _update_progress(
                    status="completed", finished_at=dt.utcnow().isoformat(),
                    stored=result["stored"], duplicates=result["duplicates"],
                    pages=result["pages"],
                )
            elif req.mode == "backfill":
                sync_backfill_chunk(db_url=DB_URL, chunk_size=1000)
            elif req.mode == "complete_years":
                sync_complete_years(db_url=DB_URL)
            elif req.filing_year:
                from datetime import datetime as dt
                _update_progress(
                    status="running", mode="year",
                    stored=0, skipped=0, duplicates=0, pages=0,
                    current_year=req.filing_year, years_completed=[], error=None,
                    started_at=dt.utcnow().isoformat(), finished_at=None,
                )
                result = sync_year(req.filing_year, db_url=DB_URL, max_pages=req.max_pages)
                _update_progress(
                    status="completed", finished_at=dt.utcnow().isoformat(),
                    stored=result["stored"], duplicates=result["duplicates"],
                    pages=result["pages"],
                )
            else:
                sync_incremental(db_url=DB_URL, max_pages=req.max_pages)
        except Exception as e:
            logger.error(f"Sync error: {e}")
            from datetime import datetime as dt
            _update_progress(status="error", error=str(e), finished_at=dt.utcnow().isoformat())
        finally:
            _invalidate_cache("stats", "top_registrants_10", "top_registrants_20", "top_clients_10", "top_clients_20")

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"status": "started", "mode": req.mode}


@app.post("/api/sync/cancel")
def cancel_sync():
    """Cancel a running backfill sync."""
    progress = get_sync_progress()
    if progress.get("status") == "running":
        _update_progress(status="cancelling")
        return {"status": "cancelling"}
    return {"status": progress.get("status", "idle")}


@app.get("/api/sync/status")
def sync_status():
    return get_sync_progress()


@app.get("/api/sync/coverage")
def sync_coverage():
    """Get year-by-year filing coverage: how many we have vs how many exist."""
    session = _get_session()
    try:
        rows = (
            session.query(Filing.filing_year, func.count(Filing.id))
            .group_by(Filing.filing_year)
            .order_by(desc(Filing.filing_year))
            .all()
        )
        return {
            "years": [{"year": y, "count": c} for y, c in rows if y is not None],
            "total": sum(c for _, c in rows),
        }
    finally:
        session.close()


# ---------- Search endpoints ----------

@app.get("/api/filings")
def search_filings(
    q: Optional[str] = Query(None, description="Full-text search query"),
    filing_year: Optional[int] = Query(None),
    filing_period: Optional[str] = Query(None),
    filing_type: Optional[str] = Query(None),
    issue_code: Optional[str] = Query(None),
    registrant: Optional[str] = Query(None),
    client: Optional[str] = Query(None),
    lobbyist: Optional[str] = Query(None, description="Filter by lobbyist name (searches JSON lobbyists field)"),
    government_entity: Optional[str] = Query(None, description="Filter by government entity contacted"),
    min_income: Optional[float] = Query(None),
    min_expenses: Optional[float] = Query(None),
    sort: str = Query("-dt_posted", description="Sort field"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    """Search filings with filters and full-text search."""
    session = _get_session()
    try:
        if q:
            fts_query = text(
                """SELECT f.id, ts_rank(
                    to_tsvector('english',
                        coalesce(r.name, '') || ' ' ||
                        coalesce(c.name, '') || ' ' ||
                        coalesce(f.filing_type_display, '') || ' ' ||
                        coalesce(f.posted_by_name, '')
                    ),
                    plainto_tsquery('english', :query)
                ) AS rank
                FROM filings f
                LEFT JOIN registrants r ON f.registrant_id = r.id
                LEFT JOIN clients c ON f.client_id = c.id
                WHERE to_tsvector('english',
                    coalesce(r.name, '') || ' ' ||
                    coalesce(c.name, '') || ' ' ||
                    coalesce(f.filing_type_display, '') || ' ' ||
                    coalesce(f.posted_by_name, '')
                ) @@ plainto_tsquery('english', :query)
                ORDER BY rank DESC
                LIMIT :limit OFFSET :offset"""
            )
            offset = (page - 1) * page_size
            fts_results = session.execute(
                fts_query, {"query": q, "limit": page_size, "offset": offset}
            ).fetchall()
            filing_ids = [r[0] for r in fts_results]

            count_query = text(
                """SELECT COUNT(*) FROM filings f
                LEFT JOIN registrants r ON f.registrant_id = r.id
                LEFT JOIN clients c ON f.client_id = c.id
                WHERE to_tsvector('english',
                    coalesce(r.name, '') || ' ' ||
                    coalesce(c.name, '') || ' ' ||
                    coalesce(f.filing_type_display, '') || ' ' ||
                    coalesce(f.posted_by_name, '')
                ) @@ plainto_tsquery('english', :query)"""
            )
            total = session.execute(count_query, {"query": q}).scalar()

            if not filing_ids:
                return {"results": [], "total": 0, "page": page, "page_size": page_size}

            query = session.query(Filing).filter(Filing.id.in_(filing_ids))
        else:
            query = session.query(Filing)
            total = None

        if filing_year:
            query = query.filter(Filing.filing_year == filing_year)
        if filing_period:
            query = query.filter(Filing.filing_period == filing_period)
        if filing_type:
            query = query.filter(Filing.filing_type == filing_type)
        if registrant:
            query = query.join(Registrant).filter(Registrant.name.ilike(f"%{registrant}%"))
        if client:
            query = query.join(Client).filter(Client.name.ilike(f"%{client}%"))
        if min_income:
            query = query.filter(Filing.income >= min_income)
        if min_expenses:
            query = query.filter(Filing.expenses >= min_expenses)
        _joined_activity = False
        if issue_code:
            query = query.join(LobbyingActivity).filter(
                LobbyingActivity.general_issue_code == issue_code
            )
            _joined_activity = True
        if lobbyist:
            lob_parts = [p.strip() for p in lobbyist.split() if p.strip()]
            lob_filters = [LobbyingActivity.lobbyists.ilike(f"%{part}%") for part in lob_parts]
            if not _joined_activity:
                query = query.join(LobbyingActivity)
                _joined_activity = True
            query = query.filter(*lob_filters)
        if government_entity:
            if not _joined_activity:
                query = query.join(LobbyingActivity)
                _joined_activity = True
            query = query.filter(
                LobbyingActivity.government_entities.ilike(f"%{government_entity}%")
            )
        if _joined_activity:
            query = query.distinct()

        if total is None:
            total = query.count()

        if sort.startswith("-"):
            sort_col = getattr(Filing, sort[1:], Filing.dt_posted)
            query = query.order_by(desc(sort_col))
        else:
            sort_col = getattr(Filing, sort, Filing.dt_posted)
            query = query.order_by(sort_col)

        if not q:
            offset = (page - 1) * page_size
            query = query.offset(offset).limit(page_size)

        filings = query.all()
        return {
            "results": [_filing_to_dict(f) for f in filings],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    finally:
        session.close()


@app.get("/api/government-entities")
def list_government_entities(q: Optional[str] = Query(None, description="Filter entities by name")):
    """Get distinct government entities from lobbying activities."""
    session = _get_session()
    try:
        query = session.query(LobbyingActivity.government_entities).filter(
            LobbyingActivity.government_entities.isnot(None),
            LobbyingActivity.government_entities != '',
        )
        rows = query.distinct().all()

        # government_entities is stored as JSON array of {id, name} objects
        entity_counts: dict[str, int] = {}
        for (raw,) in rows:
            try:
                entities = json.loads(raw)
                if isinstance(entities, list):
                    for ent in entities:
                        if isinstance(ent, dict):
                            name = ent.get("name", "").strip()
                        elif isinstance(ent, str):
                            name = ent.strip()
                        else:
                            continue
                        if name and len(name) > 1:
                            entity_counts[name] = entity_counts.get(name, 0) + 1
            except (json.JSONDecodeError, TypeError):
                # Fallback for any legacy comma-separated values
                for part in re.split(r'[;,\n]+', raw):
                    name = part.strip()
                    if name and len(name) > 1 and not name.startswith('{') and not name.startswith('['):
                        entity_counts[name] = entity_counts.get(name, 0) + 1

        # Filter if query provided
        if q:
            q_lower = q.lower()
            entity_counts = {k: v for k, v in entity_counts.items() if q_lower in k.lower()}

        # Sort by frequency, then alphabetically
        sorted_entities = sorted(entity_counts.items(), key=lambda x: (-x[1], x[0]))

        return {
            "entities": [{"name": name, "count": count} for name, count in sorted_entities[:200]],
            "total": len(sorted_entities),
        }
    finally:
        session.close()


@app.get("/api/filings/sidebar")
def filings_sidebar(
    issue_code: Optional[str] = Query(None),
    registrant: Optional[str] = Query(None),
    client: Optional[str] = Query(None),
    lobbyist: Optional[str] = Query(None),
    government_entity: Optional[str] = Query(None),
    filing_year: Optional[int] = Query(None),
    filing_period: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    limit: int = Query(10, ge=1, le=25),
):
    """Top firms, clients, and lobbyists for the current set of search filters."""
    import json as _json
    session = _get_session()
    try:
        # --- Compute the set of matching filing IDs once, then use it everywhere ---
        needs_activity = bool(issue_code or government_entity or lobbyist)
        fid_q = session.query(Filing.id).select_from(Filing)
        if needs_activity:
            fid_q = fid_q.join(LobbyingActivity, LobbyingActivity.filing_id == Filing.id)
            if issue_code:
                fid_q = fid_q.filter(LobbyingActivity.general_issue_code == issue_code)
            if government_entity:
                fid_q = fid_q.filter(LobbyingActivity.government_entities.ilike(f"%{government_entity}%"))
            if lobbyist:
                lob_parts = [p.strip() for p in lobbyist.split() if p.strip()]
                for part in lob_parts:
                    fid_q = fid_q.filter(LobbyingActivity.lobbyists.ilike(f"%{part}%"))
        if registrant:
            fid_q = fid_q.join(Registrant, Filing.registrant_id == Registrant.id).filter(Registrant.name.ilike(f"%{registrant}%"))
        if client:
            fid_q = fid_q.join(Client, Filing.client_id == Client.id).filter(Client.name.ilike(f"%{client}%"))
        if filing_year:
            fid_q = fid_q.filter(Filing.filing_year == filing_year)
        if filing_period:
            fid_q = fid_q.filter(Filing.filing_period == filing_period)
        if q:
            fid_q = fid_q.filter(
                text("""to_tsvector('english',
                    coalesce((SELECT r2.name FROM registrants r2 WHERE r2.id = filings.registrant_id), '') || ' ' ||
                    coalesce((SELECT c2.name FROM clients c2 WHERE c2.id = filings.client_id), '') || ' ' ||
                    coalesce(filings.filing_type_display, '') || ' ' ||
                    coalesce(filings.posted_by_name, '')
                ) @@ plainto_tsquery('english', :query)""")
            ).params(query=q)
        filing_ids_sub = fid_q.distinct().subquery()

        # Top firms
        top_firms = (
            session.query(
                Registrant.id,
                Registrant.name,
                func.count(func.distinct(Filing.id)).label("filing_count"),
                func.sum(Filing.income).label("total_income"),
            )
            .select_from(Registrant)
            .join(Filing, Filing.registrant_id == Registrant.id)
            .filter(Filing.id.in_(session.query(filing_ids_sub.c.id)))
            .group_by(Registrant.id, Registrant.name)
            .order_by(desc("filing_count"))
            .limit(limit)
            .all()
        )
        firms = [{"id": r[0], "name": r[1], "filing_count": r[2], "total_income": float(r[3]) if r[3] else 0} for r in top_firms]

        # Top clients
        clients_sub = (
            session.query(
                Filing.client_id,
                Filing.id.label("filing_id"),
                func.coalesce(Filing.income, Filing.expenses, 0).label("amount"),
            )
            .filter(Filing.id.in_(session.query(filing_ids_sub.c.id)))
            .distinct()
            .subquery()
        )
        top_clients = (
            session.query(
                Client.id,
                Client.name,
                func.count(clients_sub.c.filing_id).label("filing_count"),
                func.coalesce(func.sum(clients_sub.c.amount), 0).label("total_spending"),
            )
            .join(clients_sub, clients_sub.c.client_id == Client.id)
            .group_by(Client.id, Client.name)
            .order_by(desc("total_spending"))
            .limit(limit)
            .all()
        )
        clients_list = [{"id": r[0], "name": r[1], "filing_count": r[2], "total_spending": float(r[3]) if r[3] else 0} for r in top_clients]

        # Top lobbyists
        lob_q = (
            session.query(LobbyingActivity.lobbyists, Filing.id)
            .select_from(LobbyingActivity)
            .join(Filing)
            .filter(Filing.id.in_(session.query(filing_ids_sub.c.id)))
            .filter(LobbyingActivity.lobbyists.isnot(None))
        )
        activities = lob_q.all()
        lobbyist_filings: dict[str, set[int]] = {}
        for lob_json, filing_id in activities:
            try:
                lob_list = _json.loads(lob_json)
            except (ValueError, TypeError):
                continue
            if not isinstance(lob_list, list):
                continue
            for entry in lob_list:
                lob = entry.get("lobbyist", {}) if isinstance(entry, dict) else {}
                first = (lob.get("first_name") or "").strip()
                last = (lob.get("last_name") or "").strip()
                full = f"{first} {last}".strip()
                if not full:
                    continue
                key = full.lower()
                lobbyist_filings.setdefault(key, set()).add(filing_id)

        lobbyists_list = sorted(
            [{"name": key.title(), "filing_count": len(fids)} for key, fids in lobbyist_filings.items()],
            key=lambda x: x["filing_count"], reverse=True,
        )[:limit]

        return {"firms": firms, "clients": clients_list, "lobbyists": lobbyists_list}
    except Exception as e:
        logger.exception("filings_sidebar failed: %s", e)
        raise
    finally:
        session.close()


@app.get("/api/filings/{filing_uuid}")
def get_filing(filing_uuid: str):
    """Get a single filing by UUID."""
    session = _get_session()
    try:
        filing = session.query(Filing).filter_by(filing_uuid=filing_uuid).first()
        if not filing:
            raise HTTPException(status_code=404, detail="Filing not found")
        return _filing_to_dict(filing, full=True)
    finally:
        session.close()


@app.get("/api/issues")
def list_issues(
    registrant: Optional[str] = Query(None),
    client: Optional[str] = Query(None),
    lobbyist: Optional[str] = Query(None),
    government_entity: Optional[str] = Query(None),
    filing_year: Optional[int] = Query(None),
    filing_period: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
):
    """List all issue codes with filing counts, optionally filtered."""
    session = _get_session()
    try:
        query = (
            session.query(
                LobbyingActivity.general_issue_code,
                LobbyingActivity.general_issue_code_display,
                func.count(func.distinct(LobbyingActivity.id)).label("count"),
            )
            .join(Filing, LobbyingActivity.filing_id == Filing.id)
        )
        if registrant:
            query = query.join(Registrant, Filing.registrant_id == Registrant.id).filter(Registrant.name.ilike(f"%{registrant}%"))
        if client:
            query = query.join(Client, Filing.client_id == Client.id).filter(Client.name.ilike(f"%{client}%"))
        if government_entity:
            query = query.filter(LobbyingActivity.government_entities.ilike(f"%{government_entity}%"))
        if filing_year:
            query = query.filter(Filing.filing_year == filing_year)
        if filing_period:
            query = query.filter(Filing.filing_period == filing_period)
        if lobbyist:
            lob_parts = [p.strip() for p in lobbyist.split() if p.strip()]
            for part in lob_parts:
                query = query.filter(LobbyingActivity.lobbyists.ilike(f"%{part}%"))
        if q:
            query = query.filter(
                text("""to_tsvector('english',
                    coalesce((SELECT r2.name FROM registrants r2 WHERE r2.id = filings.registrant_id), '') || ' ' ||
                    coalesce((SELECT c2.name FROM clients c2 WHERE c2.id = filings.client_id), '') || ' ' ||
                    coalesce(filings.filing_type_display, '') || ' ' ||
                    coalesce(filings.posted_by_name, '')
                ) @@ plainto_tsquery('english', :query)""")
            ).params(query=q)
        results = (
            query
            .group_by(
                LobbyingActivity.general_issue_code,
                LobbyingActivity.general_issue_code_display,
            )
            .order_by(desc("count"))
            .all()
        )
        return [
            {"code": r[0], "display": r[1], "count": r[2]}
            for r in results
        ]
    finally:
        session.close()


@app.get("/api/issues/{issue_code}/filings")
def filings_by_issue(
    issue_code: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    registrant_id: int | None = Query(None),
    client_id: int | None = Query(None),
    lobbyist_name: str | None = Query(None),
):
    """Get filings for a specific issue code, optionally filtered by registrant, client, or lobbyist."""
    session = _get_session()
    try:
        query = (
            session.query(Filing)
            .join(LobbyingActivity)
            .filter(LobbyingActivity.general_issue_code == issue_code)
        )
        if registrant_id is not None:
            query = query.filter(Filing.registrant_id == registrant_id)
        if client_id is not None:
            query = query.filter(Filing.client_id == client_id)
        if lobbyist_name:
            # Lobbyist names are stored as JSON with separate first_name/last_name fields,
            # so we need to match each name part individually
            for part in lobbyist_name.strip().split():
                query = query.filter(LobbyingActivity.lobbyists.ilike(f"%{part}%"))
        query = query.order_by(desc(Filing.dt_posted))
        total = query.count()
        filings = query.offset((page - 1) * page_size).limit(page_size).all()
        return {
            "results": [_filing_to_dict(f) for f in filings],
            "total": total,
            "page": page,
            "page_size": page_size,
            "issue_code": issue_code,
        }
    finally:
        session.close()


@app.get("/api/issues/{issue_code}/sidebar")
def issue_sidebar(issue_code: str, limit: int = Query(10, ge=1, le=25)):
    """Top firms, clients, and lobbyists for a specific issue area."""
    def _fetch():
        import json as _json
        session = _get_session()
        try:
            # Top firms by filing count in this issue area
            top_firms = (
                session.query(
                    Registrant.id,
                    Registrant.name,
                    func.count(func.distinct(Filing.id)).label("filing_count"),
                    func.sum(Filing.income).label("total_income"),
                )
                .join(Filing, Filing.registrant_id == Registrant.id)
                .join(LobbyingActivity, LobbyingActivity.filing_id == Filing.id)
                .filter(LobbyingActivity.general_issue_code == issue_code)
                .group_by(Registrant.id, Registrant.name)
                .order_by(desc("filing_count"))
                .limit(limit)
                .all()
            )
            firms = [{"id": r[0], "name": r[1], "filing_count": r[2], "total_income": float(r[3]) if r[3] else 0} for r in top_firms]

            # Top clients by spending in this issue area
            # A filing may have multiple lobbying activities for the same issue,
            # so we use a subquery to get distinct (client_id, filing_id, income)
            # first, then aggregate.
            filing_sub = (
                session.query(
                    Filing.client_id,
                    Filing.id.label("filing_id"),
                    func.coalesce(Filing.income, Filing.expenses, 0).label("amount"),
                )
                .join(LobbyingActivity, LobbyingActivity.filing_id == Filing.id)
                .filter(LobbyingActivity.general_issue_code == issue_code)
                .distinct()
                .subquery()
            )
            top_clients = (
                session.query(
                    Client.id,
                    Client.name,
                    func.count(filing_sub.c.filing_id).label("filing_count"),
                    func.coalesce(func.sum(filing_sub.c.amount), 0).label("total_spending"),
                )
                .join(filing_sub, filing_sub.c.client_id == Client.id)
                .group_by(Client.id, Client.name)
                .order_by(desc("total_spending"))
                .limit(limit)
                .all()
            )
            clients = [{"id": r[0], "name": r[1], "filing_count": r[2], "total_spending": float(r[3]) if r[3] else 0} for r in top_clients]

            # Top lobbyists by filing appearances in this issue area
            activities = (
                session.query(LobbyingActivity.lobbyists, Filing.id)
                .select_from(LobbyingActivity)
                .join(Filing)
                .filter(LobbyingActivity.general_issue_code == issue_code)
                .filter(LobbyingActivity.lobbyists.isnot(None))
                .all()
            )
            lobbyist_filings: dict[str, set[int]] = {}
            for lob_json, filing_id in activities:
                try:
                    lob_list = _json.loads(lob_json)
                except (ValueError, TypeError):
                    continue
                if not isinstance(lob_list, list):
                    continue
                for entry in lob_list:
                    lob = entry.get("lobbyist", {}) if isinstance(entry, dict) else {}
                    first = (lob.get("first_name") or "").strip()
                    last = (lob.get("last_name") or "").strip()
                    full = f"{first} {last}".strip()
                    if not full:
                        continue
                    key = full.lower()
                    lobbyist_filings.setdefault(key, set()).add(filing_id)

            lobbyists_list = sorted(
                [{"name": key.title(), "filing_count": len(fids)} for key, fids in lobbyist_filings.items()],
                key=lambda x: x["filing_count"], reverse=True,
            )[:limit]

            return {"firms": firms, "clients": clients, "lobbyists": lobbyists_list}
        except Exception as e:
            logger.exception("issue_sidebar(%s) failed: %s", issue_code, e)
            raise
        finally:
            session.close()
    return _cached(f"issue_sidebar_{issue_code}_{limit}", _fetch)


@app.get("/api/registrants")
def list_registrants():
    """List all registrants with filing counts, for filter dropdowns."""
    session = _get_session()
    try:
        rows = (
            session.query(Registrant.id, Registrant.name, func.count(Filing.id).label("cnt"))
            .join(Filing)
            .group_by(Registrant.id, Registrant.name)
            .order_by(desc("cnt"))
            .all()
        )
        return [{"id": r[0], "name": r[1], "filing_count": r[2]} for r in rows]
    finally:
        session.close()


@app.get("/api/clients")
def list_clients():
    """List all clients with filing counts, for filter dropdowns."""
    session = _get_session()
    try:
        rows = (
            session.query(Client.id, Client.name, func.count(Filing.id).label("cnt"))
            .join(Filing)
            .group_by(Client.id, Client.name)
            .order_by(desc("cnt"))
            .all()
        )
        return [{"id": r[0], "name": r[1], "filing_count": r[2]} for r in rows]
    finally:
        session.close()


@app.get("/api/top-registrants")
def top_registrants(limit: int = Query(20, ge=1, le=100), sort: str = Query("filings", regex="^(filings|unique_clients|revenue)$")):
    """Get top registrants by filing count, unique client count, or revenue."""
    def _fetch():
        session = _get_session()
        try:
            order_col = {"unique_clients": "unique_clients", "revenue": "total_income"}.get(sort, "filing_count")
            fetch_limit = limit * 3
            total_income_expr = func.coalesce(func.sum(Filing.income), 0).label("total_income")
            results = (
                session.query(
                    Registrant.name, Registrant.senate_id,
                    func.count(Filing.id).label("filing_count"),
                    func.count(func.distinct(Client.id)).label("unique_clients"),
                    total_income_expr,
                )
                .select_from(Registrant)
                .join(Filing, Filing.registrant_id == Registrant.id)
                .join(Client, Filing.client_id == Client.id)
                .group_by(Registrant.id)
                .order_by(desc(order_col)).limit(fetch_limit).all()
            )
            rows = [{"name": r[0], "senate_id": r[1], "filing_count": r[2], "unique_clients": r[3], "total_income": float(r[4]) if r[4] else 0} for r in results]
            deduped = _dedup_firms(rows)
            deduped.sort(key=lambda x: x.get(order_col, 0) or 0, reverse=True)
            return deduped[:limit]
        except Exception as e:
            logger.exception("top_registrants(sort=%s) failed: %s", sort, e)
            raise
        finally:
            session.close()
    return _cached(f"top_registrants_{limit}_{sort}", _fetch)


@app.get("/api/top-clients")
def top_clients(limit: int = Query(20, ge=1, le=100), sort: str = Query("filings", regex="^(filings|unique_registrants)$")):
    """Get top clients by filing count or unique registrant count."""
    def _fetch():
        session = _get_session()
        try:
            if sort == "unique_registrants":
                results = (
                    session.query(
                        Client.name, Client.senate_id,
                        func.count(func.distinct(Registrant.id)).label("unique_registrants"),
                        func.count(Filing.id).label("filing_count"),
                        func.sum(Filing.income).label("total_income"),
                    )
                    .select_from(Client)
                    .join(Filing, Filing.client_id == Client.id)
                    .join(Registrant, Filing.registrant_id == Registrant.id)
                    .group_by(Client.id)
                    .order_by(desc("unique_registrants")).limit(limit).all()
                )
                return [{"name": r[0], "senate_id": r[1], "unique_registrants": r[2], "filing_count": r[3], "total_income": float(r[4]) if r[4] else 0} for r in results]
            else:
                results = (
                    session.query(
                        Client.name, Client.senate_id,
                        func.count(Filing.id).label("filing_count"),
                        func.count(func.distinct(Registrant.id)).label("unique_registrants"),
                        func.sum(Filing.income).label("total_income"),
                    )
                    .select_from(Client)
                    .join(Filing, Filing.client_id == Client.id)
                    .join(Registrant, Filing.registrant_id == Registrant.id)
                    .group_by(Client.id)
                    .order_by(desc("filing_count")).limit(limit).all()
                )
                return [{"name": r[0], "senate_id": r[1], "filing_count": r[2], "unique_registrants": r[3], "total_income": float(r[4]) if r[4] else 0} for r in results]
        finally:
            session.close()
    return _cached(f"top_clients_{limit}_{sort}", _fetch)


@app.get("/api/revenue-per-lobbyist")
def revenue_per_lobbyist(limit: int = Query(15, ge=1, le=50), min_clients: int = Query(0, ge=0)):
    """Firms ranked by revenue per lobbyist. Optionally filter to firms with >= min_clients unique clients."""
    def _fetch():
        session = _get_session()
        try:
            import json as _json
            # Fetch firms with revenue, client count, and enough rows for dedup
            fetch_limit = max(limit * 5, 100)
            firms = (
                session.query(
                    Registrant.id,
                    Registrant.name,
                    func.count(Filing.id).label("filing_count"),
                    func.sum(Filing.income).label("total_revenue"),
                    func.count(func.distinct(Client.id)).label("unique_clients"),
                )
                .select_from(Registrant)
                .join(Filing, Filing.registrant_id == Registrant.id)
                .join(Client, Filing.client_id == Client.id)
                .filter(Filing.income.isnot(None))
                .group_by(Registrant.id, Registrant.name)
                .having(func.count(func.distinct(Client.id)) >= min_clients)
                .order_by(desc("total_revenue"))
                .limit(fetch_limit)
                .all()
            )
            firm_ids = [r[0] for r in firms]
            if not firm_ids:
                return []

            # Count distinct lobbyists per firm from LobbyingActivity JSON
            activities = (
                session.query(Filing.registrant_id, LobbyingActivity.lobbyists)
                .select_from(LobbyingActivity)
                .join(Filing)
                .filter(Filing.registrant_id.in_(firm_ids))
                .filter(LobbyingActivity.lobbyists.isnot(None))
                .all()
            )
            firm_lobbyists: dict[int, set] = {}
            for reg_id, lob_json in activities:
                try:
                    lob_list = _json.loads(lob_json)
                except (ValueError, TypeError):
                    continue
                if not isinstance(lob_list, list):
                    continue
                names = firm_lobbyists.setdefault(reg_id, set())
                for entry in lob_list:
                    lob = entry.get("lobbyist", {}) if isinstance(entry, dict) else {}
                    first = (lob.get("first_name") or "").strip()
                    last = (lob.get("last_name") or "").strip()
                    full = f"{first} {last}".strip()
                    if full:
                        names.add(full.lower())

            rows = []
            for reg_id, name, filing_count, total_revenue, unique_clients in firms:
                rev = float(total_revenue) if total_revenue else 0
                lob_names = firm_lobbyists.get(reg_id, set())
                rows.append({
                    "id": reg_id,
                    "name": name,
                    "filing_count": filing_count,
                    "total_revenue": rev,
                    "unique_clients": unique_clients,
                    "lobbyist_count": len(lob_names),
                    "lobbyist_names": lob_names,
                    "revenue_per_lobbyist": round(rev / len(lob_names), 2) if lob_names else None,
                })
            # Dedup firms with similar names
            deduped = _dedup_firms(rows)
            # Recompute revenue_per_lobbyist after dedup (lobbyist_names are unioned)
            for d in deduped:
                lob_names = d.pop("lobbyist_names", set())
                d["lobbyist_count"] = len(lob_names) if isinstance(lob_names, set) else d.get("lobbyist_count", 0)
                d["revenue_per_lobbyist"] = round(d["total_revenue"] / d["lobbyist_count"], 2) if d["lobbyist_count"] > 0 else None
            deduped.sort(key=lambda x: x.get("revenue_per_lobbyist") or 0, reverse=True)
            return deduped[:limit]
        except Exception as e:
            logger.exception("revenue_per_lobbyist(min_clients=%s) failed: %s", min_clients, e)
            raise
        finally:
            session.close()
    return _cached(f"revenue_per_lobbyist_{limit}_{min_clients}", _fetch)


@app.get("/api/top-lobbyists-by-clients")
def top_lobbyists_by_clients(limit: int = Query(15, ge=1, le=50)):
    """Top individual lobbyists ranked by number of unique clients they've lobbied for, with firms."""
    def _fetch():
        session = _get_session()
        try:
            import json as _json
            # Only scan activities from the top 100 registrants by filing count
            # to avoid a full table scan on large databases
            top_reg_ids = [
                r[0] for r in session.query(Filing.registrant_id)
                .group_by(Filing.registrant_id)
                .order_by(desc(func.count(Filing.id)))
                .limit(100)
                .all()
            ]
            if not top_reg_ids:
                return []
            # Build registrant name lookup
            reg_names = {
                r.id: r.name for r in
                session.query(Registrant).filter(Registrant.id.in_(top_reg_ids)).all()
            }
            activities = (
                session.query(
                    LobbyingActivity.lobbyists,
                    Filing.client_id,
                    Filing.registrant_id,
                )
                .select_from(LobbyingActivity)
                .join(Filing)
                .filter(Filing.registrant_id.in_(top_reg_ids))
                .filter(LobbyingActivity.lobbyists.isnot(None))
                .all()
            )
            # lobbyist_key -> {clients: set, firms: set(name)}
            lobbyist_data: dict[str, dict] = {}
            for lob_json, client_id, reg_id in activities:
                try:
                    lob_list = _json.loads(lob_json)
                except (ValueError, TypeError):
                    continue
                if not isinstance(lob_list, list):
                    continue
                reg_name = reg_names.get(reg_id, "")
                for entry in lob_list:
                    lob = entry.get("lobbyist", {}) if isinstance(entry, dict) else {}
                    first = (lob.get("first_name") or "").strip()
                    last = (lob.get("last_name") or "").strip()
                    full = f"{first} {last}".strip()
                    if not full:
                        continue
                    key = full.lower()
                    if key not in lobbyist_data:
                        lobbyist_data[key] = {"display_name": full, "clients": set(), "firms": set()}
                    lobbyist_data[key]["clients"].add(client_id)
                    if reg_name:
                        lobbyist_data[key]["firms"].add(reg_name)

            result = []
            for key, d in lobbyist_data.items():
                result.append({
                    "name": d["display_name"],
                    "unique_clients": len(d["clients"]),
                    "firms": sorted(d["firms"]),
                })
            result.sort(key=lambda x: x["unique_clients"], reverse=True)
            return result[:limit]
        finally:
            session.close()
    return _cached(f"top_lobbyists_by_clients_{limit}", _fetch)


@app.get("/api/top-consultants")
def top_consultants(limit: int = Query(10, ge=1, le=50), sort: str = Query("mention_count", regex="^(mention_count|filings)$")):
    """Top consultants (entities with is_consultant=True), ranked by mention count or filing count."""
    session = _get_session()
    try:
        query = (
            session.query(
                Entity.id,
                Entity.name,
                Entity.display_name,
                Entity.mention_count,
                Entity.registrant_id,
            )
            .filter(Entity.is_consultant == True)
        )

        if sort == "filings":
            query = (
                session.query(
                    Entity.id,
                    Entity.name,
                    Entity.display_name,
                    Entity.mention_count,
                    Entity.registrant_id,
                    func.count(Filing.id).label("filing_count"),
                    func.count(func.distinct(Client.id)).label("unique_clients"),
                )
                .outerjoin(Filing, Filing.registrant_id == Entity.registrant_id)
                .outerjoin(Client, Filing.client_id == Client.id)
                .filter(Entity.is_consultant == True)
                .group_by(Entity.id, Entity.name, Entity.display_name, Entity.mention_count, Entity.registrant_id)
                .order_by(desc("filing_count"))
                .limit(limit)
            )
            results = query.all()
            return [
                {"id": r[0], "name": r[1], "display_name": r[2] or r[1], "mention_count": r[3] or 0,
                 "filing_count": r[5], "unique_clients": r[6]}
                for r in results
            ]
        else:
            results = query.order_by(desc(Entity.mention_count)).limit(limit).all()
            # Get filing counts separately
            entity_ids = [r[0] for r in results]
            reg_ids = [r[4] for r in results if r[4]]
            filing_counts = {}
            client_counts = {}
            if reg_ids:
                fc_rows = (
                    session.query(
                        Filing.registrant_id,
                        func.count(Filing.id),
                        func.count(func.distinct(Client.id)),
                    )
                    .join(Client)
                    .filter(Filing.registrant_id.in_(reg_ids))
                    .group_by(Filing.registrant_id)
                    .all()
                )
                for reg_id, fc, cc in fc_rows:
                    filing_counts[reg_id] = fc
                    client_counts[reg_id] = cc
            return [
                {"id": r[0], "name": r[1], "display_name": r[2] or r[1], "mention_count": r[3] or 0,
                 "filing_count": filing_counts.get(r[4], 0), "unique_clients": client_counts.get(r[4], 0)}
                for r in results
            ]
    finally:
        session.close()


@app.get("/api/top-lobbyists")
def top_lobbyists(limit: int = Query(10, ge=1, le=50), sort: str = Query("mention_count", regex="^(mention_count|filings)$")):
    """Top lobbyists (entities with is_lobbyist=True), ranked by mention count or filing count."""
    session = _get_session()
    try:
        if sort == "filings":
            # Count filings where the lobbyist's name appears in lobbyist data
            # Since lobbyists are linked through registrant_id or lobbyist_senate_id
            results = (
                session.query(
                    Entity.id,
                    Entity.name,
                    Entity.display_name,
                    Entity.mention_count,
                )
                .filter(Entity.is_lobbyist == True)
                .order_by(desc(Entity.mention_count))
                .limit(limit)
                .all()
            )
        else:
            results = (
                session.query(
                    Entity.id,
                    Entity.name,
                    Entity.display_name,
                    Entity.mention_count,
                )
                .filter(Entity.is_lobbyist == True)
                .order_by(desc(Entity.mention_count))
                .limit(limit)
                .all()
            )
        return [
            {"id": r[0], "name": r[1], "display_name": r[2] or r[1], "mention_count": r[3] or 0}
            for r in results
        ]
    finally:
        session.close()


@app.get("/api/stats")
def get_stats():
    """Get overall database statistics."""
    def _fetch():
        session = _get_session()
        try:
            total_filings = session.query(func.count(Filing.id)).scalar() or 0
            total_registrants = session.query(func.count(Registrant.id)).scalar() or 0
            total_clients = session.query(func.count(Client.id)).scalar() or 0
            latest_filing = session.query(func.max(Filing.dt_posted)).scalar()
            total_revenue = session.query(func.sum(Filing.income)).filter(Filing.income.isnot(None)).scalar() or 0
            # Count unique lobbyists from filing data (JSON lobbyists field)
            import json as _json
            lob_rows = (
                session.query(LobbyingActivity.lobbyists)
                .filter(LobbyingActivity.lobbyists.isnot(None))
                .all()
            )
            unique_lobbyists: set[str] = set()
            for (lob_json,) in lob_rows:
                try:
                    lob_list = _json.loads(lob_json)
                except (ValueError, TypeError):
                    continue
                if not isinstance(lob_list, list):
                    continue
                for entry in lob_list:
                    lob = entry.get("lobbyist", {}) if isinstance(entry, dict) else {}
                    first = (lob.get("first_name") or "").strip()
                    last = (lob.get("last_name") or "").strip()
                    full = f"{first} {last}".strip().lower()
                    if full:
                        unique_lobbyists.add(full)
            total_lobbyists = len(unique_lobbyists)
            year_counts = (
                session.query(Filing.filing_year, func.count(Filing.id))
                .group_by(Filing.filing_year)
                .order_by(desc(Filing.filing_year))
                .all()
            )
            return {
                "total_filings": total_filings,
                "total_registrants": total_registrants,
                "total_clients": total_clients,
                "total_lobbyists": total_lobbyists,
                "total_revenue": float(total_revenue),
                "latest_filing": latest_filing.isoformat() if latest_filing else None,
                "filings_by_year": [{"year": y, "count": c} for y, c in year_counts],
            }
        finally:
            session.close()
    return _cached("stats", _fetch)


# ---------- Report endpoints ----------

@app.get("/api/reports/registrations-by-period")
def registrations_by_period(
    granularity: str = Query("week", regex="^(week|month)$"),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    limit: int = Query(10, ge=1, le=25),
    registrant_id: Optional[int] = Query(None),
    issue_code: Optional[str] = Query(None),
):
    """Top lobbying firms by new registrations, grouped by week or month."""
    session = _get_session()
    try:
        from sqlalchemy import case, extract, cast, Date
        q = session.query(Filing).filter(Filing.filing_type == 'RR')
        if start_date:
            q = q.filter(Filing.dt_posted >= start_date)
        if end_date:
            q = q.filter(Filing.dt_posted <= end_date)
        if registrant_id:
            q = q.filter(Filing.registrant_id == registrant_id)
        if issue_code:
            q = q.join(LobbyingActivity, LobbyingActivity.filing_uuid == Filing.filing_uuid).filter(LobbyingActivity.general_issue_code == issue_code)

        # Get top registrants in the period
        top_regs = (
            q.join(Registrant)
            .with_entities(Registrant.id, Registrant.name, func.count(func.distinct(Filing.id)).label("cnt"))
            .group_by(Registrant.id, Registrant.name)
            .order_by(desc("cnt"))
            .limit(limit)
            .all()
        )
        top_reg_ids = [r[0] for r in top_regs]
        top_reg_names = {r[0]: r[1] for r in top_regs}

        if not top_reg_ids:
            return {"series": [], "granularity": granularity}

        # Build time-series for each top registrant
        if granularity == "week":
            period_expr = func.to_char(Filing.dt_posted, 'IYYY-IW')
        else:
            period_expr = func.to_char(Filing.dt_posted, 'YYYY-MM')

        rows = (
            session.query(
                Registrant.id,
                period_expr.label("period"),
                func.count(func.distinct(Filing.id)).label("count"),
            )
            .select_from(Filing)
            .join(Registrant)
            .filter(Filing.filing_type == 'RR')
            .filter(Registrant.id.in_(top_reg_ids))
        )
        if start_date:
            rows = rows.filter(Filing.dt_posted >= start_date)
        if end_date:
            rows = rows.filter(Filing.dt_posted <= end_date)
        if issue_code:
            rows = rows.join(LobbyingActivity, LobbyingActivity.filing_uuid == Filing.filing_uuid).filter(LobbyingActivity.general_issue_code == issue_code)
        rows = rows.group_by(Registrant.id, "period").all()

        # Group by registrant
        series = {}
        for reg_id, period, count in rows:
            name = top_reg_names[reg_id]
            if name not in series:
                series[name] = {}
            series[name][period] = count

        # Collect all periods and sort
        all_periods = sorted(set(p for s in series.values() for p in s))

        result = []
        for name, data in series.items():
            result.append({
                "name": name,
                "data": [{"period": p, "count": data.get(p, 0)} for p in all_periods],
            })
        # Sort by total count descending
        result.sort(key=lambda x: sum(d["count"] for d in x["data"]), reverse=True)

        return {"series": result, "granularity": granularity, "periods": all_periods}
    finally:
        session.close()


@app.get("/api/reports/issues-by-period")
def issues_by_period(
    granularity: str = Query("week", regex="^(week|month)$"),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    limit: int = Query(10, ge=1, le=25),
    registrant_id: Optional[int] = Query(None),
    issue_code: Optional[str] = Query(None),
):
    """Top issue areas by filing count, grouped by week or month."""
    session = _get_session()
    try:
        q = session.query(LobbyingActivity).join(Filing)
        if start_date:
            q = q.filter(Filing.dt_posted >= start_date)
        if end_date:
            q = q.filter(Filing.dt_posted <= end_date)
        if registrant_id:
            q = q.filter(Filing.registrant_id == registrant_id)
        if issue_code:
            q = q.filter(LobbyingActivity.general_issue_code == issue_code)

        # Get top issues in the period
        top_issues = (
            q.with_entities(
                LobbyingActivity.general_issue_code,
                LobbyingActivity.general_issue_code_display,
                func.count(LobbyingActivity.id).label("cnt"),
            )
            .group_by(LobbyingActivity.general_issue_code, LobbyingActivity.general_issue_code_display)
            .order_by(desc("cnt"))
            .limit(limit)
            .all()
        )
        issue_names = {r[0]: r[1] for r in top_issues}
        issue_codes_list = [r[0] for r in top_issues]

        if not issue_codes_list:
            return {"series": [], "granularity": granularity}

        if granularity == "week":
            period_expr = func.to_char(Filing.dt_posted, 'IYYY-IW')
        else:
            period_expr = func.to_char(Filing.dt_posted, 'YYYY-MM')

        rows = (
            session.query(
                LobbyingActivity.general_issue_code,
                period_expr.label("period"),
                func.count(LobbyingActivity.id).label("count"),
            )
            .select_from(LobbyingActivity)
            .join(Filing)
            .filter(LobbyingActivity.general_issue_code.in_(issue_codes_list))
        )
        if start_date:
            rows = rows.filter(Filing.dt_posted >= start_date)
        if end_date:
            rows = rows.filter(Filing.dt_posted <= end_date)
        if registrant_id:
            rows = rows.filter(Filing.registrant_id == registrant_id)
        rows = rows.group_by(LobbyingActivity.general_issue_code, "period").all()

        series = {}
        for code, period, count in rows:
            name = issue_names.get(code, code)
            if name not in series:
                series[name] = {}
            series[name][period] = count

        all_periods = sorted(set(p for s in series.values() for p in s))

        result = []
        for name, data in series.items():
            result.append({
                "name": name,
                "data": [{"period": p, "count": data.get(p, 0)} for p in all_periods],
            })
        result.sort(key=lambda x: sum(d["count"] for d in x["data"]), reverse=True)

        return {"series": result, "granularity": granularity, "periods": all_periods}
    finally:
        session.close()


@app.get("/api/reports/activity-heatmap")
def activity_heatmap(
    registrant_id: Optional[int] = Query(None),
    issue_code: Optional[str] = Query(None),
):
    """Daily filing counts for the past 52 weeks, for a GitHub-style heatmap."""
    session = _get_session()
    try:
        from sqlalchemy import func, cast, Date
        cutoff = datetime.utcnow() - __import__('datetime').timedelta(weeks=52)
        q = session.query(
            cast(Filing.dt_posted, Date).label("day"),
            func.count(func.distinct(Filing.id)).label("count"),
        ).filter(Filing.dt_posted >= cutoff)
        if registrant_id:
            q = q.filter(Filing.registrant_id == registrant_id)
        if issue_code:
            q = q.join(LobbyingActivity, LobbyingActivity.filing_uuid == Filing.filing_uuid).filter(LobbyingActivity.general_issue_code == issue_code)
        rows = q.group_by("day").order_by("day").all()
        return {
            "days": [
                {"date": row.day.isoformat(), "count": row.count}
                for row in rows if row.day
            ]
        }
    finally:
        session.close()


@app.get("/api/reports/revenue-by-quarter")
def revenue_by_quarter(
    limit: int = Query(10, ge=1, le=25),
    registrant_id: Optional[int] = Query(None),
    issue_code: Optional[str] = Query(None),
):
    """Total revenue by quarter, and top firms' revenue over time."""
    session = _get_session()
    try:
        # Base query with optional filters
        base_q = session.query(Filing).filter(Filing.income.isnot(None))
        if registrant_id:
            base_q = base_q.filter(Filing.registrant_id == registrant_id)
        if issue_code:
            base_q = base_q.join(LobbyingActivity, LobbyingActivity.filing_uuid == Filing.filing_uuid).filter(LobbyingActivity.general_issue_code == issue_code)

        # Overall revenue by quarter
        overall = (
            base_q.with_entities(
                Filing.filing_year,
                Filing.filing_period,
                func.sum(Filing.income).label("revenue"),
                func.count(func.distinct(Filing.id)).label("filing_count"),
            )
            .group_by(Filing.filing_year, Filing.filing_period)
            .order_by(Filing.filing_year, Filing.filing_period)
            .all()
        )
        overall_data = [
            {"year": r[0], "period": r[1], "revenue": float(r[2]) if r[2] else 0, "filing_count": r[3]}
            for r in overall
        ]

        # Top firms by total revenue (skip if already filtering to one firm)
        firm_series = {}
        if not registrant_id:
            top_q = session.query(
                Registrant.id, Registrant.name,
                func.sum(Filing.income).label("total_revenue"),
            ).join(Filing).filter(Filing.income.isnot(None))
            if issue_code:
                top_q = top_q.join(LobbyingActivity, LobbyingActivity.filing_uuid == Filing.filing_uuid).filter(LobbyingActivity.general_issue_code == issue_code)
            top_firms = (
                top_q.group_by(Registrant.id, Registrant.name)
                .order_by(desc("total_revenue"))
                .limit(limit)
                .all()
            )
            top_firm_ids = [r[0] for r in top_firms]
            top_firm_names = {r[0]: r[1] for r in top_firms}

            if top_firm_ids:
                firm_q = (
                    session.query(
                        Registrant.id,
                        Filing.filing_year,
                        Filing.filing_period,
                        func.sum(Filing.income).label("revenue"),
                    )
                    .select_from(Filing)
                    .join(Registrant)
                    .filter(Filing.income.isnot(None), Registrant.id.in_(top_firm_ids))
                )
                if issue_code:
                    firm_q = firm_q.join(LobbyingActivity, LobbyingActivity.filing_uuid == Filing.filing_uuid).filter(LobbyingActivity.general_issue_code == issue_code)
                rows = firm_q.group_by(Registrant.id, Filing.filing_year, Filing.filing_period).all()
                for reg_id, year, period, revenue in rows:
                    name = top_firm_names[reg_id]
                    if name not in firm_series:
                        firm_series[name] = {}
                    key = f"{year}-{period}"
                    firm_series[name][key] = float(revenue) if revenue else 0

        all_periods = sorted(set(f"{r['year']}-{r['period']}" for r in overall_data))
        series = []
        for name, data in firm_series.items():
            series.append({
                "name": name,
                "data": [{"period": p, "revenue": data.get(p, 0)} for p in all_periods],
            })
        series.sort(key=lambda x: sum(d["revenue"] for d in x["data"]), reverse=True)

        return {"overall": overall_data, "series": series, "periods": all_periods}
    finally:
        session.close()


@app.get("/api/reports/entity-appearances")
def entity_appearances(limit: int = Query(25, ge=1, le=100), entity_type: Optional[str] = Query(None)):
    """Leaderboard of entities by number of newsletter appearances."""
    session = _get_session()
    try:
        q = (
            session.query(
                Entity.id, Entity.name, Entity.entity_type, Entity.display_name,
                Entity.mention_count,
                func.count(func.distinct(EntityMention.newsletter_id)).label("newsletter_count"),
            )
            .join(EntityMention, EntityMention.entity_id == Entity.id)
            .group_by(Entity.id)
            .order_by(desc("newsletter_count"))
        )
        if entity_type:
            q = q.filter(Entity.entity_type == entity_type)
        rows = q.limit(limit).all()
        return [
            {
                "id": r[0], "name": r[1], "entity_type": r[2],
                "display_name": r[3] or r[1], "mention_count": r[4],
                "newsletter_count": r[5],
            }
            for r in rows
        ]
    finally:
        session.close()


@app.get("/api/reports/issue-firm-heatmap")
def issue_firm_heatmap(limit: int = Query(15, ge=1, le=50)):
    """Heatmap: top firms × issue areas showing % of each firm's filings per issue."""
    session = _get_session()
    try:
        # Top firms by filing count
        top_firms = (
            session.query(Registrant.id, Registrant.name, func.count(Filing.id).label("total"))
            .join(Filing)
            .group_by(Registrant.id, Registrant.name)
            .order_by(desc("total"))
            .limit(limit)
            .all()
        )
        firm_ids = [r[0] for r in top_firms]
        firm_names = [r[1] for r in top_firms]
        firm_totals = {r[0]: r[2] for r in top_firms}

        if not firm_ids:
            return {"firms": [], "issues": [], "cells": []}

        # Issue breakdown per firm
        rows = (
            session.query(
                Registrant.id,
                LobbyingActivity.general_issue_code_display,
                func.count(func.distinct(Filing.id)).label("cnt"),
            )
            .select_from(LobbyingActivity)
            .join(Filing)
            .join(Registrant)
            .filter(Registrant.id.in_(firm_ids))
            .filter(LobbyingActivity.general_issue_code_display.isnot(None))
            .group_by(Registrant.id, LobbyingActivity.general_issue_code_display)
            .all()
        )

        # Find top issues across these firms
        issue_counts: dict = {}
        for _, issue, cnt in rows:
            issue_counts[issue] = issue_counts.get(issue, 0) + cnt
        top_issues = sorted(issue_counts, key=issue_counts.get, reverse=True)[:20]

        # Build cells: for each firm, % of their filings in each issue
        firm_issue_map: dict = {}
        for reg_id, issue, cnt in rows:
            if issue in top_issues:
                firm_issue_map.setdefault(reg_id, {})[issue] = cnt

        cells = []
        for reg_id in firm_ids:
            total = firm_totals[reg_id]
            row_data = []
            for issue in top_issues:
                cnt = firm_issue_map.get(reg_id, {}).get(issue, 0)
                row_data.append(round(cnt / total * 100, 1) if total else 0)
            cells.append(row_data)

        return {"firms": firm_names, "issues": top_issues, "cells": cells}
    finally:
        session.close()


@app.get("/api/influence/entities/{entity_id}/lda-stats")
def entity_lda_stats(entity_id: int):
    """LDA stats for a consultant entity: ranking, filing count, revenue, issue breakdown with overindex."""
    session = _get_session()
    try:
        entity = session.query(Entity).get(entity_id)
        if not entity:
            raise HTTPException(status_code=404, detail="Entity not found")

        if not entity.registrant_id:
            return {"has_lda_data": False}

        reg_id = entity.registrant_id
        registrant = session.query(Registrant).get(reg_id)

        # Filing count and total revenue for this registrant
        stats = (
            session.query(
                func.count(Filing.id).label("filing_count"),
                func.sum(Filing.income).label("total_revenue"),
                func.count(func.distinct(Client.id)).label("unique_clients"),
            )
            .select_from(Filing)
            .join(Client)
            .filter(Filing.registrant_id == reg_id)
            .first()
        )
        filing_count = stats[0] or 0
        total_revenue = float(stats[1]) if stats[1] else 0
        unique_clients = stats[2] or 0

        # Rank among all registrants by filing count
        rank_result = session.execute(
            text("""
                SELECT rank FROM (
                    SELECT r.id, RANK() OVER (ORDER BY COUNT(f.id) DESC) as rank
                    FROM registrants r JOIN filings f ON f.registrant_id = r.id
                    GROUP BY r.id
                ) sub WHERE sub.id = :reg_id
            """),
            {"reg_id": reg_id},
        ).fetchone()
        rank = rank_result[0] if rank_result else None
        total_registrants = session.query(func.count(Registrant.id)).scalar() or 0

        # Issue area breakdown for this registrant
        issue_rows = (
            session.query(
                LobbyingActivity.general_issue_code_display,
                func.count(func.distinct(Filing.id)).label("cnt"),
            )
            .select_from(LobbyingActivity)
            .join(Filing)
            .filter(Filing.registrant_id == reg_id)
            .filter(LobbyingActivity.general_issue_code_display.isnot(None))
            .group_by(LobbyingActivity.general_issue_code_display)
            .order_by(desc("cnt"))
            .all()
        )
        entity_issue_total = sum(r[1] for r in issue_rows)

        # Average issue distribution across all registrants
        avg_rows = (
            session.query(
                LobbyingActivity.general_issue_code_display,
                func.count(func.distinct(Filing.id)).label("cnt"),
            )
            .select_from(LobbyingActivity)
            .join(Filing)
            .filter(LobbyingActivity.general_issue_code_display.isnot(None))
            .group_by(LobbyingActivity.general_issue_code_display)
            .all()
        )
        avg_total = sum(r[1] for r in avg_rows)
        avg_pcts = {r[0]: r[1] / avg_total * 100 if avg_total else 0 for r in avg_rows}

        issues = []
        for issue_name, cnt in issue_rows[:15]:
            entity_pct = cnt / entity_issue_total * 100 if entity_issue_total else 0
            avg_pct = avg_pcts.get(issue_name, 0)
            overindex = round(entity_pct / avg_pct, 2) if avg_pct > 0 else 0
            issues.append({
                "issue": issue_name,
                "count": cnt,
                "pct": round(entity_pct, 1),
                "avg_pct": round(avg_pct, 1),
                "overindex": overindex,
            })

        return {
            "has_lda_data": True,
            "registrant_name": registrant.name if registrant else None,
            "filing_count": filing_count,
            "total_revenue": total_revenue,
            "unique_clients": unique_clients,
            "rank": rank,
            "total_registrants": total_registrants,
            "issues": issues,
        }
    finally:
        session.close()


@app.get("/api/reports/top-consultants-by-revenue")
def top_consultants_by_revenue(limit: int = Query(15, ge=1, le=50)):
    """Top consultants ranked by total revenue from their registrant's filings."""
    session = _get_session()
    try:
        rows = (
            session.query(
                Entity.id,
                Entity.display_name,
                Entity.name,
                func.sum(Filing.income).label("total_revenue"),
                func.count(Filing.id).label("filing_count"),
                func.count(func.distinct(Client.id)).label("unique_clients"),
            )
            .join(Filing, Filing.registrant_id == Entity.registrant_id)
            .join(Client, Filing.client_id == Client.id)
            .filter(Entity.is_consultant == True)
            .filter(Filing.income.isnot(None))
            .group_by(Entity.id, Entity.display_name, Entity.name)
            .order_by(desc("total_revenue"))
            .limit(limit)
            .all()
        )
        return [
            {"id": r[0], "display_name": r[1] or r[2], "name": r[2],
             "total_revenue": float(r[3]) if r[3] else 0, "filing_count": r[4], "unique_clients": r[5]}
            for r in rows
        ]
    finally:
        session.close()


@app.get("/api/reports/top-clients-by-spend")
def top_clients_by_spend(limit: int = Query(15, ge=1, le=50)):
    """Top clients ranked by total lobbying spend (income or expenses)."""
    session = _get_session()
    try:
        amount_expr = func.coalesce(Filing.income, Filing.expenses, 0)
        rows = (
            session.query(
                Client.name,
                func.sum(amount_expr).label("total_spend"),
                func.count(Filing.id).label("filing_count"),
                func.count(func.distinct(Registrant.id)).label("firm_count"),
            )
            .select_from(Filing)
            .join(Client, Filing.client_id == Client.id)
            .join(Registrant, Filing.registrant_id == Registrant.id)
            .group_by(Client.id, Client.name)
            .order_by(desc("total_spend"))
            .limit(limit)
            .all()
        )
        return [
            {"name": r[0], "total_spend": float(r[1]) if r[1] else 0, "filing_count": r[2], "firm_count": r[3]}
            for r in rows
        ]
    finally:
        session.close()


@app.get("/api/reports/filing-type-breakdown")
def filing_type_breakdown(
    registrant_id: Optional[int] = Query(None),
    issue_code: Optional[str] = Query(None),
):
    """Breakdown of filings by type."""
    session = _get_session()
    try:
        q = session.query(
            Filing.filing_type,
            Filing.filing_type_display,
            func.count(func.distinct(Filing.id)).label("count"),
        )
        if registrant_id:
            q = q.filter(Filing.registrant_id == registrant_id)
        if issue_code:
            q = q.join(LobbyingActivity, LobbyingActivity.filing_uuid == Filing.filing_uuid).filter(LobbyingActivity.general_issue_code == issue_code)
        rows = (
            q.group_by(Filing.filing_type, Filing.filing_type_display)
            .order_by(desc("count"))
            .all()
        )
        return [{"type": r[0], "display": r[1] or r[0], "count": r[2]} for r in rows]
    finally:
        session.close()


@app.get("/api/reports/registration-trend")
def registration_trend(
    granularity: str = Query("month", regex="^(week|month)$"),
    registrant_id: Optional[int] = Query(None),
    issue_code: Optional[str] = Query(None),
):
    """New registrations vs terminations over time."""
    session = _get_session()
    try:
        if granularity == "week":
            period_expr = func.to_char(Filing.dt_posted, 'IYYY-IW')
        else:
            period_expr = func.to_char(Filing.dt_posted, 'YYYY-MM')

        TERMINATION_TYPES = ['1T', '2T', '3T', '4T', '1TY', '2TY', '3TY', '4TY']
        q = (
            session.query(
                Filing.filing_type,
                period_expr.label("period"),
                func.count(func.distinct(Filing.id)).label("count"),
            )
            .filter(Filing.filing_type.in_(['RR'] + TERMINATION_TYPES))
        )
        if registrant_id:
            q = q.filter(Filing.registrant_id == registrant_id)
        if issue_code:
            q = q.join(LobbyingActivity, LobbyingActivity.filing_uuid == Filing.filing_uuid).filter(LobbyingActivity.general_issue_code == issue_code)
        rows = q.group_by(Filing.filing_type, "period").all()

        registrations: dict = {}
        terminations: dict = {}
        for ftype, period, count in rows:
            if ftype == 'RR':
                registrations[period] = count
            else:
                # Sum all termination subtypes into the same period bucket
                terminations[period] = terminations.get(period, 0) + count

        all_periods = sorted(set(list(registrations.keys()) + list(terminations.keys())))
        return {
            "periods": all_periods,
            "registrations": [registrations.get(p, 0) for p in all_periods],
            "terminations": [terminations.get(p, 0) for p in all_periods],
            "granularity": granularity,
        }
    finally:
        session.close()


@app.get("/api/reports/top-issues-by-revenue")
def top_issues_by_revenue(limit: int = Query(15, ge=1, le=50)):
    """Top issue areas ranked by total lobbying revenue."""
    session = _get_session()
    try:
        rows = (
            session.query(
                LobbyingActivity.general_issue_code_display,
                func.sum(Filing.income).label("total_revenue"),
                func.count(func.distinct(Filing.id)).label("filing_count"),
                func.count(func.distinct(Registrant.id)).label("firm_count"),
            )
            .select_from(LobbyingActivity)
            .join(Filing)
            .join(Registrant)
            .filter(Filing.income.isnot(None))
            .filter(LobbyingActivity.general_issue_code_display.isnot(None))
            .group_by(LobbyingActivity.general_issue_code_display)
            .order_by(desc("total_revenue"))
            .limit(limit)
            .all()
        )
        return [
            {"issue": r[0], "total_revenue": float(r[1]) if r[1] else 0, "filing_count": r[2], "firm_count": r[3]}
            for r in rows
        ]
    finally:
        session.close()


# ---------- Helpers ----------

def _filing_to_dict(filing: Filing, full: bool = False) -> dict:
    result = {
        "filing_uuid": filing.filing_uuid,
        "filing_type": filing.filing_type,
        "filing_type_display": filing.filing_type_display,
        "filing_year": filing.filing_year,
        "filing_period": filing.filing_period,
        "filing_period_display": filing.filing_period_display,
        "filing_date": filing.filing_date.isoformat() if filing.filing_date else None,
        "dt_posted": filing.dt_posted.isoformat() if filing.dt_posted else None,
        "added_to_db": filing.added_to_db.isoformat() if filing.added_to_db else None,
        "income": filing.income,
        "expenses": filing.expenses,
        "url": filing.url,
        "registrant": {
            "name": filing.registrant.name,
            "senate_id": filing.registrant.senate_id,
        } if filing.registrant else None,
        "client": {
            "name": filing.client.name,
            "senate_id": filing.client.senate_id,
        } if filing.client else None,
        "issue_codes": list(set(
            a.general_issue_code_display
            for a in filing.lobbying_activities
            if a.general_issue_code_display
        )),
    }

    if full:
        result["expenses_method"] = filing.expenses_method
        result["expenses_method_display"] = filing.expenses_method_display
        result["posted_by_name"] = filing.posted_by_name
        result["registrant_detail"] = {
            "name": filing.registrant.name,
            "senate_id": filing.registrant.senate_id,
            "description": filing.registrant.description,
            "address": filing.registrant.address,
            "country": filing.registrant.country,
            "state": filing.registrant.state,
        } if filing.registrant else None
        result["client_detail"] = {
            "name": filing.client.name,
            "senate_id": filing.client.senate_id,
            "description": filing.client.description,
            "country": filing.client.country,
            "state": filing.client.state,
        } if filing.client else None
        result["lobbying_activities"] = [
            {
                "general_issue_code": a.general_issue_code,
                "general_issue_code_display": a.general_issue_code_display,
                "description": a.description,
                "specific_issues": a.specific_issues,
                "government_entities": _safe_json_loads(a.government_entities),
                "lobbyists": _safe_json_loads(a.lobbyists),
            }
            for a in filing.lobbying_activities
        ]

    return result


def _safe_json_loads(val):
    if not val:
        return []
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return val


# ---------- Politico Influence endpoints ----------

class InfluenceScrapeRequest(BaseModel):
    max_newsletters: int = 50
    max_discovery_pages: int = 5
    cutoff_date: str = None


_influence_status: dict = {"status": "idle"}


@app.post("/api/influence/scrape")
def trigger_influence_scrape(req: InfluenceScrapeRequest):
    """Trigger a background scrape of Politico Influence newsletters.
    Runs in a separate thread so it doesn't block the server.
    """
    global _influence_status
    if _influence_status.get("status") == "running":
        return {"status": "already_running"}

    _influence_status = {"status": "running"}

    def _run_scrape():
        global _influence_status
        try:
            result = scrape_and_store(
                max_newsletters=req.max_newsletters,
                max_discovery_pages=req.max_discovery_pages,
                db_url=DB_URL,
                cutoff_date=req.cutoff_date,
            )
            _influence_status = {"status": "completed", **result}
        except Exception as e:
            _influence_status = {"status": "error", "error": str(e)}

    thread = threading.Thread(target=_run_scrape, daemon=True)
    thread.start()
    return {"status": "started"}


@app.get("/api/influence/scrape/status")
def get_influence_status():
    result = dict(_influence_status)
    if result.get("status") == "running":
        result["progress"] = get_scrape_progress()
    return result


@app.get("/api/influence/newsletters")
def list_newsletters(
    q: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    """List scraped newsletters, most recent first."""
    session = _get_session()
    try:
        query = session.query(Newsletter).order_by(desc(Newsletter.published_date))
        if q:
            query = query.filter(
                Newsletter.title.ilike(f"%{q}%") | Newsletter.body_text.ilike(f"%{q}%")
            )
        total = query.count()
        newsletters = query.offset((page - 1) * page_size).limit(page_size).all()
        return {
            "results": [
                {
                    "id": nl.id,
                    "url": nl.url,
                    "title": nl.title,
                    "published_date": nl.published_date.isoformat() if nl.published_date else None,
                    "scraped_at": nl.scraped_at.isoformat() if nl.scraped_at else None,
                    "entities_extracted": nl.entities_extracted,
                    "body_preview": (nl.body_text or "")[:300],
                }
                for nl in newsletters
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    finally:
        session.close()


@app.get("/api/influence/newsletters/{newsletter_id}")
def get_newsletter(newsletter_id: int):
    """Get full newsletter content."""
    session = _get_session()
    try:
        nl = session.query(Newsletter).get(newsletter_id)
        if not nl:
            raise HTTPException(status_code=404, detail="Newsletter not found")

        mentions = (
            session.query(EntityMention, Entity)
            .join(Entity, EntityMention.entity_id == Entity.id)
            .filter(EntityMention.newsletter_id == newsletter_id)
            .all()
        )

        return {
            "id": nl.id,
            "url": nl.url,
            "title": nl.title,
            "published_date": nl.published_date.isoformat() if nl.published_date else None,
            "body_text": nl.body_text,
            "body_html": nl.body_html,
            "entities": [
                {
                    "id": ent.id,
                    "name": ent.name,
                    "entity_type": ent.entity_type,
                    "is_consultant": ent.is_consultant,
                    "is_client": ent.is_client,
                    "display_name": ent.display_name,
                    "paragraph_index": mention.paragraph_index,
                    "context": mention.context_text,
                    "section_heading": mention.section_heading,
                }
                for mention, ent in mentions
            ],
        }
    finally:
        session.close()


@app.get("/api/influence/entities")
def list_entities(
    q: Optional[str] = Query(None),
    entity_type: Optional[str] = Query(None),
    sort: str = Query("-mention_count"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """List entities, optionally filtered by type or search query."""
    session = _get_session()
    try:
        query = session.query(Entity)
        if q:
            query = query.filter(Entity.name.ilike(f"%{q}%"))
        if entity_type:
            query = query.filter(Entity.entity_type == entity_type)

        total = query.count()

        if sort.startswith("-"):
            sort_col = getattr(Entity, sort[1:], Entity.mention_count)
            query = query.order_by(desc(sort_col))
        else:
            sort_col = getattr(Entity, sort, Entity.mention_count)
            query = query.order_by(sort_col)

        entities = query.offset((page - 1) * page_size).limit(page_size).all()
        return {
            "results": [
                {
                    "id": e.id,
                    "name": e.name,
                    "entity_type": e.entity_type,
                    "is_consultant": e.is_consultant,
                    "is_client": e.is_client,
                    "display_name": e.display_name,
                    "mention_count": e.mention_count,
                    "first_seen": e.first_seen.isoformat() if e.first_seen else None,
                    "last_seen": e.last_seen.isoformat() if e.last_seen else None,
                }
                for e in entities
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    finally:
        session.close()


@app.get("/api/influence/entities/{entity_id}")
def get_entity(entity_id: int):
    """Get entity detail with relationships."""
    session = _get_session()
    try:
        entity = session.query(Entity).get(entity_id)
        if not entity:
            raise HTTPException(status_code=404, detail="Entity not found")

        rels = (
            session.query(Relationship)
            .filter(
                (Relationship.entity_a_id == entity_id) |
                (Relationship.entity_b_id == entity_id)
            )
            .order_by(desc(Relationship.weight))
            .all()
        )

        connections = []
        for rel in rels:
            other_id = rel.entity_b_id if rel.entity_a_id == entity_id else rel.entity_a_id
            other = session.query(Entity).get(other_id)
            if other:
                conn = {
                    "entity": {
                        "id": other.id,
                        "name": other.name,
                        "entity_type": other.entity_type,
                        "is_consultant": other.is_consultant,
                        "is_client": other.is_client,
                        "is_lobbyist": other.is_lobbyist,
                        "display_name": other.display_name,
                        "mention_count": other.mention_count,
                    },
                    "relationship_type": rel.relationship_type,
                    "weight": rel.weight,
                    "first_seen": rel.first_seen.isoformat() if rel.first_seen else None,
                    "last_seen": rel.last_seen.isoformat() if rel.last_seen else None,
                    "context_snippets": _safe_json_loads(rel.context_snippets),
                    "match_confidence": rel.match_confidence,
                    "filing_id": None,
                    "filing_uuid": None,
                    "filing_type": None,
                    "filing_url": None,
                    "filing_date": None,
                }
                if rel.filing_id:
                    filing = session.query(Filing).get(rel.filing_id)
                    if filing:
                        conn["filing_id"] = filing.id
                        conn["filing_uuid"] = filing.filing_uuid
                        conn["filing_type"] = filing.filing_type_display or filing.filing_type
                        conn["filing_url"] = filing.url
                        conn["filing_date"] = filing.dt_posted.isoformat() if filing.dt_posted else None
                connections.append(conn)

        mentions = (
            session.query(EntityMention, Newsletter)
            .join(Newsletter, EntityMention.newsletter_id == Newsletter.id)
            .filter(EntityMention.entity_id == entity_id)
            .order_by(desc(Newsletter.published_date))
            .all()
        )

        seen_nl_ids = set()
        unique_mentions = []
        for mention, nl in mentions:
            if nl.id not in seen_nl_ids:
                seen_nl_ids.add(nl.id)
                unique_mentions.append({
                    "newsletter_id": nl.id,
                    "newsletter_title": nl.title,
                    "published_date": nl.published_date.isoformat() if nl.published_date else None,
                    "context": mention.context_text,
                })
            if len(unique_mentions) >= 20:
                break

        # Fetch LDA filings linked to this entity
        lda_filings = []
        if entity.registrant_id or entity.client_id:
            filing_query = session.query(Filing)
            if entity.registrant_id and entity.client_id:
                filing_query = filing_query.filter(
                    (Filing.registrant_id == entity.registrant_id) |
                    (Filing.client_id == entity.client_id)
                )
            elif entity.registrant_id:
                filing_query = filing_query.filter(Filing.registrant_id == entity.registrant_id)
            else:
                filing_query = filing_query.filter(Filing.client_id == entity.client_id)

            recent_filings = filing_query.order_by(desc(Filing.dt_posted)).limit(20).all()
            for f in recent_filings:
                reg = session.query(Registrant).get(f.registrant_id) if f.registrant_id else None
                cli = session.query(Client).get(f.client_id) if f.client_id else None
                lda_filings.append({
                    "filing_uuid": f.filing_uuid,
                    "filing_type": f.filing_type,
                    "filing_type_display": f.filing_type_display or f.filing_type,
                    "filing_year": f.filing_year,
                    "filing_period_display": f.filing_period_display,
                    "dt_posted": f.dt_posted.isoformat() if f.dt_posted else None,
                    "income": f.income,
                    "expenses": f.expenses,
                    "url": f.url,
                    "registrant_name": reg.name if reg else None,
                    "client_name": cli.name if cli else None,
                })

        return {
            "id": entity.id,
            "name": entity.name,
            "entity_type": entity.entity_type,
            "is_consultant": entity.is_consultant,
            "is_client": entity.is_client,
            "is_lobbyist": entity.is_lobbyist,
            "display_name": entity.display_name,
            "mention_count": entity.mention_count,
            "first_seen": entity.first_seen.isoformat() if entity.first_seen else None,
            "last_seen": entity.last_seen.isoformat() if entity.last_seen else None,
            "registrant_id": entity.registrant_id,
            "client_id": entity.client_id,
            "lda_match_method": entity.lda_match_method,
            "connections": connections,
            "newsletter_mentions": unique_mentions,
            "lda_filings": lda_filings,
        }
    finally:
        session.close()


@app.patch("/api/influence/entities/{entity_id}")
def update_entity_type(entity_id: int, body: dict = Body(...)):
    """Update an entity's type (person, organization, unknown). Sets user_override=True."""
    session = _get_session()
    try:
        entity = session.query(Entity).get(entity_id)
        if not entity:
            raise HTTPException(status_code=404, detail="Entity not found")

        new_type = body.get("entity_type")
        if new_type not in ("person", "organization", "unknown"):
            raise HTTPException(status_code=400, detail="entity_type must be person, organization, or unknown")

        old_type = entity.entity_type
        entity.entity_type = new_type
        entity.user_override = True

        if body.get("display_name"):
            entity.display_name = body["display_name"]

        session.commit()

        return {
            "id": entity.id,
            "name": entity.name,
            "entity_type": entity.entity_type,
            "display_name": entity.display_name,
            "user_override": entity.user_override,
            "old_type": old_type,
        }
    finally:
        session.close()


@app.post("/api/influence/reprocess")
def reprocess_entities_endpoint():
    """Clear and re-extract all entities from existing newsletters."""
    def _run():
        try:
            result = reprocess_all_entities(DB_URL)
            _invalidate_cache("influence_stats", "stats")
            logger.info(f"Reprocessed {result['processed']} newsletters")
        except Exception as e:
            logger.error(f"Reprocess error: {e}")

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"status": "started"}


@app.get("/api/influence/reprocess/status")
def reprocess_status_endpoint():
    """Get reprocessing progress."""
    return get_reprocess_progress()


@app.post("/api/influence/link-lda")
def link_lda_endpoint():
    """Manually trigger entity merge + LDA linking without full reprocess."""
    session = _get_session()
    try:
        merge_result = merge_duplicate_entities(session)
        result = link_entities_to_lda(session)
        lobbyist_result = link_lobbyists_to_entities(session)
        return {"status": "done", "merge": merge_result, **result, "lobbyist_links": lobbyist_result}
    except Exception as e:
        logger.error(f"LDA linking error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        session.close()


@app.get("/api/influence/network")
def get_network(
    min_weight: int = Query(1, ge=1),
    max_nodes: int = Query(100, ge=10, le=500),
    entity_type: Optional[str] = Query(None),
    center_entity_id: Optional[int] = Query(None),
    depth: int = Query(1, ge=1, le=3),
):
    """
    Get the network graph data for visualization.
    When center_entity_id is set, depth controls how many levels of connections to include.
    """
    session = _get_session()
    try:
        if center_entity_id:
            # Collect entity IDs at each depth level
            current_ids = {center_entity_id}
            all_seen_ids = {center_entity_id}
            all_rels = []
            seen_rel_ids = set()

            for _level in range(depth):
                level_rels = (
                    session.query(Relationship)
                    .filter(
                        (Relationship.entity_a_id.in_(current_ids)) |
                        (Relationship.entity_b_id.in_(current_ids)),
                        Relationship.weight >= min_weight,
                    )
                    .order_by(desc(Relationship.weight))
                    .all()
                )
                next_ids = set()
                for rel in level_rels:
                    if rel.id not in seen_rel_ids:
                        seen_rel_ids.add(rel.id)
                        all_rels.append(rel)
                    next_ids.add(rel.entity_a_id)
                    next_ids.add(rel.entity_b_id)
                current_ids = next_ids - all_seen_ids
                all_seen_ids |= next_ids

            # Fetch all inter-connections among discovered entities
            # so 2nd-level nodes show their relationships to each other
            if len(all_seen_ids) > 1:
                inter_rels = (
                    session.query(Relationship)
                    .filter(
                        Relationship.entity_a_id.in_(all_seen_ids),
                        Relationship.entity_b_id.in_(all_seen_ids),
                        Relationship.weight >= min_weight,
                    )
                    .all()
                )
                for rel in inter_rels:
                    if rel.id not in seen_rel_ids:
                        seen_rel_ids.add(rel.id)
                        all_rels.append(rel)

            rels = all_rels[:max_nodes * 2]
        else:
            rels = (
                session.query(Relationship)
                .filter(Relationship.weight >= min_weight)
                .order_by(desc(Relationship.weight))
                .limit(max_nodes * 2)
                .all()
            )

        entity_ids = set()
        for rel in rels:
            entity_ids.add(rel.entity_a_id)
            entity_ids.add(rel.entity_b_id)

        entities = session.query(Entity).filter(Entity.id.in_(entity_ids)).all()
        if entity_type:
            entities = [e for e in entities if e.entity_type == entity_type or e.entity_type == "unknown"]

        entity_map = {e.id: e for e in entities}

        nodes = []
        included_ids = set()
        for e in sorted(entities, key=lambda x: x.mention_count or 0, reverse=True)[:max_nodes]:
            nodes.append({
                "id": e.id,
                "name": e.name,
                "entity_type": e.entity_type,
                "is_consultant": e.is_consultant,
                    "is_client": e.is_client,
                "display_name": e.display_name,
                "mention_count": e.mention_count or 0,
            })
            included_ids.add(e.id)

        edges = []
        for rel in rels:
            if rel.entity_a_id in included_ids and rel.entity_b_id in included_ids:
                edges.append({
                    "source": rel.entity_a_id,
                    "target": rel.entity_b_id,
                    "weight": rel.weight,
                    "relationship_type": rel.relationship_type,
                })

        return {
            "nodes": nodes,
            "edges": edges,
            "total_entities": len(entity_ids),
            "total_relationships": len(rels),
        }
    finally:
        session.close()


@app.get("/api/influence/stats")
def influence_stats():
    """Get Politico Influence stats."""
    def _fetch():
        session = _get_session()
        try:
            total_newsletters = session.query(func.count(Newsletter.id)).scalar() or 0
            total_entities = session.query(func.count(Entity.id)).scalar() or 0
            total_relationships = session.query(func.count(Relationship.id)).scalar() or 0
            total_persons = session.query(func.count(Entity.id)).filter(Entity.entity_type == "person").scalar() or 0
            total_orgs = session.query(func.count(Entity.id)).filter(Entity.entity_type == "organization").scalar() or 0
            latest_newsletter = session.query(func.max(Newsletter.published_date)).scalar()
            total_affiliations = session.query(func.count(Relationship.id)).filter(Relationship.relationship_type == "affiliation").scalar() or 0
            return {
                "total_newsletters": total_newsletters,
                "total_entities": total_entities,
                "total_persons": total_persons,
                "total_organizations": total_orgs,
                "total_relationships": total_relationships,
                "total_affiliations": total_affiliations,
                "latest_newsletter": latest_newsletter.isoformat() if latest_newsletter else None,
            }
        finally:
            session.close()
    return _cached("influence_stats", _fetch)


# ---------- AI Endpoints ----------

class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[int] = None
    entity_id: Optional[int] = None


@app.post("/api/ai/entity-summary/{entity_id}")
def ai_entity_summary(entity_id: int):
    """Generate an AI-powered summary for an entity."""
    try:
        summary = generate_entity_summary(entity_id)
        return {"summary": summary}
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("AI entity summary failed")
        raise HTTPException(status_code=500, detail=f"AI summary generation failed: {str(e)}")


@app.post("/api/ai/chat")
def ai_chat_endpoint(req: ChatRequest):
    """Chat with the dataset using AI. Persists messages to conversation history."""
    session = _get_session()
    try:
        # Get or create conversation
        if req.conversation_id:
            convo = session.query(ChatConversation).get(req.conversation_id)
            if not convo:
                raise HTTPException(status_code=404, detail="Conversation not found")
        else:
            convo = ChatConversation(
                title=req.message[:100],
                entity_id=req.entity_id,
            )
            session.add(convo)
            session.flush()

        # Save user message
        user_msg = ChatMessage(conversation_id=convo.id, role="user", content=req.message)
        session.add(user_msg)
        session.flush()

        # Build message history from DB
        db_messages = (
            session.query(ChatMessage)
            .filter(ChatMessage.conversation_id == convo.id)
            .order_by(ChatMessage.created_at)
            .all()
        )
        messages = [{"role": m.role, "content": m.content} for m in db_messages]

        # Call AI
        response_text = ai_chat(messages, req.message)

        # Save assistant response
        assistant_msg = ChatMessage(conversation_id=convo.id, role="assistant", content=response_text)
        session.add(assistant_msg)

        # Update conversation title on first message
        msg_count = session.query(ChatMessage).filter(ChatMessage.conversation_id == convo.id).count()
        if msg_count <= 2:
            convo.title = req.message[:100]

        session.commit()

        return {
            "response": response_text,
            "conversation_id": convo.id,
            "message_id": assistant_msg.id,
        }
    except HTTPException:
        raise
    except RuntimeError as e:
        session.rollback()
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        session.rollback()
        logger.exception("AI chat failed")
        raise HTTPException(status_code=500, detail=f"AI chat failed: {str(e)}")
    finally:
        session.close()


@app.get("/api/ai/conversations")
def list_conversations(page: int = 1, page_size: int = 20):
    """List all chat conversations, most recent first."""
    session = _get_session()
    try:
        total = session.query(func.count(ChatConversation.id)).scalar() or 0
        convos = (
            session.query(ChatConversation)
            .order_by(desc(ChatConversation.updated_at))
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        results = []
        for c in convos:
            msg_count = session.query(func.count(ChatMessage.id)).filter(ChatMessage.conversation_id == c.id).scalar() or 0
            results.append({
                "id": c.id,
                "title": c.title,
                "entity_id": c.entity_id,
                "message_count": msg_count,
                "created_at": c.created_at.isoformat() if c.created_at else None,
                "updated_at": c.updated_at.isoformat() if c.updated_at else None,
            })
        return {"results": results, "total": total, "page": page, "page_size": page_size}
    finally:
        session.close()


@app.get("/api/ai/conversations/{conversation_id}")
def get_conversation(conversation_id: int):
    """Get a conversation with all messages."""
    session = _get_session()
    try:
        convo = session.query(ChatConversation).get(conversation_id)
        if not convo:
            raise HTTPException(status_code=404, detail="Conversation not found")

        messages = (
            session.query(ChatMessage)
            .filter(ChatMessage.conversation_id == conversation_id)
            .order_by(ChatMessage.created_at)
            .all()
        )
        return {
            "id": convo.id,
            "title": convo.title,
            "entity_id": convo.entity_id,
            "created_at": convo.created_at.isoformat() if convo.created_at else None,
            "updated_at": convo.updated_at.isoformat() if convo.updated_at else None,
            "messages": [
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "created_at": m.created_at.isoformat() if m.created_at else None,
                }
                for m in messages
            ],
        }
    finally:
        session.close()


@app.delete("/api/ai/conversations/{conversation_id}")
def delete_conversation(conversation_id: int):
    """Delete a conversation and all its messages."""
    session = _get_session()
    try:
        convo = session.query(ChatConversation).get(conversation_id)
        if not convo:
            raise HTTPException(status_code=404, detail="Conversation not found")
        session.query(ChatMessage).filter(ChatMessage.conversation_id == conversation_id).delete()
        session.delete(convo)
        session.commit()
        return {"status": "deleted"}
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


@app.get("/api/ai/status")
def ai_status():
    """Check if AI features are available (API key configured)."""
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    return {"available": has_key}


# ---------- Ad Tracking Endpoints ----------

@app.post("/api/ads/scrape")
def trigger_ad_scrape(
    sites: Optional[str] = Body(None, embed=True),
    max_pages_per_site: int = Body(3, embed=True),
):
    """Trigger an ad scrape. Optionally filter to specific sites (comma-separated)."""
    progress = get_ad_scrape_progress()
    if progress.get("status") == "running":
        return {"status": "already_running", **progress}

    site_list = [s.strip() for s in sites.split(",")] if sites else None

    def _run():
        scrape_ads(sites=site_list, max_pages_per_site=max_pages_per_site)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return {"status": "started"}


@app.get("/api/ads/scrape/status")
def ad_scrape_status():
    """Get current ad scrape progress."""
    return get_ad_scrape_progress()


@app.get("/api/ads/captures")
def list_ad_captures(
    site: Optional[str] = Query(None),
    domain: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    """List captured ads with optional filters."""
    session = _get_session()
    try:
        q = session.query(AdCapture).order_by(desc(AdCapture.captured_at))
        if site:
            q = q.filter(AdCapture.site == site)
        if domain:
            q = q.filter(AdCapture.destination_domain.ilike(f"%{domain}%"))

        total = q.count()
        results = q.offset((page - 1) * page_size).limit(page_size).all()

        return {
            "results": [
                {
                    "id": r.id,
                    "site": r.site,
                    "page_url": r.page_url,
                    "ad_slot": r.ad_slot,
                    "destination_url": r.destination_url,
                    "destination_domain": r.destination_domain,
                    "resolved_url": r.resolved_url,
                    "resolved_domain": r.resolved_domain,
                    "landing_page_title": r.landing_page_title,
                    "landing_page_type": r.landing_page_type,
                    "ad_text": r.ad_text,
                    "has_screenshot": bool(r.screenshot_base64),
                    "width": r.width,
                    "height": r.height,
                    "captured_at": r.captured_at.isoformat() if r.captured_at else None,
                    "campaign_id": r.campaign_id,
                }
                for r in results
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    finally:
        session.close()


@app.get("/api/ads/captures/{capture_id}")
def get_ad_capture(capture_id: int):
    """Get a single ad capture including its screenshot."""
    session = _get_session()
    try:
        r = session.query(AdCapture).get(capture_id)
        if not r:
            raise HTTPException(status_code=404, detail="Ad capture not found")
        return {
            "id": r.id,
            "site": r.site,
            "page_url": r.page_url,
            "ad_slot": r.ad_slot,
            "destination_url": r.destination_url,
            "destination_domain": r.destination_domain,
            "resolved_url": r.resolved_url,
            "resolved_domain": r.resolved_domain,
            "landing_page_title": r.landing_page_title,
            "landing_page_description": r.landing_page_description,
            "landing_page_og_image": r.landing_page_og_image,
            "landing_page_keywords": r.landing_page_keywords,
            "landing_page_type": r.landing_page_type,
            "ad_text": r.ad_text,
            "screenshot_base64": r.screenshot_base64,
            "width": r.width,
            "height": r.height,
            "captured_at": r.captured_at.isoformat() if r.captured_at else None,
            "campaign_id": r.campaign_id,
        }
    finally:
        session.close()


@app.get("/api/ads/campaigns")
def list_ad_campaigns(
    sort: str = Query("recent", regex="^(recent|captures|name)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    """List ad campaigns (grouped advertisers)."""
    session = _get_session()
    try:
        q = session.query(AdCampaign)
        if sort == "recent":
            q = q.order_by(desc(AdCampaign.last_seen))
        elif sort == "captures":
            q = q.order_by(desc(AdCampaign.capture_count))
        else:
            q = q.order_by(AdCampaign.advertiser_name)

        total = q.count()
        results = q.offset((page - 1) * page_size).limit(page_size).all()

        return {
            "results": [
                {
                    "id": r.id,
                    "advertiser_name": r.advertiser_name,
                    "advertiser_domain": r.advertiser_domain,
                    "entity_id": r.entity_id,
                    "first_seen": r.first_seen.isoformat() if r.first_seen else None,
                    "last_seen": r.last_seen.isoformat() if r.last_seen else None,
                    "capture_count": r.capture_count,
                    "sites_seen_on": json.loads(r.sites_seen_on) if r.sites_seen_on else [],
                }
                for r in results
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    finally:
        session.close()


@app.get("/api/ads/stats")
def ad_stats():
    """Summary statistics for ad tracking."""
    session = _get_session()
    try:
        total_captures = session.query(func.count(AdCapture.id)).scalar() or 0
        total_campaigns = session.query(func.count(AdCampaign.id)).scalar() or 0
        unique_domains = session.query(func.count(func.distinct(AdCapture.destination_domain))).filter(
            AdCapture.destination_domain.isnot(None)
        ).scalar() or 0

        latest = session.query(func.max(AdCapture.captured_at)).scalar()

        # Top advertisers by capture count
        top_advertisers = (
            session.query(AdCampaign.advertiser_name, AdCampaign.capture_count, AdCampaign.advertiser_domain)
            .order_by(desc(AdCampaign.capture_count))
            .limit(10)
            .all()
        )

        # Captures by site
        by_site = (
            session.query(AdCapture.site, func.count(AdCapture.id))
            .group_by(AdCapture.site)
            .all()
        )

        return {
            "total_captures": total_captures,
            "total_campaigns": total_campaigns,
            "unique_domains": unique_domains,
            "latest_capture": latest.isoformat() if latest else None,
            "top_advertisers": [
                {"name": name, "capture_count": count, "domain": domain}
                for name, count, domain in top_advertisers
            ],
            "captures_by_site": {site: count for site, count in by_site},
        }
    finally:
        session.close()


@app.get("/api/db-dump")
async def download_db_dump():
    dump_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "db_dump.tar.gz")
    if not os.path.isfile(dump_path):
        raise HTTPException(status_code=404, detail="No database dump available")
    return FileResponse(dump_path, media_type="application/gzip", filename="db_dump.tar.gz")


# Serve React frontend in production
static_dir = os.path.join(os.path.dirname(__file__), "..", "client", "dist")
if os.path.isdir(static_dir):
    app.mount("/assets", StaticFiles(directory=os.path.join(static_dir, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file_path = os.path.join(static_dir, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(static_dir, "index.html"))
