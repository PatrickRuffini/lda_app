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


def discover_newsletter_urls(page, max_pages: int = 5) -> list[str]:
    """
    Discover newsletter edition URLs from the listing page using the browser.
    """
    urls = []

    html = _fetch_with_browser(page, NEWSLETTER_LIST_URL, wait_ms=5000)
    if not html:
        return urls

    link_matches = re.findall(
        r'/newsletters/politico-influence/\d{4}/\d{2}/\d{2}/[^"<>\s]+',
        html,
    )
    for href in link_matches:
        full_url = urljoin(BASE_URL, href)
        if full_url not in urls:
            urls.append(full_url)

    logger.info(f"Discovered {len(urls)} newsletter URLs from listing page")

    if max_pages > 1:
        soup = BeautifulSoup(html, "lxml")
        for page_num in range(1, max_pages):
            next_link = soup.find("a", {"class": re.compile(r"next|load-more|pagination", re.I)})
            if not next_link or not next_link.get("href"):
                break

            next_url = urljoin(BASE_URL, next_link["href"])
            html = _fetch_with_browser(page, next_url, wait_ms=3000)
            if not html:
                break

            more_links = re.findall(
                r'/newsletters/politico-influence/\d{4}/\d{2}/\d{2}/[^"<>\s]+',
                html,
            )
            for href in more_links:
                full_url = urljoin(BASE_URL, href)
                if full_url not in urls:
                    urls.append(full_url)

            soup = BeautifulSoup(html, "lxml")
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
    body_text = body.get_text(separator="\n", strip=True)

    return {
        "url": url,
        "title": title,
        "published_date": published_date,
        "body_text": body_text,
        "body_html": body_html,
    }


def extract_bold_entities_from_html(body_html: str) -> list[dict]:
    """
    Extract bold entities from newsletter HTML.

    Returns a list of dicts with keys:
    - name: the entity name
    - paragraph_index: which paragraph it appeared in
    - context: the paragraph text
    """
    soup = BeautifulSoup(body_html, "lxml")
    entities = []

    paragraphs = soup.find_all(["p", "li"])

    for para_idx, para in enumerate(paragraphs):
        para_text = para.get_text(separator=" ", strip=True)
        if not para_text or len(para_text) < 10:
            continue

        bold_tags = para.find_all(["strong", "b"])
        for bold_tag in bold_tags:
            name = bold_tag.get_text(strip=True)
            if not name or len(name) < 2:
                continue

            skip_patterns = [
                r"^(Read|More|Click|Subscribe|Sign up|Good|POLITICO|Influence|Happy|NEW|HAPPENING|ICYMI|SPOTTED|FIRST IN)",
                r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)",
                r"^(January|February|March|April|May|June|July|August|September|October|November|December)",
                r"^(Q[1-4]|FY\d|H[1-2])",
                r"^\d+$",
                r"^https?://",
            ]
            if any(re.match(pat, name, re.I) for pat in skip_patterns):
                continue

            if len(name) > 100:
                continue

            entities.append({
                "name": name,
                "paragraph_index": para_idx,
                "context": para_text[:500],
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
    """Get or create an entity by name and type."""
    entity = (
        session.query(Entity)
        .filter(Entity.name == name, Entity.entity_type == entity_type)
        .first()
    )
    if not entity:
        entity = Entity(
            name=name,
            entity_type=entity_type,
            display_name=display_name or name,
            first_seen=date,
            last_seen=date,
            mention_count=0,
        )
        session.add(entity)
        session.flush()
    else:
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
    """
    if not newsletter.body_html:
        return

    bold_entities = extract_bold_entities_from_html(newsletter.body_html)

    para_groups: dict[int, list[dict]] = {}
    for ent in bold_entities:
        para_idx = ent["paragraph_index"]
        if para_idx not in para_groups:
            para_groups[para_idx] = []
        para_groups[para_idx].append(ent)

    pub_date = newsletter.published_date

    for para_idx, para_entities in para_groups.items():
        context = para_entities[0]["context"] if para_entities else ""

        affiliations = detect_affiliations(para_entities, context)
        affiliated_persons = set()

        for aff in affiliations:
            person_entity = _get_or_create_entity(
                session, aff["person"], "person",
                display_name=f"{aff['person']} ({aff['company']})",
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
            ))
            session.add(EntityMention(
                entity_id=company_entity.id,
                newsletter_id=newsletter.id,
                paragraph_index=para_idx,
                context_text=context[:500],
            ))

            affiliated_persons.add(aff["person"])

        para_entity_objs = []
        for ent in para_entities:
            if ent["name"] in affiliated_persons:
                continue

            entity_obj = _get_or_create_entity(
                session, ent["name"], "unknown", date=pub_date,
            )
            entity_obj.mention_count += 1
            para_entity_objs.append(entity_obj)

            session.add(EntityMention(
                entity_id=entity_obj.id,
                newsletter_id=newsletter.id,
                paragraph_index=para_idx,
                context_text=context[:500],
            ))

        all_entities_in_para = para_entity_objs.copy()
        for aff in affiliations:
            person_ent = (
                session.query(Entity)
                .filter(Entity.name == aff["person"], Entity.entity_type == "person")
                .first()
            )
            company_ent = (
                session.query(Entity)
                .filter(Entity.name == aff["company"], Entity.entity_type == "organization")
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

    newsletter.entities_extracted = True


def scrape_and_store(
    max_newsletters: int = 50,
    max_discovery_pages: int = 5,
    db_url: str = None,
) -> dict:
    """
    Main entry point: discover, scrape, extract, and store newsletters.
    Uses a headless browser to bypass Cloudflare.
    """
    engine = init_db(db_url)
    session = get_session(engine)

    pw = None
    browser = None

    try:
        pw, browser, page = _get_browser_page()

        logger.info("Discovering newsletter URLs...")
        urls = discover_newsletter_urls(page, max_pages=max_discovery_pages)
        logger.info(f"Found {len(urls)} newsletter URLs")

        stored = 0
        skipped = 0
        errors = 0

        for url in urls[:max_newsletters]:
            existing = session.query(Newsletter).filter_by(url=url).first()
            if existing:
                skipped += 1
                continue

            logger.info(f"Scraping: {url}")
            data = scrape_newsletter(page, url)
            if not data:
                errors += 1
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
            time.sleep(2)

        return {
            "stored": stored,
            "skipped": skipped,
            "errors": errors,
            "total_urls": len(urls),
        }

    except Exception as e:
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


def reprocess_entities(db_url: str = None) -> dict:
    """
    Re-extract entities from all newsletters that haven't been processed yet.
    """
    engine = init_db(db_url)
    session = get_session(engine)

    try:
        newsletters = (
            session.query(Newsletter)
            .filter(Newsletter.entities_extracted == False)
            .order_by(Newsletter.published_date)
            .all()
        )

        processed = 0
        for nl in newsletters:
            process_newsletter_entities(session, nl)
            session.commit()
            processed += 1

        return {"processed": processed}
    except Exception as e:
        session.rollback()
        raise
    finally:
        session.close()
