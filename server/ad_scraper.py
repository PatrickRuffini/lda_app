"""Ad scraper for political news sites.

Captures banner/display ads from Politico, Axios, and Punchbowl News.
Supports two backends:
  1. Playwright (headless Chromium) — captures full JS-rendered ads with
     screenshots, network interception, and iframe scanning
  2. httpx fallback — parses server-rendered HTML for ad slot definitions,
     sponsored content links, and GPT ad unit metadata

The httpx backend captures less data (no screenshots, no JS-rendered ads)
but works without a browser binary.
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

# Ad network URL patterns
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

_CLICKTHROUGH_PARAMS = ["adurl", "r", "clickthrough", "click", "dest", "redirect", "landing", "url", "ct"]

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


def _extract_domain(url: str) -> Optional[str]:
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
    try:
        parsed = urlparse(ad_url)
        params = parse_qs(parsed.query)
        for key in _CLICKTHROUGH_PARAMS:
            vals = params.get(key, [])
            if vals:
                candidate = unquote(vals[0])
                if candidate.startswith("http"):
                    return candidate
        path = unquote(parsed.path)
        url_match = re.search(r'(https?://[^\s&;]+)', path)
        if url_match:
            candidate = url_match.group(1)
            cand_domain = _extract_domain(candidate)
            if cand_domain and not _ad_network_re.search(candidate):
                return candidate
    except Exception:
        pass
    return None


def _classify_ad_slot(element_id: str, element_classes: str, bbox: Optional[dict] = None) -> str:
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

    if bbox:
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
    if not src:
        return False
    return bool(_ad_network_re.search(src))


# ---------- Playwright backend ----------

def _get_browser_page():
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


def _capture_ads_playwright(browser_page, page_url: str, site: str) -> list[dict]:
    """Capture ads using Playwright with network interception + iframe/DOM scanning."""
    captures = []
    ad_network_urls = []
    seen_destinations = set()

    def _on_request(request):
        url = request.url
        if _ad_network_re.search(url):
            ad_network_urls.append(url)

    browser_page.on("request", _on_request)

    try:
        browser_page.goto(page_url, timeout=30000, wait_until="domcontentloaded")
        browser_page.wait_for_timeout(6000)

        title = browser_page.title()
        if "just a moment" in title.lower():
            browser_page.wait_for_timeout(10000)
            title = browser_page.title()
            if "just a moment" in title.lower():
                return captures

        for frac in [0.25, 0.5, 0.75]:
            browser_page.evaluate(f"window.scrollTo(0, document.body.scrollHeight * {frac})")
            browser_page.wait_for_timeout(2000)
        browser_page.evaluate("window.scrollTo(0, 0)")
        browser_page.wait_for_timeout(1000)

    except Exception as e:
        logger.error(f"Failed to load {page_url}: {e}")
        return captures
    finally:
        try:
            browser_page.remove_listener("request", _on_request)
        except Exception:
            pass

    # Extract clickthrough URLs
    clickthrough_urls = {}
    for ad_url in ad_network_urls:
        ct = _extract_clickthrough_from_ad_url(ad_url)
        if ct:
            ct_domain = _extract_domain(ct)
            if ct_domain:
                clickthrough_urls[ct_domain] = ct

    # Scan iframes
    try:
        for iframe in browser_page.query_selector_all("iframe"):
            try:
                src = iframe.get_attribute("src") or ""
                iframe_id = iframe.get_attribute("id") or ""
                iframe_name = iframe.get_attribute("name") or ""
                iframe_class = iframe.get_attribute("class") or ""

                is_ad = _is_ad_iframe(src)
                combined_attrs = f"{iframe_id} {iframe_name} {iframe_class}".lower()
                if any(kw in combined_attrs for kw in ["google_ads", "ad_iframe", "ad-", "gpt-ad", "dfp", "advertisement"]):
                    is_ad = True
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
                    continue

                screenshot_bytes = None
                try:
                    screenshot_bytes = iframe.screenshot(timeout=5000)
                except Exception:
                    pass

                dest_url = None
                dest_domain = None
                ct = _extract_clickthrough_from_ad_url(src)
                if ct:
                    dest_url = ct
                    dest_domain = _extract_domain(ct)
                if not dest_url and clickthrough_urls:
                    for domain, url in clickthrough_urls.items():
                        dest_url = url
                        dest_domain = domain
                        break

                dedup_key = dest_domain or f"no-domain-{iframe_id}-{len(captures)}"
                if dedup_key in seen_destinations and dest_domain:
                    continue
                seen_destinations.add(dedup_key)

                captures.append({
                    "site": site, "page_url": page_url,
                    "ad_slot": _classify_ad_slot(iframe_id or iframe_name, iframe_class, bbox),
                    "destination_url": dest_url, "destination_domain": dest_domain,
                    "ad_text": None,
                    "screenshot_base64": base64.b64encode(screenshot_bytes).decode() if screenshot_bytes else None,
                    "width": int(bbox["width"]), "height": int(bbox["height"]),
                })
            except Exception:
                continue
    except Exception:
        pass

    # Scan ad container divs
    for selector in [
        'div[id*="gpt-ad"]', 'div[id*="google_ads"]', 'div[data-google-query-id]',
        'div[data-ad]', 'div[data-ad-slot]', 'div[data-ad-unit]',
        'div[class*="ad-container"]', 'div[class*="ad-slot"]', 'div[class*="ad-wrapper"]',
        'div[class*="advertisement"]', 'div[aria-label*="advertisement" i]',
    ]:
        try:
            for el in browser_page.query_selector_all(selector):
                try:
                    bbox = el.bounding_box()
                    if not bbox or bbox["width"] < 60 or bbox["height"] < 20:
                        continue
                    child_iframe = el.query_selector("iframe")
                    if child_iframe and _is_ad_iframe(child_iframe.get_attribute("src") or ""):
                        continue

                    screenshot_bytes = None
                    try:
                        screenshot_bytes = el.screenshot(timeout=5000)
                    except Exception:
                        pass

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
                    dedup_key = dest_domain or f"div-{len(captures)}"
                    if dedup_key in seen_destinations and dest_domain:
                        continue
                    seen_destinations.add(dedup_key)

                    el_id = el.get_attribute("id") or ""
                    el_class = el.get_attribute("class") or ""
                    captures.append({
                        "site": site, "page_url": page_url,
                        "ad_slot": _classify_ad_slot(el_id, el_class, bbox),
                        "destination_url": dest_url, "destination_domain": dest_domain,
                        "ad_text": ad_text if ad_text else None,
                        "screenshot_base64": base64.b64encode(screenshot_bytes).decode() if screenshot_bytes else None,
                        "width": int(bbox["width"]), "height": int(bbox["height"]),
                    })
                except Exception:
                    continue
        except Exception:
            continue

    # Network-only fallback
    if not captures and clickthrough_urls:
        for domain, url in clickthrough_urls.items():
            captures.append({
                "site": site, "page_url": page_url, "ad_slot": "network-detected",
                "destination_url": url, "destination_domain": domain,
                "ad_text": None, "screenshot_base64": None, "width": None, "height": None,
            })

    return captures


# ---------- httpx fallback backend ----------

def _capture_ads_httpx(page_url: str, site: str, _log=None) -> list[dict]:
    """Capture ad metadata from server-rendered HTML using httpx + BeautifulSoup.

    This won't capture JS-rendered display ads, but it can find:
    - GPT ad slot definitions in inline scripts (ad unit paths, sizes)
    - Sponsored content links
    - Ad container div metadata (IDs, data attributes)
    - Hardcoded ad iframes
    """
    import httpx
    from bs4 import BeautifulSoup

    captures = []
    seen_destinations = set()

    try:
        # Prefer curl_cffi if available — it impersonates Chrome's TLS fingerprint
        # to bypass Cloudflare, which blocks plain httpx/requests
        try:
            from curl_cffi import requests as cffi_requests
            r = cffi_requests.get(page_url, impersonate="chrome", timeout=20)
            status_code = r.status_code
            html_text = r.text
        except ImportError:
            r = httpx.get(
                page_url,
                follow_redirects=True,
                timeout=20,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
            )
            status_code = r.status_code
            html_text = r.text

        if status_code == 403:
            if _log:
                _log(f"  Blocked (HTTP 403) from {page_url} — likely proxy or Cloudflare. Deploy to production for full access.")
            raise RuntimeError(f"HTTP 403 from {page_url} — network proxy is blocking access to this site")
        if status_code != 200:
            if _log:
                _log(f"  HTTP {status_code} from {page_url}")
            return captures
    except RuntimeError:
        raise
    except (httpx.ProxyError, Exception) as e:
        err_str = str(e).lower()
        if "proxy" in err_str or "403" in err_str or "tunnel" in err_str:
            if _log:
                _log(f"  Network blocked: cannot reach {page_url}. Deploy to production for full access.")
            raise RuntimeError(f"Network access blocked: {e}")
        if _log:
            _log(f"  HTTP error: {e}")
        return captures

    html = r.text
    if _log:
        _log(f"  Fetched {len(html):,} bytes from {page_url}")
    soup = BeautifulSoup(html, "lxml")

    # Strategy 1: Parse GPT ad slot definitions from inline scripts
    # These look like: googletag.defineSlot('/12345/site.politico/section', [[728,90],[970,250]], 'div-gpt-ad-123')
    gpt_slot_re = re.compile(
        r"""googletag\.defineSlot\(\s*['"]([^'"]+)['"]\s*,\s*(\[[\[\]0-9,\s]+\])\s*,\s*['"]([^'"]+)['"]""",
        re.MULTILINE,
    )
    for script in soup.find_all("script"):
        text = script.string or ""
        for match in gpt_slot_re.finditer(text):
            ad_unit_path = match.group(1)
            sizes_str = match.group(2)
            div_id = match.group(3)

            # Parse the ad unit path for advertiser clues
            # e.g. /21735021903/site.politico/tier1/news
            parts = [p for p in ad_unit_path.split("/") if p]

            # Estimate the ad slot type from the div ID and sizes
            slot = _classify_ad_slot(div_id, "", None)

            # Parse sizes to get the largest
            width, height = None, None
            try:
                sizes = json.loads(sizes_str)
                if sizes and isinstance(sizes[0], list):
                    # Pick the largest size
                    largest = max(sizes, key=lambda s: s[0] * s[1] if len(s) == 2 else 0)
                    width, height = largest[0], largest[1]
                elif len(sizes) == 2 and isinstance(sizes[0], int):
                    width, height = sizes[0], sizes[1]
            except Exception:
                pass

            dedup_key = f"gpt-{div_id}"
            if dedup_key in seen_destinations:
                continue
            seen_destinations.add(dedup_key)

            captures.append({
                "site": site,
                "page_url": page_url,
                "ad_slot": slot,
                "destination_url": None,
                "destination_domain": None,
                "ad_text": f"GPT slot: {ad_unit_path}",
                "screenshot_base64": None,
                "width": width,
                "height": height,
            })

    # Strategy 2: Find sponsored/partner content links
    for link in soup.find_all("a", href=True):
        href = link["href"]
        text = link.get_text(strip=True)
        parent_text = ""
        for parent in link.parents:
            parent_class = " ".join(parent.get("class", []))
            parent_text = f"{parent.get('id', '')} {parent_class}"
            if any(kw in parent_text.lower() for kw in [
                "sponsor", "partner", "paid", "promoted", "advertisement", "branded"
            ]):
                break
        else:
            # Check if the link text itself suggests sponsored content
            combined = f"{text} {parent_text}".lower()
            if not any(kw in combined for kw in ["sponsor", "partner", "paid", "promoted", "branded", "advertisement"]):
                continue

        if not href.startswith("http"):
            continue
        dest_domain = _extract_domain(href)
        if not dest_domain:
            continue
        # Skip internal links
        site_domain = _extract_domain(page_url)
        if dest_domain == site_domain:
            continue

        dedup_key = dest_domain
        if dedup_key in seen_destinations:
            continue
        seen_destinations.add(dedup_key)

        captures.append({
            "site": site,
            "page_url": page_url,
            "ad_slot": "sponsored-content",
            "destination_url": href,
            "destination_domain": dest_domain,
            "ad_text": text[:500] if text else None,
            "screenshot_base64": None,
            "width": None,
            "height": None,
        })

    # Strategy 3: Find ad iframes in the HTML source
    for iframe in soup.find_all("iframe", src=True):
        src = iframe["src"]
        if not _is_ad_iframe(src):
            continue

        iframe_id = iframe.get("id", "")
        ct = _extract_clickthrough_from_ad_url(src)
        dest_domain = _extract_domain(ct) if ct else None

        dedup_key = dest_domain or f"iframe-{iframe_id or len(captures)}"
        if dedup_key in seen_destinations and dest_domain:
            continue
        seen_destinations.add(dedup_key)

        width = iframe.get("width")
        height = iframe.get("height")

        captures.append({
            "site": site,
            "page_url": page_url,
            "ad_slot": _classify_ad_slot(iframe_id, " ".join(iframe.get("class", [])), None),
            "destination_url": ct,
            "destination_domain": dest_domain,
            "ad_text": None,
            "screenshot_base64": None,
            "width": int(width) if width and width.isdigit() else None,
            "height": int(height) if height and height.isdigit() else None,
        })

    # Strategy 4: Find ad container divs with data attributes
    for div in soup.find_all("div", attrs={"data-ad-slot": True}):
        slot_val = div.get("data-ad-slot", "")
        div_id = div.get("id", "")

        dedup_key = f"data-ad-{div_id or slot_val or len(captures)}"
        if dedup_key in seen_destinations:
            continue
        seen_destinations.add(dedup_key)

        captures.append({
            "site": site,
            "page_url": page_url,
            "ad_slot": _classify_ad_slot(div_id, " ".join(div.get("class", [])), None),
            "destination_url": None,
            "destination_domain": None,
            "ad_text": f"Ad slot: {slot_val}" if slot_val else None,
            "screenshot_base64": None,
            "width": None,
            "height": None,
        })

    return captures


# ---------- Landing page resolver ----------

# Keywords that suggest what type of landing page it is
_PAGE_TYPE_SIGNALS = {
    "advocacy": [
        "take action", "tell congress", "sign the petition", "call your",
        "urge", "support", "oppose", "protect", "fight for", "stand with",
        "grassroots", "campaign", "mobilize", "pledge", "voice",
    ],
    "donation": [
        "donate", "contribution", "give now", "support us", "chip in",
        "fundrais", "recurring gift",
    ],
    "issue": [
        "policy", "legislation", "bill", "regulation", "issue brief",
        "fact sheet", "white paper", "research", "report", "study",
    ],
    "corporate": [
        "about us", "our company", "our mission", "investor", "careers",
        "annual report", "sustainability", "press release",
    ],
    "product": [
        "buy now", "shop", "pricing", "free trial", "subscribe",
        "get started", "demo",
    ],
}


def _classify_landing_page_type(title: str, description: str, body_text: str) -> str:
    """Classify the landing page type based on its content."""
    combined = f"{title} {description} {body_text}".lower()
    scores = {}
    for ptype, keywords in _PAGE_TYPE_SIGNALS.items():
        scores[ptype] = sum(1 for kw in keywords if kw in combined)
    best = max(scores, key=scores.get)
    if scores[best] > 0:
        return best
    return "unknown"


def _fetch_url(url: str, follow_redirects: bool = True, timeout: int = 15):
    """Fetch a URL using the best available HTTP client. Returns (response_obj, final_url, html_text) or raises."""
    # Try curl_cffi first for Cloudflare bypass
    try:
        from curl_cffi import requests as cffi_requests
        r = cffi_requests.get(url, impersonate="chrome", timeout=timeout, allow_redirects=follow_redirects)
        # curl_cffi tracks the final URL after redirects
        final_url = str(r.url) if hasattr(r, 'url') else url
        return r.status_code, final_url, r.text
    except ImportError:
        pass
    except Exception:
        pass

    # Fall back to httpx
    import httpx
    r = httpx.get(
        url,
        follow_redirects=follow_redirects,
        timeout=timeout,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    final_url = str(r.url)
    return r.status_code, final_url, r.text


def resolve_landing_page(destination_url: str, _log=None) -> dict:
    """Follow a destination URL through redirects and extract landing page metadata.

    Returns a dict with:
        resolved_url, resolved_domain, landing_page_title, landing_page_description,
        landing_page_og_image, landing_page_keywords, landing_page_type
    """
    result = {
        "resolved_url": None,
        "resolved_domain": None,
        "landing_page_title": None,
        "landing_page_description": None,
        "landing_page_og_image": None,
        "landing_page_keywords": None,
        "landing_page_type": None,
    }

    if not destination_url:
        return result

    try:
        from bs4 import BeautifulSoup
    except ImportError:
        if _log:
            _log("  beautifulsoup4 not installed, skipping landing page resolution")
        return result

    try:
        status, final_url, html = _fetch_url(destination_url)
        if status != 200:
            if _log:
                _log(f"    Landing page HTTP {status}: {destination_url}")
            return result

        result["resolved_url"] = final_url
        result["resolved_domain"] = _extract_domain(final_url)

        soup = BeautifulSoup(html, "lxml")

        # Title: prefer og:title, fall back to <title>
        og_title = soup.find("meta", property="og:title")
        if og_title and og_title.get("content"):
            result["landing_page_title"] = og_title["content"][:1000]
        else:
            title_tag = soup.find("title")
            if title_tag:
                result["landing_page_title"] = title_tag.get_text(strip=True)[:1000]

        # Description: prefer og:description, fall back to meta description
        og_desc = soup.find("meta", property="og:description")
        if og_desc and og_desc.get("content"):
            result["landing_page_description"] = og_desc["content"][:2000]
        else:
            meta_desc = soup.find("meta", attrs={"name": "description"})
            if meta_desc and meta_desc.get("content"):
                result["landing_page_description"] = meta_desc["content"][:2000]

        # OG image
        og_image = soup.find("meta", property="og:image")
        if og_image and og_image.get("content"):
            result["landing_page_og_image"] = og_image["content"][:2000]

        # Keywords from meta tag
        meta_kw = soup.find("meta", attrs={"name": "keywords"})
        if meta_kw and meta_kw.get("content"):
            result["landing_page_keywords"] = meta_kw["content"][:2000]

        # Classify landing page type using title + description + some body text
        body_text = ""
        body = soup.find("body")
        if body:
            body_text = body.get_text(" ", strip=True)[:5000]

        result["landing_page_type"] = _classify_landing_page_type(
            result["landing_page_title"] or "",
            result["landing_page_description"] or "",
            body_text,
        )

        if _log:
            _log(f"    Resolved: {result['resolved_domain']} — {result['landing_page_title'][:80] if result['landing_page_title'] else '(no title)'} [{result['landing_page_type']}]")

    except Exception as e:
        if _log:
            _log(f"    Failed to resolve {destination_url}: {str(e)[:100]}")

    return result


# ---------- Campaign management ----------

def _find_or_create_campaign(session, domain: str, advertiser_name: str, site: str) -> Optional[int]:
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


# ---------- Main scrape entry point ----------

def _detect_backend(_log=None) -> str:
    """Detect which scraping backend is available."""
    # Try Playwright first
    try:
        from playwright.sync_api import sync_playwright
        from .influence import CHROMIUM_PATH
        import os
        if os.path.exists(CHROMIUM_PATH):
            if _log:
                _log("Using Playwright backend (headless Chromium)")
            return "playwright"
        elif _log:
            _log(f"Playwright installed but Chromium not found at {CHROMIUM_PATH}")
    except ImportError:
        if _log:
            _log("Playwright not installed")

    # Fall back to curl_cffi (better Cloudflare bypass) or plain httpx
    try:
        from curl_cffi import requests as _cffi
        if _log:
            _log("Using curl_cffi + httpx backend (HTML-only, Chrome TLS fingerprint)")
        return "httpx"
    except ImportError:
        pass

    try:
        import httpx
        if _log:
            _log("Using httpx backend (HTML-only, no JS rendering)")
        return "httpx"
    except ImportError:
        pass

    return "none"


def scrape_ads(sites: Optional[list[str]] = None, max_pages_per_site: int = 3):
    """Scrape ads from configured political news sites."""
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
        _scrape_progress["log"] = (_scrape_progress.get("log", []) + [msg])[-50:]

    target_sites = sites or list(SITE_CONFIGS.keys())
    engine = init_db()
    session = get_session(engine)

    pw = None
    browser = None
    backend = _detect_backend(_log)

    if backend == "none":
        _scrape_progress["status"] = "error"
        _scrape_progress["error"] = "No scraping backend available. Install playwright or httpx."
        _log("ERROR: No scraping backend available. Install playwright or httpx.")
        session.close()
        return

    try:
        browser_page = None
        if backend == "playwright":
            _log("Launching headless browser...")
            try:
                pw, browser, browser_page = _get_browser_page()
            except Exception as e:
                _log(f"Playwright launch failed: {str(e)[:150]}")
                _log("Falling back to httpx backend (HTML-only)")
                backend = "httpx"

        for site_key in target_sites:
            if site_key not in SITE_CONFIGS:
                _log(f"Unknown site: {site_key}, skipping")
                continue

            config = SITE_CONFIGS[site_key]
            urls = config["urls"][:max_pages_per_site]
            _log(f"Scraping {site_key} ({len(urls)} pages)...")

            for page_url in urls:
                try:
                    if backend == "playwright" and browser_page:
                        ad_captures = _capture_ads_playwright(browser_page, page_url, site_key)
                    else:
                        ad_captures = _capture_ads_httpx(page_url, site_key, _log)

                    _log(f"  {page_url}: {len(ad_captures)} ads found")

                    for cap_data in ad_captures:
                        dest_url = cap_data.get("destination_url")
                        domain = cap_data.get("destination_domain")

                        # Resolve the landing page
                        landing = {"resolved_url": None, "resolved_domain": None,
                                   "landing_page_title": None, "landing_page_description": None,
                                   "landing_page_og_image": None, "landing_page_keywords": None,
                                   "landing_page_type": None}
                        if dest_url:
                            try:
                                landing = resolve_landing_page(dest_url, _log)
                            except Exception as e:
                                _log(f"    Landing page error: {str(e)[:100]}")

                        # Use resolved domain for campaign grouping if available
                        effective_domain = landing.get("resolved_domain") or domain
                        advertiser = KNOWN_ADVOCACY_DOMAINS.get(effective_domain, effective_domain or "Unknown")

                        campaign_id = _find_or_create_campaign(
                            session, effective_domain, advertiser, site_key
                        ) if effective_domain else None

                        capture = AdCapture(
                            site=cap_data["site"],
                            page_url=cap_data["page_url"],
                            ad_slot=cap_data["ad_slot"],
                            destination_url=dest_url,
                            destination_domain=domain,
                            resolved_url=landing.get("resolved_url"),
                            resolved_domain=landing.get("resolved_domain"),
                            landing_page_title=landing.get("landing_page_title"),
                            landing_page_description=landing.get("landing_page_description"),
                            landing_page_og_image=landing.get("landing_page_og_image"),
                            landing_page_keywords=landing.get("landing_page_keywords"),
                            landing_page_type=landing.get("landing_page_type"),
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

                except RuntimeError as e:
                    # Network blocked — stop trying other pages/sites
                    _log(f"  {str(e)}")
                    session.rollback()
                    _scrape_progress["errors"] = _scrape_progress.get("errors", 0) + 1
                    _scrape_progress["status"] = "error"
                    _scrape_progress["error"] = str(e)
                    return
                except Exception as e:
                    logger.error(f"Error scraping {page_url}: {e}")
                    session.rollback()
                    _scrape_progress["errors"] = _scrape_progress.get("errors", 0) + 1
                    _log(f"  ERROR on {page_url}: {str(e)[:200]}")

                time.sleep(2)

            _scrape_progress["sites_completed"].append(site_key)

        total = _scrape_progress["captured"]
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
