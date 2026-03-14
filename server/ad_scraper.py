"""Ad scraper for political news sites.

Captures banner/display ads from Politico, Axios, and Punchbowl News
using Playwright headless Chromium. Uses three strategies:
  1. Network request interception — captures ad server URLs (doubleclick,
     googlesyndication, Amazon AAX, etc.) as the page loads
  2. Iframe scanning — screenshots all visible ad iframes
  3. DOM selector scanning — finds ad containers by common patterns

Extracts ad screenshots, destination URLs, and text content for tracking
advocacy ad campaigns.
"""
import base64
import json
import logging
import re
import time
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse, parse_qs, unquote

from sqlalchemy import func

from .models import AdCapture, AdCampaign, get_engine, get_session, init_db

logger = logging.getLogger(__name__)

# Site configurations
SITE_CONFIGS = {
    "politico": {
        "urls": [
            "https://www.politico.com/",
            "https://www.politico.com/news/congress",
            "https://www.politico.com/news/white-house",
        ],
    },
    "axios": {
        "urls": [
            "https://www.axios.com/",
            "https://www.axios.com/politics",
        ],
    },
    "punchbowl": {
        "urls": [
            "https://punchbowl.news/",
        ],
    },
}

# Ad network URL patterns — if a network request matches, it's ad-related
AD_NETWORK_PATTERNS = [
    r"doubleclick\.net",
    r"googlesyndication\.com",
    r"googleadservices\.com",
    r"googletagservices\.com",
    r"google\.com/pagead",
    r"googleads\.g\.doubleclick",
    r"aax\.amazon-adsystem\.com",
    r"amazon-adsystem\.com",
    r"adsrvr\.org",
    r"adnxs\.com",
    r"criteo\.(com|net)",
    r"taboola\.com",
    r"outbrain\.com",
    r"pubmatic\.com",
    r"rubiconproject\.com",
    r"openx\.net",
    r"casalemedia\.com",
    r"indexexchange\.com",
    r"33across\.com",
    r"sharethrough\.com",
    r"moatads\.com",
    r"serving-sys\.com",
    r"2mdn\.net",
    r"snigelweb\.com",
    r"connatix\.com",
]
_ad_network_re = re.compile("|".join(AD_NETWORK_PATTERNS), re.IGNORECASE)

# Patterns to extract click-through/landing page URLs from ad request params
_CLICKTHROUGH_PARAMS = ["adurl", "r", "clickthrough", "click", "dest", "redirect", "landing", "url", "ct"]

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
    "meta.com": "Meta",
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
    "exxonmobil.com": "ExxonMobil",
    "chevron.com": "Chevron",
    "att.com": "AT&T",
    "verizon.com": "Verizon",
    "comcast.com": "Comcast",
    "t-mobile.com": "T-Mobile",
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
        if domain.startswith("www."):
            domain = domain[4:]
        return domain or None
    except Exception:
        return None


def _extract_clickthrough_from_ad_url(ad_url: str) -> Optional[str]:
    """Try to extract the advertiser's landing page URL from an ad network request URL."""
    try:
        parsed = urlparse(ad_url)
        params = parse_qs(parsed.query)
        for key in _CLICKTHROUGH_PARAMS:
            vals = params.get(key, [])
            if vals:
                candidate = unquote(vals[0])
                if candidate.startswith("http"):
                    return candidate
        # Also check the URL path for encoded URLs (common in doubleclick)
        path = unquote(parsed.path)
        url_match = re.search(r'(https?://[^\s&;]+)', path)
        if url_match:
            candidate = url_match.group(1)
            # Filter out ad network domains themselves
            cand_domain = _extract_domain(candidate)
            if cand_domain and not _ad_network_re.search(candidate):
                return candidate
    except Exception:
        pass
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
    if w >= 600 and h <= 200:
        return "leaderboard"
    if w <= 400 and h >= 200:
        return "sidebar"
    if w >= 250 and h >= 200:
        return "rectangle"
    return "unknown"


def _is_ad_iframe(src: str) -> bool:
    """Check if an iframe src looks like it comes from an ad network."""
    if not src:
        return False
    return bool(_ad_network_re.search(src))


