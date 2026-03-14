"""AI-powered entity summaries and chat using Anthropic Claude."""
import json
import logging
import os
from typing import Optional

import anthropic
from sqlalchemy import desc, func, text
from sqlalchemy.orm import Session

from .models import (
    Entity, EntityMention, Newsletter, Relationship,
    Filing, LobbyingActivity, Registrant, Client,
    get_engine, get_session, init_db,
)

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-4-20250514"

_engine = None

def _get_engine():
    global _engine
    if _engine is None:
        _engine = init_db()
    return _engine

def _get_session():
    return get_session(_get_engine())


def _get_client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=api_key)


def _gather_entity_context(session: Session, entity_id: int) -> dict:
    """Gather all available context for an entity to feed to the AI."""
    entity = session.query(Entity).get(entity_id)
    if not entity:
        return {}

    # Basic info
    ctx = {
        "name": entity.display_name or entity.name,
        "entity_type": entity.entity_type,
        "mention_count": entity.mention_count,
        "first_seen": entity.first_seen.isoformat() if entity.first_seen else None,
        "last_seen": entity.last_seen.isoformat() if entity.last_seen else None,
        "is_consultant": entity.is_consultant,
        "is_client": entity.is_client,
        "is_lobbyist": entity.is_lobbyist,
    }

    # Relationships / connections
    rels = (
        session.query(Relationship)
        .filter(
            (Relationship.entity_a_id == entity_id) |
            (Relationship.entity_b_id == entity_id)
        )
        .order_by(desc(Relationship.weight))
        .limit(30)
        .all()
    )

    connections = []
    for rel in rels:
        other_id = rel.entity_b_id if rel.entity_a_id == entity_id else rel.entity_a_id
        other = session.query(Entity).get(other_id)
        if not other:
            continue
        snippets = []
        if rel.context_snippets:
            try:
                snippets = json.loads(rel.context_snippets) if isinstance(rel.context_snippets, str) else rel.context_snippets
            except (json.JSONDecodeError, TypeError):
                pass
        connections.append({
            "name": other.display_name or other.name,
            "type": other.entity_type,
            "relationship": rel.relationship_type,
            "weight": rel.weight,
            "context": snippets[:3],
        })
    ctx["connections"] = connections

    # Newsletter mention contexts
    mentions = (
        session.query(EntityMention, Newsletter)
        .join(Newsletter, EntityMention.newsletter_id == Newsletter.id)
        .filter(EntityMention.entity_id == entity_id)
        .order_by(desc(Newsletter.published_date))
        .limit(15)
        .all()
    )
    ctx["newsletter_mentions"] = [
        {
            "title": nl.title,
            "date": nl.published_date.isoformat() if nl.published_date else None,
            "context": mention.context_text[:500] if mention.context_text else "",
        }
        for mention, nl in mentions
    ]

    # LDA filings with lobbying activity details
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

        recent_filings = filing_query.order_by(desc(Filing.dt_posted)).limit(15).all()
        for f in recent_filings:
            reg = session.query(Registrant).get(f.registrant_id) if f.registrant_id else None
            cli = session.query(Client).get(f.client_id) if f.client_id else None

            # Get lobbying activities for this filing
            activities = session.query(LobbyingActivity).filter(LobbyingActivity.filing_id == f.id).all()
            activity_details = []
            for act in activities:
                activity_details.append({
                    "issue_code": act.general_issue_code_display or act.general_issue_code,
                    "description": act.description[:300] if act.description else "",
                    "specific_issues": act.specific_issues[:300] if act.specific_issues else "",
                })

            lda_filings.append({
                "type": f.filing_type_display or f.filing_type,
                "year": f.filing_year,
                "period": f.filing_period_display,
                "income": f.income,
                "expenses": f.expenses,
                "registrant": reg.name if reg else None,
                "client": cli.name if cli else None,
                "activities": activity_details,
            })
    ctx["lda_filings"] = lda_filings

    return ctx


