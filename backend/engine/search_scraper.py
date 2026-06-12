"""
search_scraper.py — Instagram Search Engine V3

Perubahan dari V2:
  ─ Urutan strategy dibalik: GraphQL FIRST → CDP Direct → REST
    (GraphQL + CDP lebih reliable untuk hashtag populer Indonesia)
  ─ Cursor-based pagination penuh di GraphQL (bisa ambil ratusan post)
  ─ CDP pagination juga diperbaiki (loop sampai max_posts)
  ─ _collect_hashtag_posts sekarang bisa ambil unlimited dengan cursor loop
  ─ Worker deep search di search_checkpoint.py diupgrade:
      • per-hashtag bisa ambil ratusan post (bukan dibatasi 1 halaman)
      • retry otomatis kalau strategy 1 gagal
  ─ Semua infrastructure tetap sama dgn scraper_post.py V16
"""

import os
import re
import json
import time
import random
import traceback
import requests
from datetime import datetime
from typing import List, Dict, Optional, Tuple
from urllib.parse import quote

from dotenv import load_dotenv
from colorama import Fore, init
from playwright.sync_api import sync_playwright, Page, BrowserContext

from cookie_injector import inject_cookies_sync, has_valid_session

init(autoreset=True)
load_dotenv()

# ── CONFIG ─────────────────────────────────────────────────────────────────
HEADLESS    = os.getenv("HEADLESS", "true").lower() == "true"
PROXY       = os.getenv("PROXY", "")
PROFILE_DIR = os.getenv("SEARCH_PROFILE_DIR", "chrome_profile_search")
CHROME_PROFILE = os.path.join(os.getcwd(), PROFILE_DIR)

OUTPUT_DIR = "output"
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(CHROME_PROFILE, exist_ok=True)

IG_APP_ID = "936619743392459"

# ── GraphQL query hashes untuk hashtag ────────────────────────────────────
# Coba beberapa hash — IG kadang rotate
HASHTAG_GQL_HASHES = [
    "174a5243287c5f3a7de741089750ab3b",   # edge_hashtag_to_media (primary)
    "ded47faa9a1aaded10161a2ff32abb6b",   # fallback
    "9b498c08113f1e09617a1703c22b2f32",   # v2 fallback
]

# ── RATE LIMIT CONFIG ──────────────────────────────────────────────────────
RATE_LIMIT_WAIT_DEFAULT  = 60
RATE_LIMIT_WAIT_EXTENDED = 90
MAX_RETRIES              = 3
RETRY_BASE_DELAY         = 2.0


