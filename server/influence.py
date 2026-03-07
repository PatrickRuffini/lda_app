"""Scraper for Politico Influence newsletter.

Fetches newsletters from politico.com/newsletters/politico-influence,
extracts bold entities, detects relationships from co-occurrences,
and stores everything in the local database.

Uses Playwright (headless Chromium) to bypass Cloudflare protection.
"""
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta
from itertools import combinations
from typing import Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag
from sqlalchemy import text

from .models import (
    Entity, EntityMention, Newsletter, Relationship,
    get_engine, get_session, init_db,
)

logger = logging.getLogger(__name__)

BASE_URL = "https://www.politico.com"
NEWSLETTER_LIST_URL = f"{BASE_URL}/newsletters/politico-influence"
CHROMIUM_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".cache", "ms-playwright", "chromium-1208", "chrome-linux64", "chrome"
)
GBM_LIB_DIR = None
for entry in os.listdir("/nix/store") if os.path.exists("/nix/store") else []:
    if "mesa-libgbm" in entry:
        candidate = os.path.join("/nix/store", entry, "lib")
        if os.path.exists(os.path.join(candidate, "libgbm.so.1")):
            GBM_LIB_DIR = candidate
            break


def _get_browser_page():
    """Launch a headless Chromium browser and return (playwright, browser, page)."""
    from playwright.sync_api import sync_playwright

    if GBM_LIB_DIR:
        ld_path = os.environ.get("LD_LIBRARY_PATH", "")
        if GBM_LIB_DIR not in ld_path:
            os.environ["LD_LIBRARY_PATH"] = f"{GBM_LIB_DIR}:{ld_path}"

    pw = sync_playwright().start()
    browser = pw.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        chromium_sandbox=False,
        executable_path=CHROMIUM_PATH,
    )
    ctx = browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1920, "height": 1080},
    )
    page = ctx.new_page()
    page.add_init_script('Object.defineProperty(navigator, "webdriver", {get: () => undefined})')
    return pw, browser, page


def _fetch_with_browser(page, url: str, wait_ms: int = 5000) -> Optional[str]:
    """Fetch a URL using the browser page and return HTML content."""
    try:
        page.goto(url, timeout=30000, wait_until="domcontentloaded")
        page.wait_for_timeout(wait_ms)
        title = page.title()
        if "just a moment" in title.lower():
            logger.warning(f"Cloudflare challenge on {url}, waiting longer...")
            page.wait_for_timeout(10000)
            title = page.title()
            if "just a moment" in title.lower():
                logger.error(f"Could not bypass Cloudflare for {url}")
                return None
        return page.content()
    except Exception as e:
        logger.error(f"Browser fetch error for {url}: {e}")
        return None


ARCHIVE_URL = f"{BASE_URL}/newsletters/politico-influence/archive"


def discover_newsletter_urls(page, max_pages: int = 5) -> list[str]:
    """
    Discover newsletter edition URLs from the archive page using the browser.
    Archive pages are numbered: /archive, /archive/2, /archive/3, etc.
    Each page has ~10 newsletter links.
    """
    urls = []

    for page_num in range(1, max_pages + 1):
        archive_page_url = ARCHIVE_URL if page_num == 1 else f"{ARCHIVE_URL}/{page_num}"
        html = _fetch_with_browser(page, archive_page_url, wait_ms=5000 if page_num == 1 else 3000)
        if not html:
            logger.warning(f"Failed to fetch archive page {page_num}")
            break

        link_matches = re.findall(
            r'/newsletters/politico-influence/\d{4}/\d{2}/\d{2}/[^"<>\s]+',
            html,
        )
        new_count = 0
        for href in link_matches:
            full_url = urljoin(BASE_URL, href)
            if full_url not in urls:
                urls.append(full_url)
                new_count += 1

        logger.info(f"Archive page {page_num}: found {new_count} new URLs (total: {len(urls)})")

        if new_count == 0:
            break

        time.sleep(1)

    return urls