def _capture_ads_on_page(browser_page, page_url: str, site: str) -> list[dict]:
    """Navigate to a page and capture all visible ads using multiple strategies."""
    captures = []
    ad_network_urls = []
    seen_destinations = set()  # deduplicate ads by destination domain

    # Strategy 1: Intercept network requests to ad servers
    def _on_request(request):
        url = request.url
        if _ad_network_re.search(url):
            ad_network_urls.append(url)

    browser_page.on("request", _on_request)

    try:
        logger.info(f"  Loading {page_url}...")
        browser_page.goto(page_url, timeout=30000, wait_until="domcontentloaded")
        # Wait for ads to load — they're async and take time
        browser_page.wait_for_timeout(6000)

        # Check for Cloudflare challenge
        title = browser_page.title()
        if "just a moment" in title.lower():
            logger.warning(f"  Cloudflare challenge on {page_url}, waiting...")
            browser_page.wait_for_timeout(10000)
            title = browser_page.title()
            if "just a moment" in title.lower():
                logger.error(f"  Could not bypass Cloudflare for {page_url}")
                return captures

        # Scroll to trigger lazy-loaded ads
        browser_page.evaluate("window.scrollTo(0, document.body.scrollHeight / 4)")
        browser_page.wait_for_timeout(2000)
        browser_page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
        browser_page.wait_for_timeout(2000)
        browser_page.evaluate("window.scrollTo(0, (document.body.scrollHeight * 3) / 4)")
        browser_page.wait_for_timeout(2000)
        browser_page.evaluate("window.scrollTo(0, 0)")
        browser_page.wait_for_timeout(1000)

    except Exception as e:
        logger.error(f"  Failed to load {page_url}: {e}")
        return captures
    finally:
        try:
            browser_page.remove_listener("request", _on_request)
        except Exception:
            pass

    logger.info(f"  Intercepted {len(ad_network_urls)} ad network requests")

    # Extract clickthrough URLs from intercepted ad requests
    clickthrough_urls = {}
    for ad_url in ad_network_urls:
        ct = _extract_clickthrough_from_ad_url(ad_url)
        if ct:
            ct_domain = _extract_domain(ct)
            if ct_domain:
                clickthrough_urls[ct_domain] = ct

    if clickthrough_urls:
        logger.info(f"  Found {len(clickthrough_urls)} unique advertiser destinations from network requests")

    # Strategy 2: Find all iframes on the page and check if they're ads
    try:
        all_iframes = browser_page.query_selector_all("iframe")
        logger.info(f"  Found {len(all_iframes)} total iframes on page")

        for iframe in all_iframes:
            try:
                src = iframe.get_attribute("src") or ""
                iframe_id = iframe.get_attribute("id") or ""
                iframe_name = iframe.get_attribute("name") or ""
                iframe_class = iframe.get_attribute("class") or ""

                # Check if this iframe is ad-related
                is_ad = _is_ad_iframe(src)
                # Also check ID/name patterns
                combined_attrs = f"{iframe_id} {iframe_name} {iframe_class}".lower()
                if any(kw in combined_attrs for kw in ["google_ads", "ad_iframe", "ad-", "gpt-ad", "dfp", "advertisement"]):
                    is_ad = True
                # Check if parent div is ad-related
                if not is_ad:
                    try:
                        parent_id = browser_page.evaluate(
                            "(el) => { const p = el.parentElement; return p ? (p.id || '') + ' ' + (p.className || '') : ''; }",
                            iframe
                        )
                        if any(kw in parent_id.lower() for kw in ["ad-", "ad_", "advertisement", "gpt-ad", "dfp"]):
                            is_ad = True
                    except Exception:
                        pass

                if not is_ad:
                    continue

                bbox = iframe.bounding_box()
                if not bbox or bbox["width"] < 60 or bbox["height"] < 20:
                    continue  # Skip invisible/tiny

                # Take screenshot of the ad iframe
                screenshot_bytes = None
                try:
                    screenshot_bytes = iframe.screenshot(timeout=5000)
                except Exception:
                    pass

                # Try to find the destination URL
                dest_url = None
                dest_domain = None

                # Extract from iframe src
                ct = _extract_clickthrough_from_ad_url(src)
                if ct:
                    dest_url = ct
                    dest_domain = _extract_domain(ct)

                # If no clickthrough found in iframe src, check if any of the
                # intercepted ad network clickthroughs match
                if not dest_url and clickthrough_urls:
                    # Use the first available clickthrough as a fallback
                    for domain, url in clickthrough_urls.items():
                        dest_url = url
                        dest_domain = domain
                        break

                # Deduplicate by destination domain (skip if we've already captured this advertiser on this page)
                dedup_key = dest_domain or f"no-domain-{iframe_id}-{len(captures)}"
                if dedup_key in seen_destinations and dest_domain:
                    continue
                seen_destinations.add(dedup_key)

                slot = _classify_ad_slot(iframe_id or iframe_name, iframe_class, bbox)

                capture = {
                    "site": site,
                    "page_url": page_url,
                    "ad_slot": slot,
                    "destination_url": dest_url,
                    "destination_domain": dest_domain,
                    "ad_text": None,
                    "screenshot_base64": base64.b64encode(screenshot_bytes).decode() if screenshot_bytes else None,
                    "width": int(bbox["width"]),
                    "height": int(bbox["height"]),
                }
                captures.append(capture)

            except Exception as e:
                logger.debug(f"  Error processing iframe: {e}")
                continue

    except Exception as e:
        logger.warning(f"  Error scanning iframes: {e}")

    # Strategy 3: Look for common ad container divs
    ad_container_selectors = [
        'div[id*="gpt-ad"]',
        'div[id*="google_ads"]',
        'div[data-google-query-id]',
        'div[data-ad]',
        'div[data-ad-slot]',
        'div[data-ad-unit]',
        'div[class*="ad-container"]',
        'div[class*="ad-slot"]',
        'div[class*="ad-wrapper"]',
        'div[class*="advertisement"]',
        'aside[class*="ad"]',
        'div[aria-label*="advertisement" i]',
        'div[role="complementary"][class*="ad"]',
    ]

    for selector in ad_container_selectors:
        try:
            elements = browser_page.query_selector_all(selector)
            for el in elements:
                try:
                    bbox = el.bounding_box()
                    if not bbox or bbox["width"] < 60 or bbox["height"] < 20:
                        continue

                    el_id = el.get_attribute("id") or ""
                    el_class = el.get_attribute("class") or ""

                    # Check if we already captured this via iframe scanning
                    # (by checking for an iframe child we already processed)
                    child_iframe = el.query_selector("iframe")
                    if child_iframe:
                        child_src = child_iframe.get_attribute("src") or ""
                        if _is_ad_iframe(child_src):
                            continue  # Already captured via iframe strategy

                    screenshot_bytes = None
                    try:
                        screenshot_bytes = el.screenshot(timeout=5000)
                    except Exception:
                        pass

                    # Try to extract links
                    dest_url = None
                    ad_text = ""
                    try:
                        link = el.query_selector("a[href]")
                        if link:
                            href = link.get_attribute("href") or ""
                            if href.startswith("http") and not _ad_network_re.search(href):
                                dest_url = href
                        ad_text = (el.inner_text() or "").strip()[:2000]
                    except Exception:
                        pass

                    if not screenshot_bytes and not dest_url and not ad_text:
                        continue

                    dest_domain = _extract_domain(dest_url)
                    dedup_key = dest_domain or f"div-{el_id}-{len(captures)}"
                    if dedup_key in seen_destinations and dest_domain:
                        continue
                    seen_destinations.add(dedup_key)

                    slot = _classify_ad_slot(el_id, el_class, bbox)
                    capture = {
                        "site": site,
                        "page_url": page_url,
                        "ad_slot": slot,
                        "destination_url": dest_url,
                        "destination_domain": dest_domain,
                        "ad_text": ad_text if ad_text else None,
                        "screenshot_base64": base64.b64encode(screenshot_bytes).decode() if screenshot_bytes else None,
                        "width": int(bbox["width"]),
                        "height": int(bbox["height"]),
                    }
                    captures.append(capture)

                except Exception as e:
                    logger.debug(f"  Error processing ad container: {e}")
                    continue
        except Exception:
            continue

    # Strategy 4: If we found clickthrough URLs from network interception but
    # no visual captures, still record those as "network-only" captures
    if not captures and clickthrough_urls:
        logger.info(f"  No visual ads found but have {len(clickthrough_urls)} network-intercepted destinations")
        for domain, url in clickthrough_urls.items():
            captures.append({
                "site": site,
                "page_url": page_url,
                "ad_slot": "network-detected",
                "destination_url": url,
                "destination_domain": domain,
                "ad_text": None,
                "screenshot_base64": None,
                "width": None,
                "height": None,
            })

    logger.info(f"  Total captures on {page_url}: {len(captures)}")
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

    _scrape_progress = {
        "status": "running",
        "captured": 0,
        "errors": 0,
        "sites_completed": [],
        "log": [],
    }

    def _log(msg):
        logger.info(msg)
        _scrape_progress["log"] = (_scrape_progress.get("log", []) + [msg])[-50:]  # Keep last 50

    target_sites = sites or list(SITE_CONFIGS.keys())
    engine = init_db()
    session = get_session(engine)
    pw = None
    browser = None

    try:
        _log("Launching headless browser...")
        pw, browser, page = _get_browser_page()

        for site_key in target_sites:
            if site_key not in SITE_CONFIGS:
                _log(f"Unknown site: {site_key}, skipping")
                continue

            config = SITE_CONFIGS[site_key]
            urls = config["urls"][:max_pages_per_site]

            _log(f"Scraping {site_key} ({len(urls)} pages)...")

            for page_url in urls:
                try:
                    ad_captures = _capture_ads_on_page(page, page_url, site_key)
                    _log(f"  {page_url}: {len(ad_captures)} ads found")

                    for cap_data in ad_captures:
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
                    _log(f"  ERROR on {page_url}: {str(e)[:200]}")

                # Polite delay between pages
                time.sleep(2)

            _scrape_progress["sites_completed"].append(site_key)

        total = _scrape_progress['captured']
        _scrape_progress["status"] = "done"
        _log(f"Scrape complete: {total} ads captured")

    except Exception as e:
        logger.error(f"Ad scrape failed: {e}")
        _scrape_progress["status"] = "error"
        _scrape_progress["error"] = str(e)
        _scrape_progress.setdefault("log", []).append(f"FATAL: {str(e)[:200]}")
    finally:
        session.close()
        if browser:
            browser.close()
        if pw:
            pw.stop()