class InstagramSearchScraper:

    def __init__(self):
        self.playwright  = None
        self.context: Optional[BrowserContext] = None
        self.page:    Optional[Page]           = None
        self.session: Optional[requests.Session] = None
        os.makedirs(CHROME_PROFILE, exist_ok=True)
        if has_valid_session():
            print(Fore.GREEN + "🍪 Search: login via cookie session")
        else:
            print(Fore.YELLOW + "⚠️  Search: belum ada cookie session — search butuh login.")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    # ════════════════════════════════════════════════════════════
    # REQUIRE GUARDS
    # ════════════════════════════════════════════════════════════

    def _require_page(self) -> Page:
        if self.page is None:
            raise RuntimeError("Browser belum di-inisialisasi.")
        return self.page

    def _require_context(self) -> BrowserContext:
        if self.context is None:
            raise RuntimeError("Context belum dibuat.")
        return self.context

    def _require_session(self) -> requests.Session:
        if self.session is None:
            raise RuntimeError("Session belum dibuat.")
        return self.session

    # ════════════════════════════════════════════════════════════
    # BROWSER SETUP — identik dgn scraper_post.py V16
    # ════════════════════════════════════════════════════════════

    def _build_context(self) -> BrowserContext:
        self.playwright = sync_playwright().start()

        args = [
            "--disable-blink-features=AutomationControlled",
            "--disable-notifications",
            "--no-sandbox",
            "--mute-audio",
            "--disable-infobars",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-features=IsolateOrigins,site-per-process",
        ]
        if PROXY:
            args.append(f"--proxy-server={PROXY}")

        stealth_script = r"""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
            Object.defineProperty(navigator, 'deviceMemory', {get: () => 8});
            Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 4});
            delete navigator.__proto__.webdriver;
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications'
                    ? Promise.resolve({state: Notification.permission})
                    : originalQuery(parameters)
            );
        """

        context = self.playwright.chromium.launch_persistent_context(
            CHROME_PROFILE,
            headless=HEADLESS,
            args=args,
            viewport=(
                {"width": 1920, "height": 1080} if not HEADLESS
                else {"width": 1366, "height": 768}
            ),
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
            ),
            locale="en-US",
            timezone_id="Asia/Jakarta",
            bypass_csp=True,
            java_script_enabled=True,
        )
        context.on("page", lambda page: page.add_init_script(stealth_script))

        try:
            if has_valid_session():
                n = inject_cookies_sync(context)
                print(Fore.GREEN + f"🍪 Inject {n} cookies ke profil search")
        except Exception as e:
            print(Fore.YELLOW + f"⚠️  Cookie inject dilewati: {e}")

        return context

    def initialize_browser(self):
        if self.context:
            return
        print(Fore.CYAN + "\n🌐 Membuka browser (Playwright) untuk SEARCH...")
        self.context = self._build_context()
        self.page = (
            self.context.pages[0] if self.context.pages
            else self.context.new_page()
        )
        page = self.page

        def block_heavy_resources(route):
            rt  = route.request.resource_type
            url = route.request.url.lower()
            if rt in ("image", "media", "font"):
                if "favicon" in url or "icon" in url:
                    route.continue_()
                else:
                    route.abort()
            else:
                route.continue_()

        page.route("**/*", block_heavy_resources)
        page.goto("https://www.instagram.com/")
        time.sleep(5)
        self._close_popups()

        if "login" in page.url:
            print(Fore.RED + "❌ Session expired. Jalankan login_helper_playwright.py.")
            self.close()
            raise RuntimeError("Redirect ke login — session expired.")
        print(Fore.GREEN + "✅ Browser siap (LOGGED IN)")

    def _close_popups(self):
        page = self._require_page()
        for selector in [
            "text=Not Now", "text=Sekarang tidak", "text=Cancel",
            "text=Batal", "text=Turn Off", "text=Save Info",
            "button:has-text('Not Now')",
        ]:
            try:
                if page.locator(selector).count() > 0:
                    page.locator(selector).first.click(timeout=2000)
                    time.sleep(0.8)
            except Exception:
                pass

    def close(self):
        try:
            if self.session:
                self.session.close()
                self.session = None
            if self.context:
                self.context.close()
                self.context = None
            if self.playwright:
                self.playwright.stop()
                self.playwright = None
        except Exception:
            pass

    # ════════════════════════════════════════════════════════════
    # REQUESTS SESSION — identik dgn scraper_post.py V16
    # ════════════════════════════════════════════════════════════

    def _build_requests_session(self) -> requests.Session:
        sess    = requests.Session()
        context = self._require_context()
        cookies = context.cookies()
        for cookie in cookies:
            name, value = cookie.get("name"), cookie.get("value")
            if name and value is not None:
                sess.cookies.set(name, value, domain=cookie.get("domain", ".instagram.com"))
        csrf = next(
            (c.get("value", "") for c in cookies if c.get("name") == "csrftoken"), ""
        )
        sess.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
            ),
            "Accept":           "*/*",
            "Accept-Language":  "en-US,en;q=0.9",
            "X-IG-App-ID":      IG_APP_ID,
            "X-ASBD-ID":        "129477",
            "X-IG-WWW-Claim":   "0",
            "X-CSRFToken":      csrf,
            "X-Requested-With": "XMLHttpRequest",
            "Sec-Fetch-Dest":   "empty",
            "Sec-Fetch-Mode":   "cors",
            "Sec-Fetch-Site":   "same-origin",
            "Referer":          "https://www.instagram.com/",
            "Origin":           "https://www.instagram.com",
        })
        return sess

    def _ensure_ready(self):
        self.initialize_browser()
        if self.session is None:
            self.session = self._build_requests_session()

    # ════════════════════════════════════════════════════════════
    # LOW-LEVEL HTTP HELPERS
    # ════════════════════════════════════════════════════════════

    def _cdp_get(self, path: str) -> Tuple[Optional[dict], int]:
        page = self._require_page()
        try:
            result = page.evaluate(r"""async (path) => {
                try {
                    const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
                    const resp = await fetch(path, {
                        method: 'GET', credentials: 'include',
                        headers: {
                            'X-IG-App-ID': '936619743392459',
                            'X-ASBD-ID': '129477',
                            'X-IG-WWW-Claim': '0',
                            'X-CSRFToken': csrf,
                            'X-Requested-With': 'XMLHttpRequest',
                            'Accept': '*/*',
                        },
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (e) {}
                    return { ok: resp.ok, status: resp.status, data: data };
                } catch (e) {
                    return { ok: false, status: 0, error: e.toString() };
                }
            }""", path)
            if not result:
                return None, 0
            return result.get("data"), int(result.get("status", 0) or 0)
        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  CDP GET error: {e}")
            return None, 0

    def _cdp_post_form(self, path: str, form: dict) -> Tuple[Optional[dict], int]:
        page = self._require_page()
        try:
            result = page.evaluate(r"""async (args) => {
                const { path, form } = args;
                try {
                    const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
                    const body = new URLSearchParams(form).toString();
                    const resp = await fetch(path, {
                        method: 'POST', credentials: 'include',
                        headers: {
                            'X-IG-App-ID': '936619743392459',
                            'X-ASBD-ID': '129477',
                            'X-IG-WWW-Claim': '0',
                            'X-CSRFToken': csrf,
                            'X-Requested-With': 'XMLHttpRequest',
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Accept': '*/*',
                        },
                        body: body,
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (e) {}
                    return { ok: resp.ok, status: resp.status, data: data };
                } catch (e) {
                    return { ok: false, status: 0, error: e.toString() };
                }
            }""", {"path": path, "form": {k: str(v) for k, v in form.items()}})
            if not result:
                return None, 0
            return result.get("data"), int(result.get("status", 0) or 0)
        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  CDP POST error: {e}")
            return None, 0

    def _sess_get(self, url: str, params: Optional[dict] = None) -> Tuple[Optional[dict], int]:
        try:
            resp = self._require_session().get(url, params=params, timeout=20)
            if resp.status_code != 200:
                return None, resp.status_code
            if "json" not in resp.headers.get("content-type", ""):
                return None, resp.status_code
            return resp.json(), resp.status_code
        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  requests GET error: {e}")
            return None, 0

    def _sess_post(self, url: str, data: Optional[dict] = None) -> Tuple[Optional[dict], int]:
        try:
            resp = self._require_session().post(url, data=data, timeout=20)
            if resp.status_code != 200:
                return None, resp.status_code
            if "json" not in resp.headers.get("content-type", ""):
                return None, resp.status_code
            return resp.json(), resp.status_code
        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  requests POST error: {e}")
            return None, 0

    def _api_get_robust(
        self,
        path: str,
        retries: int = MAX_RETRIES,
        rate_limit_wait: int = RATE_LIMIT_WAIT_DEFAULT,
    ) -> Optional[dict]:
        url = (
            f"https://www.instagram.com{path}"
            if path.startswith("/") else path
        )
        for attempt in range(retries + 1):
            data, status = self._cdp_get(path)
            if status == 429:
                print(Fore.YELLOW + f"   ⚠️  429 (CDP), tunggu {rate_limit_wait}s...")
                time.sleep(rate_limit_wait)
                continue
            if data is not None:
                return data

            rdata, rstatus = self._sess_get(url)
            if rstatus == 429:
                print(Fore.YELLOW + f"   ⚠️  429 (REST), tunggu {rate_limit_wait}s...")
                time.sleep(rate_limit_wait)
                continue
            if rdata is not None:
                return rdata

            if attempt < retries:
                wait = RETRY_BASE_DELAY * (2 ** attempt) + random.uniform(0, 1)
                print(Fore.YELLOW + f"   ↩️  Retry {attempt+1}/{retries} ({wait:.1f}s)...")
                time.sleep(wait)
        return None

    def _api_post_robust(
        self,
        path: str,
        form: dict,
        retries: int = MAX_RETRIES,
        rate_limit_wait: int = RATE_LIMIT_WAIT_DEFAULT,
    ) -> Optional[dict]:
        url = (
            f"https://www.instagram.com{path}"
            if path.startswith("/") else path
        )
        for attempt in range(retries + 1):
            data, status = self._cdp_post_form(path, form)
            if status == 429:
                print(Fore.YELLOW + f"   ⚠️  429 (CDP POST), tunggu {rate_limit_wait}s...")
                time.sleep(rate_limit_wait)
                continue
            if data is not None:
                return data

            rdata, rstatus = self._sess_post(url, form)
            if rstatus == 429:
                print(Fore.YELLOW + f"   ⚠️  429 (REST POST), tunggu {rate_limit_wait}s...")
                time.sleep(rate_limit_wait)
                continue
            if rdata is not None:
                return rdata

            if attempt < retries:
                wait = RETRY_BASE_DELAY * (2 ** attempt) + random.uniform(0, 1)
                print(Fore.YELLOW + f"   ↩️  Retry {attempt+1}/{retries} ({wait:.1f}s)...")
                time.sleep(wait)
        return None

    # ════════════════════════════════════════════════════════════
    # STRATEGY 1: GraphQL — CURSOR-BASED PAGINATION PENUH
    # Ini yang paling reliable untuk hashtag Indonesia
    # ════════════════════════════════════════════════════════════

    def _fetch_hashtag_via_graphql(
        self,
        tag: str,
        max_posts: int,
        rate_limit_wait: int = RATE_LIMIT_WAIT_DEFAULT,
    ) -> Tuple[List[Dict], int]:
        """
        Ambil posts via GraphQL dengan cursor pagination penuh.
        Bisa ambil ratusan/ribuan post asalkan IG tidak rate-limit.
        Return (posts_list, total_count_from_ig).
        """
        all_posts: List[Dict] = []
        seen: set = set()
        total_count = 0

        print(Fore.CYAN + f"   📡 [GraphQL] #{tag} max_posts={max_posts}")

        for query_hash in HASHTAG_GQL_HASHES:
            if all_posts:
                break   # sudah dapat dari hash pertama

            end_cursor: Optional[str] = None
            page_num = 0
            max_pages = min(200, (max_posts // 10) + 5)

            while len(all_posts) < max_posts and page_num < max_pages:
                page_num += 1
                variables = {
                    "tag_name": tag,
                    "first":    min(50, max_posts - len(all_posts)),
                    "show_ranked_hashtag_media_viewer": True,
                }
                if end_cursor:
                    variables["after"] = end_cursor

                path = (
                    f"/graphql/query/"
                    f"?query_hash={query_hash}"
                    f"&variables={quote(json.dumps(variables))}"
                )

                data = None
                for attempt in range(MAX_RETRIES + 1):
                    d, status = self._cdp_get(path)
                    if status == 429:
                        print(Fore.YELLOW + f"   ⚠️  429 GraphQL CDP, tunggu {rate_limit_wait}s...")
                        time.sleep(rate_limit_wait)
                        continue
                    if d is not None:
                        data = d
                        break
                    # Fallback requests
                    d2, s2 = self._sess_get(f"https://www.instagram.com{path}")
                    if s2 == 429:
                        print(Fore.YELLOW + f"   ⚠️  429 GraphQL REST, tunggu {rate_limit_wait}s...")
                        time.sleep(rate_limit_wait)
                        continue
                    if d2 is not None:
                        data = d2
                        break
                    if attempt < MAX_RETRIES:
                        time.sleep(RETRY_BASE_DELAY * (2 ** attempt))

                if not data:
                    print(Fore.YELLOW + f"   ⚠️  GraphQL no data (hash={query_hash[:8]}...)")
                    break

                if data.get("status") == "fail":
                    print(Fore.YELLOW + f"   ⚠️  GraphQL fail: {data.get('message','')}")
                    break

                # Navigasi struktur
                ht = (
                    data.get("data", {}).get("hashtag", {})
                    or data.get("data", {}).get("hashtag_edge", {})
                )
                if not ht:
                    break

                if not total_count:
                    total_count = int(
                        ht.get("edge_hashtag_to_media", {}).get("count", 0) or 0
                    )

                added = 0
                page_info: Dict = {}

                # Ambil dari top_posts + recent (gabung, dedup via seen)
                for edge_key in (
                    "edge_hashtag_to_top_posts",
                    "edge_hashtag_to_media",
                    "edge_hashtag_to_top_posts_for_featured_media",
                ):
                    edge = ht.get(edge_key, {})
                    if not edge.get("edges"):
                        continue
                    if edge_key == "edge_hashtag_to_media":
                        page_info = edge.get("page_info", {})

                    for e in edge.get("edges", []):
                        node = e.get("node", {})
                        if not node:
                            continue
                        parsed = self._parse_media_graphql(
                            node, f"graphql_{edge_key}", len(all_posts) + 1
                        )
                        if not parsed:
                            continue
                        key = parsed["media_id"] or parsed["shortcode"]
                        if key in seen:
                            continue
                        seen.add(key)
                        all_posts.append(parsed)
                        added += 1
                        if len(all_posts) >= max_posts:
                            break
                    if len(all_posts) >= max_posts:
                        break

                print(Fore.CYAN + f"   📡 GraphQL page {page_num}: +{added} (total {len(all_posts)})")

                if not page_info.get("has_next_page"):
                    print(Fore.GREEN + f"   ✅ GraphQL: halaman terakhir ({len(all_posts)} posts)")
                    break
                end_cursor = page_info.get("end_cursor")
                if not end_cursor:
                    break

                delay = random.uniform(2.0, 4.0)
                time.sleep(delay)

        return all_posts, total_count

    # ════════════════════════════════════════════════════════════
    # STRATEGY 2: CDP Direct — in-browser POST ke sections API
    # Reliable karena pakai cookie session browser langsung
    # ════════════════════════════════════════════════════════════

    def _fetch_hashtag_via_cdp(
        self,
        tag: str,
        max_posts: int,
        rate_limit_wait: int = RATE_LIMIT_WAIT_DEFAULT,
    ) -> List[Dict]:
        """
        Ambil posts via CDP in-browser fetch.
        Loop sampai max_posts atau habis.
        """
        page = self._require_page()
        all_posts: List[Dict] = []
        seen: set = set()
        next_max_id: Optional[str] = None
        page_num = 0
        max_pages = min(100, (max_posts // 8) + 5)

        print(Fore.CYAN + f"   📡 [CDP Direct] #{tag} max_posts={max_posts}")

        while len(all_posts) < max_posts and page_num < max_pages:
            page_num += 1
            try:
                result = page.evaluate(r"""async (params) => {
                    const { tag, maxId, pageNum } = params;
                    try {
                        const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
                        const body = new URLSearchParams({
                            include_persistent: '0',
                            page: String(pageNum),
                            surface: 'grid',
                            tab: 'recent',
                            ...(maxId ? { max_id: maxId } : {}),
                        }).toString();
                        const resp = await fetch(
                            `/api/v1/tags/${encodeURIComponent(tag)}/sections/`, {
                            method: 'POST', credentials: 'include',
                            headers: {
                                'X-IG-App-ID': '936619743392459',
                                'X-ASBD-ID': '129477',
                                'X-IG-WWW-Claim': '0',
                                'X-CSRFToken': csrf,
                                'X-Requested-With': 'XMLHttpRequest',
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Accept': '*/*',
                            },
                            body: body,
                        });
                        const data = await resp.json();
                        return { ok: true, status: resp.status, data: data };
                    } catch (e) {
                        return { ok: false, error: e.toString() };
                    }
                }""", {"tag": tag, "maxId": next_max_id, "pageNum": page_num})

                if not result or not result.get("ok"):
                    break
                if result.get("status") == 429:
                    print(Fore.YELLOW + f"   ⚠️  429 CDP Direct, tunggu {rate_limit_wait}s...")
                    time.sleep(rate_limit_wait)
                    continue

                sec   = result.get("data") or {}
                added = 0
                for media in self._extract_medias_from_sections(sec.get("sections", [])):
                    parsed = self._parse_media(media, "cdp_direct", len(all_posts) + 1)
                    if not parsed:
                        continue
                    key = parsed["media_id"] or parsed["shortcode"]
                    if key in seen:
                        continue
                    seen.add(key)
                    all_posts.append(parsed)
                    added += 1
                    if len(all_posts) >= max_posts:
                        break

                print(Fore.CYAN + f"   📡 CDP page {page_num}: +{added} (total {len(all_posts)})")
                next_max_id = sec.get("next_max_id")
                more        = bool(sec.get("more_available", False))
                if added == 0 or not next_max_id or not more:
                    break

                time.sleep(random.uniform(1.5, 3.0))

            except Exception as e:
                print(Fore.RED + f"   ❌ CDP Direct error: {e}")
                break

        return all_posts

    # ════════════════════════════════════════════════════════════
    # STRATEGY 3: REST /api/v1/tags/ — fallback terakhir
    # ════════════════════════════════════════════════════════════

    def _fetch_hashtag_via_rest(
        self,
        tag: str,
        max_posts: int,
        include_top: bool,
        include_recent: bool,
        recent_pages: int,
        rate_limit_wait: int = RATE_LIMIT_WAIT_DEFAULT,
    ) -> Tuple[List[Dict], int, str]:
        info = self._api_get_robust(
            f"/api/v1/tags/web_info/?tag_name={quote(tag)}",
            rate_limit_wait=rate_limit_wait,
        )
        if not info or "data" not in info:
            return [], 0, ""

        d             = info.get("data", {}) or {}
        media_count   = int(d.get("media_count", 0) or 0)
        formatted     = d.get("formatted_media_count", "") or self._fmt_count(media_count)
        seen, posts   = set(), []
        top_c = rec_c = 0

        def _add(media: Dict, src: str) -> bool:
            nonlocal top_c, rec_c
            parsed = self._parse_media(media, src, len(posts) + 1)
            if not parsed:
                return False
            key = parsed["media_id"] or parsed["shortcode"]
            if not key or key in seen:
                return False
            seen.add(key)
            posts.append(parsed)
            if src == "top": top_c += 1
            else:            rec_c += 1
            return True

        if include_top:
            for media in self._extract_medias_from_sections(
                (d.get("top", {}) or {}).get("sections", [])
            ):
                if len(posts) >= max_posts:
                    break
                _add(media, "top")

        if include_recent and len(posts) < max_posts:
            recent         = d.get("recent", {}) or {}
            next_max_id    = recent.get("next_max_id")
            next_media_ids = recent.get("next_media_ids", []) or []
            more           = bool(recent.get("more_available", False))
            page_num       = 1

            for media in self._extract_medias_from_sections(recent.get("sections", [])):
                if len(posts) >= max_posts:
                    break
                _add(media, "recent")

            while more and next_max_id and page_num < recent_pages and len(posts) < max_posts:
                page_num += 1
                time.sleep(random.uniform(1.5, 3.2))
                form = {
                    "include_persistent": "0",
                    "max_id":   next_max_id or "",
                    "page":     str(page_num),
                    "surface":  "grid",
                    "tab":      "recent",
                }
                if next_media_ids:
                    form["next_media_ids"] = json.dumps(next_media_ids)

                sec = self._api_post_robust(
                    f"/api/v1/tags/{quote(tag)}/sections/",
                    form, rate_limit_wait=rate_limit_wait,
                )
                if not sec:
                    break
                added = 0
                for media in self._extract_medias_from_sections(sec.get("sections", [])):
                    if len(posts) >= max_posts:
                        break
                    if _add(media, "recent"):
                        added += 1
                print(Fore.CYAN + f"   📄 REST page {page_num}: +{added} (total {len(posts)})")
                more           = bool(sec.get("more_available", False))
                next_max_id    = sec.get("next_max_id")
                next_media_ids = sec.get("next_media_ids", []) or []
                if added == 0 or not next_max_id:
                    break

        return posts, media_count, formatted

    # ════════════════════════════════════════════════════════════
    # ORCHESTRATOR — GraphQL FIRST, lalu CDP, lalu REST
    # ════════════════════════════════════════════════════════════

    def _collect_hashtag_posts(
        self,
        tag: str,
        max_posts: int,
        include_top: bool    = True,
        include_recent: bool = True,
        recent_pages: int    = 5,
        rate_limit_wait: int = RATE_LIMIT_WAIT_DEFAULT,
    ) -> Dict:
        out: Dict = {
            "posts": [], "media_count": 0, "formatted_media_count": "",
            "top_count": 0, "recent_count": 0, "method": "", "error": None,
        }

        # ── Strategy 1: GraphQL ─────────────────────────────────
        print(Fore.CYAN + f"\n   📡 [Strategy 1] GraphQL (#{tag})")
        gql_posts, gql_mc = self._fetch_hashtag_via_graphql(tag, max_posts, rate_limit_wait)
        if gql_posts:
            out["posts"]                 = gql_posts[:max_posts]
            out["media_count"]           = gql_mc
            out["formatted_media_count"] = self._fmt_count(gql_mc)
            out["top_count"]             = sum(1 for p in gql_posts if "top" in p.get("source", ""))
            out["recent_count"]          = sum(1 for p in gql_posts if "top" not in p.get("source", ""))
            out["method"]                = "graphql"
            print(Fore.GREEN + f"   ✅ GraphQL: {len(out['posts'])} posts")
            return out

        print(Fore.YELLOW + "   ↩️  GraphQL kosong → coba CDP Direct...")

        # ── Strategy 2: CDP Direct ──────────────────────────────
        print(Fore.CYAN + f"   📡 [Strategy 2] CDP Direct (#{tag})")
        cdp_posts = self._fetch_hashtag_via_cdp(tag, max_posts, rate_limit_wait)
        if cdp_posts:
            out["posts"]        = cdp_posts[:max_posts]
            out["recent_count"] = len(cdp_posts)
            out["method"]       = "cdp_direct"
            print(Fore.GREEN + f"   ✅ CDP Direct: {len(out['posts'])} posts")
            return out

        print(Fore.YELLOW + "   ↩️  CDP kosong → coba REST...")

        # ── Strategy 3: REST ────────────────────────────────────
        print(Fore.CYAN + f"   📡 [Strategy 3] REST /api/v1/tags/ (#{tag})")
        rest_posts, mc, fmc = self._fetch_hashtag_via_rest(
            tag, max_posts, include_top, include_recent, recent_pages, rate_limit_wait,
        )
        if rest_posts:
            out["posts"]                 = rest_posts[:max_posts]
            out["media_count"]           = mc
            out["formatted_media_count"] = fmc
            out["top_count"]             = sum(1 for p in rest_posts if p["source"] == "top")
            out["recent_count"]          = sum(1 for p in rest_posts if p["source"] != "top")
            out["method"]                = "rest"
            print(Fore.GREEN + f"   ✅ REST: {len(out['posts'])} posts")
            return out

        print(Fore.RED + f"   ❌ Semua strategy gagal untuk #{tag}")
        out["error"] = "all_strategies_failed"
        return out

    # ════════════════════════════════════════════════════════════
    # TOPSEARCH — dengan retry + fallback
    # ════════════════════════════════════════════════════════════

    def _topsearch(self, query: str) -> Dict:
        out  = {"hashtags": [], "users": [], "places": []}
        path = (
            f"/api/v1/web/search/topsearch/"
            f"?context=blended&query={quote(query)}&include_reel=true"
        )
        data = self._api_get_robust(path)
        if not data:
            return out

        for h in (data.get("hashtags", []) or []):
            ht   = h.get("hashtag", {}) or {}
            name = ht.get("name", "")
            if not name:
                continue
            mc = int(ht.get("media_count", 0) or 0)
            out["hashtags"].append({
                "name":                   name,
                "media_count":            mc,
                "formatted_media_count":  self._fmt_count(mc),
                "id":                     str(ht.get("id", "")),
                "search_result_subtitle": ht.get("search_result_subtitle", ""),
            })

        for u in (data.get("users", []) or []):
            us = u.get("user", {}) or {}
            un = us.get("username", "")
            if not un:
                continue
            out["users"].append({
                "username":        un,
                "full_name":       us.get("full_name", ""),
                "profile_pic_url": us.get("profile_pic_url", ""),
                "is_verified":     bool(us.get("is_verified", False)),
                "is_private":      bool(us.get("is_private", False)),
                "follower_count":  int(us.get("follower_count", 0) or 0),
            })

        for p in (data.get("places", []) or []):
            pl  = p.get("place", {}) or {}
            loc = pl.get("location", {}) or {}
            nm  = loc.get("name", "") or pl.get("title", "")
            if not nm:
                continue
            out["places"].append({
                "name":    nm,
                "address": loc.get("address", ""),
                "city":    loc.get("city", ""),
            })

        return out

    # ════════════════════════════════════════════════════════════
    # PARSING HELPERS
    # ════════════════════════════════════════════════════════════

    @staticmethod
    def _normalize_hashtag(raw: str) -> str:
        s = (raw or "").strip().lstrip("#")
        s = re.sub(r"\s+", "", s)
        s = re.sub(r"[^0-9A-Za-z_\u00C0-\uFFFF]", "", s)
        return s.lower()

    @staticmethod
    def _fmt_count(n) -> str:
        n = int(n or 0)
        if n >= 1_000_000:
            return f"{n/1_000_000:.1f}".rstrip("0").rstrip(".") + "M"
        if n >= 1_000:
            return f"{n/1_000:.1f}".rstrip("0").rstrip(".") + "K"
        return str(n)

    @staticmethod
    def _post_url(code: str, product_type: str = "") -> str:
        if product_type in ("clips", "reels"):
            return f"https://www.instagram.com/reel/{code}/"
        return f"https://www.instagram.com/p/{code}/"

    def _parse_media(self, media: Dict, source: str, rank: int) -> Optional[Dict]:
        """Parse media object dari REST /api/v1/tags/ response."""
        if not media:
            return None
        code = media.get("code", "")
        if not code:
            return None

        pk           = str(media.get("pk") or media.get("id") or "")
        user         = media.get("user", {}) or {}
        cap          = media.get("caption") or {}
        caption_text = cap.get("text", "") if isinstance(cap, dict) else ""
        mtype        = {1: "PHOTO", 2: "VIDEO", 8: "CAROUSEL"}.get(media.get("media_type", 0), "UNKNOWN")
        product_type = media.get("product_type", "") or ""
        taken_at     = int(media.get("taken_at", 0) or 0)
        iso          = ""
        if taken_at:
            try:
                iso = datetime.fromtimestamp(taken_at).isoformat()
            except Exception:
                iso = ""

        thumb = ""
        cands = (media.get("image_versions2", {}) or {}).get("candidates", []) or []
        if cands:
            thumb = cands[0].get("url", "")
        if not thumb:
            thumb = media.get("thumbnail_src") or media.get("display_url") or ""

        return {
            "media_id":          pk,
            "shortcode":         code,
            "url":               self._post_url(code, product_type),
            "owner_username":    user.get("username", ""),
            "owner_full_name":   user.get("full_name", ""),
            "owner_is_verified": bool(user.get("is_verified", False)),
            "caption":           caption_text[:500],
            "like_count":        int(media.get("like_count", 0) or 0),
            "comment_count":     int(media.get("comment_count", 0) or 0),
            "view_count":        int(
                media.get("view_count") or media.get("play_count")
                or media.get("ig_play_count") or 0
            ),
            "play_count":        int(media.get("play_count") or media.get("ig_play_count") or 0),
            "taken_at":          taken_at,
            "taken_at_iso":      iso,
            "media_type":        mtype,
            "product_type":      product_type,
            "thumbnail_url":     thumb,
            "is_video":          mtype == "VIDEO",
            "source":            source,
            "rank":              rank,
        }

    def _parse_media_graphql(self, node: Dict, source: str, rank: int) -> Optional[Dict]:
        """Parse node dari GraphQL response."""
        if not node:
            return None
        code = node.get("shortcode", "")
        if not code:
            return None

        pk          = str(node.get("id", ""))
        owner       = node.get("owner", {}) or {}
        caption_raw = node.get("edge_media_to_caption", {})
        caption_text = ""
        if isinstance(caption_raw, dict):
            edges_c = caption_raw.get("edges", [])
            if edges_c:
                caption_text = edges_c[0].get("node", {}).get("text", "")

        is_video     = bool(node.get("is_video", False))
        mtype        = "VIDEO" if is_video else "PHOTO"
        # Carousel detection
        if node.get("__typename") == "GraphSidecar":
            mtype = "CAROUSEL"
        taken_at     = int(node.get("taken_at_timestamp", 0) or 0)
        iso          = ""
        if taken_at:
            try:
                iso = datetime.fromtimestamp(taken_at).isoformat()
            except Exception:
                iso = ""

        thumb        = node.get("thumbnail_src") or node.get("display_url") or ""
        product_type = "clips" if is_video else ""

        return {
            "media_id":          pk,
            "shortcode":         code,
            "url":               self._post_url(code, product_type),
            "owner_username":    owner.get("username", ""),
            "owner_full_name":   owner.get("full_name", ""),
            "owner_is_verified": bool(owner.get("is_verified", False)),
            "caption":           caption_text[:500],
            "like_count":        int(
                node.get("edge_liked_by", {}).get("count", 0)
                or node.get("edge_media_preview_like", {}).get("count", 0)
                or 0
            ),
            "comment_count":     int(
                node.get("edge_media_to_comment", {}).get("count", 0)
                or node.get("edge_media_preview_comment", {}).get("count", 0)
                or 0
            ),
            "view_count":        int(node.get("video_view_count", 0) or 0),
            "play_count":        int(node.get("video_play_count", 0) or 0),
            "taken_at":          taken_at,
            "taken_at_iso":      iso,
            "media_type":        mtype,
            "product_type":      product_type,
            "thumbnail_url":     thumb,
            "is_video":          is_video,
            "source":            source,
            "rank":              rank,
        }

    @staticmethod
    def _extract_medias_from_sections(sections: List[Dict]) -> List[Dict]:
        medias = []
        for section in sections or []:
            lc = section.get("layout_content", {}) or {}
            for m in lc.get("medias", []) or []:
                if m.get("media"):
                    medias.append(m["media"])
            clips = (lc.get("one_by_two_item", {}) or {}).get("clips", {}) or {}
            for it in clips.get("items", []) or []:
                if it.get("media"):
                    medias.append(it["media"])
            for m in lc.get("fill_items", []) or []:
                if m.get("media"):
                    medias.append(m["media"])
        return medias

    # ════════════════════════════════════════════════════════════
    # PUBLIC API
    # ════════════════════════════════════════════════════════════

    def discover(self, query: str, max_hashtags: int = 20, max_users: int = 20) -> Dict:
        result = {
            "query": query, "scraped_at": datetime.now().isoformat(),
            "success": False, "hashtags": [], "users": [], "places": [], "error": None,
        }
        if not (query or "").strip():
            result["error"] = "Query kosong"
            return result
        print(Fore.CYAN + f"\n🔎 DISCOVER: '{query}'")
        try:
            self._ensure_ready()
            out = self._topsearch(query.strip())
            result["hashtags"] = out["hashtags"][:max_hashtags]
            result["users"]    = out["users"][:max_users]
            result["places"]   = out["places"][:10]
            result["success"]  = True
            print(Fore.GREEN + f"   ✅ {len(result['hashtags'])} hashtag · "
                  f"{len(result['users'])} akun · {len(result['places'])} tempat")
        except Exception as e:
            traceback.print_exc()
            result["error"] = str(e)
        return result

    def search_hashtag(
        self,
        hashtag: str,
        max_posts: int       = 60,
        include_top: bool    = True,
        include_recent: bool = True,
        recent_pages: int    = 5,
    ) -> Dict:
        tag = self._normalize_hashtag(hashtag)
        result: Dict = {
            "query": hashtag, "hashtag": tag,
            "media_count": 0, "formatted_media_count": "",
            "scraped_at": datetime.now().isoformat(),
            "scraped_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "success": False,
            "top_count": 0, "recent_count": 0, "total_fetched": 0,
            "method": "", "posts": [], "related_hashtags": [], "error": None,
        }
        if not tag:
            result["error"] = "Hashtag tidak valid"
            return result

        print(Fore.CYAN + "\n" + "=" * 70)
        print(Fore.CYAN + f"🔎 SEARCH HASHTAG: #{tag}  (max_posts={max_posts})")
        print(Fore.CYAN + "=" * 70)
        try:
            self._ensure_ready()
            try:
                result["related_hashtags"] = self._topsearch(tag).get("hashtags", [])[:12]
            except Exception:
                pass

            collected = self._collect_hashtag_posts(
                tag, max_posts, include_top, include_recent, recent_pages,
            )
            if collected.get("error") == "all_strategies_failed" and not collected["posts"]:
                result["error"] = (
                    "Semua strategy gagal. "
                    "Hashtag mungkin tidak ada, diblokir, atau sesi perlu di-refresh."
                )
                return result

            result.update({
                "media_count":           collected["media_count"],
                "formatted_media_count": collected["formatted_media_count"],
                "top_count":             collected["top_count"],
                "recent_count":          collected["recent_count"],
                "posts":                 collected["posts"],
                "total_fetched":         len(collected["posts"]),
                "method":                collected.get("method", ""),
                "success":               True,
            })
            print(Fore.GREEN + f"\n✅ #{tag}: {result['total_fetched']} post "
                  f"via {result['method']} | total IG: {result['formatted_media_count']}")
        except Exception as e:
            traceback.print_exc()
            result["error"] = str(e)
        return result

    def search_keyword(
        self,
        keyword: str,
        max_posts: int          = 60,
        max_hashtags: int       = 3,
        per_hashtag_pages: int  = 1,
        include_recent: bool    = True,
    ) -> Dict:
        result: Dict = {
            "query": keyword,
            "scraped_at": datetime.now().isoformat(),
            "scraped_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "success": False,
            "searched_hashtags": [], "suggested_hashtags": [],
            "suggested_users": [], "total_fetched": 0,
            "posts": [], "error": None,
        }
        kw = (keyword or "").strip()
        if not kw:
            result["error"] = "Keyword kosong"
            return result

        print(Fore.CYAN + "\n" + "=" * 70)
        print(Fore.CYAN + f"🔎 SEARCH KEYWORD: '{kw}'  (max_posts={max_posts}, max_hashtags={max_hashtags})")
        print(Fore.CYAN + "=" * 70)
        try:
            self._ensure_ready()
            disc = self._topsearch(kw)
            result["suggested_hashtags"] = disc["hashtags"][:20]
            result["suggested_users"]    = disc["users"][:10]

            candidate_tags = [h["name"] for h in disc["hashtags"] if h.get("name")]
            if not candidate_tags:
                fb = self._normalize_hashtag(kw)
                if fb:
                    candidate_tags = [fb]
            if not candidate_tags:
                result["error"] = "Tidak ada hashtag relevan ditemukan."
                return result

            chosen = candidate_tags[:max_hashtags]
            print(Fore.CYAN + f"   🏷️  Hashtag dipilih: {', '.join('#'+t for t in chosen)}")

            seen: set = set()
            agg:  List[Dict] = []

            for idx, tag in enumerate(chosen, 1):
                print(Fore.CYAN + f"\n   [{idx}/{len(chosen)}] #{tag}...")
                collected = self._collect_hashtag_posts(
                    tag, max_posts=max_posts,
                    include_top=True, include_recent=include_recent,
                    recent_pages=per_hashtag_pages,
                )
                result["searched_hashtags"].append({
                    "hashtag": tag,
                    "method":  collected.get("method", ""),
                    "fetched": len(collected["posts"]),
                })
                for p in collected["posts"]:
                    key = p["media_id"] or p["shortcode"]
                    if key in seen:
                        continue
                    seen.add(key)
                    agg.append({**p, "hashtag": tag})
                if idx < len(chosen):
                    time.sleep(random.uniform(2.5, 4.5))

            agg.sort(
                key=lambda x: (x.get("like_count", 0), x.get("comment_count", 0)),
                reverse=True,
            )
            agg = agg[:max_posts]
            for i, p in enumerate(agg, 1):
                p["rank"] = i

            result["posts"]         = agg
            result["total_fetched"] = len(agg)
            result["success"]       = True
            print(Fore.GREEN + f"\n✅ '{kw}': {len(agg)} post dari {len(chosen)} hashtag")
        except Exception as e:
            traceback.print_exc()
            result["error"] = str(e)
        return result

    def _save(self, data: Dict, filename: str) -> str:
        fp = os.path.join(OUTPUT_DIR, filename)
        with open(fp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2, default=str)
        print(Fore.GREEN + f"💾 Saved: {fp}")
        return fp

    def run(self):
        print(Fore.CYAN + "\n" + "=" * 70)
        print(Fore.CYAN + "  INSTAGRAM SEARCH SCRAPER V3")
        print(Fore.CYAN + "  Strategy: GraphQL (cursor) → CDP Direct → REST")
        print(Fore.CYAN + "=" * 70)
        while True:
            print(Fore.CYAN + "\n📋 MENU")
            print("  1. Search by Hashtag")
            print("  2. Search by Keyword")
            print("  3. Discover")
            print("  4. Exit")
            choice = input("\nPilih [1-4]: ").strip()
            if choice == "1":
                tag = input("Hashtag (tanpa #): ").strip()
                if not tag:
                    continue
                raw = input("Max posts [60]: ").strip()
                mp  = int(raw) if raw.isdigit() else 60
                raw = input("Recent pages [5]: ").strip()
                rp  = int(raw) if raw.isdigit() else 5
                res = self.search_hashtag(tag, max_posts=mp, recent_pages=rp)
                self._save(
                    res,
                    f"search_tag_{self._normalize_hashtag(tag)}"
                    f"_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json",
                )
            elif choice == "2":
                kw = input("Keyword: ").strip()
                if not kw:
                    continue
                raw = input("Max posts [60]: ").strip()
                mp  = int(raw) if raw.isdigit() else 60
                raw = input("Max hashtags [3]: ").strip()
                mh  = int(raw) if raw.isdigit() else 3
                res = self.search_keyword(kw, max_posts=mp, max_hashtags=mh)
                self._save(res, f"search_kw_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
            elif choice == "3":
                q = input("Query: ").strip()
                if not q:
                    continue
                res = self.discover(q)
                print(json.dumps(res, ensure_ascii=False, indent=2, default=str)[:2000])
            elif choice == "4":
                print(Fore.CYAN + "\n👋 Bye!")
                break
            else:
                print(Fore.RED + "❌ Pilihan tidak valid")


if __name__ == "__main__":
    with InstagramSearchScraper() as scraper:
        scraper.run()