def scrape_newsletter(page, url: str) -> Optional[dict]:
    """
    Scrape a single newsletter page using the browser and return structured data.
    """
    html = _fetch_with_browser(page, url, wait_ms=3000)
    if not html:
        return None

    soup = BeautifulSoup(html, "lxml")

    title_tag = soup.find("h1") or soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else "Untitled"

    date_match = re.search(r"/(\d{4})/(\d{2})/(\d{2})/", url)
    published_date = None
    if date_match:
        try:
            published_date = datetime(
                int(date_match.group(1)),
                int(date_match.group(2)),
                int(date_match.group(3)),
            )
        except ValueError:
            pass

    if not published_date:
        date_meta = soup.find("meta", {"property": "article:published_time"})
        if date_meta and date_meta.get("content"):
            try:
                published_date = datetime.fromisoformat(
                    date_meta["content"].replace("Z", "+00:00")
                )
            except ValueError:
                pass

    body = (
        soup.find("div", {"class": re.compile(r"story-text|article-body|newsletter-body|content-body", re.I)})
        or soup.find("article")
        or soup.find("div", {"class": re.compile(r"story__content|mag-content", re.I)})
    )

    if not body:
        body = soup.find("main") or soup.find("div", {"id": "main"})

    if not body:
        logger.warning(f"Could not find article body in {url}")
        return None

    body_html = str(body)

    paragraphs = body.find_all(["p", "li", "h2", "h3", "h4"])
    para_texts = []
    for p in paragraphs:
        text = re.sub(r" {2,}", " ", p.get_text(separator=" ", strip=True))
        if text:
            para_texts.append(text)
    body_text = _strip_boilerplate("\n\n".join(para_texts))

    return {
        "url": url,
        "title": title,
        "published_date": published_date,
        "body_text": body_text,
        "body_html": body_html,
    }


def _strip_boilerplate(body_text: str) -> str:
    paras = body_text.split("\n\n")
    byline_idx = None
    for i, p in enumerate(paras):
        if re.match(r"^By\s+[A-Z][A-Z\s]+(?:and\s+[A-Z][A-Z\s]+)?$", p.strip()):
            byline_idx = i
            break

    if byline_idx is None:
        return body_text

    content_re = re.compile(
        r"^([A-Z][A-Z\s'\u2019&,\-]+:|FIRST IN PI|"
        r"Happy \w+day and welcome to PI|"
        r"\u2014 |\u2013 |— )"
    )

    for i in range(byline_idx + 1, len(paras)):
        if content_re.match(paras[i].strip()):
            return "\n\n".join(paras[i:])

    return "\n\n".join(paras[byline_idx + 1:])


PERSON_INDICATORS = [
    r"\b(said|told|wrote|argued|testified|lobbied|hired|appointed|named|joined|left|resigned|fired)\b",
    r"\b(former|ex-|incoming|outgoing)\b.*\b(chief|director|secretary|president|chair|adviser|counsel|lobbyist|attorney|partner|aide|staffer|spokesperson|analyst|reporter|editor|correspondent|strategist|consultant|manager|officer|head)\b",
    r"\b(Sen\.|Rep\.|Gov\.|Secretary|Ambassador|Commissioner|Chairman|Chairwoman|Judge|Justice|Attorney General|Director|President|Vice President|Mayor|Speaker|Minority Leader|Majority Leader)\s",
    r"\b(Jr\.|Sr\.|III|IV)\b",
]

ORG_INDICATORS = [
    r"\b(Inc\.|Corp\.|LLC|LLP|Ltd\.|Co\.|Group|Association|Institute|Foundation|Committee|Commission|Council|Bureau|Agency|Department|Administration|Board|Authority|Fund|PAC|Super PAC|Partners|Advisors|Strategies|Consulting|Solutions|Services|Alliance|Coalition|Union|Federation|Network|Center|Society)\b",
    r"\b(the\s+)?(White House|Congress|Senate|House|Pentagon|State Department|Treasury|EPA|FDA|FCC|FTC|SEC|DOJ|DOD|DOE|HHS|USDA|Interior|Commerce|Labor|Education|HUD|VA|DHS|DOT|SBA|OMB|CIA|FBI|NSA|IRS|OSHA|FEMA|NIH|CDC|WHO|NATO|UN|IMF|WTO)\b",
]

KNOWN_ACRONYM_ENTITIES = {
    "NATO", "UN", "IMF", "WTO", "WHO", "FBI", "CIA", "NSA", "IRS",
    "EPA", "FDA", "FCC", "FTC", "SEC", "DOJ", "DOD", "DOE", "HHS",
    "USDA", "DHS", "DOT", "SBA", "OMB", "NIH", "CDC", "OSHA", "FEMA",
    "BP", "IBM", "AT&T", "HP", "GE", "GM", "BMW",
}


