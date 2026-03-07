"""Service to sync filings from the Senate LDA API into PostgreSQL.

Supports two sync modes:
  - incremental: grab filings newer than what we have (stops when it hits known filings)
  - backfill:    systematically work backwards by year to grab all historical data
"""
import json
import logging
import os
import threading
import time
from datetime import datetime
from typing import Optional

import requests
from sqlalchemy import text, func, desc

from .models import (
    Client, Filing, LobbyingActivity, Registrant,
    get_engine, get_session, init_db,
)

logger = logging.getLogger(__name__)

BASE_URL = "https://lda.senate.gov/api/v1"

OLDEST_YEAR = 1999
PAGE_SIZE = 25

_sync_progress: dict = {
    "status": "idle",
    "mode": None,
    "stored": 0,
    "skipped": 0,
    "duplicates": 0,
    "pages": 0,
    "current_year": None,
    "years_completed": [],
    "error": None,
    "started_at": None,
    "finished_at": None,
}
_sync_lock = threading.Lock()


def get_sync_progress() -> dict:
    with _sync_lock:
        return dict(_sync_progress)


def _update_progress(**kwargs):
    with _sync_lock:
        _sync_progress.update(kwargs)


def _get_headers() -> dict:
    api_key = os.environ.get("LDA_API_KEY", "")
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Token {api_key}"
    return headers


