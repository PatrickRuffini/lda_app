"""Ad scraper for political news sites.

Captures banner/display ads from Politico, Axios, and Punchbowl News
using Playwright headless Chromium. Extracts ad screenshots, destination
URLs, and text content for tracking advocacy ad campaigns.
"""
import base64
import json
import logging
import re
import time
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy import func

from .models import AdCapture, AdCampaign, get_engine, get_session, init_db

logger = logging.getLogger(__name__)

# Site configurations: CSS selectors for ad containers
SITE_CONFIGS = {
    "politico": {
        "urls": [
            "https://www.politico.com/",
            "https://www.politico.com/news/congress",
            "https://www.politico.com/news/white-house",
        ],
        "ad_selectors": [
            'div[id*="ad-"]',
            'div[class*="ad-"]',
            'div[data-ad-slot]',
            'div[id*="google_ads"]',
            'iframe[id*="google_ads"]',
            'div[class*="dfp"]',
            'div[id*="gpt-ad"]',
        ],
    },
    "axios": {
        "urls": [
            "https://www.axios.com/",
            "https://www.axios.com/politics",
        ],
        "ad_selectors": [
            'div[id*="ad-"]',
            'div[class*="ad-"]',
            'div[data-ad-slot]',
            'div[id*="google_ads"]',
            'iframe[id*="google_ads"]',
            'div[id*="gpt-ad"]',
        ],
    },
    "punchbowl": {
        "urls": [
            "https://punchbowl.news/",
        ],
        "ad_selectors": [
            'div[id*="ad-"]',
            'div[class*="ad-"]',
            'div[data-ad-slot]',
            'div[id*="google_ads"]',
            'iframe[id*="google_ads"]',
            'div[id*="gpt-ad"]',
        ],
    },
}

# Known advocacy domains to help identify advertisers
KNOWN_ADVOCACY_DOMAINS = {
    "phrma.org": "PhRMA",
    "api.org": "American Petroleum Institute",
    "uschamber.com": "U.S. Chamber of Commerce",
    "nam.org": "National Association of Manufacturers",
    "aha.org": "American Hospital Association",
    "ahip.org": "AHIP",
    "nrf.com": "National Retail Federation",
    "facebook.com": "Meta",
    "google.com": "Google",
    "amazon.com": "Amazon",
    "apple.com": "Apple",
    "microsoft.com": "Microsoft",
    "qualcomm.com": "Qualcomm",
    "boeing.com": "Boeing",
    "lockheedmartin.com": "Lockheed Martin",
    "raytheon.com": "RTX (Raytheon)",
    "northropgrumman.com": "Northrop Grumman",
    "generaldynamics.com": "General Dynamics",
}

_scrape_progress = {"status": "idle"}


def get_ad_scrape_progress():
    return dict(_scrape_progress)


def _get_browser_page():
    """Launch a headless Chromium browser and return (playwright, browser, page)."""
    import os
    from playwright.sync_api import sync_playwright
    from .influence import CHROMIUM_PATH, GBM_LIB_DIR

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