_POSSESSIVE_BRANDS = {"Lowe's", "McDonald's", "Arby's", "Macy's", "Campbell's", "Hellmann's",
                      "Lowe\u2019s", "McDonald\u2019s", "Arby\u2019s", "Macy\u2019s", "Campbell\u2019s", "Hellmann\u2019s"}

KNOWN_SECTION_HEADINGS = {
    "JOBS REPORT", "INFLUENCE AD WATCH", "FIRST IN PI",
    "K STREET FILES", "NEW LOBBYING REGISTRATIONS",
    "NEW LOBBYING TERMINATIONS", "SPOTTED",
    "NEW JOINT FUNDRAISERS", "NEW PACS",
}


def _is_section_heading(name: str, para_text: str) -> bool:
    stripped = name.strip().rstrip(":")
    if len(stripped) < 3:
        return False
    if stripped.upper() in KNOWN_ACRONYM_ENTITIES:
        return False
    if stripped.upper() in KNOWN_SECTION_HEADINGS:
        return True
    if stripped.upper() != stripped:
        return False
    if name.strip().endswith(":"):
        return True
    if re.match(r"^[A-Z][A-Z\s\'\u2019&,\-:]{3,}$", name.strip()):
        em_dash_pat = re.escape(name.strip()) + r"\s*\u2014"
        if re.search(em_dash_pat, para_text):
            return True
        words_in_name = len(name.split())
        words_in_para = len(para_text.split())
        if words_in_name >= (words_in_para * 0.4):
            return True
    return False


def _classify_entity_type(name: str, context: str) -> str:
    for pattern in ORG_INDICATORS:
        if re.search(pattern, name, re.I):
            return "organization"

    name_parts = name.strip().split()
    name_parts_filtered = [p for p in name_parts if p.lower() not in ("the", "of", "and", "for", "de", "van", "von", "al", "el")]

    has_no_org_words = not re.search(
        r"\b(Inc|Corp|LLC|Association|Institute|Foundation|Committee|Partners|Group|Alliance|Coalition|Center|Club|Bureau|Agency|Council|Company|Fund|Society|Network|Strategies|Advisors|Consulting|Solutions|Services|Labs|Technologies|Media)\b",
        name, re.I
    )

    if has_no_org_words and 1 <= len(name_parts_filtered) <= 4:
        all_title = all(
            p[0].isupper()
            for p in name_parts_filtered
            if len(p) > 1
        )
        if all_title:
            for pattern in PERSON_INDICATORS:
                if re.search(pattern, context, re.I):
                    return "person"

    if re.search(r"\b(company|firm|corporation|organization|lobby|lobbying firm|trade group|tech giant|bank|lender|insurer|carrier)\b", context, re.I):
        if name in context:
            idx = context.index(name)
            surrounding = context[max(0, idx-50):idx+len(name)+50]
            if re.search(r"\b(company|firm|corporation|organization|lobby|lobbying firm|trade group|tech giant|bank|lender|insurer|carrier)\b", surrounding, re.I):
                return "organization"

    return "unknown"


def extract_registration_pairs(body_text: str) -> list[dict]:
    """
    Extract lobbying registration/termination pairs from newsletter body text.

    These appear under headers like "New Lobbying Registrations" or
    "New Lobbying Terminations" in the format: Company1: Company2
    """
    pairs = []
    lines = body_text.split("\n\n")
    in_section = False
    section_type = None

    for line in lines:
        stripped = line.strip()
        lower = stripped.lower()

        if re.match(r"^new lobbying\s+(registrations?|terminations?)$", lower):
            in_section = True
            section_type = "registration" if "registr" in lower else "termination"
            continue

        if in_section:
            if ":" not in stripped:
                in_section = False
                continue

            last_colon = stripped.rfind(":")
            company_a = stripped[:last_colon].strip()
            company_b = stripped[last_colon + 1:].strip()

            if not company_a or not company_b:
                continue
            if len(company_a) < 2 or len(company_b) < 2:
                continue
            if re.match(r"^(a message from|politico|advertisement)", company_a, re.I):
                in_section = False
                continue

            pairs.append({
                "registrant": company_a,
                "client": company_b,
                "section_type": section_type,
            })

    return pairs


