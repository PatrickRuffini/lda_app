"""Service to sync filings from the Senate LDA API into local SQLite."""
import json
import logging
import os
import time
from datetime import datetime
from typing import Optional

import requests
from sqlalchemy import text

from .models import (
    Client, Filing, LobbyingActivity, Registrant,
    get_engine, get_session, init_db,
)

logger = logging.getLogger(__name__)

BASE_URL = "https://lda.senate.gov/api/v1"


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
                wait = 2 ** (attempt + 1)
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
    """Create or update a registrant record."""
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
    """Create or update a client record."""
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
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(val, fmt)
        except ValueError:
            continue
    return None


def _store_filing(session, data: dict) -> Optional[Filing]:
    """Store or update a single filing and its related records."""
    uuid = data.get("filing_uuid")
    if not uuid:
        return None

    filing = session.query(Filing).filter_by(filing_uuid=uuid).first()
    is_new = filing is None
    if is_new:
        filing = Filing(filing_uuid=uuid)
        session.add(filing)

    # Registrant
    reg_data = data.get("registrant")
    if reg_data:
        registrant = _upsert_registrant(session, reg_data)
        if registrant:
            session.flush()
            filing.registrant_id = registrant.id

    # Client
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
    filing.income = data.get("income")
    filing.expenses = data.get("expenses")
    filing.expenses_method = data.get("expenses_method", "")
    filing.expenses_method_display = data.get("expenses_method_display", "")
    filing.posted_by_name = data.get("posted_by_name", "")
    filing.url = data.get("url", "")

    # Lobbying activities
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

    return filing


def _update_fts(session, filing: Filing):
    """Update the FTS index for a filing."""
    reg_name = filing.registrant.name if filing.registrant else ""
    client_name = filing.client.name if filing.client else ""

    issue_codes = []
    specific_issues_parts = []
    descriptions = []
    gov_entities_parts = []
    lobbyist_names = []

    for act in filing.lobbying_activities:
        if act.general_issue_code_display:
            issue_codes.append(act.general_issue_code_display)
        if act.specific_issues:
            specific_issues_parts.append(act.specific_issues)
        if act.description:
            descriptions.append(act.description)
        if act.government_entities:
            try:
                entities = json.loads(act.government_entities)
                for e in entities:
                    if isinstance(e, dict):
                        gov_entities_parts.append(e.get("name", ""))
                    else:
                        gov_entities_parts.append(str(e))
            except (json.JSONDecodeError, TypeError):
                gov_entities_parts.append(act.government_entities)
        if act.lobbyists:
            try:
                lobs = json.loads(act.lobbyists)
                for l in lobs:
                    if isinstance(l, dict):
                        parts = [l.get("lobbyist", {}).get("first_name", ""),
                                 l.get("lobbyist", {}).get("last_name", "")]
                        lobbyist_names.append(" ".join(p for p in parts if p))
                    else:
                        lobbyist_names.append(str(l))
            except (json.JSONDecodeError, TypeError):
                lobbyist_names.append(act.lobbyists)

    # Delete old FTS entry
    session.execute(
        text("DELETE FROM filings_fts WHERE filing_uuid = :uuid"),
        {"uuid": filing.filing_uuid},
    )
    # Insert new
    session.execute(
        text(
            """INSERT INTO filings_fts(filing_uuid, registrant_name, client_name,
               issue_codes, specific_issues, description, government_entities, lobbyist_names)
               VALUES(:uuid, :reg, :client, :issues, :specific, :desc, :gov, :lobs)"""
        ),
        {
            "uuid": filing.filing_uuid,
            "reg": reg_name,
            "client": client_name,
            "issues": " | ".join(issue_codes),
            "specific": " ".join(specific_issues_parts),
            "desc": " ".join(descriptions),
            "gov": " | ".join(gov_entities_parts),
            "lobs": " | ".join(lobbyist_names),
        },
    )


def sync_filings(
    filing_year: Optional[int] = None,
    filing_period: Optional[str] = None,
    filing_type: Optional[str] = None,
    registrant_name: Optional[str] = None,
    client_name: Optional[str] = None,
    max_pages: int = 50,
    page_size: int = 25,
    db_path: str = "lda_filings.db",
) -> dict:
    """
    Pull filings from the Senate LDA API and store them locally.

    Returns summary stats.
    """
    engine = init_db(db_path)
    session = get_session(engine)

    params: dict = {"page_size": page_size, "ordering": "-dt_posted"}
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
                filing = _store_filing(session, filing_data)
                if filing:
                    session.flush()
                    _update_fts(session, filing)
                    total_stored += 1
                else:
                    total_skipped += 1

            session.commit()
            logger.info(f"Page {page}: stored {len(results)} filings")

            if not data.get("next"):
                break
            page += 1
            time.sleep(0.5)  # Be polite to the API

    except Exception as e:
        session.rollback()
        logger.error(f"Sync error: {e}")
        raise
    finally:
        session.close()

    return {"stored": total_stored, "skipped": total_skipped, "pages": page}
