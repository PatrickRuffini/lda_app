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
    Client, Entity, EntityMention, Filing, LobbyingActivity, Newsletter,
    Registrant, Relationship, get_engine, get_session, init_db,
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
    "New Lobbying Terminations" in the format:
      Company1: Company2
      Company1: Company2 On Behalf Of Company3

    When "On Behalf Of" appears in the client portion, the part before is
    a second consultant and the part after is the actual client.

    Returns a list of dicts with keys:
    - registrant: str (always present, role=consultant)
    - client: str (always present, role=client)
    - on_behalf_of: str | None (second consultant when present, role=consultant)
    - section_type: "registration" | "termination"
    """
    pairs = []
    lines = body_text.split("\n\n")
    in_section = False
    section_type = None

    for line in lines:
        stripped = line.strip()
        lower = stripped.lower()

        if re.match(r"^new lobbying\s+(registrations?|terminations?):?\s*$", lower):
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

            # Check for "On Behalf Of" in the client portion
            obo_match = re.split(r"\s+[Oo]n\s+[Bb]ehalf\s+[Oo]f\s+", company_b, maxsplit=1)
            if len(obo_match) == 2:
                second_consultant = obo_match[0].strip()
                actual_client = obo_match[1].strip()
                if second_consultant and actual_client and len(second_consultant) >= 2 and len(actual_client) >= 2:
                    pairs.append({
                        "registrant": company_a,
                        "client": actual_client,
                        "on_behalf_of": second_consultant,
                        "section_type": section_type,
                    })
                    continue

            pairs.append({
                "registrant": company_a,
                "client": company_b,
                "on_behalf_of": None,
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
                          date: Optional[datetime] = None,
                          is_consultant: bool = False,
                          is_client: bool = False) -> Entity:
    """Get or create an entity by name. Respects user_override for type."""
    entity = session.query(Entity).filter(Entity.name == name).first()
    if not entity:
        entity = Entity(
            name=name,
            entity_type=entity_type,
            is_consultant=is_consultant,
            is_client=is_client,
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
        if is_consultant:
            entity.is_consultant = True
        if is_client:
            entity.is_client = True
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
            is_consultant=True,
        )
        registrant.mention_count += 1

        client_ent = _get_or_create_entity(
            session, pair["client"], "organization", date=pub_date,
            is_client=True,
        )
        client_ent.mention_count += 1

        # Collect all entities on this line for pairwise relationships
        line_entities = [registrant, client_ent]

        # Handle "On Behalf Of" — second consultant entity
        obo_ent = None
        if pair.get("on_behalf_of"):
            obo_ent = _get_or_create_entity(
                session, pair["on_behalf_of"], "organization", date=pub_date,
                is_consultant=True,
            )
            obo_ent.mention_count += 1
            line_entities.append(obo_ent)

        section_label = f"New Lobbying {'Registrations' if pair['section_type'] == 'registration' else 'Terminations'}"
        if obo_ent:
            ctx = f"{pair['registrant']}: {pair['on_behalf_of']} On Behalf Of {pair['client']}"
        else:
            ctx = f"{pair['registrant']}: {pair['client']}"

        # Create mentions for all entities on this line
        for ent in line_entities:
            session.add(EntityMention(
                entity_id=ent.id,
                newsletter_id=newsletter.id,
                paragraph_index=9000,
                context_text=ctx,
                section_heading=section_label,
            ))

        # Create pairwise relationships between all entities on this line
        rel_type = "lobbying_registration" if pair["section_type"] == "registration" else "lobbying_termination"
        for ent_a, ent_b in combinations(line_entities, 2):
            _upsert_relationship(session, ent_a, ent_b, rel_type, ctx, pub_date)

    newsletter.entities_extracted = True


def _normalize_org_name(name: str) -> str:
    """Normalize an organization name for fuzzy matching against LDA records."""
    n = name.upper().strip()
    # Strip common legal suffixes
    n = re.sub(
        r",?\s*\b(LLC|LLP|L\.L\.C\.|L\.L\.P\.|INC\.?|CORP\.?|CORPORATION|LTD\.?|CO\.?|P\.?A\.?|PLLC|P\.?L\.?L\.?C\.?|P\.?C\.?|L\.?P\.?)\s*$",
        "", n, flags=re.I,
    ).strip()
    # Strip trailing commas/periods
    n = n.rstrip(".,").strip()
    # Collapse whitespace
    n = re.sub(r"\s+", " ", n)
    return n


def _normalize_org_aggressive(name: str) -> str:
    """More aggressive normalization: strip parentheticals, Mr./Mrs., commas between name parts."""
    n = _normalize_org_name(name)
    # Strip parenthetical suffixes like (FKA ...) or (FORMERLY ...) or (DC)
    n = re.sub(r"\s*\(.*$", "", n).strip()
    # Strip Mr./Mrs./Ms. prefix
    n = re.sub(r"^(MR\.?|MRS\.?|MS\.?)\s+", "", n)
    # Strip commas between name parts ("AKIN, GUMP, STRAUSS" -> "AKIN GUMP STRAUSS")
    n = n.replace(",", " ")
    n = re.sub(r"\s+", " ", n).strip()
    return n


# Known aliases: informal name -> formal LDA name (both UPPER CASE after normalization)
# These are manually curated for cases where the short name in Politico Influence
# doesn't mechanically reduce to the full LDA registrant name.
ENTITY_ALIASES: dict[str, str] = {
    "AKIN GUMP": "AKIN GUMP STRAUSS HAUER & FELD",
    "FAEGRE DRINKER": "FAEGRE DRINKER BIDDLE & REATH",
    "DUANE MORRIS": "DUANE MORRIS GOVERNMENT STRATEGIES",
    "ICE MILLER STRATEGIES": "ICE MILLER",
    "BROWNSTEIN HYATT": "BROWNSTEIN HYATT FARBER SCHRECK",
    "BROWNSTEIN HYATT FARBER AND SCHRECK": "BROWNSTEIN HYATT FARBER SCHRECK",
    "COVINGTON & BURLING": "COVINGTON & BURLING",
    "SQUIRE PATTON BOGGS": "SQUIRE PATTON BOGGS (US)",
    "HOGAN LOVELLS": "HOGAN LOVELLS US",
    "KING & SPALDING": "KING & SPALDING",
    "INVARIANT": "INVARIANT",
    "ERVIN GRAVES STRATEGY": "ERVIN GRAVES STRATEGY GROUP",
    "FORWARD GLOBAL US": "FORWARD GLOBAL",
    "MONTICELLO GROUP": "MONTICELLO ADVISORY GROUP",
    "FGH HOLDINGS": "FGS GLOBAL (US) LLC (FKA FGH HOLDINGS LLC)",
    "JEFFREY J. KIMBELL AND ASSOCIATES": "JEFFREY J. KIMBELL & ASSOCIATES",
    "SMITH GARSON FKS SMITH DAWSON & ANDREWS": "SMITH GARSON FKA SMITH DAWSON & ANDREWS",
}


def link_entities_to_lda(session) -> dict:
    """
    Match newsletter entities to LDA registrant/client records using 3-tier matching:
    1. Exact normalized name match (strip legal suffixes)
    2. Aggressive normalization (also strip parentheticals, Mr./Mrs., commas)
    3. Alias table lookup

    Also match lobbying_registration/termination relationships to specific filings.
    Returns counts of matches made.
    """
    # Build normalized name -> id lookups for registrants (both tiers)
    reg_by_norm: dict[str, int] = {}
    reg_by_agg: dict[str, int] = {}
    for r in session.query(Registrant).all():
        reg_by_norm[_normalize_org_name(r.name)] = r.id
        reg_by_agg[_normalize_org_aggressive(r.name)] = r.id

    # Build normalized name -> id lookups for clients (both tiers)
    cli_by_norm: dict[str, int] = {}
    cli_by_agg: dict[str, int] = {}
    for c in session.query(Client).all():
        cli_by_norm[_normalize_org_name(c.name)] = c.id
        cli_by_agg[_normalize_org_aggressive(c.name)] = c.id

    def _match_registrant(name: str) -> tuple[int, str] | None:
        """Try 3-tier matching against registrants. Returns (id, method) or None."""
        norm = _normalize_org_name(name)
        if norm in reg_by_norm:
            return (reg_by_norm[norm], "exact")
        agg = _normalize_org_aggressive(name)
        if agg in reg_by_agg:
            return (reg_by_agg[agg], "aggressive")
        alias_target = ENTITY_ALIASES.get(norm) or ENTITY_ALIASES.get(agg)
        if alias_target:
            if alias_target in reg_by_norm:
                return (reg_by_norm[alias_target], "alias")
            if alias_target in reg_by_agg:
                return (reg_by_agg[alias_target], "alias")
        return None

    def _match_client(name: str) -> tuple[int, str] | None:
        """Try 3-tier matching against clients. Returns (id, method) or None."""
        norm = _normalize_org_name(name)
        if norm in cli_by_norm:
            return (cli_by_norm[norm], "exact")
        agg = _normalize_org_aggressive(name)
        if agg in cli_by_agg:
            return (cli_by_agg[agg], "aggressive")
        alias_target = ENTITY_ALIASES.get(norm) or ENTITY_ALIASES.get(agg)
        if alias_target:
            if alias_target in cli_by_norm:
                return (cli_by_norm[alias_target], "alias")
            if alias_target in cli_by_agg:
                return (cli_by_agg[alias_target], "alias")
        return None

    entity_matches = 0

    # Link consultant entities to registrants
    consultants = session.query(Entity).filter(Entity.is_consultant == True).all()
    for ent in consultants:
        match = _match_registrant(ent.name)
        if match:
            rid, method = match
            if ent.registrant_id != rid:
                ent.registrant_id = rid
                ent.lda_match_method = method
                entity_matches += 1

    # Link client entities to clients
    clients = session.query(Entity).filter(Entity.is_client == True).all()
    for ent in clients:
        match = _match_client(ent.name)
        if match:
            cid, method = match
            if ent.client_id != cid:
                ent.client_id = cid
                ent.lda_match_method = method
                entity_matches += 1

    session.flush()

    # Match registration/termination relationships to filings
    filing_matches = 0
    reg_rels = (
        session.query(Relationship)
        .filter(
            Relationship.relationship_type.in_(["lobbying_registration", "lobbying_termination"]),
            Relationship.filing_id == None,
        )
        .all()
    )

    for rel in reg_rels:
        ent_a = session.query(Entity).get(rel.entity_a_id)
        ent_b = session.query(Entity).get(rel.entity_b_id)
        if not ent_a or not ent_b:
            continue

        # Determine which is registrant and which is client
        reg_id = ent_a.registrant_id or ent_b.registrant_id
        cli_id = ent_a.client_id or ent_b.client_id

        if not reg_id or not cli_id:
            continue

        # Query filings for this registrant+client pair
        filing_query = (
            session.query(Filing)
            .filter(Filing.registrant_id == reg_id, Filing.client_id == cli_id)
        )

        if rel.relationship_type == "lobbying_registration":
            filing_query = filing_query.filter(Filing.filing_type == "RR")
        else:
            filing_query = filing_query.filter(Filing.filing_type.in_(["1T", "2T", "3T", "4T"]))

        # Try date-windowed match first (filing posted within 30 days before relationship first_seen)
        matched_filing = None
        if rel.first_seen:
            window_start = rel.first_seen - timedelta(days=30)
            windowed = (
                filing_query
                .filter(Filing.dt_posted >= window_start, Filing.dt_posted <= rel.first_seen)
                .order_by(Filing.dt_posted.desc())
                .first()
            )
            if windowed:
                matched_filing = windowed

        # Fall back to closest filing of the right type
        if not matched_filing:
            matched_filing = filing_query.order_by(Filing.dt_posted.desc()).first()

        if matched_filing:
            rel.filing_id = matched_filing.id
            filing_matches += 1

    session.commit()
    logger.info(f"LDA linking: {entity_matches} entity matches, {filing_matches} filing matches")
    return {"entity_matches": entity_matches, "filing_matches": filing_matches}


def merge_duplicate_entities(session) -> dict:
    """
    Merge entity records that resolve to the same normalized name.

    For each group of duplicates, keeps the entity with the highest mention_count
    as the primary record (the "winner"). All other entities in the group have
    their mentions, relationships, and metadata folded into the winner, then
    are deleted.

    Uses aggressive normalization so "Ballard Partners, LLC" and "Ballard Partners"
    and "Ballard Partners (FKA Foo)" all collapse to the same key.

    Returns counts of merges performed and entities removed.
    """
    all_entities = session.query(Entity).all()

    # Group by aggressive-normalized name
    groups: dict[str, list[Entity]] = {}
    for ent in all_entities:
        key = _normalize_org_aggressive(ent.name)
        if not key:
            continue
        groups.setdefault(key, []).append(ent)

    merged_groups = 0
    entities_removed = 0

    for key, group in groups.items():
        if len(group) < 2:
            continue

        # Pick winner: prefer user_override, then highest mention_count, then lowest id
        group.sort(key=lambda e: (
            -int(e.user_override or False),
            -e.mention_count,
            e.id,
        ))
        winner = group[0]
        losers = group[1:]

        for loser in losers:
            # Merge metadata: accumulate mention counts
            winner.mention_count += loser.mention_count

            # Keep earliest first_seen
            if loser.first_seen:
                if not winner.first_seen or loser.first_seen < winner.first_seen:
                    winner.first_seen = loser.first_seen
            # Keep latest last_seen
            if loser.last_seen:
                if not winner.last_seen or loser.last_seen > winner.last_seen:
                    winner.last_seen = loser.last_seen

            # Merge flags (OR logic)
            if loser.is_consultant:
                winner.is_consultant = True
            if loser.is_client:
                winner.is_client = True
            if loser.is_lobbyist:
                winner.is_lobbyist = True

            # Prefer non-null LDA links
            if loser.registrant_id and not winner.registrant_id:
                winner.registrant_id = loser.registrant_id
                winner.lda_match_method = loser.lda_match_method
            if loser.client_id and not winner.client_id:
                winner.client_id = loser.client_id
                if not winner.lda_match_method:
                    winner.lda_match_method = loser.lda_match_method
            if loser.lobbyist_senate_id and not winner.lobbyist_senate_id:
                winner.lobbyist_senate_id = loser.lobbyist_senate_id

            # Reassign entity mentions from loser to winner
            session.query(EntityMention).filter(
                EntityMention.entity_id == loser.id
            ).update({EntityMention.entity_id: winner.id})

            # Reassign relationships: merge edges
            loser_rels = session.query(Relationship).filter(
                (Relationship.entity_a_id == loser.id) |
                (Relationship.entity_b_id == loser.id)
            ).all()

            for rel in loser_rels:
                # Determine the "other" entity in this relationship
                other_id = rel.entity_b_id if rel.entity_a_id == loser.id else rel.entity_a_id

                # Skip self-loops (loser connected to winner)
                if other_id == winner.id:
                    session.delete(rel)
                    continue

                # Check if winner already has a relationship with this other entity
                a_id = min(winner.id, other_id)
                b_id = max(winner.id, other_id)
                existing = session.query(Relationship).filter(
                    Relationship.entity_a_id == a_id,
                    Relationship.entity_b_id == b_id,
                ).first()

                if existing:
                    # Merge into existing: sum weights, widen date range
                    existing.weight += rel.weight
                    if rel.first_seen:
                        if not existing.first_seen or rel.first_seen < existing.first_seen:
                            existing.first_seen = rel.first_seen
                    if rel.last_seen:
                        if not existing.last_seen or rel.last_seen > existing.last_seen:
                            existing.last_seen = rel.last_seen
                    # Merge context snippets
                    try:
                        existing_snips = json.loads(existing.context_snippets or "[]")
                    except (json.JSONDecodeError, TypeError):
                        existing_snips = []
                    try:
                        loser_snips = json.loads(rel.context_snippets or "[]")
                    except (json.JSONDecodeError, TypeError):
                        loser_snips = []
                    combined = existing_snips + [s for s in loser_snips if s not in existing_snips]
                    existing.context_snippets = json.dumps(combined[-10:])
                    # Prefer non-null filing_id
                    if rel.filing_id and not existing.filing_id:
                        existing.filing_id = rel.filing_id
                    # Upgrade match confidence
                    if rel.match_confidence == "high":
                        existing.match_confidence = "high"
                    # Keep more specific relationship_type
                    if existing.relationship_type == "co_mention" and rel.relationship_type != "co_mention":
                        existing.relationship_type = rel.relationship_type
                    session.delete(rel)
                else:
                    # Reassign the relationship to point to winner
                    if rel.entity_a_id == loser.id:
                        rel.entity_a_id = winner.id
                    else:
                        rel.entity_b_id = winner.id
                    # Ensure a_id < b_id ordering
                    if rel.entity_a_id > rel.entity_b_id:
                        rel.entity_a_id, rel.entity_b_id = rel.entity_b_id, rel.entity_a_id

            # Delete the loser entity
            session.delete(loser)
            entities_removed += 1

        merged_groups += 1

    session.commit()
    logger.info(f"Entity merge: {merged_groups} groups merged, {entities_removed} entities removed")
    return {"merged_groups": merged_groups, "entities_removed": entities_removed}


def _title_case_name(name: str) -> str:
    """Convert ALL CAPS name to Title Case, handling suffixes like Jr., III."""
    parts = name.strip().split()
    result = []
    no_capitalize = {"II", "III", "IV", "JR.", "SR.", "JR", "SR"}
    for p in parts:
        if p.upper() in no_capitalize:
            result.append(p.upper() if p.upper() in {"II", "III", "IV"} else p.capitalize())
        else:
            result.append(p.capitalize())
    return " ".join(result)


def link_lobbyists_to_entities(session) -> dict:
    """
    Extract individual lobbyists from LDA filing data and create/match
    entity records + affiliation edges to their registrant firms.

    Match confidence:
    - "high": lobbyist name already exists as an entity connected to the firm via Politico Influence
    - "low": lobbyist name exists as an entity but not connected to this firm, or is newly created

    Returns counts of new entities created, matches made, and edges created.
    """
    # Build registrant_id -> Entity lookup (firms that have entity records)
    firm_entities: dict[int, Entity] = {}
    for ent in session.query(Entity).filter(Entity.registrant_id != None).all():
        firm_entities[ent.registrant_id] = ent

    # Build lowercase name -> Entity lookup for existing entities
    existing_by_name: dict[str, Entity] = {}
    for ent in session.query(Entity).all():
        existing_by_name[ent.name.lower()] = ent

    # Track existing affiliation pairs (entity_a_id, entity_b_id) for confidence check
    existing_affiliations: set[tuple[int, int]] = set()
    for rel in session.query(Relationship).filter(
        Relationship.relationship_type == "affiliation"
    ).all():
        existing_affiliations.add((rel.entity_a_id, rel.entity_b_id))

    # Parse all lobbyists from all filing activities
    activities = (
        session.query(LobbyingActivity)
        .filter(LobbyingActivity.lobbyists != None)
        .all()
    )

    new_entities = 0
    matched_entities = 0
    edges_created = 0
    edges_updated = 0

    # Collect unique lobbyist records per registrant
    # Key: (registrant_id, lobbyist_name_lower) -> lobbyist info
    seen: set[tuple[int, str]] = set()

    for activity in activities:
        filing = session.query(Filing).get(activity.filing_id)
        if not filing or not filing.registrant_id:
            continue

        firm_entity = firm_entities.get(filing.registrant_id)
        if not firm_entity:
            continue

        try:
            lobbyists_data = json.loads(activity.lobbyists)
        except (json.JSONDecodeError, TypeError):
            continue

        if not isinstance(lobbyists_data, list):
            continue

        for lob_record in lobbyists_data:
            lob = lob_record.get("lobbyist", {}) if isinstance(lob_record, dict) else {}
            first_name = (lob.get("first_name") or "").strip()
            last_name = (lob.get("last_name") or "").strip()
            if not first_name or not last_name:
                continue

            senate_id = lob.get("id")
            covered_position = (lob_record.get("covered_position") or "").strip() if isinstance(lob_record, dict) else ""

            # Build name: title case from ALL CAPS
            full_name_display = f"{_title_case_name(first_name)} {_title_case_name(last_name)}"
            full_name_lower = f"{first_name} {last_name}".lower()

            # Deduplicate per registrant
            dedup_key = (filing.registrant_id, full_name_lower)
            if dedup_key in seen:
                continue
            seen.add(dedup_key)

            # Try to match to existing entity (lowercase match)
            existing_ent = existing_by_name.get(full_name_lower)
            # Also try title case match
            if not existing_ent:
                existing_ent = existing_by_name.get(full_name_display.lower())

            confidence = "low"

            if existing_ent:
                # Check if there's already an affiliation/edge to this firm
                pair = (min(existing_ent.id, firm_entity.id), max(existing_ent.id, firm_entity.id))
                if pair in existing_affiliations:
                    confidence = "high"
                matched_entities += 1

                # Update flags
                existing_ent.is_lobbyist = True
                if senate_id:
                    existing_ent.lobbyist_senate_id = senate_id
                if not existing_ent.user_override:
                    existing_ent.entity_type = "person"

                lobbyist_entity = existing_ent
            else:
                # Create new entity with title-cased name
                lobbyist_entity = Entity(
                    name=full_name_display,
                    entity_type="person",
                    is_lobbyist=True,
                    lobbyist_senate_id=senate_id,
                    display_name=full_name_display,
                    mention_count=0,
                    user_override=False,
                )
                session.add(lobbyist_entity)
                session.flush()
                new_entities += 1
                # Add to lookup for future iterations
                existing_by_name[full_name_display.lower()] = lobbyist_entity

            # Create/update affiliation edge (weight=2 for formal employer relationship)
            a_id = min(lobbyist_entity.id, firm_entity.id)
            b_id = max(lobbyist_entity.id, firm_entity.id)

            rel = (
                session.query(Relationship)
                .filter(
                    Relationship.entity_a_id == a_id,
                    Relationship.entity_b_id == b_id,
                )
                .first()
            )

            ctx = f"Registered lobbyist at {firm_entity.display_name or firm_entity.name}"
            if covered_position:
                ctx += f" — Covered position: {covered_position}"

            if not rel:
                rel = Relationship(
                    entity_a_id=a_id,
                    entity_b_id=b_id,
                    relationship_type="affiliation",
                    weight=2,
                    first_seen=filing.dt_posted,
                    last_seen=filing.dt_posted,
                    context_snippets=json.dumps([ctx[:500]]),
                    match_confidence=confidence,
                )
                session.add(rel)
                edges_created += 1
                existing_affiliations.add((a_id, b_id))
            else:
                # Update existing edge
                if rel.weight < 2:
                    rel.weight = 2
                if filing.dt_posted:
                    if not rel.first_seen or filing.dt_posted < rel.first_seen:
                        rel.first_seen = filing.dt_posted
                    if not rel.last_seen or filing.dt_posted > rel.last_seen:
                        rel.last_seen = filing.dt_posted
                # Upgrade confidence if we now have a high-confidence match
                if confidence == "high" and rel.match_confidence != "high":
                    rel.match_confidence = "high"
                elif not rel.match_confidence:
                    rel.match_confidence = confidence
                # Append covered position context
                if covered_position:
                    try:
                        snippets = json.loads(rel.context_snippets or "[]")
                    except (json.JSONDecodeError, TypeError):
                        snippets = []
                    if ctx[:500] not in snippets:
                        snippets.append(ctx[:500])
                        rel.context_snippets = json.dumps(snippets[-10:])
                edges_updated += 1

    session.commit()
    logger.info(
        f"Lobbyist linking: {new_entities} new entities, {matched_entities} matched, "
        f"{edges_created} edges created, {edges_updated} edges updated"
    )
    return {
        "new_entities": new_entities,
        "matched_entities": matched_entities,
        "edges_created": edges_created,
        "edges_updated": edges_updated,
    }


_scrape_progress: dict = {}
_reprocess_progress: dict = {}


def get_scrape_progress() -> dict:
    return dict(_scrape_progress)


def get_reprocess_progress() -> dict:
    return dict(_reprocess_progress)


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

        # Merge duplicates, then link to LDA records
        merge_result = merge_duplicate_entities(session)
        link_result = link_entities_to_lda(session)
        lobbyist_result = link_lobbyists_to_entities(session)

        _scrape_progress = {}
        return {
            "stored": stored,
            "skipped": skipped,
            "errors": errors,
            "total_urls": len(urls),
            "merge": merge_result,
            "lda_links": link_result,
            "lobbyist_links": lobbyist_result,
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
    global _reprocess_progress
    engine = init_db(db_url)
    session = get_session(engine)

    try:
        _reprocess_progress = {"status": "running", "processed": 0, "total": 0}

        session.query(EntityMention).delete()
        session.query(Relationship).delete()
        session.execute(Entity.__table__.update().values(mention_count=0, is_consultant=False, is_client=False))
        session.query(Newsletter).update({Newsletter.entities_extracted: False})
        session.commit()

        logger.info("Cleared mentions, relationships, reset mention counts and roles. Entities preserved.")

        newsletters = (
            session.query(Newsletter)
            .order_by(Newsletter.published_date)
            .all()
        )

        total = len(newsletters)
        _reprocess_progress = {"status": "running", "processed": 0, "total": total}

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
            _reprocess_progress = {"status": "running", "processed": processed, "total": total}
            if processed % 10 == 0:
                logger.info(f"Reprocessed {processed}/{total} newsletters")

        orphans = session.query(Entity).filter(Entity.mention_count == 0).count()
        if orphans:
            session.query(Entity).filter(Entity.mention_count == 0).delete()
            session.commit()
            logger.info(f"Cleaned up {orphans} orphaned entities with no mentions")

        # Merge duplicates, then link to LDA records
        merge_result = merge_duplicate_entities(session)
        link_result = link_entities_to_lda(session)
        lobbyist_result = link_lobbyists_to_entities(session)

        logger.info(f"Reprocess complete: {processed} newsletters")
        _reprocess_progress = {"status": "done", "processed": processed, "total": total}
        return {"processed": processed, "orphans_removed": orphans, "merge": merge_result, "lda_links": link_result, "lobbyist_links": lobbyist_result}
    except Exception as e:
        _reprocess_progress = {"status": "error", "error": str(e)}
        session.rollback()
        raise
    finally:
        session.close()