def _merge_consecutive_bold_tags(para) -> list:
    """
    Merge consecutive bold tags into single entities.
    E.g. <b>Donald</b> <b>Trump</b> becomes "Donald Trump".
    Returns list of merged bold text strings with their positions preserved.
    """
    bold_tags = para.find_all(["strong", "b"])
    if not bold_tags:
        return []

    merged = []
    current_parts = []
    prev_tag = None

    for tag in bold_tags:
        text = tag.get_text(strip=True)
        if not text:
            continue

        if prev_tag is not None:
            between = ""
            node = prev_tag.next_sibling
            while node and node != tag:
                if hasattr(node, 'get_text'):
                    between += node.get_text()
                elif isinstance(node, str):
                    between += node
                node = node.next_sibling

            if between.strip() == "" and len(between) <= 2:
                current_parts.append(text)
            else:
                if current_parts:
                    merged.append(" ".join(current_parts))
                current_parts = [text]
        else:
            current_parts = [text]

        prev_tag = tag

    if current_parts:
        merged.append(" ".join(current_parts))

    return merged


def _is_inside_ad(element) -> bool:
    parent = element
    while parent:
        classes = parent.get("class", []) if hasattr(parent, "get") else []
        if any("intext-ad" in c for c in classes):
            return True
        parent = parent.parent
    return False


def extract_bold_entities_from_html(body_html: str) -> list[dict]:
    """
    Extract bold entities from newsletter HTML.

    Returns a list of dicts with keys:
    - name: the entity name
    - paragraph_index: which paragraph it appeared in
    - context: the paragraph text
    - is_section_heading: whether this is a section heading
    """
    soup = BeautifulSoup(body_html, "lxml")
    entities = []

    paragraphs = soup.find_all(["p", "li"])

    skip_patterns = [
        r"^(Read|More|Click|Subscribe|Sign up|Good|POLITICO|Influence|Happy|NEW|HAPPENING|ICYMI|SPOTTED|FIRST IN)",
        r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)",
        r"^(January|February|March|April|May|June|July|August|September|October|November|December)",
        r"^(Q[1-4]|FY\d|H[1-2])",
        r"^\d+$",
        r"^https?://",
    ]

    for para_idx, para in enumerate(paragraphs):
        para_text = para.get_text(separator=" ", strip=True)
        if not para_text or len(para_text) < 10:
            continue

        if _is_inside_ad(para):
            continue

        merged_names = _merge_consecutive_bold_tags(para)
        for name in merged_names:
            if not name or len(name) < 2:
                continue

            if name not in _POSSESSIVE_BRANDS:
                name = re.sub(r"['\u2019]s$", "", name).strip()

            if not name or len(name) < 2:
                continue

            if any(re.match(pat, name, re.I) for pat in skip_patterns):
                continue

            if len(name) > 100:
                continue

            is_heading = _is_section_heading(name, para_text)

            entities.append({
                "name": name,
                "paragraph_index": para_idx,
                "context": para_text[:500],
                "is_section_heading": is_heading,
            })

    return entities


def detect_affiliations(entities_in_paragraph: list[dict], paragraph_text: str) -> list[dict]:
    """
    Detect professional affiliations from patterns like:
    - "<Bold Person> of <Bold Company>"
    - "<Bold Company>'s <Bold Person>"
    """
    affiliations = []
    if len(entities_in_paragraph) < 2:
        return affiliations

    for i, ent_a in enumerate(entities_in_paragraph):
        for ent_b in entities_in_paragraph[i + 1:]:
            name_a = ent_a["name"]
            name_b = ent_b["name"]

            pattern1 = re.search(
                re.escape(name_a) + r"\s+of\s+" + re.escape(name_b),
                paragraph_text,
                re.I,
            )
            if pattern1:
                affiliations.append({
                    "person": name_a,
                    "company": name_b,
                    "pattern": "person_of_company",
                })
                continue

            pattern1r = re.search(
                re.escape(name_b) + r"\s+of\s+" + re.escape(name_a),
                paragraph_text,
                re.I,
            )
            if pattern1r:
                affiliations.append({
                    "person": name_b,
                    "company": name_a,
                    "pattern": "person_of_company",
                })
                continue

            pattern2 = re.search(
                re.escape(name_a) + r"\s*['\u2019]\s*s\s+" + re.escape(name_b),
                paragraph_text,
                re.I,
            )
            if pattern2:
                affiliations.append({
                    "person": name_b,
                    "company": name_a,
                    "pattern": "company_possessive_person",
                })
                continue

            pattern2r = re.search(
                re.escape(name_b) + r"\s*['\u2019]\s*s\s+" + re.escape(name_a),
                paragraph_text,
                re.I,
            )
            if pattern2r:
                affiliations.append({
                    "person": name_a,
                    "company": name_b,
                    "pattern": "company_possessive_person",
                })

    return affiliations


