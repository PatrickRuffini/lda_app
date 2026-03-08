"""FastAPI application for LDA filings search and browsing."""
import json
import logging
import os
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
    get_engine, get_session, init_db, run_migrations,
)
from .sync import sync_filings, sync_incremental, sync_backfill, sync_backfill_chunk, sync_complete_years, sync_year, get_sync_progress, _update_progress
from .influence import scrape_and_store, reprocess_all_entities, get_scrape_progress, get_reprocess_progress, link_entities_to_lda, link_lobbyists_to_entities, merge_duplicate_entities
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


# ---------- Pydantic schemas ----------

class SyncRequest(BaseModel):
    mode: str = "incremental"
    filing_year: Optional[int] = None
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
            if req.mode == "backfill":
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
        if issue_code:
            query = query.join(LobbyingActivity).filter(
                LobbyingActivity.general_issue_code == issue_code
            )

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
def list_issues():
    """List all issue codes with filing counts."""
    session = _get_session()
    try:
        results = (
            session.query(
                LobbyingActivity.general_issue_code,
                LobbyingActivity.general_issue_code_display,
                func.count(LobbyingActivity.id).label("count"),
            )
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
):
    """Get filings for a specific issue code."""
    session = _get_session()
    try:
        query = (
            session.query(Filing)
            .join(LobbyingActivity)
            .filter(LobbyingActivity.general_issue_code == issue_code)
            .order_by(desc(Filing.dt_posted))
        )
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


@app.get("/api/top-registrants")
def top_registrants(limit: int = Query(20, ge=1, le=100), sort: str = Query("filings", regex="^(filings|unique_clients)$")):
    """Get top registrants by filing count or unique client count."""
    def _fetch():
        session = _get_session()
        try:
            if sort == "unique_clients":
                results = (
                    session.query(
                        Registrant.name, Registrant.senate_id,
                        func.count(func.distinct(Client.id)).label("unique_clients"),
                        func.count(Filing.id).label("filing_count"),
                        func.sum(Filing.income).label("total_income"),
                    )
                    .join(Filing).join(Client)
                    .group_by(Registrant.id)
                    .order_by(desc("unique_clients")).limit(limit).all()
                )
                return [{"name": r[0], "senate_id": r[1], "unique_clients": r[2], "filing_count": r[3], "total_income": float(r[4]) if r[4] else 0} for r in results]
            else:
                results = (
                    session.query(
                        Registrant.name, Registrant.senate_id,
                        func.count(Filing.id).label("filing_count"),
                        func.count(func.distinct(Client.id)).label("unique_clients"),
                        func.sum(Filing.income).label("total_income"),
                    )
                    .join(Filing).join(Client)
                    .group_by(Registrant.id)
                    .order_by(desc("filing_count")).limit(limit).all()
                )
                return [{"name": r[0], "senate_id": r[1], "filing_count": r[2], "unique_clients": r[3], "total_income": float(r[4]) if r[4] else 0} for r in results]
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
                    .join(Filing).join(Registrant)
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
                    .join(Filing).join(Registrant)
                    .group_by(Client.id)
                    .order_by(desc("filing_count")).limit(limit).all()
                )
                return [{"name": r[0], "senate_id": r[1], "filing_count": r[2], "unique_registrants": r[3], "total_income": float(r[4]) if r[4] else 0} for r in results]
        finally:
            session.close()
    return _cached(f"top_clients_{limit}_{sort}", _fetch)


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
            total_lobbyists = session.query(func.count(Entity.id)).filter(Entity.is_lobbyist == True).scalar() or 0
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

        # Get top registrants in the period
        top_regs = (
            q.join(Registrant)
            .with_entities(Registrant.id, Registrant.name, func.count(Filing.id).label("cnt"))
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
                func.count(Filing.id).label("count"),
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
):
    """Top issue areas by filing count, grouped by week or month."""
    session = _get_session()
    try:
        q = session.query(LobbyingActivity).join(Filing)
        if start_date:
            q = q.filter(Filing.dt_posted >= start_date)
        if end_date:
            q = q.filter(Filing.dt_posted <= end_date)

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
        issue_codes = [r[0] for r in top_issues]

        if not issue_codes:
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
            .filter(LobbyingActivity.general_issue_code.in_(issue_codes))
        )
        if start_date:
            rows = rows.filter(Filing.dt_posted >= start_date)
        if end_date:
            rows = rows.filter(Filing.dt_posted <= end_date)
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
def activity_heatmap():
    """Daily filing counts for the past 52 weeks, for a GitHub-style heatmap."""
    session = _get_session()
    try:
        from sqlalchemy import func, cast, Date
        cutoff = datetime.utcnow() - __import__('datetime').timedelta(weeks=52)
        rows = (
            session.query(
                cast(Filing.dt_posted, Date).label("day"),
                func.count().label("count"),
            )
            .filter(Filing.dt_posted >= cutoff)
            .group_by("day")
            .order_by("day")
            .all()
        )
        return {
            "days": [
                {"date": row.day.isoformat(), "count": row.count}
                for row in rows if row.day
            ]
        }
    finally:
        session.close()


