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


def _gather_chat_context(session: Session, query: str) -> str:
    """Search the database for context relevant to a chat query."""
    context_parts = []

    # Search entities by name
    entity_matches = (
        session.query(Entity)
        .filter(Entity.name.ilike(f"%{query}%"))
        .order_by(desc(Entity.mention_count))
        .limit(10)
        .all()
    )

    if entity_matches:
        context_parts.append("## Matching Entities")
        for e in entity_matches:
            context_parts.append(
                f"- **{e.display_name or e.name}** (ID: {e.id}, type: {e.entity_type}, "
                f"mentions: {e.mention_count}, consultant: {e.is_consultant}, "
                f"client: {e.is_client}, lobbyist: {e.is_lobbyist})"
            )

    # Search for entities mentioned in the query — get their full context
    # Try to find the most relevant entity
    best_entity = None
    if entity_matches:
        best_entity = entity_matches[0]
    else:
        # Try partial matching on individual words (3+ chars)
        words = [w for w in query.split() if len(w) >= 3]
        for word in words:
            match = (
                session.query(Entity)
                .filter(Entity.name.ilike(f"%{word}%"))
                .order_by(desc(Entity.mention_count))
                .first()
            )
            if match:
                best_entity = match
                break

    if best_entity:
        full_ctx = _gather_entity_context(session, best_entity.id)
        context_parts.append(f"\n## Detailed Context for {best_entity.display_name or best_entity.name}")
        context_parts.append(json.dumps(full_ctx, indent=2, default=str))

    # Search newsletter content
    newsletter_matches = (
        session.query(Newsletter)
        .filter(Newsletter.body_text.ilike(f"%{query}%"))
        .order_by(desc(Newsletter.published_date))
        .limit(5)
        .all()
    )
    if newsletter_matches:
        context_parts.append("\n## Relevant Newsletter Excerpts")
        for nl in newsletter_matches:
            # Extract relevant paragraph
            text = nl.body_text or ""
            lower = text.lower()
            idx = lower.find(query.lower())
            if idx >= 0:
                start = max(0, idx - 200)
                end = min(len(text), idx + 300)
                excerpt = text[start:end].strip()
            else:
                excerpt = text[:500]
            context_parts.append(f"### {nl.title} ({nl.published_date})")
            context_parts.append(excerpt)

    # Search filings by registrant/client name
    filing_matches = (
        session.query(Filing, Registrant, Client)
        .outerjoin(Registrant, Filing.registrant_id == Registrant.id)
        .outerjoin(Client, Filing.client_id == Client.id)
        .filter(
            (Registrant.name.ilike(f"%{query}%")) |
            (Client.name.ilike(f"%{query}%"))
        )
        .order_by(desc(Filing.dt_posted))
        .limit(10)
        .all()
    )

    # Search lobbying activities by description, specific issues, and lobbyist names
    query_words = [w for w in query.split() if len(w) >= 3]
    activity_matches = (
        session.query(LobbyingActivity, Filing, Registrant, Client)
        .join(Filing, LobbyingActivity.filing_id == Filing.id)
        .outerjoin(Registrant, Filing.registrant_id == Registrant.id)
        .outerjoin(Client, Filing.client_id == Client.id)
        .filter(
            (LobbyingActivity.description.ilike(f"%{query}%")) |
            (LobbyingActivity.specific_issues.ilike(f"%{query}%")) |
            (LobbyingActivity.government_entities.ilike(f"%{query}%")) |
            (LobbyingActivity.lobbyists.ilike(f"%{query}%"))
        )
        .order_by(desc(Filing.dt_posted))
        .limit(15)
        .all()
    )

    # If no exact matches on activities, try matching each word for lobbyist names
    if not activity_matches and len(query_words) > 1:
        word_filters = [LobbyingActivity.lobbyists.ilike(f"%{w}%") for w in query_words]
        activity_matches = (
            session.query(LobbyingActivity, Filing, Registrant, Client)
            .join(Filing, LobbyingActivity.filing_id == Filing.id)
            .outerjoin(Registrant, Filing.registrant_id == Registrant.id)
            .outerjoin(Client, Filing.client_id == Client.id)
            .filter(*word_filters)
            .order_by(desc(Filing.dt_posted))
            .limit(15)
            .all()
        )

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