def _get_or_create_entity(session, name: str, entity_type: str = "unknown",
                          display_name: Optional[str] = None,
                          date: Optional[datetime] = None) -> Entity:
    """Get or create an entity by name. Respects user_override for type."""
    entity = session.query(Entity).filter(Entity.name == name).first()
    if not entity:
        entity = Entity(
            name=name,
            entity_type=entity_type,
            display_name=display_name or name,
            first_seen=date,
            last_seen=date,
            mention_count=0,
            user_override=False,
        )
        session.add(entity)
        session.flush()
    else:
        if not entity.user_override and entity_type != "unknown":
            entity.entity_type = entity_type
        if display_name and not entity.user_override:
            entity.display_name = display_name
        if date:
            if not entity.first_seen or date < entity.first_seen:
                entity.first_seen = date
            if not entity.last_seen or date > entity.last_seen:
                entity.last_seen = date
    return entity


def _upsert_relationship(session, entity_a: Entity, entity_b: Entity,
                         rel_type: str, context: str,
                         date: Optional[datetime] = None):
    """Create or update a relationship between two entities."""
    if entity_a.id > entity_b.id:
        entity_a, entity_b = entity_b, entity_a

    rel = (
        session.query(Relationship)
        .filter(
            Relationship.entity_a_id == entity_a.id,
            Relationship.entity_b_id == entity_b.id,
        )
        .first()
    )

    if not rel:
        rel = Relationship(
            entity_a_id=entity_a.id,
            entity_b_id=entity_b.id,
            relationship_type=rel_type,
            weight=1,
            first_seen=date,
            last_seen=date,
            context_snippets=json.dumps([context[:300]]),
        )
        session.add(rel)
    else:
        rel.weight += 1
        if date:
            if not rel.first_seen or date < rel.first_seen:
                rel.first_seen = date
            if not rel.last_seen or date > rel.last_seen:
                rel.last_seen = date
        try:
            snippets = json.loads(rel.context_snippets or "[]")
        except (json.JSONDecodeError, TypeError):
            snippets = []
        snippets.append(context[:300])
        rel.context_snippets = json.dumps(snippets[-10:])
        if rel_type == "affiliation":
            rel.relationship_type = "affiliation"


