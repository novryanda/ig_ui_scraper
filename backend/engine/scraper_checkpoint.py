# scraper_checkpoint.py  → taruh di folder engine/ (sama dgn scraper_post.py)
"""
CheckpointMixin — scraping komentar BATCH-PER-BATCH dengan dukungan resume.

Konsep:
  - Tiap pemanggilan mengambil SATU batch (mis. 300 komentar terbaru).
  - Mengembalikan `next_cursor` (end_cursor GraphQL / next_min_id REST-CDP)
    supaya batch berikutnya bisa lanjut PERSIS dari titik berhenti → tanpa duplikat.
  - `has_more=False` artinya semua komentar pada postingan sudah habis.

Cara pasang di scraper_post.py:

    from scraper_checkpoint import CheckpointMixin

    class InstagramScraperV16(CheckpointMixin):   # <- tambahkan (CheckpointMixin)
        ...

Mixin ini memakai infrastruktur milik kelas induk:
  initialize_browser, _require_page, _require_session, _build_requests_session,
  _get_media_id, _get_owner_username, _get_engagement_metrics, _close_popups,
  _build_comment_entry, _fetch_replies, self.sentiment
"""
import re
import json
import time
import random
from typing import List, Dict, Optional, Tuple

from colorama import Fore

# HARUS sama dengan GRAPHQL_QUERY_HASH di scraper_post.py
CHECKPOINT_GRAPHQL_QUERY_HASH = "97b41c52301f77ce508f55e66d17620e"