def generate_entity_summary(entity_id: int) -> str:
    """Generate an AI-powered summary for an entity."""
    session = _get_session()
    try:
        ctx = _gather_entity_context(session, entity_id)
        if not ctx:
            raise ValueError("Entity not found")

        client = _get_client()

        system_prompt = """You are an expert policy analyst specializing in U.S. federal lobbying and political influence. You produce sharp, specific intelligence briefs about entities (people and organizations) tracked in lobbying disclosure data and Politico's Influence newsletter.

Your analysis should:
- Lead with a concise 1-2 sentence overview of who/what this entity is and why they matter
- Identify their key policy priorities and issue areas based on lobbying filings and newsletter coverage
- Highlight notable relationships (affiliations, clients, consultants, co-mentioned entities)
- Note specific dollar amounts from LDA filings where relevant
- Call out any trends (increasing/decreasing activity, new issue areas, new relationships)
- Reference specific details from the newsletter snippets and filing data provided
- Be specific — name names, cite amounts, reference issue areas
- Use short paragraphs with clear headers
- Keep the total to 300-400 words

Do NOT make claims beyond what the provided data supports. If data is limited, say so."""

        user_prompt = f"""Analyze this entity based on the following data from our lobbying disclosure and Politico Influence tracking database:

{json.dumps(ctx, indent=2, default=str)}

Provide a concise intelligence brief on this entity's lobbying activity, policy priorities, and political influence network."""

        response = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
        return response.content[0].text
    finally:
        session.close()