def process_newsletter_entities(session, newsletter: Newsletter):
    """
    Extract entities from a newsletter and build the relationship graph.

    Only entities within the SAME PARAGRAPH are related (co-mentions).
    Section headings are captured as metadata but not as entities.
    No cross-paragraph section-level relationships are created.
    Lobbying terminations create entities/mentions but no relationships.
    Lobbying registrations create entities/mentions and registration relationships.
    """
    if not newsletter.body_html:
        return

    bold_entities = extract_bold_entities_from_html(newsletter.body_html)

    para_groups: dict[int, list[dict]] = {}
    current_section = None
    section_map: dict[int, str] = {}

    for ent in bold_entities:
        para_idx = ent["paragraph_index"]
        if ent.get("is_section_heading"):
            current_section = ent["name"].strip().rstrip(":")
            continue
        if current_section:
            section_map[para_idx] = current_section
        if para_idx not in para_groups:
            para_groups[para_idx] = []
        para_groups[para_idx].append(ent)

    pub_date = newsletter.published_date

    for para_idx, para_entities in para_groups.items():
        context = para_entities[0]["context"] if para_entities else ""
        section = section_map.get(para_idx)

        affiliations = detect_affiliations(para_entities, context)
        affiliated_persons = set()

        for aff in affiliations:
            person_entity = _get_or_create_entity(
                session, aff["person"], "person",
                display_name=aff["person"],
                date=pub_date,
            )
            person_entity.mention_count += 1

            company_entity = _get_or_create_entity(
                session, aff["company"], "organization",
                date=pub_date,
            )
            company_entity.mention_count += 1

            _upsert_relationship(
                session, person_entity, company_entity,
                "affiliation", context, pub_date,
            )

            session.add(EntityMention(
                entity_id=person_entity.id,
                newsletter_id=newsletter.id,
                paragraph_index=para_idx,
                context_text=context[:500],
                section_heading=section,
            ))
            session.add(EntityMention(
                entity_id=company_entity.id,
                newsletter_id=newsletter.id,
                paragraph_index=para_idx,
                context_text=context[:500],
                section_heading=section,
            ))

            affiliated_persons.add(aff["person"])

        para_entity_objs = []
        for ent in para_entities:
            if ent["name"] in affiliated_persons:
                continue

            classified_type = _classify_entity_type(ent["name"], context)
            entity_obj = _get_or_create_entity(
                session, ent["name"], classified_type, date=pub_date,
            )
            entity_obj.mention_count += 1
            para_entity_objs.append(entity_obj)

            session.add(EntityMention(
                entity_id=entity_obj.id,
                newsletter_id=newsletter.id,
                paragraph_index=para_idx,
                context_text=context[:500],
                section_heading=section,
            ))

        all_entities_in_para = para_entity_objs.copy()
        for aff in affiliations:
            person_ent = (
                session.query(Entity)
                .filter(Entity.name == aff["person"])
                .first()
            )
            company_ent = (
                session.query(Entity)
                .filter(Entity.name == aff["company"])
                .first()
            )
            if person_ent:
                all_entities_in_para.append(person_ent)
            if company_ent:
                all_entities_in_para.append(company_ent)

        seen_ids = set()
        unique_entities = []
        for e in all_entities_in_para:
            if e.id not in seen_ids:
                seen_ids.add(e.id)
                unique_entities.append(e)

        for ent_a, ent_b in combinations(unique_entities, 2):
            existing = (
                session.query(Relationship)
                .filter(
                    Relationship.entity_a_id == min(ent_a.id, ent_b.id),
                    Relationship.entity_b_id == max(ent_a.id, ent_b.id),
                    Relationship.relationship_type == "affiliation",
                )
                .first()
            )
            if existing:
                existing.weight += 1
                if pub_date and (not existing.last_seen or pub_date > existing.last_seen):
                    existing.last_seen = pub_date
                continue

            _upsert_relationship(
                session, ent_a, ent_b, "co_mention", context, pub_date,
            )

    reg_pairs = extract_registration_pairs(newsletter.body_text or "")
    for pair in reg_pairs:
        registrant = _get_or_create_entity(
            session, pair["registrant"], "organization", date=pub_date,
        )
        registrant.mention_count += 1

        client_ent = _get_or_create_entity(
            session, pair["client"], "organization", date=pub_date,
        )
        client_ent.mention_count += 1

        section_label = f"New Lobbying {'Registrations' if pair['section_type'] == 'registration' else 'Terminations'}"
        ctx = f"{pair['registrant']}: {pair['client']}"

        session.add(EntityMention(
            entity_id=registrant.id,
            newsletter_id=newsletter.id,
            paragraph_index=9000,
            context_text=ctx,
            section_heading=section_label,
        ))
        session.add(EntityMention(
            entity_id=client_ent.id,
            newsletter_id=newsletter.id,
            paragraph_index=9000,
            context_text=ctx,
            section_heading=section_label,
        ))

        if pair["section_type"] == "registration":
            a_id, b_id = (registrant, client_ent) if registrant.id < client_ent.id else (client_ent, registrant)
            existing = (
                session.query(Relationship)
                .filter(
                    Relationship.entity_a_id == a_id.id,
                    Relationship.entity_b_id == b_id.id,
                )
                .first()
            )
            if existing:
                existing.weight = max(existing.weight, 1.5)
                if pub_date and (not existing.last_seen or pub_date > existing.last_seen):
                    existing.last_seen = pub_date
                try:
                    snippets = json.loads(existing.context_snippets or "[]")
                except (json.JSONDecodeError, TypeError):
                    snippets = []
                snippets.append(ctx)
                existing.context_snippets = json.dumps(snippets[-10:])
            else:
                rel = Relationship(
                    entity_a_id=a_id.id,
                    entity_b_id=b_id.id,
                    relationship_type="lobbying_registration",
                    weight=1.5,
                    first_seen=pub_date,
                    last_seen=pub_date,
                    context_snippets=json.dumps([ctx]),
                )
                session.add(rel)

    newsletter.entities_extracted = True


