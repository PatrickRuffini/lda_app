"""FastAPI application for LDA filings search and browsing."""
import json
import logging
import os
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, Query, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import text, func, desc

from .models import (
    Filing, LobbyingActivity, Registrant, Client,
    get_engine, get_session, init_db,
)
from .sync import sync_filings

logger = logging.getLogger(__name__)

DB_PATH = os.environ.get("LDA_DB_PATH", "lda_filings.db")

app = FastAPI(title="LDA Filings Search", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _get_session():
    engine = init_db(DB_PATH)
    return get_session(engine)


# ---------- Pydantic schemas ----------

class SyncRequest(BaseModel):
    filing_year: Optional[int] = None
    filing_period: Optional[str] = None
    filing_type: Optional[str] = None
    registrant_name: Optional[str] = None
    client_name: Optional[str] = None
    max_pages: int = 50
    page_size: int = 25


class SyncStatus(BaseModel):
    status: str
    stored: int = 0
    skipped: int = 0
    pages: int = 0
    error: Optional[str] = None


# Global sync status tracking
_sync_status: dict = {"status": "idle"}


# ---------- Sync endpoints ----------

@app.post("/api/sync", response_model=SyncStatus)
def trigger_sync(req: SyncRequest, background_tasks: BackgroundTasks):
    """Trigger a background sync from the Senate LDA API."""
    global _sync_status
    if _sync_status.get("status") == "running":
        return SyncStatus(status="already_running")

    _sync_status = {"status": "running"}

    def _run_sync():
        global _sync_status
        try:
            result = sync_filings(
                filing_year=req.filing_year,
                filing_period=req.filing_period,
                filing_type=req.filing_type,
                registrant_name=req.registrant_name,
                client_name=req.client_name,
                max_pages=req.max_pages,
                page_size=req.page_size,
                db_path=DB_PATH,
            )
            _sync_status = {"status": "completed", **result}
        except Exception as e:
            _sync_status = {"status": "error", "error": str(e)}

    background_tasks.add_task(_run_sync)
    return SyncStatus(status="started")


@app.get("/api/sync/status", response_model=SyncStatus)
def get_sync_status():
    return SyncStatus(**_sync_status)


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
        # If full-text search query provided, use FTS
        if q:
            fts_query = text(
                """SELECT filing_uuid FROM filings_fts
                   WHERE filings_fts MATCH :query
                   ORDER BY rank
                   LIMIT :limit OFFSET :offset"""
            )
            offset = (page - 1) * page_size
            fts_results = session.execute(
                fts_query, {"query": q, "limit": page_size, "offset": offset}
            ).fetchall()
            uuids = [r[0] for r in fts_results]

            # Count total
            count_query = text(
                "SELECT COUNT(*) FROM filings_fts WHERE filings_fts MATCH :query"
            )
            total = session.execute(count_query, {"query": q}).scalar()

            if not uuids:
                return {"results": [], "total": 0, "page": page, "page_size": page_size}

            query = session.query(Filing).filter(Filing.filing_uuid.in_(uuids))
        else:
            query = session.query(Filing)
            total = None  # will compute below

        # Apply filters
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

        # Sorting
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
def top_registrants(limit: int = Query(20, ge=1, le=100)):
    """Get top registrants by filing count."""
    session = _get_session()
    try:
        results = (
            session.query(
                Registrant.name,
                Registrant.senate_id,
                func.count(Filing.id).label("filing_count"),
                func.sum(Filing.income).label("total_income"),
            )
            .join(Filing)
            .group_by(Registrant.id)
            .order_by(desc("filing_count"))
            .limit(limit)
            .all()
        )
        return [
            {
                "name": r[0],
                "senate_id": r[1],
                "filing_count": r[2],
                "total_income": float(r[3]) if r[3] else 0,
            }
            for r in results
        ]
    finally:
        session.close()


@app.get("/api/top-clients")
def top_clients(limit: int = Query(20, ge=1, le=100)):
    """Get top clients by filing count."""
    session = _get_session()
    try:
        results = (
            session.query(
                Client.name,
                Client.senate_id,
                func.count(Filing.id).label("filing_count"),
                func.sum(Filing.income).label("total_income"),
            )
            .join(Filing)
            .group_by(Client.id)
            .order_by(desc("filing_count"))
            .limit(limit)
            .all()
        )
        return [
            {
                "name": r[0],
                "senate_id": r[1],
                "filing_count": r[2],
                "total_income": float(r[3]) if r[3] else 0,
            }
            for r in results
        ]
    finally:
        session.close()


@app.get("/api/stats")
def get_stats():
    """Get overall database statistics."""
    session = _get_session()
    try:
        total_filings = session.query(func.count(Filing.id)).scalar() or 0
        total_registrants = session.query(func.count(Registrant.id)).scalar() or 0
        total_clients = session.query(func.count(Client.id)).scalar() or 0
        latest_filing = session.query(func.max(Filing.dt_posted)).scalar()

        # Get filing counts by year
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
            "latest_filing": latest_filing.isoformat() if latest_filing else None,
            "filings_by_year": [{"year": y, "count": c} for y, c in year_counts],
        }
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