class CheckpointMixin:

    # ════════════════════════════════════════════════════════════
    # BATCH FETCHERS — ambil komentar HINGGA batch_size lalu berhenti
    # di batas HALAMAN (tidak memotong di tengah halaman → tidak ada
    # komentar terlewat saat resume).
    # ════════════════════════════════════════════════════════════

    def _fetch_batch_graphql(
        self, shortcode: str, batch_size: int, start_cursor: Optional[str]
    ) -> Tuple[List[Dict], Optional[str], bool]:
        all_comments: List[Dict] = []
        end_cursor = start_cursor
        has_more = True
        sess = self._require_session()
        page_num = 0

        while len(all_comments) < batch_size:
            page_num += 1
            variables = {"shortcode": shortcode, "first": 50}
            if end_cursor:
                variables["after"] = end_cursor

            try:
                resp = sess.get(
                    "https://www.instagram.com/graphql/query/",
                    params={
                        "query_hash": CHECKPOINT_GRAPHQL_QUERY_HASH,
                        "variables": json.dumps(variables),
                    },
                    timeout=20,
                )
                if resp.status_code == 429:
                    print(Fore.YELLOW + "   ⚠️  429 rate limit, tunggu 60s")
                    time.sleep(60)
                    continue
                if resp.status_code != 200:
                    print(Fore.YELLOW + f"   ⚠️  GraphQL status {resp.status_code}")
                    break
                if "json" not in resp.headers.get("content-type", ""):
                    break

                data = resp.json()
                if data.get("status") == "fail":
                    print(Fore.YELLOW + f"   ⚠️  GraphQL fail: {data.get('message','')}")
                    break

                media = data.get("data", {}).get("shortcode_media", {})
                edge = media.get("edge_media_to_parent_comment", {})
                edges = edge.get("edges", [])
                page_info = edge.get("page_info", {})

                if not edges:
                    has_more = False
                    break

                for e in edges:
                    n = e.get("node", {})
                    username = n.get("owner", {}).get("username", "")
                    text = n.get("text", "")
                    if not username or not text:
                        continue
                    all_comments.append({
                        "username":    username,
                        "text":        text,
                        "comment_id":  n.get("id", ""),
                        "like_count":  n.get("edge_liked_by", {}).get("count", 0),
                        "created_at":  n.get("created_at", 0),
                        "reply_count": n.get("edge_threaded_comments", {}).get("count", 0),
                    })

                end_cursor = page_info.get("end_cursor")
                print(Fore.CYAN + f"   📡 GraphQL page {page_num}: total batch {len(all_comments)}")

                if not page_info.get("has_next_page") or not end_cursor:
                    has_more = False
                    break

                time.sleep(random.uniform(2.0, 3.5))

            except Exception as e:
                print(Fore.RED + f"   ❌ GraphQL batch error: {e}")
                break

        return all_comments, end_cursor, has_more

    def _fetch_batch_cdp(
        self, media_id: str, batch_size: int, start_cursor: Optional[str]
    ) -> Tuple[List[Dict], Optional[str], bool]:
        all_comments: List[Dict] = []
        next_min_id = start_cursor
        has_more = True
        page = self._require_page()
        page_num = 0

        while len(all_comments) < batch_size:
            page_num += 1
            try:
                result = page.evaluate(r"""(params) => {
                    const { mediaId, minId } = params;
                    return (async () => {
                        try {
                            let url = `/api/v1/media/${mediaId}/comments/?can_support_threading=true`;
                            if (minId) url += `&min_id=${encodeURIComponent(minId)}`;
                            const resp = await fetch(url, {
                                method: 'GET', credentials: 'include',
                                headers: {
                                    'X-IG-App-ID': '936619743392459',
                                    'X-ASBD-ID': '129477',
                                    'X-Requested-With': 'XMLHttpRequest',
                                    'Accept': '*/*',
                                }
                            });
                            const data = await resp.json();
                            return {ok: true, data: data};
                        } catch(e) { return {ok: false, error: e.toString()}; }
                    })();
                }""", {"mediaId": media_id, "minId": next_min_id})

                if not result.get("ok"):
                    break
                data = result["data"]
                raw = data.get("comments", [])
                if not raw:
                    has_more = False
                    break

                for c in raw:
                    username = c.get("user", {}).get("username", "")
                    text = c.get("text", "")
                    if not username or not text:
                        continue
                    all_comments.append({
                        "username":    username,
                        "text":        text,
                        "comment_id":  str(c.get("pk", "")),
                        "like_count":  c.get("comment_like_count", 0),
                        "created_at":  c.get("created_at", 0),
                        "reply_count": c.get("child_comment_count", 0),
                    })

                next_min_id = data.get("next_min_id")
                print(Fore.CYAN + f"   📡 CDP page {page_num}: total batch {len(all_comments)}")

                if not next_min_id or not data.get("has_more_comments", False):
                    has_more = False
                    break

                time.sleep(random.uniform(2.0, 3.5))

            except Exception as e:
                print(Fore.RED + f"   ❌ CDP batch error: {e}")
                break

        return all_comments, next_min_id, has_more

    def _fetch_batch_rest(
        self, media_id: str, batch_size: int, start_cursor: Optional[str]
    ) -> Tuple[List[Dict], Optional[str], bool]:
        all_comments: List[Dict] = []
        next_min_id = start_cursor
        has_more = True
        sess = self._require_session()
        page_num = 0

        while len(all_comments) < batch_size:
            page_num += 1
            url = f"https://www.instagram.com/api/v1/media/{media_id}/comments/"
            params = {"can_support_threading": "true"}
            if next_min_id:
                params["min_id"] = next_min_id
            try:
                resp = sess.get(url, params=params, timeout=15)
                if resp.status_code == 429:
                    print(Fore.YELLOW + "   ⚠️  429, tunggu 60s")
                    time.sleep(60)
                    continue
                if resp.status_code != 200:
                    break
                if "json" not in resp.headers.get("content-type", ""):
                    break
                data = resp.json()
                raw = data.get("comments", [])
                if not raw:
                    has_more = False
                    break
                for c in raw:
                    username = c.get("user", {}).get("username", "")
                    text = c.get("text", "")
                    if not username or not text:
                        continue
                    all_comments.append({
                        "username":    username,
                        "text":        text,
                        "comment_id":  str(c.get("pk", "")),
                        "like_count":  c.get("comment_like_count", 0),
                        "created_at":  c.get("created_at", 0),
                        "reply_count": c.get("child_comment_count", 0),
                    })
                next_min_id = data.get("next_min_id")
                print(Fore.CYAN + f"   📡 REST page {page_num}: total batch {len(all_comments)}")
                if not next_min_id or not data.get("has_more_comments", False):
                    has_more = False
                    break
                time.sleep(random.uniform(2.0, 3.5))
            except Exception as e:
                print(Fore.RED + f"   ❌ REST batch error: {e}")
                break

        return all_comments, next_min_id, has_more

    def _fetch_one_batch(
        self, shortcode: str, media_id: str, batch_size: int,
        method: Optional[str], cursor_value: Optional[str],
    ) -> Tuple[List[Dict], Optional[str], bool, str]:
        """Pilih metode. Kalau method sudah ditentukan (resume), pakai itu.
        Kalau None (batch pertama), auto-detect GraphQL → CDP → REST."""
        if method == "graphql":
            c, cur, hm = self._fetch_batch_graphql(shortcode, batch_size, cursor_value)
            return c, cur, hm, "graphql"
        if method == "cdp":
            c, cur, hm = self._fetch_batch_cdp(media_id, batch_size, cursor_value)
            return c, cur, hm, "cdp"
        if method == "rest":
            c, cur, hm = self._fetch_batch_rest(media_id, batch_size, cursor_value)
            return c, cur, hm, "rest"

        # auto-detect (batch pertama)
        c, cur, hm = self._fetch_batch_graphql(shortcode, batch_size, cursor_value)
        if c:
            return c, cur, hm, "graphql"
        if media_id:
            c, cur, hm = self._fetch_batch_cdp(media_id, batch_size, cursor_value)
            if c:
                return c, cur, hm, "cdp"
            c, cur, hm = self._fetch_batch_rest(media_id, batch_size, cursor_value)
            if c:
                return c, cur, hm, "rest"
        return [], None, False, "graphql"

    # ════════════════════════════════════════════════════════════
    # PUBLIC: scrape SATU batch
    # ════════════════════════════════════════════════════════════

    def scrape_checkpoint_batch(
        self,
        post_url: str,
        batch_size: int = 300,
        cursor: Optional[Dict] = None,          # {"method": "...", "value": "..."}
        include_replies: bool = False,
        max_replies_per_comment: int = 20,
        fetch_meta: bool = True,                # True hanya pada batch pertama
    ) -> Dict:
        m = re.search(r"/(p|reel|tv)/([A-Za-z0-9_-]+)", post_url)
        shortcode = m.group(2) if m else "unknown"
        is_reel_url = bool(re.search(r"/reel/", post_url))
        is_tv_url = bool(re.search(r"/tv/", post_url))

        out: Dict = {
            "shortcode":      shortcode,
            "batch_comments": [],
            "batch_count":    0,
            "batch_replies":  0,
            "next_cursor":    None,
            "has_more":       False,
            "method":         "",
            "meta":           {},
            "error":          None,
        }

        try:
            self.initialize_browser()
            page = self._require_page()

            cm = re.search(r"(https://www\.instagram\.com/(p|reel|tv)/[A-Za-z0-9_-]+)", post_url)
            clean = cm.group(1) if cm else post_url.split("?")[0].rstrip("/")

            print(Fore.YELLOW + f"\n🌍 [Checkpoint] Buka: {clean}")
            page.goto(clean)
            time.sleep(5)
            self._close_popups()

            if "login" in page.url:
                raise Exception("Redirect login — session expired")
            if "challenge" in page.url:
                raise Exception("Challenge terdeteksi")

            media_id = self._get_media_id()
            self.session = self._build_requests_session()

            # Metadata hanya di batch pertama (hemat waktu di batch berikutnya)
            if fetch_meta:
                meta: Dict = {"media_id": media_id or ""}
                try:
                    cap = page.evaluate(r"""() => {
                        const m = document.querySelector('meta[property="og:description"]');
                        return m ? m.content : '';
                    }""")
                    if cap:
                        meta["caption"] = cap[:500]
                except Exception:
                    pass
                try:
                    body_text = page.locator("body").inner_text()
                    lm = re.search(r"([\d,]+)\s+likes?", body_text, re.I)
                    if lm:
                        meta["likes"] = int(lm.group(1).replace(",", ""))
                except Exception:
                    pass
                owner = self._get_owner_username()
                if owner:
                    meta["owner_username"] = owner

                eng = self._get_engagement_metrics(media_id or "")
                default_eng = {
                    "media_type": "UNKNOWN", "product_type": "",
                    "video_views": 0, "play_count": 0, "shares_count": 0,
                    "reshare_count": 0, "direct_send_count": 0, "saves_count": 0,
                }
                for k, dv in default_eng.items():
                    meta[k] = eng.get(k, dv)
                if eng.get("likes", 0) > 0:
                    meta["likes"] = eng["likes"]
                if not meta.get("owner_username") and eng.get("owner_username"):
                    meta["owner_username"] = eng["owner_username"]

                if meta.get("media_type", "UNKNOWN") == "UNKNOWN":
                    if is_reel_url:
                        meta["media_type"] = "VIDEO"
                        meta["product_type"] = meta.get("product_type") or "clips"
                    elif is_tv_url:
                        meta["media_type"] = "VIDEO"
                        meta["product_type"] = meta.get("product_type") or "igtv"

                out["meta"] = meta

            method = cursor.get("method") if cursor else None
            cursor_value = cursor.get("value") if cursor else None

            print(Fore.CYAN + f"\n📝 [Checkpoint] Ambil 1 batch (size={batch_size}, "
                  f"method={method or 'auto'}, resume={'ya' if cursor_value else 'tidak'})")

            raw, new_cursor, has_more, used_method = self._fetch_one_batch(
                shortcode, media_id or "", batch_size, method, cursor_value
            )

            # dedupe di dalam batch (jaga-jaga)
            seen = set()
            unique: List[Dict] = []
            for c in raw:
                cid = c.get("comment_id", "")
                if cid and cid in seen:
                    continue
                if cid:
                    seen.add(cid)
                unique.append(c)

            # bangun entry + sentimen + balasan
            final: List[Dict] = []
            total_replies = 0
            for i, rc in enumerate(unique, 1):
                entry = self._build_comment_entry(rc, number=i)
                rcount = int(rc.get("reply_count", 0) or 0)
                if include_replies and rcount > 0 and max_replies_per_comment > 0 and media_id:
                    parent_pk = rc.get("comment_id", "")
                    raw_replies = self._fetch_replies(media_id, parent_pk, max_replies_per_comment)
                    rseen = set()
                    freplies: List[Dict] = []
                    for j, rr in enumerate(raw_replies, 1):
                        rid = rr.get("comment_id", "")
                        if rid and rid in rseen:
                            continue
                        if rid:
                            rseen.add(rid)
                        freplies.append(self._build_comment_entry(
                            rr, number=j, is_reply=True, parent_pk=parent_pk))
                    entry["replies"] = freplies
                    entry["replies_fetched"] = len(freplies)
                    total_replies += len(freplies)
                    time.sleep(random.uniform(0.3, 0.7))
                else:
                    entry["replies"] = []
                    entry["replies_fetched"] = 0
                final.append(entry)

            can_continue = bool(has_more and new_cursor)
            out.update({
                "batch_comments": final,
                "batch_count":    len(final),
                "batch_replies":  total_replies,
                "next_cursor":    {"method": used_method, "value": new_cursor} if can_continue else None,
                "has_more":       can_continue,
                "method":         used_method,
            })

            print(Fore.GREEN + f"\n✅ [Checkpoint] Batch selesai: {len(final)} komentar "
                  f"+ {total_replies} balasan | has_more={can_continue}")

        except Exception as e:
            import traceback
            traceback.print_exc()
            out["error"] = str(e)

        return out