_scrape_progress: dict = {}


def get_scrape_progress() -> dict:
    return dict(_scrape_progress)


def scrape_and_store(
    max_newsletters: int = 100,
    max_discovery_pages: int = 10,
    db_url: str = None,
) -> dict:
    """
    Main entry point: discover, scrape, extract, and store newsletters.
    Uses a headless browser to bypass Cloudflare.
    """
    global _scrape_progress
    engine = init_db(db_url)
    session = get_session(engine)

    pw = None
    browser = None

    try:
        pw, browser, page = _get_browser_page()

        _scrape_progress = {"phase": "discovering", "stored": 0, "skipped": 0, "errors": 0}
        logger.info("Discovering newsletter URLs...")
        urls = discover_newsletter_urls(page, max_pages=max_discovery_pages)
        logger.info(f"Found {len(urls)} newsletter URLs")

        stored = 0
        skipped = 0
        errors = 0
        to_process = urls[:max_newsletters]
        total = len(to_process)

        _scrape_progress = {"phase": "scraping", "stored": 0, "skipped": 0, "errors": 0, "total": total, "current": 0}

        for i, url in enumerate(to_process):
            existing = session.query(Newsletter).filter_by(url=url).first()
            if existing:
                skipped += 1
                _scrape_progress.update({"skipped": skipped, "current": i + 1})
                continue

            logger.info(f"Scraping ({i+1}/{total}): {url}")
            _scrape_progress.update({"current": i + 1, "current_url": url.split("/")[-1][:50]})

            data = scrape_newsletter(page, url)
            if not data:
                errors += 1
                _scrape_progress["errors"] = errors
                continue

            newsletter = Newsletter(
                url=data["url"],
                title=data["title"],
                published_date=data["published_date"],
                body_text=data["body_text"],
                body_html=data["body_html"],
                scraped_at=datetime.utcnow(),
            )
            session.add(newsletter)
            session.flush()

            process_newsletter_entities(session, newsletter)
            session.commit()

            stored += 1
            _scrape_progress["stored"] = stored
            time.sleep(2)

        _scrape_progress = {}
        return {
            "stored": stored,
            "skipped": skipped,
            "errors": errors,
            "total_urls": len(urls),
        }

    except Exception as e:
        _scrape_progress = {}
        session.rollback()
        logger.error(f"Scrape error: {e}")
        raise
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        if pw:
            try:
                pw.stop()
            except Exception:
                pass
        session.close()


def reprocess_all_entities(db_url: str = None) -> dict:
    """
    Rebuild relationships and mentions from stored newsletter HTML.
    Keeps existing entities in place (preserving types/overrides),
    resets mention counts, and re-extracts all relationships.
    """
    engine = init_db(db_url)
    session = get_session(engine)

    try:
        session.query(EntityMention).delete()
        session.query(Relationship).delete()
        session.execute(Entity.__table__.update().values(mention_count=0))
        session.query(Newsletter).update({Newsletter.entities_extracted: False})
        session.commit()

        logger.info("Cleared mentions, relationships, and reset mention counts. Entities preserved.")

        newsletters = (
            session.query(Newsletter)
            .order_by(Newsletter.published_date)
            .all()
        )

        processed = 0
        for nl in newsletters:
            if nl.body_html:
                soup = BeautifulSoup(nl.body_html, "lxml")
                paras = soup.find_all(["p", "li", "h2", "h3", "h4"])
                para_texts = []
                for p in paras:
                    t = re.sub(r" {2,}", " ", p.get_text(separator=" ", strip=True))
                    if t:
                        para_texts.append(t)
                nl.body_text = _strip_boilerplate("\n\n".join(para_texts))

            process_newsletter_entities(session, nl)
            session.commit()
            processed += 1
            if processed % 10 == 0:
                logger.info(f"Reprocessed {processed}/{len(newsletters)} newsletters")

        orphans = session.query(Entity).filter(Entity.mention_count == 0).count()
        if orphans:
            session.query(Entity).filter(Entity.mention_count == 0).delete()
            session.commit()
            logger.info(f"Cleaned up {orphans} orphaned entities with no mentions")

        logger.info(f"Reprocess complete: {processed} newsletters")
        return {"processed": processed, "orphans_removed": orphans}
    except Exception as e:
        session.rollback()
        raise
    finally:
        session.close()