def _extract_date_range(query: str):
    """Extract date references from a query to enable time-based filtering.

    Returns (start_date, end_date) as date objects, or (None, None) if no dates detected.
    """
    import re
    from datetime import date, timedelta

    query_lower = query.lower()

    month_map = {
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
        "jan": 1, "feb": 2, "mar": 3, "apr": 4,
        "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    }

    # Find all month+year references like "February 2026" or "Feb 2026"
    found_months = []
    for name, num in month_map.items():
        pattern = rf'\b{name}\b\s*(\d{{4}})?'
        match = re.search(pattern, query_lower)
        if match:
            year = int(match.group(1)) if match.group(1) else date.today().year
            found_months.append((year, num))

    # Also check for Q1/Q2/etc patterns
    q_match = re.search(r'\bq([1-4])\b\s*(\d{4})?', query_lower)
    if q_match:
        quarter = int(q_match.group(1))
        year = int(q_match.group(2)) if q_match.group(2) else date.today().year
        start_month = (quarter - 1) * 3 + 1
        end_month = start_month + 2
        import calendar
        end_day = calendar.monthrange(year, end_month)[1]
        return date(year, start_month, 1), date(year, end_month, end_day)

    if not found_months:
        # Check for relative time references
        if any(w in query_lower for w in ["today", "yesterday"]):
            end = date.today()
            start = end - timedelta(days=1)
            return start, end
        if "this week" in query_lower:
            end = date.today()
            start = end - timedelta(days=end.weekday())  # Monday of current week
            return start, end
        if "last week" in query_lower:
            end = date.today() - timedelta(days=date.today().weekday())  # Last Monday
            start = end - timedelta(days=7)  # Previous Monday
            return start, end
        if any(w in query_lower for w in ["recent", "latest", "current", "new", "this month"]):
            end = date.today()
            start = end - timedelta(days=30)
            return start, end
        if "this quarter" in query_lower:
            end = date.today()
            start = end - timedelta(days=90)
            return start, end
        if "this year" in query_lower:
            end = date.today()
            start = date(end.year, 1, 1)
            return start, end
        # Catch-all for general temporal language
        if any(w in query_lower for w in [
            "developments", "happening", "going on", "update",
            "what's new", "report", "overview", "trends",
            "activity", "activities",
        ]):
            end = date.today()
            start = end - timedelta(days=14)
            return start, end
        return None, None

    found_months.sort()
    import calendar
    start = date(found_months[0][0], found_months[0][1], 1)
    last = found_months[-1]
    end_day = calendar.monthrange(last[0], last[1])[1]
    end = date(last[0], last[1], end_day)
    return start, end


def _gather_temporal_context(session: Session, start_date, end_date) -> list[str]:
    """Gather aggregate data for a specific time period."""
    from datetime import date as date_type
    context_parts = []

    # Recent newsletters in the date range
    newsletters = (
        session.query(Newsletter)
        .filter(
            Newsletter.published_date >= start_date,
            Newsletter.published_date <= end_date,
        )
        .order_by(desc(Newsletter.published_date))
        .all()
    )

    if newsletters:
        context_parts.append(f"\n## Newsletters from {start_date} to {end_date} ({len(newsletters)} total)")
        for nl in newsletters:
            # Extract first ~300 chars of body for summary
            summary = (nl.body_text or "")[:400].strip()
            context_parts.append(
                f"### {nl.title} ({nl.published_date.strftime('%Y-%m-%d') if nl.published_date else 'N/A'})\n{summary}\n"
            )

    # New registrations in the period
    from sqlalchemy import and_
    new_registrations = (
        session.query(Filing, Registrant, Client)
        .outerjoin(Registrant, Filing.registrant_id == Registrant.id)
        .outerjoin(Client, Filing.client_id == Client.id)
        .filter(
            Filing.dt_posted >= start_date,
            Filing.dt_posted <= end_date,
            Filing.filing_type.in_(["RR", "RA"]),
        )
        .order_by(desc(Filing.dt_posted))
        .limit(50)
        .all()
    )

    if new_registrations:
        context_parts.append(f"\n## New Lobbying Registrations ({len(new_registrations)} shown)")
        for f, reg, cli in new_registrations:
            # Get activities for this filing
            activities = session.query(LobbyingActivity).filter(LobbyingActivity.filing_id == f.id).all()
            issues = [a.general_issue_code_display or a.general_issue_code for a in activities]
            desc_text = "; ".join(a.description[:150] for a in activities if a.description)
            parts = [
                f"- **{reg.name if reg else 'N/A'}** for **{cli.name if cli else 'N/A'}** "
                f"(posted {f.dt_posted})"
            ]
            if issues:
                parts[0] += f" — Issues: {', '.join(issues)}"
            if desc_text:
                parts.append(f"  Description: {desc_text[:300]}")
            context_parts.append("\n".join(parts))

    # Aggregate issue areas from all filings in the period
    issue_counts = (
        session.query(
            LobbyingActivity.general_issue_code_display,
            func.count(LobbyingActivity.id).label("cnt"),
        )
        .join(Filing, LobbyingActivity.filing_id == Filing.id)
        .filter(
            Filing.dt_posted >= start_date,
            Filing.dt_posted <= end_date,
        )
        .group_by(LobbyingActivity.general_issue_code_display)
        .order_by(desc("cnt"))
        .limit(20)
        .all()
    )

    if issue_counts:
        context_parts.append("\n## Top Lobbying Issue Areas in Period")
        for issue, cnt in issue_counts:
            context_parts.append(f"- {issue}: {cnt} filings")

    # Filing type breakdown
    type_counts = (
        session.query(
            Filing.filing_type_display,
            func.count(Filing.id).label("cnt"),
        )
        .filter(
            Filing.dt_posted >= start_date,
            Filing.dt_posted <= end_date,
        )
        .group_by(Filing.filing_type_display)
        .order_by(desc("cnt"))
        .all()
    )

    if type_counts:
        context_parts.append(f"\n## Filing Activity Summary ({start_date} to {end_date})")
        total = sum(c for _, c in type_counts)
        context_parts.append(f"Total filings posted: {total}")
        for ft, cnt in type_counts:
            context_parts.append(f"- {ft}: {cnt}")

    # Entity mentions in this period's newsletters
    if newsletters:
        nl_ids = [nl.id for nl in newsletters]
        top_entities = (
            session.query(
                Entity.display_name, Entity.name, Entity.entity_type,
                func.count(EntityMention.id).label("cnt"),
            )
            .join(EntityMention, Entity.id == EntityMention.entity_id)
            .filter(EntityMention.newsletter_id.in_(nl_ids))
            .group_by(Entity.id, Entity.display_name, Entity.name, Entity.entity_type)
            .order_by(desc("cnt"))
            .limit(20)
            .all()
        )

        if top_entities:
            context_parts.append("\n## Most Mentioned Entities in Period's Newsletters")
            for display_name, name, etype, cnt in top_entities:
                context_parts.append(f"- {display_name or name} ({etype}): {cnt} mentions")

    return context_parts


def _extract_search_keywords(query: str) -> list[str]:
    """Extract meaningful search keywords from a conversational query.

    Filters out common stop words and short words to get terms
    worth searching in the database.
    """
    stop_words = {
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "shall", "can", "need", "must",
        "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
        "they", "them", "their", "its", "his", "her",
        "this", "that", "these", "those", "what", "which", "who", "whom",
        "how", "when", "where", "why",
        "and", "but", "or", "nor", "not", "no", "so", "if", "then",
        "in", "on", "at", "to", "for", "of", "with", "by", "from",
        "up", "out", "off", "over", "under", "about", "into", "through",
        "give", "get", "got", "tell", "show", "find", "know", "think",
        "want", "like", "just", "also", "very", "really", "much",
        "full", "any", "all", "some", "more", "most", "other",
        "report", "developments", "update", "overview", "summary",
        "recent", "latest", "current", "new", "happening", "going",
        "week", "month", "year", "today", "yesterday", "last",
    }
    import re
    # Extract words, keeping multi-word proper nouns if quoted
    words = re.findall(r'\b[a-zA-Z]{3,}\b', query)
    keywords = [w for w in words if w.lower() not in stop_words]
    return keywords


def _gather_chat_context(session: Session, query: str) -> str:
    """Search the database for context relevant to a chat query."""
    context_parts = []

    # Check for date-range / temporal queries and gather aggregate context
    start_date, end_date = _extract_date_range(query)
    if start_date and end_date:
        temporal_ctx = _gather_temporal_context(session, start_date, end_date)
        context_parts.extend(temporal_ctx)

    # Extract meaningful keywords for database searching
    keywords = _extract_search_keywords(query)

    # Search entities by name — try full query first, then individual keywords
    entity_matches = (
        session.query(Entity)
        .filter(Entity.name.ilike(f"%{query}%"))
        .order_by(desc(Entity.mention_count))
        .limit(10)
        .all()
    )

    # If full query didn't match, try keywords
    if not entity_matches and keywords:
        for kw in keywords:
            matches = (
                session.query(Entity)
                .filter(Entity.name.ilike(f"%{kw}%"))
                .order_by(desc(Entity.mention_count))
                .limit(5)
                .all()
            )
            entity_matches.extend(matches)
        # Deduplicate
        seen_ids = set()
        unique = []
        for e in entity_matches:
            if e.id not in seen_ids:
                seen_ids.add(e.id)
                unique.append(e)
        entity_matches = unique[:10]

    if entity_matches:
        context_parts.append("## Matching Entities")
        for e in entity_matches:
            context_parts.append(
                f"- **{e.display_name or e.name}** (ID: {e.id}, type: {e.entity_type}, "
                f"mentions: {e.mention_count}, consultant: {e.is_consultant}, "
                f"client: {e.is_client}, lobbyist: {e.is_lobbyist})"
            )

    # Get detailed context for the best matching entity
    best_entity = entity_matches[0] if entity_matches else None

    if best_entity:
        full_ctx = _gather_entity_context(session, best_entity.id)
        context_parts.append(f"\n## Detailed Context for {best_entity.display_name or best_entity.name}")
        context_parts.append(json.dumps(full_ctx, indent=2, default=str))

    # Search newsletter content — use keywords instead of full query
    newsletter_matches = []
    search_terms = keywords if keywords else [query]
    for term in search_terms[:3]:  # Limit to top 3 keywords
        matches = (
            session.query(Newsletter)
            .filter(Newsletter.body_text.ilike(f"%{term}%"))
            .order_by(desc(Newsletter.published_date))
            .limit(3)
            .all()
        )
        newsletter_matches.extend(matches)

    # Deduplicate newsletters
    seen_nl_ids = set()
    unique_nls = []
    for nl in newsletter_matches:
        if nl.id not in seen_nl_ids:
            seen_nl_ids.add(nl.id)
            unique_nls.append(nl)
    newsletter_matches = unique_nls[:5]

    if newsletter_matches:
        context_parts.append("\n## Relevant Newsletter Excerpts")
        for nl in newsletter_matches:
            text = nl.body_text or ""
            lower = text.lower()
            # Find best matching keyword in text
            best_idx = -1
            for term in (keywords if keywords else [query]):
                idx = lower.find(term.lower())
                if idx >= 0:
                    best_idx = idx
                    break
            if best_idx >= 0:
                start = max(0, best_idx - 200)
                end = min(len(text), best_idx + 300)
                excerpt = text[start:end].strip()
            else:
                excerpt = text[:500]
            context_parts.append(f"### {nl.title} ({nl.published_date})")
            context_parts.append(excerpt)

    # Search filings by registrant/client name — use keywords
    filing_matches = []
    for term in (keywords[:3] if keywords else [query]):
        matches = (
            session.query(Filing, Registrant, Client)
            .outerjoin(Registrant, Filing.registrant_id == Registrant.id)
            .outerjoin(Client, Filing.client_id == Client.id)
            .filter(
                (Registrant.name.ilike(f"%{term}%")) |
                (Client.name.ilike(f"%{term}%"))
            )
            .order_by(desc(Filing.dt_posted))
            .limit(5)
            .all()
        )
        filing_matches.extend(matches)

    # Deduplicate filings
    seen_f_ids = set()
    unique_filings = []
    for item in filing_matches:
        f = item[0]
        if f.id not in seen_f_ids:
            seen_f_ids.add(f.id)
            unique_filings.append(item)
    filing_matches = unique_filings[:10]

    # Search lobbying activities by description, specific issues, and lobbyist names
    activity_matches = []
    for term in (keywords[:3] if keywords else [query]):
        matches = (
            session.query(LobbyingActivity, Filing, Registrant, Client)
            .join(Filing, LobbyingActivity.filing_id == Filing.id)
            .outerjoin(Registrant, Filing.registrant_id == Registrant.id)
            .outerjoin(Client, Filing.client_id == Client.id)
            .filter(
                (LobbyingActivity.description.ilike(f"%{term}%")) |
                (LobbyingActivity.specific_issues.ilike(f"%{term}%")) |
                (LobbyingActivity.government_entities.ilike(f"%{term}%")) |
                (LobbyingActivity.lobbyists.ilike(f"%{term}%"))
            )
            .order_by(desc(Filing.dt_posted))
            .limit(10)
            .all()
        )
        activity_matches.extend(matches)

    # Deduplicate activities
    seen_act_ids = set()
    unique_acts = []
    for item in activity_matches:
        act = item[0]
        if act.id not in seen_act_ids:
            seen_act_ids.add(act.id)
            unique_acts.append(item)
    activity_matches = unique_acts[:15]

    # Collect filing IDs already shown from the registrant/client search
    seen_filing_ids = set()

    if filing_matches:
        context_parts.append("\n## Relevant LDA Filings (by registrant/client)")
        for f, reg, cli in filing_matches:
            seen_filing_ids.add(f.id)
            activities = session.query(LobbyingActivity).filter(LobbyingActivity.filing_id == f.id).all()
            issues = [a.general_issue_code_display or a.general_issue_code for a in activities]
            context_parts.append(
                f"- {f.filing_type_display or f.filing_type} ({f.filing_year} {f.filing_period_display}): "
                f"Registrant={reg.name if reg else 'N/A'}, Client={cli.name if cli else 'N/A'}, "
                f"Income={f.income}, Expenses={f.expenses}, Issues={', '.join(issues)}"
            )

    if activity_matches:
        context_parts.append("\n## Relevant Lobbying Activities (by issue/lobbyist/description)")
        shown = 0
        for act, f, reg, cli in activity_matches:
            if f.id in seen_filing_ids:
                continue
            seen_filing_ids.add(f.id)
            # Parse lobbyist names from JSON
            lob_names = []
            if act.lobbyists:
                try:
                    lob_list = json.loads(act.lobbyists)
                    for entry in (lob_list if isinstance(lob_list, list) else []):
                        lob = entry.get("lobbyist", {}) if isinstance(entry, dict) else {}
                        first = (lob.get("first_name") or "").strip()
                        last = (lob.get("last_name") or "").strip()
                        full = f"{first} {last}".strip()
                        if full:
                            lob_names.append(full)
                except (json.JSONDecodeError, TypeError):
                    pass
            # Parse government entities
            gov_entities = []
            if act.government_entities:
                try:
                    ge_list = json.loads(act.government_entities)
                    for ge in (ge_list if isinstance(ge_list, list) else []):
                        name = ge.get("name", ge) if isinstance(ge, dict) else str(ge)
                        if name:
                            gov_entities.append(name)
                except (json.JSONDecodeError, TypeError):
                    pass
            parts = [
                f"- {f.filing_type_display or f.filing_type} ({f.filing_year} {f.filing_period_display}): "
                f"Registrant={reg.name if reg else 'N/A'}, Client={cli.name if cli else 'N/A'}, "
                f"Income={f.income}, Expenses={f.expenses}",
                f"  Issue: {act.general_issue_code_display or act.general_issue_code}",
            ]
            if act.description:
                parts.append(f"  Description: {act.description[:300]}")
            if act.specific_issues:
                parts.append(f"  Specific Issues: {act.specific_issues[:300]}")
            if lob_names:
                parts.append(f"  Lobbyists: {', '.join(lob_names)}")
            if gov_entities:
                parts.append(f"  Gov Entities: {', '.join(gov_entities)}")
            context_parts.append("\n".join(parts))
            shown += 1
            if shown >= 10:
                break

    # Fallback: if no temporal context was gathered and very little was found,
    # automatically gather recent data (last 14 days) so the AI has something to work with
    has_temporal = start_date is not None and end_date is not None
    has_substantive = bool(entity_matches or newsletter_matches or filing_matches or activity_matches)
    if not has_temporal and not has_substantive:
        from datetime import date as date_type, timedelta
        fallback_end = date_type.today()
        fallback_start = fallback_end - timedelta(days=14)
        context_parts.append(f"\n## Recent Activity (auto-retrieved, last 14 days)")
        fallback_ctx = _gather_temporal_context(session, fallback_start, fallback_end)
        context_parts.extend(fallback_ctx)

    # Get overall stats for context
    total_entities = session.query(func.count(Entity.id)).scalar() or 0
    total_filings = session.query(func.count(Filing.id)).scalar() or 0
    total_newsletters = session.query(func.count(Newsletter.id)).scalar() or 0

    context_parts.append(f"\n## Database Stats")
    context_parts.append(f"Total entities tracked: {total_entities}")
    context_parts.append(f"Total LDA filings: {total_filings}")
    context_parts.append(f"Total Politico Influence newsletters: {total_newsletters}")

    return "\n".join(context_parts)


def chat(messages: list[dict], query: str) -> str:
    """Process a chat message with database context."""
    session = _get_session()
    try:
        # Gather context from the database
        db_context = _gather_chat_context(session, query)

        client = _get_client()

        system_prompt = f"""You are an expert analyst for a U.S. lobbying disclosure and political influence tracking platform. You have access to data from Senate LDA (Lobbying Disclosure Act) filings and Politico's Influence newsletter.

You help users explore lobbying relationships, understand policy priorities, track spending patterns, and identify connections between lobbyists, firms, clients, and government entities.

Here is the relevant data from our database for the current query:

{db_context}

You may also draw on your general knowledge of recent news and public reporting from the last 3-6 months to supplement answers — for example, major lobbying developments, regulatory actions, personnel moves, or policy debates. When you do, clearly label that information as coming from recent news coverage rather than our internal database (e.g., "Per recent news reports, ..." or "According to public reporting, ..."). Always distinguish between what comes from our internal LDA/Politico Influence data and what comes from your broader knowledge.

Guidelines:
- Be specific: cite names, dollar amounts, dates, and issue areas from the data
- If you find relevant entities, mention their connections and affiliations
- If the data doesn't contain enough information to answer fully, supplement with relevant recent news context and clearly label it as such
- Use concise, analytical language — you're writing intelligence briefs, not essays
- When discussing money, format as USD with commas
- Reference the source of information (e.g., "according to their LDA filing", "as covered in Politico Influence", or "per recent news reports")
- If the user asks about something not in the database, draw on recent public reporting where possible, clearly noting the source"""

        # Build message history for Claude
        claude_messages = []
        for msg in messages:
            claude_messages.append({
                "role": msg["role"],
                "content": msg["content"],
            })

        response = client.messages.create(
            model=MODEL,
            max_tokens=2048,
            system=system_prompt,
            messages=claude_messages,
        )
        return response.content[0].text
    finally:
        session.close()