@app.get("/api/reports/revenue-by-quarter")
def revenue_by_quarter(limit: int = Query(10, ge=1, le=25)):
    """Total revenue by quarter, and top firms' revenue over time."""
    session = _get_session()
    try:
        period_expr = func.concat(Filing.filing_year, '-', Filing.filing_period)

        # Overall revenue by quarter
        overall = (
            session.query(
                Filing.filing_year,
                Filing.filing_period,
                func.sum(Filing.income).label("revenue"),
                func.count(Filing.id).label("filing_count"),
            )
            .filter(Filing.income.isnot(None))
            .group_by(Filing.filing_year, Filing.filing_period)
            .order_by(Filing.filing_year, Filing.filing_period)
            .all()
        )
        overall_data = [
            {"year": r[0], "period": r[1], "revenue": float(r[2]) if r[2] else 0, "filing_count": r[3]}
            for r in overall
        ]

        # Top firms by total revenue
        top_firms = (
            session.query(
                Registrant.id, Registrant.name,
                func.sum(Filing.income).label("total_revenue"),
            )
            .join(Filing)
            .filter(Filing.income.isnot(None))
            .group_by(Registrant.id, Registrant.name)
            .order_by(desc("total_revenue"))
            .limit(limit)
            .all()
        )
        top_firm_ids = [r[0] for r in top_firms]
        top_firm_names = {r[0]: r[1] for r in top_firms}

        # Revenue by quarter per top firm
        firm_series = {}
        if top_firm_ids:
            rows = (
                session.query(
                    Registrant.id,
                    Filing.filing_year,
                    Filing.filing_period,
                    func.sum(Filing.income).label("revenue"),
                )
                .select_from(Filing)
                .join(Registrant)
                .filter(Filing.income.isnot(None), Registrant.id.in_(top_firm_ids))
                .group_by(Registrant.id, Filing.filing_year, Filing.filing_period)
                .all()
            )
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


@app.get("/api/reports/top-clients-by-spend")
def top_clients_by_spend(limit: int = Query(15, ge=1, le=50)):
    """Top clients ranked by total lobbying spend."""
    session = _get_session()
    try:
        rows = (
            session.query(
                Client.name,
                func.sum(Filing.income).label("total_spend"),
                func.count(Filing.id).label("filing_count"),
                func.count(func.distinct(Registrant.id)).label("firm_count"),
            )
            .select_from(Filing)
            .join(Client).join(Registrant)
            .filter(Filing.income.isnot(None))
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
def filing_type_breakdown():
    """Breakdown of filings by type."""
    session = _get_session()
    try:
        rows = (
            session.query(
                Filing.filing_type,
                Filing.filing_type_display,
                func.count(Filing.id).label("count"),
            )
            .group_by(Filing.filing_type, Filing.filing_type_display)
            .order_by(desc("count"))
            .all()
        )
        return [{"type": r[0], "display": r[1] or r[0], "count": r[2]} for r in rows]
    finally:
        session.close()


@app.get("/api/reports/registration-trend")
def registration_trend(granularity: str = Query("month", regex="^(week|month)$")):
    """New registrations vs terminations over time."""
    session = _get_session()
    try:
        if granularity == "week":
            period_expr = func.to_char(Filing.dt_posted, 'IYYY-IW')
        else:
            period_expr = func.to_char(Filing.dt_posted, 'YYYY-MM')

        rows = (
            session.query(
                Filing.filing_type,
                period_expr.label("period"),
                func.count(Filing.id).label("count"),
            )
            .filter(Filing.filing_type.in_(['RR', 'TR']))
            .group_by(Filing.filing_type, "period")
            .all()
        )

        registrations: dict = {}
        terminations: dict = {}
        for ftype, period, count in rows:
            if ftype == 'RR':
                registrations[period] = count
            else:
                terminations[period] = count

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