def _extract_domain(url: str) -> Optional[str]:
    """Extract the root domain from a URL."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        # Strip www prefix
        if domain.startswith("www."):
            domain = domain[4:]
        return domain or None
    except Exception:
        return None


def _classify_ad_slot(element_id: str, element_classes: str, bbox: dict) -> str:
    """Classify an ad slot based on its attributes and size."""
    combined = f"{element_id} {element_classes}".lower()

    if any(kw in combined for kw in ["leaderboard", "top", "header", "banner"]):
        return "leaderboard"
    if any(kw in combined for kw in ["sidebar", "rail", "right"]):
        return "sidebar"
    if any(kw in combined for kw in ["mid", "inline", "article", "body"]):
        return "mid-article"
    if any(kw in combined for kw in ["footer", "bottom"]):
        return "footer"
    if any(kw in combined for kw in ["sticky", "adhesion"]):
        return "sticky"

    # Classify by dimensions
    w = bbox.get("width", 0)
    h = bbox.get("height", 0)
    if w > 600 and h < 200:
        return "leaderboard"
    if w < 400 and h > 200:
        return "sidebar"
    return "unknown"


def _capture_ads_on_page(browser_page, page_url: str, site: str, selectors: list[str]) -> list[dict]:
    """Navigate to a page and capture all visible ads."""
    captures = []

    try:
        browser_page.goto(page_url, timeout=30000, wait_until="domcontentloaded")
        # Wait for ads to load
        browser_page.wait_for_timeout(5000)

        # Scroll down to trigger lazy-loaded ads
        browser_page.evaluate("window.scrollTo(0, document.body.scrollHeight / 3)")
        browser_page.wait_for_timeout(2000)
        browser_page.evaluate("window.scrollTo(0, (document.body.scrollHeight * 2) / 3)")
        browser_page.wait_for_timeout(2000)
        browser_page.evaluate("window.scrollTo(0, 0)")
        browser_page.wait_for_timeout(1000)

    except Exception as e:
        logger.error(f"Failed to load {page_url}: {e}")
        return captures

    for selector in selectors:
        try:
            elements = browser_page.query_selector_all(selector)
            for el in elements:
                try:
                    bbox = el.bounding_box()
                    if not bbox or bbox["width"] < 50 or bbox["height"] < 20:
                        continue  # Skip invisible/tiny elements

                    # Try to get screenshot
                    screenshot_bytes = None
                    try:
                        screenshot_bytes = el.screenshot(timeout=5000)
                    except Exception:
                        pass

                    # Try to extract destination URL from links inside the ad
                    dest_url = None
                    ad_text = ""
                    try:
                        # Check for links in the ad
                        link = el.query_selector("a[href]")
                        if link:
                            dest_url = link.get_attribute("href")
                        # Also check iframes
                        if not dest_url:
                            iframe = el.query_selector("iframe")
                            if iframe:
                                dest_url = iframe.get_attribute("src")
                        # Extract visible text
                        ad_text = el.inner_text() or ""
                        ad_text = ad_text.strip()[:2000]  # Cap text length
                    except Exception:
                        pass

                    # Skip tracking pixels and empty ads
                    if not screenshot_bytes and not dest_url and not ad_text:
                        continue

                    el_id = el.get_attribute("id") or ""
                    el_class = el.get_attribute("class") or ""
                    slot = _classify_ad_slot(el_id, el_class, bbox)

                    capture = {
                        "site": site,
                        "page_url": page_url,
                        "ad_slot": slot,
                        "destination_url": dest_url,
                        "destination_domain": _extract_domain(dest_url),
                        "ad_text": ad_text if ad_text else None,
                        "screenshot_base64": base64.b64encode(screenshot_bytes).decode() if screenshot_bytes else None,
                        "width": int(bbox["width"]),
                        "height": int(bbox["height"]),
                    }
                    captures.append(capture)

                except Exception as e:
                    logger.debug(f"Error processing ad element: {e}")
                    continue

        except Exception as e:
            logger.debug(f"Error with selector {selector}: {e}")
            continue

    return captures


def _find_or_create_campaign(session, domain: str, advertiser_name: str, site: str) -> Optional[int]:
    """Find an existing campaign by domain or create a new one."""
    if not domain:
        return None

    campaign = session.query(AdCampaign).filter(
        AdCampaign.advertiser_domain == domain
    ).first()

    if campaign:
        campaign.last_seen = datetime.utcnow()
        campaign.capture_count = (campaign.capture_count or 0) + 1
        # Update sites_seen_on
        sites = json.loads(campaign.sites_seen_on) if campaign.sites_seen_on else []
        if site not in sites:
            sites.append(site)
            campaign.sites_seen_on = json.dumps(sites)
        return campaign.id

    campaign = AdCampaign(
        advertiser_name=advertiser_name,
        advertiser_domain=domain,
        first_seen=datetime.utcnow(),
        last_seen=datetime.utcnow(),
        capture_count=1,
        sites_seen_on=json.dumps([site]),
    )
    session.add(campaign)
    session.flush()
    return campaign.id


def scrape_ads(sites: Optional[list[str]] = None, max_pages_per_site: int = 3):
    """Scrape ads from configured political news sites.

    Args:
        sites: List of site keys to scrape. Defaults to all configured sites.
        max_pages_per_site: Maximum number of pages to visit per site.
    """
    global _scrape_progress

    if _scrape_progress.get("status") == "running":
        logger.warning("Ad scrape already in progress")
        return

    _scrape_progress = {"status": "running", "captured": 0, "errors": 0, "sites_completed": []}

    target_sites = sites or list(SITE_CONFIGS.keys())
    engine = init_db()
    session = get_session(engine)
    pw = None
    browser = None

    try:
        pw, browser, page = _get_browser_page()

        for site_key in target_sites:
            if site_key not in SITE_CONFIGS:
                logger.warning(f"Unknown site: {site_key}")
                continue

            config = SITE_CONFIGS[site_key]
            urls = config["urls"][:max_pages_per_site]
            selectors = config["ad_selectors"]

            logger.info(f"Scraping ads from {site_key} ({len(urls)} pages)...")

            for page_url in urls:
                try:
                    captures = _capture_ads_on_page(page, page_url, site_key, selectors)
                    logger.info(f"  {page_url}: found {len(captures)} ads")

                    for cap_data in captures:
                        domain = cap_data.get("destination_domain")
                        advertiser = KNOWN_ADVOCACY_DOMAINS.get(domain, domain or "Unknown")

                        campaign_id = _find_or_create_campaign(
                            session, domain, advertiser, site_key
                        ) if domain else None

                        capture = AdCapture(
                            site=cap_data["site"],
                            page_url=cap_data["page_url"],
                            ad_slot=cap_data["ad_slot"],
                            destination_url=cap_data.get("destination_url"),
                            destination_domain=domain,
                            ad_text=cap_data.get("ad_text"),
                            screenshot_base64=cap_data.get("screenshot_base64"),
                            width=cap_data.get("width"),
                            height=cap_data.get("height"),
                            captured_at=datetime.utcnow(),
                            campaign_id=campaign_id,
                        )
                        session.add(capture)
                        _scrape_progress["captured"] = _scrape_progress.get("captured", 0) + 1

                    session.commit()

                except Exception as e:
                    logger.error(f"Error scraping {page_url}: {e}")
                    session.rollback()
                    _scrape_progress["errors"] = _scrape_progress.get("errors", 0) + 1

                # Polite delay between pages
                time.sleep(2)

            _scrape_progress["sites_completed"].append(site_key)

        _scrape_progress["status"] = "done"
        logger.info(f"Ad scrape complete: {_scrape_progress['captured']} ads captured")

    except Exception as e:
        logger.error(f"Ad scrape failed: {e}")
        _scrape_progress["status"] = "error"
        _scrape_progress["error"] = str(e)
    finally:
        session.close()
        if browser:
            browser.close()
        if pw:
            pw.stop()