def _fetch_page(endpoint: str, params: dict, retries: int = 3) -> Optional[dict]:
    """Fetch a single page from the Senate LDA API with retry logic."""
    url = f"{BASE_URL}/{endpoint}/"
    headers = _get_headers()
    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=30)
            if resp.status_code == 429:
                wait = 2 ** (attempt + 2)
                logger.warning(f"Rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            logger.error(f"Request error (attempt {attempt+1}): {e}")
            if attempt < retries - 1:
                time.sleep(2 ** (attempt + 1))
    return None


def _upsert_registrant(session, data: dict) -> Optional[Registrant]:
    if not data:
        return None
    senate_id = data.get("id")
    if not senate_id:
        return None
    registrant = session.query(Registrant).filter_by(senate_id=senate_id).first()
    if not registrant:
        registrant = Registrant(senate_id=senate_id)
        session.add(registrant)
    registrant.name = data.get("name", "")
    registrant.description = data.get("description", "")
    registrant.address = data.get("address", "")
    registrant.country = data.get("country", "")
    registrant.state = data.get("state", "")
    return registrant


def _upsert_client(session, data: dict) -> Optional[Client]:
    if not data:
        return None
    senate_id = data.get("id")
    if not senate_id:
        return None
    client = session.query(Client).filter_by(senate_id=senate_id).first()
    if not client:
        client = Client(senate_id=senate_id)
        session.add(client)
    client.name = data.get("name", "")
    client.description = data.get("description", "")
    client.country = data.get("country", "")
    client.state = data.get("state", "")
    return client


def _parse_dt(val: Optional[str]) -> Optional[datetime]:
    if not val:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(val, fmt).replace(tzinfo=None)
        except ValueError:
            continue
    return None


def _store_filing(session, data: dict) -> tuple[Optional[Filing], bool]:
    """Store or update a single filing. Returns (filing, is_new)."""
    uuid = data.get("filing_uuid")
    if not uuid:
        return None, False

    filing = session.query(Filing).filter_by(filing_uuid=uuid).first()
    is_new = filing is None
    if is_new:
        filing = Filing(filing_uuid=uuid, added_to_db=datetime.utcnow())
        session.add(filing)

    reg_data = data.get("registrant")
    if reg_data:
        registrant = _upsert_registrant(session, reg_data)
        if registrant:
            session.flush()
            filing.registrant_id = registrant.id

    client_data = data.get("client")
    if client_data:
        client = _upsert_client(session, client_data)
        if client:
            session.flush()
            filing.client_id = client.id

    filing.filing_type = data.get("filing_type", "")
    filing.filing_type_display = data.get("filing_type_display", "")
    filing.filing_year = data.get("filing_year")
    filing.filing_period = data.get("filing_period", "")
    filing.filing_period_display = data.get("filing_period_display", "")
    filing.filing_date = _parse_dt(data.get("filing_date"))
    filing.dt_posted = _parse_dt(data.get("dt_posted"))
    filing.income = _parse_money(data.get("income"))
    filing.expenses = _parse_money(data.get("expenses"))
    filing.expenses_method = data.get("expenses_method", "")
    filing.expenses_method_display = data.get("expenses_method_display", "")
    filing.posted_by_name = data.get("posted_by_name", "")
    filing.url = data.get("url", "")

    if not is_new:
        session.query(LobbyingActivity).filter_by(filing_id=filing.id).delete()
        session.flush()

    for act_data in data.get("lobbying_activities", []):
        gov_entities = act_data.get("government_entities", [])
        lobbyists = act_data.get("lobbyists", [])
        activity = LobbyingActivity(
            filing=filing,
            general_issue_code=act_data.get("general_issue_code", ""),
            general_issue_code_display=act_data.get("general_issue_code_display", ""),
            description=act_data.get("description", ""),
            specific_issues=act_data.get("specific_issues", ""),
            government_entities=json.dumps(gov_entities) if isinstance(gov_entities, list) else str(gov_entities),
            lobbyists=json.dumps(lobbyists) if isinstance(lobbyists, list) else str(lobbyists),
        )
        session.add(activity)

    return filing, is_new


def _parse_money(val) -> Optional[float]:
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        try:
            return float(val.replace(",", ""))
        except (ValueError, TypeError):
            return None
    return None


def _get_db_year_coverage(session) -> dict:
    """Get which years we have filings for and how many."""
    rows = (
        session.query(Filing.filing_year, func.count(Filing.id))
        .group_by(Filing.filing_year)
        .all()
    )
    return {year: count for year, count in rows if year is not None}


def _get_api_year_count(year: int) -> Optional[int]:
    """Ask the API how many filings exist for a given year."""
    data = _fetch_page("filings", {"filing_year": year, "page_size": 1})
    if data:
        return data.get("count", 0)
    return None


def sync_incremental(db_url: str = None, max_pages: int = 200) -> dict:
    """
    Grab filings newer than our most recent ones.
    The Senate API requires at least one filter param, so we sync the
    current year and previous year to catch recent filings.
    Stops when we hit a streak of duplicates (filings we already have).
    """
    engine = init_db(db_url)
    session = get_session(engine)

    _update_progress(
        status="running", mode="incremental",
        stored=0, skipped=0, duplicates=0, pages=0,
        current_year=None, error=None,
        started_at=datetime.utcnow().isoformat(),
        finished_at=None,
    )

    total_stored = 0
    total_skipped = 0
    total_duplicates = 0
    total_pages = 0

    current_year = datetime.utcnow().year
    years_to_check = [current_year, current_year - 1]

    try:
        for year in years_to_check:
            if _sync_progress.get("status") == "cancelling":
                logger.info("Incremental sync cancelled")
                break

            consecutive_dupes = 0
            dupe_threshold = 50
            pages_for_year = max_pages // len(years_to_check)

            _update_progress(current_year=year)

            params = {"page_size": PAGE_SIZE, "filing_year": year}
            page = 1

            while page <= pages_for_year:
                if _sync_progress.get("status") == "cancelling":
                    break

                params["page"] = page
                data = _fetch_page("filings", params)
                if not data:
                    break

                results = data.get("results", [])
                if not results:
                    break

                total_pages += 1
                page_new = 0

                for filing_data in results:
                    filing, is_new = _store_filing(session, filing_data)
                    if filing:
                        if is_new:
                            total_stored += 1
                            page_new += 1
                            consecutive_dupes = 0
                        else:
                            total_duplicates += 1
                            consecutive_dupes += 1
                    else:
                        total_skipped += 1

                session.commit()
                _update_progress(
                    stored=total_stored, skipped=total_skipped,
                    duplicates=total_duplicates, pages=total_pages,
                )

                logger.info(f"Incremental year {year}, page {page}: {page_new} new, {len(results) - page_new} existing")

                if consecutive_dupes >= dupe_threshold:
                    logger.info(f"Year {year}: hit {dupe_threshold} consecutive duplicates, moving on")
                    break

                if not data.get("next"):
                    break

                page += 1
                time.sleep(0.3)

    except Exception as e:
        session.rollback()
        logger.error(f"Incremental sync error: {e}")
        _update_progress(status="error", error=str(e), finished_at=datetime.utcnow().isoformat())
        raise
    finally:
        session.close()

    final_status = "cancelled" if _sync_progress.get("status") == "cancelling" else "completed"
    _update_progress(
        status=final_status, finished_at=datetime.utcnow().isoformat(),
        stored=total_stored, skipped=total_skipped,
        duplicates=total_duplicates, pages=total_pages,
    )

    return {"stored": total_stored, "skipped": total_skipped, "duplicates": total_duplicates, "pages": total_pages}


def sync_year(year: int, db_url: str = None, max_pages: int = 5000) -> dict:
    """Sync all filings for a specific year."""
    engine = init_db(db_url)
    session = get_session(engine)

    total_stored = 0
    total_duplicates = 0
    page_num = 0

    try:
        params = {"page_size": PAGE_SIZE, "filing_year": year}
        page = 1

        while page <= max_pages:
            if _sync_progress.get("status") == "cancelling":
                logger.info(f"Year {year} sync cancelled")
                break

            params["page"] = page
            data = _fetch_page("filings", params)
            if not data:
                break

            results = data.get("results", [])
            if not results:
                break

            page_num = page
            for filing_data in results:
                filing, is_new = _store_filing(session, filing_data)
                if filing and is_new:
                    total_stored += 1
                elif filing:
                    total_duplicates += 1

            session.commit()
            _update_progress(current_year=year)

            logger.info(f"Year {year}, page {page}: stored {total_stored} so far")

            if not data.get("next"):
                break

            page += 1
            time.sleep(0.3)

    except Exception as e:
        session.rollback()
        logger.error(f"Year {year} sync error: {e}")
        raise
    finally:
        session.close()

    return {"year": year, "stored": total_stored, "duplicates": total_duplicates, "pages": page_num}


def sync_backfill(db_url: str = None) -> dict:
    """
    Systematically backfill historical filings year by year.
    Starts from the current year and works backwards to 1999.
    Skips years where our count matches the API count.
    """
    current_year = datetime.utcnow().year

    engine = init_db(db_url)
    session = get_session(engine)
    db_coverage = _get_db_year_coverage(session)
    session.close()

    _update_progress(
        status="running", mode="backfill",
        stored=0, skipped=0, duplicates=0, pages=0,
        current_year=None, years_completed=[],
        error=None,
        started_at=datetime.utcnow().isoformat(),
        finished_at=None,
    )

    total_stored = 0
    total_pages = 0
    years_completed = []

    try:
        for year in range(current_year, OLDEST_YEAR - 1, -1):
            if _sync_progress.get("status") == "cancelling":
                logger.info("Backfill cancelled by user")
                break

            db_count = db_coverage.get(year, 0)
            api_count = _get_api_year_count(year)

            if api_count is not None and db_count >= api_count and api_count > 0:
                logger.info(f"Year {year}: already complete ({db_count}/{api_count})")
                years_completed.append(year)
                _update_progress(current_year=year, years_completed=list(years_completed))
                continue

            logger.info(f"Year {year}: have {db_count}, API has {api_count or '?'} — syncing")
            _update_progress(current_year=year)

            result = sync_year(year, db_url=db_url)
            total_stored += result["stored"]
            total_pages += result["pages"]
            years_completed.append(year)

            _update_progress(
                stored=total_stored, pages=total_pages,
                years_completed=list(years_completed),
            )

            if _sync_progress.get("status") == "cancelling":
                break

            time.sleep(0.5)

    except Exception as e:
        logger.error(f"Backfill error: {e}")
        _update_progress(status="error", error=str(e), finished_at=datetime.utcnow().isoformat())
        raise

    final_status = "cancelled" if _sync_progress.get("status") == "cancelling" else "completed"
    _update_progress(
        status=final_status, finished_at=datetime.utcnow().isoformat(),
        stored=total_stored, pages=total_pages,
        years_completed=list(years_completed),
    )

    return {"stored": total_stored, "pages": total_pages, "years_completed": years_completed}


def sync_filings(
    filing_year: Optional[int] = None,
    filing_period: Optional[str] = None,
    filing_type: Optional[str] = None,
    registrant_name: Optional[str] = None,
    client_name: Optional[str] = None,
    max_pages: int = 50,
    page_size: int = 25,
    db_url: str = None,
) -> dict:
    """Legacy sync function — kept for backwards compatibility."""
    engine = init_db(db_url)
    session = get_session(engine)

    params: dict = {"page_size": page_size}
    if filing_year:
        params["filing_year"] = filing_year
    if filing_period:
        params["filing_period"] = filing_period
    if filing_type:
        params["filing_type"] = filing_type
    if registrant_name:
        params["registrant_name"] = registrant_name
    if client_name:
        params["client_name"] = client_name

    total_stored = 0
    total_skipped = 0
    page = 1

    try:
        while page <= max_pages:
            params["page"] = page
            data = _fetch_page("filings", params)
            if not data:
                break

            results = data.get("results", [])
            if not results:
                break

            for filing_data in results:
                filing, is_new = _store_filing(session, filing_data)
                if filing:
                    total_stored += 1
                else:
                    total_skipped += 1

            session.commit()
            logger.info(f"Page {page}: stored {len(results)} filings")

            if not data.get("next"):
                break
            page += 1
            time.sleep(0.5)

    except Exception as e:
        session.rollback()
        logger.error(f"Sync error: {e}")
        raise
    finally:
        session.close()

    return {"stored": total_stored, "skipped": total_skipped, "pages": page}
