"""
profile_scraper.py
==================
Scrape data lengkap profile Instagram + Followers + Following + Verified Following
+ Posts dengan filter tanggal + komentar & replies per post.

CHANGELOG:
- Bug `bio[1];` di HTML parser fixed
- Rate-limit backoff + early-stop saat target verified tercapai
- FIX UTAMA: ganti GraphQL query_hash (sudah mati) → v1 API
  /api/v1/friendships/{user_id}/following/ (lebih stabil & reliable)
- FIX: dedup items by user_id/username sebelum return agar tidak ada duplikat
- NEW: scrape_profile_posts() — scrape semua post dalam rentang tanggal
  + komentar (top-level) + replies per komentar
"""
import os
import re
import json
import time
import random
import traceback
import requests
from datetime import datetime
from typing import Dict, List, Optional, Any
from cookie_injector import inject_cookies_sync, has_valid_session

from dotenv import load_dotenv
from colorama import Fore, init
from playwright.sync_api import sync_playwright, Page, BrowserContext, TimeoutError as PlaywrightTimeout

init(autoreset=True)
load_dotenv()

# ── CONFIG ─────────────────────────────────────────────────────────────────
HEADLESS    = os.getenv("HEADLESS", "true").lower() == "true"
PROXY       = os.getenv("PROXY", "")
PROFILE_DIR = os.getenv("PROFILE_DIR", "chrome_profile_playwright")
CHROME_PROFILE = os.path.join(os.getcwd(), PROFILE_DIR)


def _empty_profile_fields(username: str) -> Dict[str, Any]:
    return {
        "user_id":          "",
        "username":         username,
        "full_name":        "",
        "biography":        "",
        "external_url":     "",
        "external_url_linkshimmed": "",
        "bio_links":        [],
        "category":         "",
        "category_enum":    "",
        "business_email":   "",
        "business_phone":   "",
        "business_address": "",
        "is_verified":      False,
        "is_private":       False,
        "is_business":      False,
        "is_professional":  False,
        "is_joined_recently": False,
        "profile_pic_url":  "",
        "profile_pic_url_hd": "",
        "followers":        0,
        "following":        0,
        "posts_count":      0,
        "recent_posts":     [],
    }


class InstagramProfileScraper:
    def __init__(self):
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.session: Optional[requests.Session] = None
        self.playwright = None
        self._last_scan_count = 0

        os.makedirs(CHROME_PROFILE, exist_ok=True)
        if has_valid_session():
            print(Fore.GREEN + "🍪 Login via cookie session")
        else:
            print(Fore.YELLOW + f"⚠️  Belum ada cookie session, pakai folder {CHROME_PROFILE}")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    # ════════════════════════════════════════════════════════════════════════
    # ASSERT HELPERS
    # ════════════════════════════════════════════════════════════════════════

    def _assert_page(self) -> Page:
        if self.page is None:
            raise RuntimeError("Browser page belum diinisialisasi.")
        return self.page

    def _assert_session(self) -> requests.Session:
        if self.session is None:
            raise RuntimeError("Requests session belum diinisialisasi.")
        return self.session

    def _assert_context(self) -> BrowserContext:
        if self.context is None:
            raise RuntimeError("Browser context belum diinisialisasi.")
        return self.context

    # ════════════════════════════════════════════════════════════════════════
    # BROWSER SETUP
    # ════════════════════════════════════════════════════════════════════════

    def _build_context(self) -> BrowserContext:
        self.playwright = sync_playwright().start()

        args = [
            "--start-maximized" if not HEADLESS else "",
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
        args = [a for a in args if a]

        stealth_script = r"""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
            Object.defineProperty(navigator, 'deviceMemory', {get: () => 8});
            Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 4});
            delete navigator.__proto__.webdriver;
        """

        context = self.playwright.chromium.launch_persistent_context(
            CHROME_PROFILE,
            headless=HEADLESS,
            args=args,
            viewport={"width": 1920, "height": 1080} if not HEADLESS else {"width": 1366, "height": 768},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
            locale="en-US",
            timezone_id="Asia/Jakarta",
            bypass_csp=True,
            java_script_enabled=True,
        )
        context.on("page", lambda p: p.add_init_script(stealth_script))

        try:
            if has_valid_session():
                n = inject_cookies_sync(context)
                print(Fore.GREEN + f"🍪 Inject {n} cookies dari session file")
        except Exception as e:
            print(Fore.YELLOW + f"⚠️  Cookie inject dilewati: {e}")

        return context

    def initialize_browser(self):
        if self.context:
            return

        print(Fore.CYAN + "\n🌐 Membuka browser (Playwright)...")
        self.context = self._build_context()
        self.page = self.context.pages[0] if self.context.pages else self.context.new_page()

        def block_heavy(route):
            rt = route.request.resource_type
            url = route.request.url.lower()
            if rt in ["image", "media", "font"]:
                if "favicon" in url or "icon" in url:
                    route.continue_()
                else:
                    route.abort()
            else:
                route.continue_()

        page = self._assert_page()
        page.route("**/*", block_heavy)

        page.goto("https://www.instagram.com/")
        time.sleep(5)
        self._close_popups()

        if "login" in page.url:
            print(Fore.YELLOW + "⚠️  URL mengandung 'login' — cookie mungkin belum aktif, tetap lanjut coba.")
        else:
            print(Fore.GREEN + "✅ Browser siap (LOGGED IN)")

    def _close_popups(self):
        if self.page is None:
            return
        popup_selectors = [
            "text=Not Now", "text=Sekarang tidak", "text=Cancel",
            "text=Batal", "text=Turn Off", "text=Save Info",
            "button:has-text('Not Now')",
        ]
        for sel in popup_selectors:
            try:
                if self.page.locator(sel).count() > 0:
                    self.page.locator(sel).first.click(timeout=2000)
                    time.sleep(0.5)
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

    # ════════════════════════════════════════════════════════════════════════
    # REQUESTS SESSION
    # ════════════════════════════════════════════════════════════════════════

    def _build_requests_session(self) -> requests.Session:
        sess = requests.Session()
        context = self._assert_context()
        cookies = context.cookies()

        for c in cookies:
            name = c.get("name")
            value = c.get("value")
            if name is None or value is None:
                continue
            sess.cookies.set(name, value, domain=c.get("domain", ".instagram.com"))

        csrf = ""
        for c in cookies:
            if c.get("name") == "csrftoken":
                csrf = c.get("value", "")
                break

        sess.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-IG-App-ID': '936619743392459',
            'X-ASBD-ID': '129477',
            'X-IG-WWW-Claim': '0',
            'X-CSRFToken': csrf,
            'X-Requested-With': 'XMLHttpRequest',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Referer': 'https://www.instagram.com/',
            'Origin': 'https://www.instagram.com',
        })
        self.session = sess
        return sess

    # ════════════════════════════════════════════════════════════════════════
    # USER ID & PROFILE
    # ════════════════════════════════════════════════════════════════════════

    def _get_user_id(self, username: str) -> str:
        page = self._assert_page()

        try:
            user_id = page.evaluate(r"""() => {
                const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
                for (const s of scripts) {
                    try {
                        const data = JSON.parse(s.textContent);
                        const str = JSON.stringify(data);
                        const m = str.match(/"id":"(\d+)","username":"[^"]+"/);
                        if (m) return m[1];
                        const m2 = str.match(/"user_id":"(\d+)"/);
                        if (m2) return m2[1];
                    } catch(e) {}
                }
                if (window._sharedData && window._sharedData.entry_data) {
                    const pd = window._sharedData.entry_data.ProfilePage;
                    if (pd && pd[0] && pd[0].graphql && pd[0].graphql.user) {
                        return pd[0].graphql.user.id;
                    }
                }
                return "";
            }""")
            if user_id:
                return user_id
        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  Gagal ambil user_id dari page: {e}")

        try:
            sess = self._assert_session()
            resp = sess.get(
                "https://www.instagram.com/api/v1/users/web_profile_info/",
                params={"username": username},
                timeout=15,
            )
            if resp.status_code == 200:
                data = resp.json()
                uid = data.get("data", {}).get("user", {}).get("id", "")
                if uid:
                    return uid
        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  Fallback user_id gagal: {e}")

        return ""

    def _fetch_via_web_profile_api(self, username: str) -> Dict[str, Any]:
        url = "https://www.instagram.com/api/v1/users/web_profile_info/"
        try:
            session = self._assert_session()
            resp = session.get(url, params={"username": username}, timeout=15)

            if resp.status_code != 200:
                print(Fore.YELLOW + f"   ⚠️  Web Profile API status {resp.status_code}")
                return {}
            if 'json' not in resp.headers.get('content-type', ''):
                print(Fore.YELLOW + "   ⚠️  Web Profile API response bukan JSON")
                return {}

            data = resp.json()
            user = data.get("data", {}).get("user", {})
            if not user:
                return {}

            return self._normalize_user(user)
        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  Web Profile API error: {e}")
            return {}

    def _fetch_via_cdp(self, username: str) -> Dict[str, Any]:
        try:
            page = self._assert_page()
            result = page.evaluate(r"""(username) => {
                return (async () => {
                    try {
                        const resp = await fetch(
                            `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
                            {
                                method: 'GET',
                                credentials: 'include',
                                headers: {
                                    'X-IG-App-ID': '936619743392459',
                                    'X-ASBD-ID': '129477',
                                    'X-Requested-With': 'XMLHttpRequest',
                                    'Accept': '*/*',
                                }
                            }
                        );
                        const data = await resp.json();
                        return {ok: true, data: data};
                    } catch(e) {
                        return {ok: false, error: e.toString()};
                    }
                })();
            }""", username)

            if not result.get("ok"):
                print(Fore.YELLOW + f"   ⚠️  CDP error: {result.get('error')}")
                return {}

            user = result["data"].get("data", {}).get("user", {})
            if not user:
                return {}
            return self._normalize_user(user)
        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  CDP profile error: {e}")
            return {}

    def _fetch_via_html(self, username: str) -> Dict[str, Any]:
        try:
            page = self._assert_page()
            page.goto(f"https://www.instagram.com/{username}/")
            time.sleep(5)
            self._close_popups()

            data = page.evaluate(r"""() => {
                const result = {};

                const metaDesc = document.querySelector('meta[property="og:description"]');
                if (metaDesc) result.meta_description = metaDesc.content;

                const metaTitle = document.querySelector('meta[property="og:title"]');
                if (metaTitle) result.meta_title = metaTitle.content;

                const metaImg = document.querySelector('meta[property="og:image"]');
                if (metaImg) result.profile_pic_url = metaImg.content;

                const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
                for (const s of scripts) {
                    try {
                        const json = JSON.parse(s.textContent);
                        const str = JSON.stringify(json);

                        const followers = str.match(/"edge_followed_by":\{"count":(\d+)/);
                        if (followers && !result.followers) result.followers = parseInt(followers[1]);

                        const following = str.match(/"edge_follow":\{"count":(\d+)/);
                        if (following && !result.following) result.following = parseInt(following[1]);

                        const posts = str.match(/"edge_owner_to_timeline_media":\{"count":(\d+)/);
                        if (posts && !result.posts_count) result.posts_count = parseInt(posts[1]);

                        const verified = str.match(/"is_verified":(true|false)/);
                        if (verified && result.is_verified === undefined) result.is_verified = verified[1] === 'true';

                        const fullName = str.match(/"full_name":"([^"]+)"/);
                        if (fullName && !result.full_name) result.full_name = fullName[1];

                        const bio = str.match(/"biography":"([^"]*)"/);
                        if (bio && !result.biography) result.biography = bio[1];

                        const externalUrl = str.match(/"external_url":"([^"]*)"/);
                        if (externalUrl && !result.external_url) result.external_url = externalUrl[1];

                        const category = str.match(/"category_name":"([^"]*)"/);
                        if (category && !result.category) result.category = category[1];
                    } catch(e) {}
                }

                if (result.meta_description) {
                    const md = result.meta_description.replace(/,/g, '');
                    const fm = md.match(/([\d.KMB]+)\s+Followers/i);
                    const fmw = md.match(/([\d.KMB]+)\s+Following/i);
                    const pm = md.match(/([\d.KMB]+)\s+Posts/i);
                    if (fm && !result.followers_str) result.followers_str = fm[1];
                    if (fmw && !result.following_str) result.following_str = fmw[1];
                    if (pm && !result.posts_count_str) result.posts_count_str = pm[1];
                }

                return result;
            }""")

            return self._normalize_html(data, username)
        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  HTML parse error: {e}")
            return {}

    # ════════════════════════════════════════════════════════════════════════
    # NORMALIZE
    # ════════════════════════════════════════════════════════════════════════

    def _normalize_user(self, user: Dict[str, Any]) -> Dict[str, Any]:
        followers = user.get("edge_followed_by", {}).get("count", 0)
        following = user.get("edge_follow", {}).get("count", 0)
        posts_count = user.get("edge_owner_to_timeline_media", {}).get("count", 0)

        recent_posts = []
        timeline = user.get("edge_owner_to_timeline_media", {}).get("edges", [])
        for edge in timeline[:12]:
            node = edge.get("node", {})
            recent_posts.append({
                "shortcode":  node.get("shortcode", ""),
                "id":         node.get("id", ""),
                "media_type": self._map_media_type(node),
                "likes":      node.get("edge_liked_by", {}).get("count", 0) or
                              node.get("edge_media_preview_like", {}).get("count", 0),
                "comments":   node.get("edge_media_to_comment", {}).get("count", 0),
                "views":      node.get("video_view_count", 0) or 0,
                "is_video":   node.get("is_video", False),
                "taken_at":   node.get("taken_at_timestamp", 0),
                "caption":    self._extract_caption(node)[:200],
                "url":        f"https://www.instagram.com/p/{node.get('shortcode', '')}/",
                "thumbnail_url": node.get("thumbnail_src") or node.get("display_url") or "",
            })

        out = _empty_profile_fields(user.get("username", ""))
        out.update({
            "user_id":             user.get("id", ""),
            "username":            user.get("username", ""),
            "full_name":           user.get("full_name", ""),
            "biography":           user.get("biography", ""),
            "external_url":        user.get("external_url", "") or "",
            "external_url_linkshimmed": user.get("external_url_linkshimmed", "") or "",
            "bio_links":           [
                {"title": link.get("title", ""), "url": link.get("url", "")}
                for link in (user.get("bio_links") or [])
            ],
            "category":            user.get("category_name", "") or user.get("category", "") or "",
            "category_enum":       user.get("category_enum", "") or "",
            "business_email":      user.get("business_email", "") or "",
            "business_phone":      user.get("business_phone_number", "") or "",
            "business_address":    user.get("business_address_json", "") or "",
            "is_verified":         bool(user.get("is_verified", False)),
            "is_private":          bool(user.get("is_private", False)),
            "is_business":         bool(user.get("is_business_account", False)),
            "is_professional":     bool(user.get("is_professional_account", False)),
            "is_joined_recently":  bool(user.get("is_joined_recently", False)),
            "profile_pic_url":     user.get("profile_pic_url", "") or "",
            "profile_pic_url_hd":  user.get("profile_pic_url_hd", "") or "",
            "followers":           followers,
            "following":           following,
            "posts_count":         posts_count,
            "recent_posts":        recent_posts,
        })
        return out

    def _normalize_html(self, raw: Dict[str, Any], username: str) -> Dict[str, Any]:
        def to_int(val: Any) -> int:
            if isinstance(val, int):
                return val
            if isinstance(val, str):
                v = val.upper().replace(",", "").strip()
                multiplier = 1
                if v.endswith("K"):
                    multiplier = 1_000
                    v = v[:-1]
                elif v.endswith("M"):
                    multiplier = 1_000_000
                    v = v[:-1]
                elif v.endswith("B"):
                    multiplier = 1_000_000_000
                    v = v[:-1]
                try:
                    return int(float(v) * multiplier)
                except (ValueError, TypeError):
                    return 0
            return 0

        followers = raw.get("followers") or to_int(raw.get("followers_str", "0"))
        following = raw.get("following") or to_int(raw.get("following_str", "0"))
        posts = raw.get("posts_count") or to_int(raw.get("posts_count_str", "0"))

        out = _empty_profile_fields(username)
        out.update({
            "full_name":       raw.get("full_name", ""),
            "biography":       raw.get("biography", ""),
            "external_url":    raw.get("external_url", ""),
            "category":        raw.get("category", ""),
            "is_verified":     raw.get("is_verified", False),
            "profile_pic_url": raw.get("profile_pic_url", ""),
            "followers":       followers,
            "following":       following,
            "posts_count":     posts,
        })
        return out

    @staticmethod
    def _map_media_type(node: Dict[str, Any]) -> str:
        typename = node.get("__typename", "")
        if typename == "GraphSidecar":
            return "CAROUSEL"
        if typename == "GraphVideo" or node.get("is_video"):
            return "VIDEO"
        if typename == "GraphImage":
            return "PHOTO"
        pt = node.get("product_type", "")
        if pt == "clips":
            return "VIDEO"
        return "PHOTO"

    @staticmethod
    def _extract_caption(node: Dict[str, Any]) -> str:
        edges = node.get("edge_media_to_caption", {}).get("edges", [])
        if edges:
            return edges[0].get("node", {}).get("text", "") or ""
        return ""

    # ════════════════════════════════════════════════════════════════════════
    # FOLLOWERS / FOLLOWING — v1 API
    # ════════════════════════════════════════════════════════════════════════

    @staticmethod
    def _dedup_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        seen: set = set()
        unique: List[Dict[str, Any]] = []
        for item in items:
            key = item.get("user_id") or item.get("username")
            if not key or key in seen:
                continue
            seen.add(key)
            unique.append(item)
        return unique

    def _fetch_followers_or_following(
        self,
        username: str,
        user_id: str,
        kind: str,
        max_count: int = 200,
        only_verified: bool = False,
        verified_target: int = 0,
    ) -> List[Dict[str, Any]]:
        if not user_id:
            print(Fore.YELLOW + f"   ⚠️  user_id kosong, tidak bisa ambil {kind}")
            return []

        all_items: List[Dict[str, Any]] = []
        total_scanned = 0
        max_id = None
        page_num = 0
        max_pages = 200
        consecutive_errors = 0

        page = self._assert_page()
        endpoint = "followers" if kind == "followers" else "following"

        while page_num < max_pages:
            if only_verified and verified_target > 0:
                if len(all_items) >= verified_target:
                    print(Fore.GREEN + f"   ✅ Target {verified_target} verified tercapai, stop.")
                    break
                if total_scanned >= max_count:
                    print(Fore.YELLOW + f"   ⏹️  Max scan {max_count} tercapai, stop.")
                    break
            else:
                if len(all_items) >= max_count:
                    break

            page_num += 1
            params = {"user_id": user_id, "endpoint": endpoint, "max_id": max_id or ""}

            try:
                result = page.evaluate(r"""(params) => {
                    const { user_id, endpoint, max_id } = params;
                    return (async () => {
                        try {
                            let url = `https://i.instagram.com/api/v1/friendships/${user_id}/${endpoint}/?count=50`;
                            if (max_id) url += `&max_id=${encodeURIComponent(max_id)}`;
                            const resp = await fetch(url, {
                                method: 'GET',
                                credentials: 'include',
                                headers: {
                                    'X-IG-App-ID': '936619743392459',
                                    'X-ASBD-ID': '129477',
                                    'X-Requested-With': 'XMLHttpRequest',
                                    'Accept': '*/*',
                                }
                            });
                            const status = resp.status;
                            const text = await resp.text();
                            let data = null;
                            try { data = JSON.parse(text); } catch(e) {}
                            return {ok: true, status: status, data: data, raw: data ? null : text.substring(0, 200)};
                        } catch(e) {
                            return {ok: false, error: e.toString()};
                        }
                    })();
                }""", params)

                if not result.get("ok"):
                    consecutive_errors += 1
                    wait = min(60, 5 * consecutive_errors)
                    print(Fore.YELLOW + f"   ⚠️  Fetch error: {result.get('error')} — wait {wait}s")
                    time.sleep(wait)
                    if consecutive_errors >= 3:
                        break
                    continue

                status = result.get("status", 0)
                if status == 429:
                    consecutive_errors += 1
                    wait = min(120, 30 * consecutive_errors)
                    print(Fore.RED + f"   🛑 HTTP 429 rate limit — wait {wait}s")
                    time.sleep(wait)
                    if consecutive_errors >= 3:
                        break
                    continue

                if status != 200:
                    raw = result.get("raw", "")
                    print(Fore.YELLOW + f"   ⚠️  HTTP {status} — raw: {raw[:200]}")
                    consecutive_errors += 1
                    if consecutive_errors >= 3:
                        break
                    time.sleep(10)
                    continue

                data = result.get("data") or {}
                if data.get("status") == "fail":
                    msg = data.get("message", '')
                    print(Fore.YELLOW + f"   ⚠️  API fail: {msg}")
                    if "rate" in msg.lower() or "limit" in msg.lower():
                        time.sleep(60)
                        consecutive_errors += 1
                        if consecutive_errors >= 3:
                            break
                        continue
                    break

                consecutive_errors = 0
                users = data.get("users", [])

                if not users:
                    print(Fore.YELLOW + f"   ⚠️  {kind}: tidak ada users, mungkin private/end-of-list")
                    break

                page_verified_count = 0
                for u in users:
                    total_scanned += 1
                    is_verified = bool(u.get("is_verified", False))

                    if only_verified and not is_verified:
                        continue

                    item = {
                        "username":        u.get("username", ""),
                        "full_name":       u.get("full_name", ""),
                        "user_id":         str(u.get("pk", "") or u.get("pk_id", "") or u.get("id", "")),
                        "is_verified":     is_verified,
                        "is_private":      bool(u.get("is_private", False)),
                        "profile_pic_url": u.get("profile_pic_url", ""),
                    }
                    if item["username"]:
                        all_items.append(item)
                        page_verified_count += 1

                if only_verified:
                    print(Fore.CYAN +
                          f"   📡 page {page_num}: scanned +{len(users)} (total {total_scanned}) | "
                          f"verified +{page_verified_count} (total {len(all_items)})")
                else:
                    print(Fore.CYAN + f"   📡 {kind} page {page_num}: +{len(users)} (total {len(all_items)})")

                next_max_id = data.get("next_max_id")
                if not next_max_id:
                    print(Fore.CYAN + f"   ℹ️  Tidak ada next_max_id, akhir list.")
                    break
                max_id = str(next_max_id)

                time.sleep(random.uniform(2.5, 5.0))

            except Exception as e:
                print(Fore.YELLOW + f"   ⚠️  {kind} exception: {e}")
                consecutive_errors += 1
                if consecutive_errors >= 3:
                    break
                time.sleep(5)

        self._last_scan_count = total_scanned
        unique_items = self._dedup_items(all_items)

        if only_verified and verified_target > 0:
            return unique_items[:verified_target]
        return unique_items[:max_count]

    # ════════════════════════════════════════════════════════════════════════
    # REPLIES (dipakai oleh scrape_profile_posts)
    # ════════════════════════════════════════════════════════════════════════

    def _fetch_replies(self, media_id: str, parent_pk: str, max_replies: int) -> List[Dict[str, Any]]:
        """Cascade: CDP → REST untuk child_comments."""
        if not media_id or not parent_pk:
            return []

        try:
            replies = self._fetch_replies_via_cdp(media_id, parent_pk, max_replies)
            if replies:
                return replies
        except Exception:
            pass

        try:
            return self._fetch_replies_via_rest(media_id, parent_pk, max_replies)
        except Exception:
            return []

    def _fetch_replies_via_cdp(self, media_id: str, parent_pk: str, max_replies: int) -> List[Dict[str, Any]]:
        all_replies: List[Dict[str, Any]] = []
        next_max_id: Optional[str] = None
        page_num = 0
        max_pages = 5
        page = self._assert_page()

        while len(all_replies) < max_replies and page_num < max_pages:
            page_num += 1
            try:
                result = page.evaluate(r"""(params) => {
                    const { mediaId, parentPk, maxId } = params;
                    return (async () => {
                        try {
                            let url = `/api/v1/media/${mediaId}/comments/${parentPk}/child_comments/`;
                            if (maxId) url += `?max_id=${encodeURIComponent(maxId)}`;
                            const resp = await fetch(url, {
                                method: 'GET',
                                credentials: 'include',
                                headers: {
                                    'X-IG-App-ID': '936619743392459',
                                    'X-ASBD-ID': '129477',
                                    'X-Requested-With': 'XMLHttpRequest',
                                    'Accept': '*/*',
                                }
                            });
                            const data = await resp.json();
                            return {ok: true, status: resp.status, data: data};
                        } catch(e) {
                            return {ok: false, error: e.toString()};
                        }
                    })();
                }""", {"mediaId": media_id, "parentPk": parent_pk, "maxId": next_max_id})

                if not result.get("ok"):
                    break
                if result.get("status") and result["status"] != 200:
                    break

                data = result.get("data") or {}
                raw = data.get("child_comments") or data.get("comments") or []
                if not raw:
                    break

                for c in raw:
                    username = c.get("user", {}).get("username", "")
                    text = c.get("text", "")
                    if not username or not text:
                        continue
                    all_replies.append({
                        "username":          username,
                        "text":              text,
                        "comment_id":        str(c.get("pk", "")),
                        "like_count":        int(c.get("comment_like_count", 0) or 0),
                        "created_at":        int(c.get("created_at", 0) or 0),
                        "parent_comment_id": str(parent_pk),
                    })
                    if len(all_replies) >= max_replies:
                        break

                next_max_id = data.get("next_max_id") or data.get("next_min_id")
                has_more = data.get("has_more_comments") or data.get("has_more_headload_comments") or False
                if not next_max_id or not has_more:
                    break

                time.sleep(random.uniform(0.5, 1.2))

            except Exception as e:
                print(Fore.YELLOW + f"      ⚠️  Reply CDP error: {e}")
                break

        return all_replies

    def _fetch_replies_via_rest(self, media_id: str, parent_pk: str, max_replies: int) -> List[Dict[str, Any]]:
        all_replies: List[Dict[str, Any]] = []
        next_max_id: Optional[str] = None
        page_num = 0
        max_pages = 5
        sess = self._assert_session()

        while len(all_replies) < max_replies and page_num < max_pages:
            page_num += 1
            url = f"https://www.instagram.com/api/v1/media/{media_id}/comments/{parent_pk}/child_comments/"
            params: Dict[str, str] = {}
            if next_max_id:
                params["max_id"] = next_max_id

            try:
                resp = sess.get(url, params=params, timeout=15)
                if resp.status_code == 429:
                    time.sleep(45)
                    continue
                if resp.status_code != 200:
                    break
                if 'json' not in resp.headers.get('content-type', ''):
                    break

                data = resp.json()
                raw = data.get("child_comments") or data.get("comments") or []
                if not raw:
                    break

                for c in raw:
                    username = c.get("user", {}).get("username", "")
                    text = c.get("text", "")
                    if not username or not text:
                        continue
                    all_replies.append({
                        "username":          username,
                        "text":              text,
                        "comment_id":        str(c.get("pk", "")),
                        "like_count":        int(c.get("comment_like_count", 0) or 0),
                        "created_at":        int(c.get("created_at", 0) or 0),
                        "parent_comment_id": str(parent_pk),
                    })
                    if len(all_replies) >= max_replies:
                        break

                next_max_id = data.get("next_max_id") or data.get("next_min_id")
                has_more = data.get("has_more_comments") or data.get("has_more_headload_comments") or False
                if not next_max_id or not has_more:
                    break

                time.sleep(random.uniform(0.5, 1.2))

            except Exception as e:
                print(Fore.YELLOW + f"      ⚠️  Reply REST error: {e}")
                break

        return all_replies

    # ════════════════════════════════════════════════════════════════════════
    # SCRAPE_PROFILE_POSTS — FEED USER + FILTER TANGGAL
    # ════════════════════════════════════════════════════════════════════════

    def _fetch_user_feed_page(self, user_id: str, max_id: Optional[str] = None) -> Dict:
        """Fetch satu halaman feed user via CDP."""
        page = self._assert_page()
        try:
            result = page.evaluate(r"""(params) => {
                const { userId, maxId } = params;
                return (async () => {
                    try {
                        let url = `https://i.instagram.com/api/v1/feed/user/${userId}/?count=12`;
                        if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;
                        const resp = await fetch(url, {
                            method: 'GET',
                            credentials: 'include',
                            headers: {
                                'X-IG-App-ID': '936619743392459',
                                'X-ASBD-ID': '129477',
                                'X-Requested-With': 'XMLHttpRequest',
                                'Accept': '*/*',
                            }
                        });
                        const status = resp.status;
                        const data   = await resp.json().catch(() => null);
                        return { ok: true, status, data };
                    } catch(e) {
                        return { ok: false, error: e.toString() };
                    }
                })();
            }""", {"userId": user_id, "maxId": max_id})

            if not result.get("ok"):
                print(Fore.YELLOW + f"   ⚠️  Feed CDP error: {result.get('error')}")
                return {}
            if result.get("status") != 200:
                print(Fore.YELLOW + f"   ⚠️  Feed HTTP {result.get('status')}")
                return {}
            return result.get("data") or {}

        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  _fetch_user_feed_page error: {e}")
            return {}

    def _fetch_user_feed_page_rest(self, user_id: str, max_id: Optional[str] = None) -> Dict:
        """Fallback REST untuk _fetch_user_feed_page."""
        try:
            sess = self._assert_session()
            url = f"https://i.instagram.com/api/v1/feed/user/{user_id}/"
            params: Dict[str, Any] = {"count": 12}
            if max_id:
                params["max_id"] = max_id
            resp = sess.get(url, params=params, timeout=15)
            if resp.status_code != 200:
                print(Fore.YELLOW + f"   ⚠️  Feed REST HTTP {resp.status_code}")
                return {}
            return resp.json()
        except Exception as e:
            print(Fore.YELLOW + f"   ⚠️  _fetch_user_feed_page_rest error: {e}")
            return {}

    @staticmethod
    def _normalize_feed_item(item: Dict) -> Dict:
        """Normalisasi raw item dari /api/v1/feed/user/ menjadi dict terstruktur."""
        media_type_map = {1: "PHOTO", 2: "VIDEO", 8: "CAROUSEL"}
        mt = media_type_map.get(item.get("media_type", 0), "PHOTO")

        # Caption
        cap_node = item.get("caption")
        caption = ""
        if isinstance(cap_node, dict):
            caption = cap_node.get("text", "") or ""
        elif isinstance(cap_node, str):
            caption = cap_node

        # Shortcode / code
        shortcode = item.get("code", "") or item.get("shortcode", "")
        pk = str(item.get("pk", "") or item.get("id", ""))

        # Likes
        like_count = item.get("like_count") or 0
        if isinstance(like_count, dict):
            like_count = like_count.get("count", 0)
        like_count = int(like_count or 0)

        # Comments
        comment_count = int(item.get("comment_count", 0) or 0)

        # Views (video)
        view_count = int(
            item.get("view_count") or
            item.get("ig_play_count") or
            item.get("video_view_count") or 0
        )
        play_count = int(
            item.get("play_count") or
            item.get("ig_play_count") or 0
        )

        # Thumbnail
        thumbnail = ""
        img_versions = item.get("image_versions2", {}).get("candidates", [])
        if img_versions:
            thumbnail = img_versions[0].get("url", "")

        taken_at = int(item.get("taken_at", 0) or 0)

        return {
            "media_id":      pk,
            "shortcode":     shortcode,
            "url":           f"https://www.instagram.com/p/{shortcode}/" if shortcode else "",
            "media_type":    mt,
            "product_type":  item.get("product_type", "") or "",
            "taken_at":      taken_at,
            "taken_at_iso":  datetime.utcfromtimestamp(taken_at).isoformat() + "Z" if taken_at else "",
            "caption":       caption,
            "like_count":    like_count,
            "comment_count": comment_count,
            "view_count":    view_count,
            "play_count":    play_count,
            "thumbnail_url": thumbnail,
            "is_video":      mt == "VIDEO",
            "location":      (item.get("location") or {}).get("name", ""),
        }

    def _fetch_post_comments_simple(
        self,
        media_id: str,
        shortcode: str,
        max_comments: int = 50,
        max_replies: int = 10,
    ) -> List[Dict]:
        """
        Ambil komentar top-level + replies untuk satu post.
        Cascade: REST → CDP. Dipakai oleh scrape_profile_posts.
        """
        if not media_id and not shortcode:
            return []

        sess = self._assert_session()
        comments: List[Dict] = []
        next_min_id: Optional[str] = None
        page_num = 0

        while len(comments) < max_comments and page_num < 20:
            page_num += 1
            try:
                url = f"https://www.instagram.com/api/v1/media/{media_id}/comments/"
                params: Dict[str, Any] = {"can_support_threading": "true"}
                if next_min_id:
                    params["min_id"] = next_min_id

                resp = sess.get(url, params=params, timeout=15)
                if resp.status_code == 429:
                    print(Fore.YELLOW + "      ⚠️  429 comments — tunggu 45s")
                    time.sleep(45)
                    continue
                if resp.status_code != 200:
                    break
                if "json" not in resp.headers.get("content-type", ""):
                    break

                data = resp.json()
                raw = data.get("comments", [])
                if not raw:
                    break

                for c in raw:
                    username    = c.get("user", {}).get("username", "")
                    text        = c.get("text", "")
                    comment_pk  = str(c.get("pk", ""))
                    like_count  = int(c.get("comment_like_count", 0) or 0)
                    created_at  = int(c.get("created_at", 0) or 0)
                    reply_count = int(c.get("child_comment_count", 0) or 0)

                    if not username or not text:
                        continue

                    comment_entry: Dict[str, Any] = {
                        "username":    username,
                        "text":        text,
                        "comment_id":  comment_pk,
                        "like_count":  like_count,
                        "created_at":  created_at,
                        "reply_count": reply_count,
                        "replies":     [],
                    }

                    # Fetch replies jika ada
                    if reply_count > 0 and max_replies > 0 and media_id and comment_pk:
                        raw_replies = self._fetch_replies(media_id, comment_pk, max_replies)
                        comment_entry["replies"] = [
                            {
                                "username":          r.get("username", ""),
                                "text":              r.get("text", ""),
                                "comment_id":        r.get("comment_id", ""),
                                "like_count":        int(r.get("like_count", 0) or 0),
                                "created_at":        int(r.get("created_at", 0) or 0),
                                "parent_comment_id": comment_pk,
                            }
                            for r in raw_replies
                            if r.get("username") and r.get("text")
                        ]
                        time.sleep(random.uniform(0.3, 0.8))

                    comments.append(comment_entry)
                    if len(comments) >= max_comments:
                        break

                next_min_id = data.get("next_min_id")
                if not next_min_id or not data.get("has_more_comments", False):
                    break

                time.sleep(random.uniform(1.5, 3.0))

            except Exception as e:
                print(Fore.YELLOW + f"      ⚠️  fetch comments error: {e}")
                break

        return comments

    def scrape_profile_posts(
        self,
        username: str,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        max_posts: int = 50,
        include_comments: bool = False,
        max_comments_per_post: int = 20,
        max_replies_per_comment: int = 5,
    ) -> Dict[str, Any]:
        """
        Scrape semua postingan dari profil @username dalam rentang tanggal.

        Parameters
        ----------
        username               : Instagram username (tanpa @)
        date_from              : '2019-01-01' (inclusive). None = tidak ada batas bawah.
        date_to                : '2020-12-31' (inclusive). None = hari ini.
        max_posts              : batas jumlah post yang dikumpulkan (default 50, max 500)
        include_comments       : apakah scrape komentar tiap post
        max_comments_per_post  : maks komentar per post (default 20)
        max_replies_per_comment: maks replies per komentar (default 5)
        """
        username = username.strip().lstrip("@").lower()

        print(Fore.CYAN + "\n" + "=" * 70)
        print(Fore.CYAN + f"📸 Scraping POSTS: @{username}")
        print(Fore.CYAN + f"   Rentang: {date_from or 'awal'} → {date_to or 'sekarang'}")
        print(Fore.CYAN + f"   Max posts: {max_posts} | include_comments: {include_comments}")
        print(Fore.CYAN + "=" * 70)

        result: Dict[str, Any] = {
            "username":      username,
            "date_from":     date_from,
            "date_to":       date_to,
            "scraped_at":    datetime.now().isoformat(),
            "scraped_date":  datetime.now().strftime("%Y-%m-%d"),
            "success":       False,
            "total_posts":   0,
            "posts":         [],
            "error":         "",
        }

        # Parse filter tanggal → unix timestamp
        ts_from: int = 0
        ts_to: int = int(datetime.now().timestamp()) + 86400  # +1 hari buffer

        if date_from:
            try:
                ts_from = int(datetime.strptime(date_from, "%Y-%m-%d").timestamp())
            except ValueError:
                result["error"] = f"Format date_from salah: '{date_from}'. Gunakan YYYY-MM-DD."
                return result

        if date_to:
            try:
                ts_to = int(datetime.strptime(date_to, "%Y-%m-%d").timestamp()) + 86399
            except ValueError:
                result["error"] = f"Format date_to salah: '{date_to}'. Gunakan YYYY-MM-DD."
                return result

        if ts_from > ts_to:
            result["error"] = "date_from tidak boleh lebih besar dari date_to."
            return result

        try:
            self.initialize_browser()
            self._build_requests_session()

            print(Fore.CYAN + "\n📡 Mengambil user_id...")
            page = self._assert_page()
            page.goto(f"https://www.instagram.com/{username}/")
            time.sleep(random.uniform(4, 6))
            self._close_popups()

            if "challenge" in page.url:
                raise RuntimeError("Challenge terdeteksi — buka akun manual di browser dulu")

            user_id = self._get_user_id(username)
            if not user_id:
                result["error"] = "Tidak bisa mendapatkan user_id"
                return result

            print(Fore.GREEN + f"✅ User ID: {user_id}")

            # ── PAGINATION ────────────────────────────────────────────────
            all_posts: List[Dict[str, Any]] = []
            max_id: Optional[str] = None
            page_num = 0
            max_pages = 200
            done = False
            consecutive_errors = 0

            while not done and page_num < max_pages and len(all_posts) < max_posts:
                page_num += 1

                # Fetch satu halaman feed
                data = self._fetch_user_feed_page(user_id, max_id)
                if not data:
                    print(Fore.YELLOW + "   ↩️  CDP gagal, coba REST...")
                    data = self._fetch_user_feed_page_rest(user_id, max_id)

                if not data:
                    consecutive_errors += 1
                    if consecutive_errors >= 3:
                        print(Fore.RED + "   ❌ 3 error berturut, stop pagination.")
                        break
                    time.sleep(10)
                    continue

                if data.get("status") == "fail":
                    msg = data.get("message", "")
                    if "rate" in msg.lower() or "limit" in msg.lower():
                        print(Fore.RED + f"   🛑 Rate limit: {msg} — tunggu 60s")
                        time.sleep(60)
                        consecutive_errors += 1
                        if consecutive_errors >= 3:
                            break
                        continue
                    print(Fore.YELLOW + f"   ⚠️  API fail: {msg}")
                    break

                consecutive_errors = 0
                items = data.get("items", [])

                if not items:
                    print(Fore.CYAN + "   ℹ️  Tidak ada item, akhir feed.")
                    break

                page_all_older = True

                for item in items:
                    taken_at = int(item.get("taken_at", 0) or 0)

                    # Skip kalau lebih baru dari date_to
                    if taken_at > ts_to:
                        continue

                    # Kalau sudah lebih tua dari date_from, stop
                    if ts_from > 0 and taken_at < ts_from:
                        done = True
                        break

                    page_all_older = False
                    post = self._normalize_feed_item(item)

                    # Fetch komentar kalau diminta
                    if include_comments and post["media_id"]:
                        print(Fore.CYAN + f"   💬 Ambil komentar: {post['shortcode'] or post['media_id']}")
                        post["comments"] = self._fetch_post_comments_simple(
                            post["media_id"],
                            post["shortcode"],
                            max_comments_per_post,
                            max_replies_per_comment,
                        )
                        post["comments_fetched"] = len(post["comments"])
                        time.sleep(random.uniform(1.0, 2.5))
                    else:
                        post["comments"] = []
                        post["comments_fetched"] = 0

                    all_posts.append(post)

                    taken_dt = datetime.utcfromtimestamp(taken_at).strftime("%Y-%m-%d") if taken_at else "?"
                    print(Fore.CYAN +
                          f"   📷 [{len(all_posts):>4}] {taken_dt} "
                          f"| {post['media_type']:8} "
                          f"| ❤ {post['like_count']:>7,} "
                          f"| 💬 {post['comment_count']:>5,} "
                          f"| {post['caption'][:45].replace(chr(10), ' ')}...")

                    if len(all_posts) >= max_posts:
                        done = True
                        break

                # Kalau semua item lebih tua dari ts_from, stop
                if page_all_older and ts_from > 0:
                    print(Fore.CYAN + f"   ℹ️  Semua item di halaman ini lebih tua dari {date_from}, stop.")
                    break

                # Next page cursor
                next_max_id = data.get("next_max_id")
                if not next_max_id or not data.get("more_available", False):
                    print(Fore.CYAN + "   ℹ️  Tidak ada halaman berikutnya.")
                    break

                max_id = str(next_max_id)
                print(Fore.CYAN + f"   📄 Halaman {page_num} selesai — {len(all_posts)} post terkumpul")
                time.sleep(random.uniform(2.5, 5.0))

            result["posts"] = all_posts
            result["total_posts"] = len(all_posts)
            result["success"] = True

            print(Fore.GREEN + f"\n✅ Selesai! {len(all_posts)} post dari @{username}")
            if all_posts:
                oldest = datetime.utcfromtimestamp(all_posts[-1]["taken_at"]).strftime("%Y-%m-%d") if all_posts[-1]["taken_at"] else "?"
                newest = datetime.utcfromtimestamp(all_posts[0]["taken_at"]).strftime("%Y-%m-%d") if all_posts[0]["taken_at"] else "?"
                print(Fore.GREEN + f"   Rentang aktual: {oldest} → {newest}")

        except Exception as e:
            print(Fore.RED + f"\n❌ GAGAL: {e}")
            traceback.print_exc()
            result["error"] = str(e)

        return result

    # ════════════════════════════════════════════════════════════════════════
    # SCRAPE FOLLOWERS / FOLLOWING PUBLIC METHODS
    # ════════════════════════════════════════════════════════════════════════

    def scrape_followers(self, username: str, max_count: int = 200) -> Dict[str, Any]:
        username = username.strip().lstrip("@").lower()

        print(Fore.CYAN + "\n" + "=" * 70)
        print(Fore.CYAN + f"👥 Scraping followers: @{username}")
        print(Fore.CYAN + "=" * 70)

        result = {
            "username": username,
            "kind": "followers",
            "scraped_at": datetime.now().isoformat(),
            "scraped_date": datetime.now().strftime("%Y-%m-%d"),
            "success": False,
            "count": 0,
            "items": [],
            "error": "",
        }

        try:
            self.initialize_browser()
            self._build_requests_session()

            print(Fore.CYAN + "\n📡 Mengambil user_id...")
            page = self._assert_page()
            page.goto(f"https://www.instagram.com/{username}/")
            time.sleep(random.uniform(4, 6))
            self._close_popups()

            user_id = self._get_user_id(username)
            if not user_id:
                result["error"] = "Tidak bisa mendapatkan user_id"
                return result

            print(Fore.GREEN + f"✅ User ID: {user_id}")

            items = self._fetch_followers_or_following(username, user_id, "followers", max_count)
            result["items"] = items
            result["count"] = len(items)
            result["success"] = len(items) > 0
            if not result["success"]:
                result["error"] = "Tidak ada followers yang berhasil di-scrape"

        except Exception as e:
            print(Fore.RED + f"\n❌ GAGAL: {e}")
            traceback.print_exc()
            result["error"] = str(e)

        return result

    def scrape_following(self, username: str, max_count: int = 200) -> Dict[str, Any]:
        username = username.strip().lstrip("@").lower()

        print(Fore.CYAN + "\n" + "=" * 70)
        print(Fore.CYAN + f"👥 Scraping following: @{username}")
        print(Fore.CYAN + "=" * 70)

        result = {
            "username": username,
            "kind": "following",
            "scraped_at": datetime.now().isoformat(),
            "scraped_date": datetime.now().strftime("%Y-%m-%d"),
            "success": False,
            "count": 0,
            "items": [],
            "error": "",
        }

        try:
            self.initialize_browser()
            self._build_requests_session()

            print(Fore.CYAN + "\n📡 Mengambil user_id...")
            page = self._assert_page()
            page.goto(f"https://www.instagram.com/{username}/")
            time.sleep(random.uniform(4, 6))
            self._close_popups()

            user_id = self._get_user_id(username)
            if not user_id:
                result["error"] = "Tidak bisa mendapatkan user_id"
                return result

            print(Fore.GREEN + f"✅ User ID: {user_id}")

            items = self._fetch_followers_or_following(username, user_id, "following", max_count)
            result["items"] = items
            result["count"] = len(items)
            result["success"] = len(items) > 0
            if not result["success"]:
                result["error"] = "Tidak ada following yang berhasil di-scrape"

        except Exception as e:
            print(Fore.RED + f"\n❌ GAGAL: {e}")
            traceback.print_exc()
            result["error"] = str(e)

        return result

    def scrape_following_verified(self, username: str, max_count: int = 500) -> Dict[str, Any]:
        username = username.strip().lstrip("@").lower()

        print(Fore.CYAN + "\n" + "=" * 70)
        print(Fore.CYAN + f"✅ Scraping VERIFIED FOLLOWING: @{username}")
        print(Fore.CYAN + "=" * 70)

        result = {
            "username": username,
            "kind": "following_verified",
            "scraped_at": datetime.now().isoformat(),
            "scraped_date": datetime.now().strftime("%Y-%m-%d"),
            "success": False,
            "count": 0,
            "items": [],
            "total_scanned": 0,
            "error": "",
        }

        try:
            self.initialize_browser()
            self._build_requests_session()

            print(Fore.CYAN + "\n📡 Mengambil user_id...")
            page = self._assert_page()
            page.goto(f"https://www.instagram.com/{username}/")
            time.sleep(random.uniform(4, 6))
            self._close_popups()

            user_id = self._get_user_id(username)
            if not user_id:
                result["error"] = "Tidak bisa mendapatkan user_id"
                return result

            print(Fore.GREEN + f"✅ User ID: {user_id}")

            profile_data = self._fetch_via_web_profile_api(username)
            total_following = profile_data.get("following", 0)
            is_private = profile_data.get("is_private", False)
            print(Fore.CYAN + f"📊 Total following: {total_following:,}")

            if is_private:
                result["error"] = "Akun private — tidak bisa scrape following"
                return result

            if total_following == 0:
                result["error"] = "Akun ini tidak follow siapapun"
                return result

            scan_cap = min(max_count * 10, total_following, 5000)
            print(Fore.CYAN + f"🔍 Will scan up to {scan_cap:,} following, target {max_count} verified")

            self._last_scan_count = 0
            items = self._fetch_followers_or_following(
                username, user_id, "following",
                max_count=scan_cap,
                only_verified=True,
                verified_target=max_count,
            )

            result["items"] = items[:max_count]
            result["count"] = len(result["items"])
            result["total_scanned"] = self._last_scan_count or scan_cap
            result["success"] = result["count"] > 0

            if result["success"]:
                print(Fore.GREEN + f"\n✅ Berhasil! {result['count']} verified dari {result['total_scanned']:,} di-scan")
            else:
                if result["total_scanned"] == 0:
                    result["error"] = (
                        "Tidak bisa fetch following list — kemungkinan rate-limit, "
                        "session expired, atau akun terbatas. Coba lagi nanti."
                    )
                else:
                    result["error"] = (
                        f"Sudah scan {result['total_scanned']:,} following tapi tidak ada yang verified. "
                        "Akun ini mungkin memang tidak follow akun verified."
                    )

        except Exception as e:
            print(Fore.RED + f"\n❌ GAGAL: {e}")
            traceback.print_exc()
            result["error"] = str(e)

        return result

    # ════════════════════════════════════════════════════════════════════════
    # ENGAGEMENT SUMMARY
    # ════════════════════════════════════════════════════════════════════════

    @staticmethod
    def _compute_engagement_summary(recent_posts: List[Dict[str, Any]], followers: int) -> Dict[str, Any]:
        if not recent_posts:
            return {
                "posts_analyzed":  0,
                "avg_likes":       0,
                "avg_comments":    0,
                "avg_views":       0,
                "engagement_rate": 0.0,
                "best_post":       None,
                "worst_post":      None,
                "by_media_type":   {},
            }

        n = len(recent_posts)
        total_likes = sum(p["likes"] for p in recent_posts)
        total_comments = sum(p["comments"] for p in recent_posts)

        video_posts = [p for p in recent_posts if p.get("is_video") and p.get("views", 0) > 0]
        total_views = sum(p["views"] for p in video_posts)

        avg_likes    = total_likes    // n
        avg_comments = total_comments // n
        avg_views    = total_views // len(video_posts) if video_posts else 0

        er = (avg_likes + avg_comments) / followers * 100 if followers > 0 else 0.0

        scored = sorted(recent_posts, key=lambda p: p["likes"] + p["comments"], reverse=True)
        best  = scored[0]
        worst = scored[-1]

        by_type: Dict[str, Dict[str, Any]] = {}
        for p in recent_posts:
            mt = p["media_type"]
            if mt not in by_type:
                by_type[mt] = {"count": 0, "total_likes": 0, "total_comments": 0, "total_views": 0}
            by_type[mt]["count"]          += 1
            by_type[mt]["total_likes"]    += p["likes"]
            by_type[mt]["total_comments"] += p["comments"]
            by_type[mt]["total_views"]    += p["views"]

        for mt, stats in by_type.items():
            cnt = stats["count"]
            stats["avg_likes"]    = stats["total_likes"]    // cnt
            stats["avg_comments"] = stats["total_comments"] // cnt
            stats["avg_views"]    = stats["total_views"]    // cnt if stats["total_views"] else 0

        return {
            "posts_analyzed":  n,
            "avg_likes":       avg_likes,
            "avg_comments":    avg_comments,
            "avg_views":       avg_views,
            "engagement_rate": round(er, 3),
            "best_post": {
                "url": best["url"], "likes": best["likes"],
                "comments": best["comments"], "media_type": best["media_type"],
            },
            "worst_post": {
                "url": worst["url"], "likes": worst["likes"],
                "comments": worst["comments"], "media_type": worst["media_type"],
            },
            "by_media_type": by_type,
        }

    # ════════════════════════════════════════════════════════════════════════
    # SCRAPE PROFILE
    # ════════════════════════════════════════════════════════════════════════

    def scrape_profile(self, username: str) -> Dict[str, Any]:
        username = username.strip().lstrip("@").lower()

        print(Fore.CYAN + "\n" + "=" * 70)
        print(Fore.CYAN + f"👤 Scraping profile: @{username}")
        print(Fore.CYAN + "=" * 70)

        result: Dict[str, Any] = _empty_profile_fields(username)
        result.update({
            "scraped_at":   datetime.now().isoformat(),
            "scraped_date": datetime.now().strftime("%Y-%m-%d"),
            "method":       "",
            "success":      False,
        })

        try:
            self.initialize_browser()
            self._build_requests_session()

            print(Fore.YELLOW + f"\n🌍 Membuka https://www.instagram.com/{username}/")
            page = self._assert_page()
            page.goto(f"https://www.instagram.com/{username}/")
            time.sleep(random.uniform(4, 6))
            self._close_popups()

            if "challenge" in page.url:
                raise RuntimeError("Challenge terdeteksi — buka akun manual di browser dulu")

            print(Fore.CYAN + "\n📡 [Strategy 1] Web Profile API...")
            data = self._fetch_via_web_profile_api(username)
            if data and data.get("followers", 0) > 0:
                result.update(data)
                result["method"] = "web_profile_api"
                result["success"] = True
                print(Fore.GREEN + "   ✅ Berhasil via Web Profile API")
            else:
                print(Fore.YELLOW + "   ⚠️  Web Profile API kosong / 0")

            if not result["success"]:
                print(Fore.CYAN + "\n📡 [Strategy 2] CDP Fetch...")
                data = self._fetch_via_cdp(username)
                if data and data.get("followers", 0) > 0:
                    result.update(data)
                    result["method"] = "cdp_fetch"
                    result["success"] = True
                    print(Fore.GREEN + "   ✅ Berhasil via CDP Fetch")
                else:
                    print(Fore.YELLOW + "   ⚠️  CDP Fetch kosong / 0")

            if not result["success"]:
                print(Fore.CYAN + "\n📡 [Strategy 3] HTML Parse...")
                data = self._fetch_via_html(username)
                if data and data.get("followers", 0) > 0:
                    result.update(data)
                    result["method"] = "html_parse"
                    result["success"] = True
                    print(Fore.GREEN + "   ✅ Berhasil via HTML Parse")
                else:
                    print(Fore.YELLOW + "   ⚠️  HTML Parse kosong / 0")

            if result.get("success") and result.get("recent_posts"):
                result["engagement_summary"] = self._compute_engagement_summary(
                    result["recent_posts"], result.get("followers", 0),
                )
            else:
                result["engagement_summary"] = self._compute_engagement_summary([], 0)

            if not result["success"]:
                result["error"] = "Semua strategy gagal — cookie mungkin expired atau akun private/diblokir"

            self._print_summary(result)

        except Exception as e:
            print(Fore.RED + f"\n❌ GAGAL: {e}")
            traceback.print_exc()
            result["error"] = str(e)
            if "engagement_summary" not in result:
                result["engagement_summary"] = self._compute_engagement_summary([], 0)

        return result

    @staticmethod
    def _print_summary(d: Dict[str, Any]) -> None:
        if not d.get("success"):
            print(Fore.RED + "\n❌ Tidak ada data berhasil di-scrape")
            return

        print(Fore.CYAN + "\n" + "=" * 60)
        print(Fore.CYAN + "📋 PROFILE SUMMARY")
        print(Fore.CYAN + "=" * 60)
        print(f"  👤 Username     : @{d.get('username', '')}")
        print(f"  📛 Full name    : {d.get('full_name', '')}")
        if d.get("is_verified"):
            print(Fore.BLUE + "  ✔️  Verified     : YES")
        if d.get("is_business"):
            print(f"  🏢 Business     : YES")
        if d.get("is_private"):
            print(Fore.YELLOW + "  🔒 Private      : YES")
        if d.get("category"):
            print(f"  🏷️  Category     : {d.get('category')}")
        if d.get("biography"):
            bio = d["biography"].replace("\n", " | ")[:100]
            print(f"  📝 Bio          : {bio}")
        if d.get("external_url"):
            print(f"  🔗 URL          : {d.get('external_url')}")

        print(Fore.CYAN + "\n  📊 STATS:")
        print(f"     👥 Followers : {d.get('followers', 0):>12,}")
        print(f"     ➡️  Following : {d.get('following', 0):>12,}")
        print(f"     📷 Posts     : {d.get('posts_count', 0):>12,}")

        eng = d.get("engagement_summary") or {}
        if eng.get("posts_analyzed", 0) > 0:
            print(Fore.CYAN + "\n  📈 ENGAGEMENT (dari {} post terakhir):".format(eng["posts_analyzed"]))
            print(f"     ❤️  Avg likes    : {eng['avg_likes']:>10,}")
            print(f"     💬 Avg comments : {eng['avg_comments']:>10,}")
            if eng["avg_views"] > 0:
                print(f"     👁️  Avg views    : {eng['avg_views']:>10,}")
            print(Fore.GREEN + f"     📊 Engagement Rate: {eng['engagement_rate']}% "
                  + InstagramProfileScraper._classify_er(eng['engagement_rate']))

    @staticmethod
    def _classify_er(er: float) -> str:
        if er >= 6.0:
            return Fore.GREEN + "(🔥 Excellent)"
        elif er >= 3.0:
            return Fore.GREEN + "(✅ Good)"
        elif er >= 1.0:
            return Fore.YELLOW + "(👍 Average)"
        elif er > 0:
            return Fore.RED + "(⚠️  Below average)"
        return ""


# ── STANDALONE TEST ────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python profile_scraper.py <username> [profile|followers|following|verified|posts]")
        print("       python profile_scraper.py username posts 2019-01-01 2020-12-31 50")
        sys.exit(1)

    username = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "profile"

    with InstagramProfileScraper() as scraper:
        if mode == "followers":
            data = scraper.scrape_followers(username)
        elif mode == "following":
            data = scraper.scrape_following(username)
        elif mode == "verified":
            data = scraper.scrape_following_verified(username)
        elif mode == "posts":
            date_from  = sys.argv[3] if len(sys.argv) > 3 else None
            date_to    = sys.argv[4] if len(sys.argv) > 4 else None
            max_posts  = int(sys.argv[5]) if len(sys.argv) > 5 else 50
            data = scraper.scrape_profile_posts(
                username,
                date_from=date_from,
                date_to=date_to,
                max_posts=max_posts,
                include_comments=False,
            )
        else:
            data = scraper.scrape_profile(username)

        out_dir = "output"
        os.makedirs(out_dir, exist_ok=True)
        fp = os.path.join(out_dir, f"{mode}_{username}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
        with open(fp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(Fore.GREEN + f"\n💾 Saved: {fp}")