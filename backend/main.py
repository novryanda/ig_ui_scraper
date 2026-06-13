"""
main.py — FastAPI Backend untuk Instagram Scraper
Versi: V16.4 + Unlimited Comments (max_comments=0) + Unified + Aggressive Likers
"""
import os
import re
import sys
import csv
import json
import time
import subprocess
import tempfile
import traceback
import io
from datetime import datetime
from typing import Optional, List, Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, field_validator
from checkpoint_session_api import router as checkpoint_router
from search_deep_endpoints import deep_search_router
import job_manager

# ── PATH SETUP ──────────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.join(BASE_DIR, "engine")
OUTPUT_DIR = os.path.join(ENGINE_DIR, "output")

sys.path.insert(0, ENGINE_DIR)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── APP ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Instagram Scraper API", version="2.1.0")


def _parse_cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "").strip()
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    return [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]


_cors_origins = _parse_cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(checkpoint_router)
app.include_router(deep_search_router)


@app.on_event("startup")
def _cleanup_orphaned_jobs():
    """Tandai job yang nyangkut 'running' dari proses sebelumnya jadi 'error'
    supaya frontend tidak polling selamanya setelah container restart."""
    try:
        n = job_manager.mark_orphaned_jobs()
        if n:
            print(f"[startup] {n} job tertinggal ditandai error (server restart).")
    except Exception as e:
        print(f"[startup] gagal cleanup job tertinggal: {e}")


# Batas aman default — bisa di-override via env
SAFE_MAX_COMMENTS = int(os.getenv("SAFE_MAX_COMMENTS", 2000))


# ════════════════════════════════════════════════════════════════════════════
# MODELS
# ════════════════════════════════════════════════════════════════════════════

class ScrapePostRequest(BaseModel):
    url: str
    max_comments: int = 100        # 0 = unlimited (ambil semua)
    include_replies: bool = True
    max_replies_per_comment: int = 20

    @field_validator("max_comments")
    @classmethod
    def validate_max_comments(cls, v: int) -> int:
        # Izinkan 0 (unlimited) dan positif; tolak negatif
        if v < 0:
            raise ValueError("max_comments tidak boleh negatif. Gunakan 0 untuk unlimited.")
        return v

class ScrapePostsRequest(BaseModel):
    urls: List[str]
    max_comments: int = 100
    delay_between: int = 8
    include_replies: bool = True
    max_replies_per_comment: int = 20

    @field_validator("max_comments")
    @classmethod
    def validate_max_comments(cls, v: int) -> int:
        if v < 0:
            raise ValueError("max_comments tidak boleh negatif.")
        return v

class ScrapePostLikersRequest(BaseModel):
    url: str
    max_likers: int = 0
    aggressive_likers: bool = False
    checkpoint_size: int = 200
    checkpoint_delay_min: int = 8
    checkpoint_delay_max: int = 15
    page_delay_min: float = 1.5
    page_delay_max: float = 3.0

class ScrapeUnifiedRequest(BaseModel):
    url: str
    # Comments — 0 = unlimited
    max_comments: int = 100
    include_replies: bool = True
    max_replies_per_comment: int = 20
    # Likers
    scrape_likers: bool = True
    max_likers: int = 1000
    aggressive_likers: bool = False
    checkpoint_size: int = 200
    checkpoint_delay_min: int = 8
    checkpoint_delay_max: int = 15
    page_delay_min: float = 1.5
    page_delay_max: float = 3.0

    @field_validator("max_comments")
    @classmethod
    def validate_max_comments(cls, v: int) -> int:
        if v < 0:
            raise ValueError("max_comments tidak boleh negatif. Gunakan 0 untuk unlimited.")
        return v

class ScrapeProfileRequest(BaseModel):
    username: str
    save_snapshot: bool = True

class ScrapeFollowersRequest(BaseModel):
    username: str
    max_count: int = 200

class ScrapeFollowingRequest(BaseModel):
    username: str
    max_count: int = 200

class ScrapeFollowingVerifiedRequest(BaseModel):
    username: str
    max_count: int = 500

class ScrapeProfilePostsRequest(BaseModel):
    username: str
    date_from: Optional[str] = None
    date_to:   Optional[str] = None
    max_posts: int = 50
    include_comments: bool = False
    max_comments_per_post: int = 20
    max_replies_per_comment: int = 5


class ScrapeProfileDeepRequest(BaseModel):
    """
    Endpoint induk: scrape SEMUA post dari profil sekaligus dengan
    komentar + likers + replies tiap postingan.

    Phase 1 — Kumpulkan URL post (pakai profile_scraper.scrape_profile_posts)
    Phase 2 — Untuk tiap URL, jalankan unified scraper (komentar+likers+replies)
    Phase 3 — Gabungkan semua hasil jadi 1 JSON output file
    """
    username: str

    # Filter post
    date_from:  Optional[str] = None   # "YYYY-MM-DD" atau None (semua)
    date_to:    Optional[str] = None   # "YYYY-MM-DD" atau None (sampai sekarang)
    max_posts:  int = 50               # 0 = semua post (hati-hati, bisa sangat lama)

    # Config komentar per post
    max_comments:            int  = 100   # 0 = unlimited
    include_replies:         bool = True
    max_replies_per_comment: int  = 20

    # Config likers per post
    scrape_likers:       bool  = True
    max_likers:          int   = 500     # 0 = semua likers
    aggressive_likers:   bool  = False

    # Jeda antar post (detik) — supaya tidak kena rate-limit
    delay_between_posts: int = 15

    @field_validator("max_comments")
    @classmethod
    def validate_max_comments(cls, v: int) -> int:
        if v < 0:
            raise ValueError("max_comments tidak boleh negatif. Gunakan 0 untuk unlimited.")
        return v

    @field_validator("max_posts")
    @classmethod
    def validate_max_posts(cls, v: int) -> int:
        if v < 0:
            raise ValueError("max_posts tidak boleh negatif. Gunakan 0 untuk semua post.")
        return v


class LoginCookieRequest(BaseModel):
    cookies_json: str

class DownloadCommentsInlineRequest(BaseModel):
    comments: List[Any] = []
    include_replies: bool = True
    filename_hint: str = "comments"

class DownloadLikersInlineRequest(BaseModel):
    likers: List[Any] = []
    filename_hint: str = "likers"

class DownloadActiveCommentersInlineRequest(BaseModel):
    active_commenters: List[Any] = []
    filename_hint: str = "active_commenters"


# ════════════════════════════════════════════════════════════════════════════
# HELPERS
# ════════════════════════════════════════════════════════════════════════════

def success(data: dict, message: str = "Success"):
    return {
        "success":   True,
        "message":   message,
        "timestamp": datetime.now().isoformat(),
        "data":      data,
    }

def failure(message: str, data: Optional[dict] = None):
    return {
        "success":   False,
        "message":   message,
        "timestamp": datetime.now().isoformat(),
        "data":      data or {},
    }


_IG_RESERVED = {
    "p", "reel", "reels", "tv", "stories", "explore",
    "accounts", "direct", "api", "share", "about",
}

def extract_username(raw: str) -> str:
    s = (raw or "").strip()
    if "instagram.com" in s.lower():
        m = re.search(r'instagram\.com/([^/?#]+)', s, re.I)
        if m:
            candidate = m.group(1).strip().lstrip("@").lower()
            if candidate and candidate not in _IG_RESERVED:
                return candidate
        return ""
    return s.lstrip("@").lower()


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r'[^A-Za-z0-9._-]', "_", name)
    return cleaned or "unknown"


def save_json_output(data: dict, filename: str) -> str:
    safe_name = sanitize_filename(filename)
    fp = os.path.join(OUTPUT_DIR, safe_name)
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, default=str)
    return safe_name


def _estimate_timeout(max_comments: int, include_replies: bool, scrape_likers: bool = False) -> int:
    """
    Estimasi timeout subprocess berdasarkan jumlah komentar yang diminta.
    max_comments=0 → unlimited, pakai timeout maksimum.
    """
    if max_comments == 0:
        # Unlimited mode: bisa sampai berjam-jam
        base = 7200
    elif max_comments <= 200:
        base = 600
    elif max_comments <= 500:
        base = 1200
    elif max_comments <= 1000:
        base = 2400
    else:
        base = 3600

    if include_replies:
        base = int(base * 1.5)
    if scrape_likers:
        base += 3600

    return base


# ════════════════════════════════════════════════════════════════════════════
# SUBPROCESS RUNNERS
# ════════════════════════════════════════════════════════════════════════════

def _run_subprocess(script: str, timeout: int) -> dict:
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, encoding="utf-8"
    ) as f:
        f.write(script)
        script_path = f.name

    try:
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"]       = "1"

        result = subprocess.run(
            [sys.executable, script_path],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=ENGINE_DIR,
            encoding="utf-8",
            errors="replace",
            env=env,
        )

        out = result.stdout or ""
        if "___RESULT_START___" in out:
            json_part = out.split("___RESULT_START___", 1)[1].strip()
            for line in json_part.split("\n"):
                line = line.strip()
                if line.startswith("{"):
                    try:
                        return json.loads(line)
                    except json.JSONDecodeError:
                        continue

        stderr_tail = (result.stderr or "")[-1200:]
        stdout_tail = out[-600:]
        raise Exception(
            f"Tidak ada output JSON valid (returncode={result.returncode}).\n"
            f"STDERR: {stderr_tail}\n"
            f"STDOUT: {stdout_tail}"
        )

    finally:
        try:
            os.unlink(script_path)
        except Exception:
            pass


def run_post_scraper(
    url: str,
    max_comments: int,
    include_replies: bool = True,
    max_replies_per_comment: int = 20,
) -> dict:
    """
    max_comments=0 → scraper akan ambil semua komentar (unlimited mode).
    """
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from scraper_post import InstagramScraperV16
import json

with InstagramScraperV16() as scraper:
    result = scraper.scrape_post_comments(
        {json.dumps(url)},
        {max_comments},
        include_replies={include_replies},
        max_replies_per_comment={max_replies_per_comment},
    )
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    timeout = _estimate_timeout(max_comments, include_replies)
    return _run_subprocess(script, timeout=timeout)



def run_unified_scraper(
    url: str,
    max_comments: int,
    include_replies: bool,
    max_replies_per_comment: int,
    scrape_likers: bool,
    max_likers: int,
    aggressive_likers: bool,
    checkpoint_size: int,
    checkpoint_delay_min: int,
    checkpoint_delay_max: int,
    page_delay_min: float,
    page_delay_max: float,
) -> dict:
    """
    max_comments=0 → unlimited comments.
    """
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from scraper_post import InstagramScraperV16
import json

with InstagramScraperV16() as scraper:
    result = scraper.scrape_post_unified(
        {json.dumps(url)},
        max_comments={max_comments},
        include_replies={include_replies},
        max_replies_per_comment={max_replies_per_comment},
        scrape_likers={scrape_likers},
        max_likers={max_likers},
        aggressive_likers={aggressive_likers},
        checkpoint_size={checkpoint_size},
        checkpoint_delay_min={checkpoint_delay_min},
        checkpoint_delay_max={checkpoint_delay_max},
        page_delay_min={page_delay_min},
        page_delay_max={page_delay_max},
    )
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    timeout = _estimate_timeout(max_comments, include_replies, scrape_likers)
    return _run_subprocess(script, timeout=timeout)


def run_likers_scraper(
    url: str,
    max_likers: int,
    aggressive_likers: bool,
    checkpoint_size: int,
    checkpoint_delay_min: int,
    checkpoint_delay_max: int,
    page_delay_min: float,
    page_delay_max: float,
) -> dict:
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from scraper_post import InstagramScraperV16
import json

with InstagramScraperV16() as scraper:
    result = scraper.scrape_post_likers(
        {json.dumps(url)},
        max_likers={max_likers},
        aggressive_likers={aggressive_likers},
        checkpoint_size={checkpoint_size},
        checkpoint_delay_min={checkpoint_delay_min},
        checkpoint_delay_max={checkpoint_delay_max},
        page_delay_min={page_delay_min},
        page_delay_max={page_delay_max},
    )
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    return _run_subprocess(script, timeout=7200)


def run_profile_scraper(username: str) -> dict:
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from profile_scraper import InstagramProfileScraper
import json

with InstagramProfileScraper() as scraper:
    result = scraper.scrape_profile({json.dumps(username)})
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    return _run_subprocess(script, timeout=120)


def run_followers_scraper(username: str, max_count: int) -> dict:
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from profile_scraper import InstagramProfileScraper
import json

with InstagramProfileScraper() as scraper:
    result = scraper.scrape_followers({json.dumps(username)}, {max_count})
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    return _run_subprocess(script, timeout=300)


def run_following_scraper(username: str, max_count: int) -> dict:
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from profile_scraper import InstagramProfileScraper
import json

with InstagramProfileScraper() as scraper:
    result = scraper.scrape_following({json.dumps(username)}, {max_count})
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    return _run_subprocess(script, timeout=300)


def run_following_verified_scraper(username: str, max_count: int) -> dict:
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from profile_scraper import InstagramProfileScraper
import json

with InstagramProfileScraper() as scraper:
    result = scraper.scrape_following_verified({json.dumps(username)}, {max_count})
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    return _run_subprocess(script, timeout=1800)


def run_profile_posts_scraper(
    username: str,
    date_from: Optional[str],
    date_to: Optional[str],
    max_posts: int,
    include_comments: bool,
    max_comments_per_post: int,
    max_replies_per_comment: int,
) -> dict:
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from profile_scraper import InstagramProfileScraper
import json

with InstagramProfileScraper() as scraper:
    result = scraper.scrape_profile_posts(
        {json.dumps(username)},
        date_from={json.dumps(date_from)},
        date_to={json.dumps(date_to)},
        max_posts={max_posts},
        include_comments={include_comments},
        max_comments_per_post={max_comments_per_post},
        max_replies_per_comment={max_replies_per_comment},
    )
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    return _run_subprocess(script, timeout=1800)


def run_profile_deep_scraper(
    username: str,
    date_from: Optional[str],
    date_to: Optional[str],
    max_posts: int,
    max_comments: int,
    include_replies: bool,
    max_replies_per_comment: int,
    scrape_likers: bool,
    max_likers: int,
    aggressive_likers: bool,
    delay_between_posts: int,
    progress_callback=None,
) -> dict:
    """
    Single-subprocess deep scraper:
    Phase 1: Ambil semua URL post dari profil.
    Phase 2: Untuk tiap URL, scrape unified (komentar+likers+replies).
    Phase 3: Gabung semua hasil, simpan ke output.

    Semua berjalan dalam SATU subprocess supaya cookie injector
    & browser session dipakai bersama (lebih cepat + anti error null).
    """
    _max_posts_feed = max_posts if max_posts > 0 else 500

    # Helper: convert Python None → "None" string untuk f-string script
    _df = 'None' if date_from is None else json.dumps(date_from)
    _dt = 'None' if date_to is None else json.dumps(date_to)
    # Username sebagai JSON-quoted string (untuk embedding di code, bukan di f-string)
    _un_json = json.dumps(username)

    script = f"""
import sys, os, json, time, random, traceback
from datetime import datetime
sys.path.insert(0, r'{ENGINE_DIR}')
from profile_scraper import InstagramProfileScraper
from scraper_post import InstagramScraperV16

OUTPUT_DIR = r'{OUTPUT_DIR}'
_UN = {_un_json}   # username sebagai variabel Python (hindari quote conflict di f-string)

def _save(data, fname):
    safe = ''.join(c if c.isalnum() or c in '._-' else '_' for c in fname) or 'unknown'
    fp = os.path.join(OUTPUT_DIR, safe)
    with open(fp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2, default=str)
    return safe

result_summary = {{
    "success": False,
    "username": {_un_json},
    "date_from": {_df},
    "date_to": {_dt},
    "scraped_at": datetime.now().isoformat(),
    "total_posts_found": 0,
    "total_posts_scraped": 0,
    "total_comments": 0,
    "total_replies": 0,
    "total_likers": 0,
    "posts": [],
    "errors": [],
    "saved_file": "",
    "elapsed_seconds": 0,
}}

t_start = time.time()

# ── Phase 1: kumpulkan URL post ──
print(f"\\n[DeepScraper] Phase 1: Ambil daftar post @{{_UN}}...")

try:
    with InstagramProfileScraper() as prof:
        feed_result = prof.scrape_profile_posts(
            _UN,
            date_from={_df},
            date_to={_dt},
            max_posts={_max_posts_feed},
            include_comments=False,
            max_comments_per_post=0,
            max_replies_per_comment=0,
        )
except Exception as e:
    result_summary["errors"].append({{"phase": "1_feed", "error": str(e)}})
    result_summary["elapsed_seconds"] = round(time.time() - t_start, 2)
    print("___RESULT_START___")
    print(json.dumps(result_summary, ensure_ascii=False, default=str))
    sys.exit(0)

if not feed_result.get("success"):
    err = feed_result.get("error", "Gagal ambil daftar post")
    result_summary["errors"].append({{"phase": "1_feed", "error": err}})
    result_summary["elapsed_seconds"] = round(time.time() - t_start, 2)
    print("___RESULT_START___")
    print(json.dumps(result_summary, ensure_ascii=False, default=str))
    sys.exit(0)

posts_feed = feed_result.get("posts", [])
total_found = len(posts_feed)
result_summary["total_posts_found"] = total_found
print(f"[DeepScraper] Phase 1 selesai: {{total_found}} post ditemukan")

if total_found == 0:
    result_summary["success"] = True
    result_summary["elapsed_seconds"] = round(time.time() - t_start, 2)
    print("___RESULT_START___")
    print(json.dumps(result_summary, ensure_ascii=False, default=str))
    sys.exit(0)

# ── Phase 2: unified scrape tiap post ──
print(f"[DeepScraper] Phase 2: Unified scrape {{total_found}} post...")

def _looks_throttled(ud, feed_cc, feed_lc):
    # Deteksi hasil "kosong/rusak" akibat Instagram nge-throttle request beruntun
    # (post ke-2, ke-3, dst). Ciri-cirinya: cara ambil komentar gagal total
    # (method kosong), atau metadata post jelas rusak (post rame tapi likes <=1),
    # atau feed bilang ada komentar tapi hasil 0.
    if not isinstance(ud, dict):
        return True
    method = (ud.get("method") or "").strip()
    cc = ud.get("comments_count", 0) or 0
    likes = ud.get("likes_count", 0) or 0
    if feed_lc and feed_lc > 50 and likes <= 1:
        return True
    if method == "":
        return True
    if feed_cc and feed_cc > 0 and cc == 0:
        return True
    return False

for idx, post_meta in enumerate(posts_feed, 1):
    post_url = post_meta.get("url", "")
    post_shortcode = post_meta.get("shortcode", "")

    if not post_url:
        result_summary["errors"].append({{
            "url": post_shortcode, "shortcode": post_shortcode,
            "error": "URL kosong dari feed",
        }})
        continue

    print(f"[DeepScraper] [{{idx}}/{{total_found}}] {{post_url}}")

    post_entry = {{
        "index": idx, "url": post_url, "shortcode": post_shortcode,
        "taken_at": post_meta.get("taken_at", 0),
        "taken_at_iso": post_meta.get("taken_at_iso", ""),
        "media_type": post_meta.get("media_type", ""),
        "feed_like_count": post_meta.get("like_count", 0),
        "feed_comment_count": post_meta.get("comment_count", 0),
        "feed_view_count": post_meta.get("view_count", 0),
        "feed_caption": post_meta.get("caption", "")[:200],
        "thumbnail_url": post_meta.get("thumbnail_url", ""),
        "scraped": False, "error": None, "data": None,
    }}

    feed_cc = post_meta.get("comment_count", 0) or 0
    feed_lc = post_meta.get("like_count", 0) or 0

    unified_data = None
    last_err = None
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            # PENTING: instance browser BARU tiap percobaan. Sesi/halaman yang
            # dipakai ulang lintas-post bikin post ke-2 dst balik kosong
            # (media_id/komentar/likers 0). Browser fresh = tiap post bersih
            # seperti post pertama.
            with InstagramScraperV16() as scraper:
                unified_data = scraper.scrape_post_unified(
                    post_url,
                    max_comments={max_comments},
                    include_replies={include_replies},
                    max_replies_per_comment={max_replies_per_comment},
                    scrape_likers={scrape_likers},
                    max_likers={max_likers},
                    aggressive_likers={aggressive_likers},
                    checkpoint_size=200,
                    checkpoint_delay_min=8,
                    checkpoint_delay_max=15,
                    page_delay_min=1.5,
                    page_delay_max=3.0,
                )
        except Exception as e:
            last_err = str(e)
            unified_data = None
            print(f"[DeepScraper] [{{idx}}/{{total_found}}] attempt {{attempt}} EXCEPTION {{last_err[:120]}}")

        # Berhasil kalau dapat data dan TIDAK kelihatan kena throttle.
        if unified_data is not None and not _looks_throttled(unified_data, feed_cc, feed_lc):
            break

        if attempt < max_attempts:
            cool = random.randint(20, 40) * attempt
            print(f"[DeepScraper] [{{idx}}/{{total_found}}] hasil kosong/throttle, "
                  f"retry {{attempt + 1}}/{{max_attempts}} setelah {{cool}}s...")
            time.sleep(cool)

    if unified_data is not None:
        cc = unified_data.get("comments_count", 0)
        rc = unified_data.get("replies_count", 0)
        lf = unified_data.get("likers_fetched", 0)

        result_summary["total_comments"] += cc
        result_summary["total_replies"] += rc
        result_summary["total_likers"] += lf
        result_summary["total_posts_scraped"] += 1
        post_entry["scraped"] = True
        post_entry["data"] = unified_data

        if _looks_throttled(unified_data, feed_cc, feed_lc):
            post_entry["warning"] = (
                "Hasil kemungkinan kena throttle Instagram (tetap kosong "
                f"setelah {{max_attempts}}x percobaan)."
            )
            print(f"[DeepScraper] [{{idx}}/{{total_found}}] MASIH KOSONG setelah {{max_attempts}}x percobaan")
        else:
            print(f"[DeepScraper] [{{idx}}/{{total_found}}] OK komentar={{cc}} replies={{rc}} likers={{lf}}")
    else:
        err_msg = last_err or "Gagal scrape post (tidak ada data dikembalikan)"
        post_entry["scraped"] = False
        post_entry["error"] = err_msg
        result_summary["errors"].append({{"url": post_url, "error": err_msg}})
        print(f"[DeepScraper] [{{idx}}/{{total_found}}] FAIL {{err_msg[:120]}}")

    result_summary["posts"].append(post_entry)

    if idx < total_found:
        jeda = {delay_between_posts} + random.randint(3, 8)
        print(f"[DeepScraper] Jeda {{jeda}}s...")
        time.sleep(jeda)

# ── Phase 3: simpan gabungan ──
result_summary["success"] = True
result_summary["elapsed_seconds"] = round(time.time() - t_start, 2)

ts = datetime.now().strftime("%Y%m%d_%H%M%S")
def _sanitize(name):
    return ''.join(c if c.isalnum() or c in '._-' else '_' for c in name) or 'unknown'

fname = f"profile_deep_{{_sanitize(_UN)}}_{{ts}}.json"
saved = _save(result_summary, fname)
result_summary["saved_file"] = saved

print(f"\\n[DeepScraper] Selesai! "
      f"{{result_summary['total_posts_scraped']}}/{{total_found}} post, "
      f"{{result_summary['total_comments']}} komentar, "
      f"{{result_summary['total_likers']}} likers | file: {{saved}}")

print("___RESULT_START___")
print(json.dumps(result_summary, ensure_ascii=False, default=str))
"""

    # Timeout sangat besar karena bisa scrape banyak post
    timeout = max(7200, 1800 + max_posts * 600)
    return _run_subprocess(script, timeout=timeout)


# ════════════════════════════════════════════════════════════════════════════
# DOWNLOAD HELPERS
# ════════════════════════════════════════════════════════════════════════════

def _comments_to_csv_rows(comments: list, include_replies: bool = True) -> list:
    rows = []
    for c in comments:
        rows.append({
            "type":              "comment",
            "number":            c.get("number", ""),
            "username":          c.get("username", ""),
            "text":              c.get("text", ""),
            "comment_id":        c.get("comment_id", ""),
            "like_count":        c.get("like_count", 0),
            "reply_count":       c.get("reply_count", 0),
            "created_at":        c.get("created_at", ""),
            "category":          c.get("category", ""),
            "sentiment":         c.get("sentiment", ""),
            "language":          c.get("language", ""),
            "is_hate_speech":    c.get("is_hate_speech", False),
            "is_toxic":          c.get("is_toxic", False),
            "is_sarcasm":        c.get("is_sarcasm", False),
            "is_wellwish":       c.get("is_wellwish", False),
            "hate_score":        c.get("hate_score", 0),
            "ml_confidence":     c.get("ml_confidence", 0),
            "vader_compound":    c.get("vader_compound", 0),
            "decision_source":   c.get("decision_source", ""),
            "hate_words":        "|".join(c.get("hate_words", []) or []),
            "toxic_words":       "|".join(c.get("toxic_words", []) or []),
            "positive_words":    "|".join(c.get("positive_words", []) or []),
            "negative_words":    "|".join(c.get("negative_words", []) or []),
            "humor_words":       "|".join(c.get("humor_words", []) or []),
            "emojis":            "|".join(c.get("emojis", []) or []),
            "parent_comment_id": "",
        })
        if include_replies:
            for r in c.get("replies", []) or []:
                rows.append({
                    "type":              "reply",
                    "number":            r.get("number", ""),
                    "username":          r.get("username", ""),
                    "text":              r.get("text", ""),
                    "comment_id":        r.get("comment_id", ""),
                    "like_count":        r.get("like_count", 0),
                    "reply_count":       0,
                    "created_at":        r.get("created_at", ""),
                    "category":          r.get("category", ""),
                    "sentiment":         r.get("sentiment", ""),
                    "language":          r.get("language", ""),
                    "is_hate_speech":    r.get("is_hate_speech", False),
                    "is_toxic":          r.get("is_toxic", False),
                    "is_sarcasm":        r.get("is_sarcasm", False),
                    "is_wellwish":       r.get("is_wellwish", False),
                    "hate_score":        r.get("hate_score", 0),
                    "ml_confidence":     r.get("ml_confidence", 0),
                    "vader_compound":    r.get("vader_compound", 0),
                    "decision_source":   r.get("decision_source", ""),
                    "hate_words":        "|".join(r.get("hate_words", []) or []),
                    "toxic_words":       "|".join(r.get("toxic_words", []) or []),
                    "positive_words":    "|".join(r.get("positive_words", []) or []),
                    "negative_words":    "|".join(r.get("negative_words", []) or []),
                    "humor_words":       "|".join(r.get("humor_words", []) or []),
                    "emojis":            "|".join(r.get("emojis", []) or []),
                    "parent_comment_id": r.get("parent_comment_id", ""),
                })
    return rows


def _likers_to_csv_rows(likers: list) -> list:
    return [{
        "no":              i + 1,
        "user_id":         l.get("user_id", ""),
        "username":        l.get("username", ""),
        "full_name":       l.get("full_name", ""),
        "is_verified":     l.get("is_verified", False),
        "is_private":      l.get("is_private", False),
        "profile_url":     f"https://www.instagram.com/{l.get('username', '')}/",
    } for i, l in enumerate(likers)]


def _active_commenters_to_csv_rows(active_commenters: list) -> list:
    rows = []
    for rank, u in enumerate(active_commenters, 1):
        base = {
            "rank":               rank,
            "username":           u.get("username", ""),
            "total_comments":     u.get("comment_count", 0),
            "total_replies":      u.get("reply_count", 0),
            "total_interactions": u.get("total_interactions", 0),
            "total_likes":        u.get("total_likes", 0),
            "dominant_category":  u.get("dominant_category", ""),
            "dominant_sentiment": u.get("dominant_sentiment", ""),
        }
        for c in u.get("comments", []) or []:
            rows.append({**base, "type": "comment", "text": c.get("text", ""),
                         "like_count": c.get("like_count", 0), "category": c.get("category", ""),
                         "sentiment": c.get("sentiment", ""), "reply_to": ""})
        for r in u.get("replies", []) or []:
            rows.append({**base, "type": "reply", "text": r.get("text", ""),
                         "like_count": r.get("like_count", 0), "category": r.get("category", ""),
                         "sentiment": r.get("sentiment", ""), "reply_to": r.get("reply_to", "")})
    return rows


ACTIVE_COMMENTER_CSV_FIELDS = [
    "rank", "username", "total_comments", "total_replies",
    "total_interactions", "total_likes", "dominant_category",
    "dominant_sentiment", "type", "text", "like_count",
    "category", "sentiment", "reply_to",
]


COMMENT_CSV_FIELDS = [
    "type", "number", "username", "text", "comment_id",
    "like_count", "reply_count", "created_at",
    "category", "sentiment", "language",
    "is_hate_speech", "is_toxic", "is_sarcasm", "is_wellwish",
    "hate_score", "ml_confidence", "vader_compound", "decision_source",
    "hate_words", "toxic_words", "positive_words", "negative_words",
    "humor_words", "emojis", "parent_comment_id",
]

LIKER_CSV_FIELDS = [
    "no", "user_id", "username", "full_name",
    "is_verified", "is_private", "profile_url",
]


def _rows_to_csv_bytes(rows: list, fieldnames: list) -> bytes:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8-sig")


def _validate_json_filename(filename: str):
    if "/" in filename or "\\" in filename or not filename.endswith(".json"):
        raise HTTPException(400, "Nama file tidak valid")
    fp = os.path.join(OUTPUT_DIR, filename)
    if not os.path.exists(fp):
        raise HTTPException(404, f"File '{filename}' tidak ditemukan")
    return fp


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — HEALTH
# ════════════════════════════════════════════════════════════════════════════

@app.get("/api/health")
def health():
    return success({
        "api":                "running",
        "version":            "2.1.0",
        "engine_dir":         ENGINE_DIR,
        "output_dir":         OUTPUT_DIR,
        "engine_files_found": os.path.exists(os.path.join(ENGINE_DIR, "scraper_post.py")),
        "safe_max_comments":  SAFE_MAX_COMMENTS,
    }, "FastAPI backend running")


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — AUTH
# ════════════════════════════════════════════════════════════════════════════

@app.post("/api/auth/cookies")
def save_cookies(req: LoginCookieRequest):
    try:
        import session_manager as sm
        cookies = sm.parse_cookie_json(req.cookies_json)
        ok, missing, _ = sm.validate_cookies(cookies)
        if not ok:
            raise HTTPException(400, f"Cookie wajib hilang: {', '.join(missing)}")
        payload = sm.save_session(cookies)
        return success({
            "user_id":      payload.get("user_id"),
            "cookie_count": payload.get("cookie_count"),
            "saved_at":     payload.get("saved_at"),
        }, "Cookies berhasil disimpan")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/auth/session")
def session_info():
    try:
        import session_manager as sm
        s = sm.load_session()
        if not s:
            return success({"has_session": False, "user_id": None}, "Belum login")
        expired  = sm.is_session_expired(s)
        is_valid, missing, _ = sm.validate_cookies(s.get("cookies", []))
        return success({
            "has_session":     True,
            "user_id":         s.get("user_id"),
            "cookie_count":    s.get("cookie_count"),
            "saved_at":        s.get("saved_at"),
            "is_expired":      expired,
            "is_valid":        is_valid,
            "missing_cookies": missing,
        }, "Session info retrieved")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/auth/status")
def auth_status():
    try:
        import session_manager as sm
        s = sm.load_session()
        has_session = s is not None
        is_valid = False
        if has_session:
            is_valid, _, _ = sm.validate_cookies(s.get("cookies", []))
        return success({
            "is_running":      False,
            "login_detected":  has_session,
            "username":        s.get("username") if s else None,
            "is_logged_in":    has_session and is_valid,
            "profile_exists":  os.path.exists(os.path.join(ENGINE_DIR, "chrome_profile_playwright")),
        }, "Auth status retrieved")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/auth/login")
def trigger_login():
    return success({"triggered": True}, "Login helper perlu dijalankan manual")


@app.post("/api/auth/logout")
def logout():
    try:
        import session_manager as sm
        sm.clear_session()
        return success({"cleared": True}, "Session dihapus")
    except Exception as e:
        raise HTTPException(500, str(e))


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — SCRAPE POST
# ════════════════════════════════════════════════════════════════════════════

@app.post("/api/scrape/post")
def scrape_post(req: ScrapePostRequest):
    """
    max_comments=0 → ambil SEMUA komentar (unlimited mode).
    Timeout otomatis disesuaikan.
    """
    try:
        t0 = time.time()
        is_unlimited = req.max_comments == 0
        result = run_post_scraper(
            req.url,
            req.max_comments,
            include_replies=req.include_replies,
            max_replies_per_comment=req.max_replies_per_comment,
        )
        elapsed = round(time.time() - t0, 2)

        filename = f"api_post_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        save_json_output(result, filename)

        result["_meta"] = {"elapsed_seconds": elapsed, "saved_file": filename}
        mode_str = "UNLIMITED" if is_unlimited else str(req.max_comments)
        msg = (
            f"Scraped {result.get('comments_count', 0)} comments"
            f" [mode: {mode_str}]"
            f" + {result.get('replies_count', 0)} replies in {elapsed}s"
        )
        return success(result, msg)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"Scrape failed: {str(e)}")


@app.post("/api/scrape/posts/batch")
def scrape_posts_batch(req: ScrapePostsRequest):
    import random as _random
    results = []
    t0 = time.time()
    for i, url in enumerate(req.urls):
        try:
            r = run_post_scraper(
                url,
                req.max_comments,
                include_replies=req.include_replies,
                max_replies_per_comment=req.max_replies_per_comment,
            )
            results.append({"url": url, "success": True, "data": r})
        except Exception as e:
            results.append({"url": url, "success": False, "error": str(e)})
        if i < len(req.urls) - 1:
            time.sleep(req.delay_between + _random.randint(1, 3))

    summary = {
        "total":           len(req.urls),
        "success":         sum(1 for r in results if r["success"]),
        "failed":          sum(1 for r in results if not r["success"]),
        "elapsed_seconds": round(time.time() - t0, 2),
        "results":         results,
    }
    filename = f"api_batch_posts_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    save_json_output(summary, filename)
    summary["saved_file"] = filename
    return success(summary, f"Batch: {summary['success']}/{summary['total']} success")


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — UNIFIED SCRAPE
# ════════════════════════════════════════════════════════════════════════════

@app.post("/api/scrape/post/unified")
def scrape_post_unified(req: ScrapeUnifiedRequest):
    """
    Unified: komentar + likers dalam satu sesi.
    max_comments=0 → unlimited comments.
    """
    try:
        t0 = time.time()
        is_unlimited = req.max_comments == 0
        result = run_unified_scraper(
            req.url,
            req.max_comments,
            req.include_replies,
            req.max_replies_per_comment,
            req.scrape_likers,
            req.max_likers,
            req.aggressive_likers,
            req.checkpoint_size,
            req.checkpoint_delay_min,
            req.checkpoint_delay_max,
            req.page_delay_min,
            req.page_delay_max,
        )
        elapsed = round(time.time() - t0, 2)

        filename = f"api_unified_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        save_json_output(result, filename)

        result["_meta"] = {"elapsed_seconds": elapsed, "saved_file": filename}
        mode_str = "UNLIMITED" if is_unlimited else str(req.max_comments)
        msg = (
            f"Unified: {result.get('comments_count', 0)} comments [{mode_str}] + "
            f"{result.get('replies_count', 0)} replies + "
            f"{result.get('likers_fetched', 0)} likers in {elapsed}s"
        )
        return success(result, msg)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"Unified scrape failed: {str(e)}")


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — SCRAPE LIKERS
# ════════════════════════════════════════════════════════════════════════════

@app.post("/api/scrape/post/likers")
def scrape_post_likers(req: ScrapePostLikersRequest):
    try:
        t0 = time.time()
        result = run_likers_scraper(
            req.url,
            req.max_likers,
            req.aggressive_likers,
            req.checkpoint_size,
            req.checkpoint_delay_min,
            req.checkpoint_delay_max,
            req.page_delay_min,
            req.page_delay_max,
        )
        elapsed = round(time.time() - t0, 2)

        filename = f"api_likers_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        save_json_output(result, filename)

        result["_meta"] = {"elapsed_seconds": elapsed, "saved_file": filename}
        msg = (
            f"Likers scraped: {result.get('likers_fetched', 0):,} "
            f"dari {result.get('likes_count', 0):,} likes in {elapsed}s"
        )
        return success(result, msg)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"Likers scrape failed: {str(e)}")


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — DOWNLOAD JSON
# ════════════════════════════════════════════════════════════════════════════

@app.get("/api/download/post/{filename}")
def download_post_json(filename: str):
    fp = _validate_json_filename(filename)
    with open(fp, "r", encoding="utf-8") as f:
        content = f.read()
    return StreamingResponse(
        io.BytesIO(content.encode("utf-8")),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/download/likers/{filename}")
def download_likers_json(filename: str):
    fp = _validate_json_filename(filename)
    with open(fp, "r", encoding="utf-8") as f:
        content = f.read()
    return StreamingResponse(
        io.BytesIO(content.encode("utf-8")),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/download/unified/{filename}")
def download_unified_json(filename: str):
    fp = _validate_json_filename(filename)
    with open(fp, "r", encoding="utf-8") as f:
        content = f.read()
    return StreamingResponse(
        io.BytesIO(content.encode("utf-8")),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — DOWNLOAD CSV
# ════════════════════════════════════════════════════════════════════════════

@app.get("/api/download/post/{filename}/comments.csv")
def download_post_comments_csv(
    filename: str,
    replies: bool = Query(True),
):
    fp = _validate_json_filename(filename)
    with open(fp, "r", encoding="utf-8") as f:
        data = json.load(f)

    comments = data.get("comments", [])
    rows = _comments_to_csv_rows(comments, include_replies=replies)
    csv_bytes = _rows_to_csv_bytes(rows, COMMENT_CSV_FIELDS)
    csv_filename = filename.replace(".json", "_comments.csv")

    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{csv_filename}"'},
    )


@app.get("/api/download/likers/{filename}/likers.csv")
def download_likers_csv(filename: str):
    fp = _validate_json_filename(filename)
    with open(fp, "r", encoding="utf-8") as f:
        data = json.load(f)

    likers = data.get("likers", [])
    rows = _likers_to_csv_rows(likers)
    csv_bytes = _rows_to_csv_bytes(rows, LIKER_CSV_FIELDS)
    csv_filename = filename.replace(".json", "_likers.csv")

    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{csv_filename}"'},
    )


@app.get("/api/download/unified/{filename}/comments.csv")
def download_unified_comments_csv(
    filename: str,
    replies: bool = Query(True),
):
    fp = _validate_json_filename(filename)
    with open(fp, "r", encoding="utf-8") as f:
        data = json.load(f)

    comments = data.get("comments", [])
    rows = _comments_to_csv_rows(comments, include_replies=replies)
    csv_bytes = _rows_to_csv_bytes(rows, COMMENT_CSV_FIELDS)
    csv_filename = filename.replace(".json", "_comments.csv")

    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{csv_filename}"'},
    )


@app.get("/api/download/unified/{filename}/likers.csv")
def download_unified_likers_csv(filename: str):
    fp = _validate_json_filename(filename)
    with open(fp, "r", encoding="utf-8") as f:
        data = json.load(f)

    likers = data.get("likers", [])
    rows = _likers_to_csv_rows(likers)
    csv_bytes = _rows_to_csv_bytes(rows, LIKER_CSV_FIELDS)
    csv_filename = filename.replace(".json", "_likers.csv")

    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{csv_filename}"'},
    )


@app.post("/api/download/comments-csv")
def download_comments_csv_inline(req: DownloadCommentsInlineRequest):
    rows = _comments_to_csv_rows(req.comments, include_replies=req.include_replies)
    csv_bytes = _rows_to_csv_bytes(rows, COMMENT_CSV_FIELDS)
    fname = sanitize_filename(f"{req.filename_hint}_comments.csv")

    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.post("/api/download/likers-csv")
def download_likers_csv_inline(req: DownloadLikersInlineRequest):
    rows = _likers_to_csv_rows(req.likers)
    csv_bytes = _rows_to_csv_bytes(rows, LIKER_CSV_FIELDS)
    fname = sanitize_filename(f"{req.filename_hint}_likers.csv")

    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.post("/api/download/active-commenters-csv")
def download_active_commenters_csv_inline(req: DownloadActiveCommentersInlineRequest):
    rows = _active_commenters_to_csv_rows(req.active_commenters)
    csv_bytes = _rows_to_csv_bytes(rows, ACTIVE_COMMENTER_CSV_FIELDS)
    fname = sanitize_filename(f"{req.filename_hint}_active_commenters.csv")

    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — SCRAPE PROFILE
# ════════════════════════════════════════════════════════════════════════════

@app.post("/api/scrape/profile")
def scrape_profile(req: ScrapeProfileRequest):
    username = extract_username(req.username)
    if not username:
        return failure(
            f"Tidak bisa menentukan username dari input: '{req.username}'.",
            {"profile": {"username": req.username, "success": False}},
        )

    try:
        t0 = time.time()
        result = run_profile_scraper(username)
        elapsed = round(time.time() - t0, 2)

        filename = f"api_profile_{username}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        saved = save_json_output(result, filename)
        result["_meta"] = {"elapsed_seconds": elapsed, "saved_file": saved}

        if not result.get("success"):
            err = result.get("error", "Scrape gagal tanpa detail")
            return failure(f"Profile @{username} gagal: {err}", {"profile": result, **result})

        return success({"profile": result, **result}, f"Profile @{username} scraped in {elapsed}s")
    except Exception as e:
        traceback.print_exc()
        return failure(f"Profile @{username} error: {str(e)}",
                       {"profile": {"username": username, "success": False, "error": str(e)}})


@app.post("/api/scrape/profile/followers")
def scrape_followers(req: ScrapeFollowersRequest):
    username = extract_username(req.username)
    if not username:
        return failure(f"Tidak bisa menentukan username dari input: '{req.username}'",
                       {"username": req.username, "kind": "followers", "success": False, "items": []})

    try:
        t0 = time.time()
        result = run_followers_scraper(username, req.max_count)
        elapsed = round(time.time() - t0, 2)

        filename = f"api_followers_{username}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        saved = save_json_output(result, filename)
        result["_meta"] = {"elapsed_seconds": elapsed, "saved_file": saved}

        if not result.get("success"):
            err = result.get("error", "Gagal tanpa detail")
            return failure(f"Followers @{username} gagal: {err}", {"followers": result, **result})

        return success({"followers": result, **result},
                       f"Followers @{username}: {result.get('count', 0)} items in {elapsed}s")
    except Exception as e:
        traceback.print_exc()
        return failure(f"Followers @{username} error: {str(e)}",
                       {"followers": {"username": username, "success": False, "items": [], "error": str(e)}})


@app.post("/api/scrape/profile/following")
def scrape_following(req: ScrapeFollowingRequest):
    username = extract_username(req.username)
    if not username:
        return failure(f"Tidak bisa menentukan username dari input: '{req.username}'",
                       {"username": req.username, "kind": "following", "success": False, "items": []})

    try:
        t0 = time.time()
        result = run_following_scraper(username, req.max_count)
        elapsed = round(time.time() - t0, 2)

        filename = f"api_following_{username}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        saved = save_json_output(result, filename)
        result["_meta"] = {"elapsed_seconds": elapsed, "saved_file": saved}

        if not result.get("success"):
            err = result.get("error", "Gagal tanpa detail")
            return failure(f"Following @{username} gagal: {err}", {"following": result, **result})

        return success({"following": result, **result},
                       f"Following @{username}: {result.get('count', 0)} items in {elapsed}s")
    except Exception as e:
        traceback.print_exc()
        return failure(f"Following @{username} error: {str(e)}",
                       {"following": {"username": username, "success": False, "items": [], "error": str(e)}})


@app.post("/api/scrape/profile/following-verified")
def scrape_following_verified(req: ScrapeFollowingVerifiedRequest):
    username = extract_username(req.username)
    if not username:
        return failure(f"Tidak bisa menentukan username dari input: '{req.username}'",
                       {"username": req.username, "kind": "following_verified", "success": False, "items": []})

    try:
        t0 = time.time()
        result = run_following_verified_scraper(username, req.max_count)
        elapsed = round(time.time() - t0, 2)

        filename = f"api_following_verified_{username}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        saved = save_json_output(result, filename)
        result["_meta"] = {"elapsed_seconds": elapsed, "saved_file": saved}

        if not result.get("success"):
            err = result.get("error", "Gagal tanpa detail")
            return failure(f"Verified Following @{username} gagal: {err}",
                           {"following_verified": result, **result})

        return success({"following_verified": result, **result},
                       f"Verified Following @{username}: {result.get('count', 0)} verified in {elapsed}s")
    except Exception as e:
        traceback.print_exc()
        return failure(f"Verified Following @{username} error: {str(e)}",
                       {"following_verified": {"username": username, "success": False, "items": [], "error": str(e)}})


@app.post("/api/scrape/profile/posts")
def scrape_profile_posts(req: ScrapeProfilePostsRequest):
    username = extract_username(req.username)
    if not username:
        return failure(f"Tidak bisa menentukan username dari input: '{req.username}'",
                       {"username": req.username, "success": False, "posts": []})

    try:
        t0 = time.time()
        result = run_profile_posts_scraper(
            username, req.date_from, req.date_to, req.max_posts,
            req.include_comments, req.max_comments_per_post, req.max_replies_per_comment,
        )
        elapsed = round(time.time() - t0, 2)

        filename = f"api_posts_{username}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        saved = save_json_output(result, filename)
        result["_meta"] = {"elapsed_seconds": elapsed, "saved_file": saved}

        if not result.get("success"):
            err = result.get("error", "Gagal tanpa detail")
            return failure(f"Posts @{username} gagal: {err}", {"posts_result": result, **result})

        return success({"posts_result": result, **result},
                       f"Posts @{username}: {result.get('total_posts', 0)} posts in {elapsed}s")
    except Exception as e:
        traceback.print_exc()
        return failure(f"Posts @{username} error: {str(e)}",
                       {"posts_result": {"username": username, "success": False, "posts": [], "error": str(e)}})


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — PROFILE DEEP SCRAPE
# ════════════════════════════════════════════════════════════════════════════

@app.post("/api/scrape/profile/deep")
def scrape_profile_deep(req: ScrapeProfileDeepRequest):
    """
    Endpoint INDUK: scrape semua post dari profil @username secara mendalam.

    Flow:
      1. Ambil list semua URL post (filter tanggal, max_posts)
      2. Tiap URL di-scrape dengan unified scraper (komentar + likers + replies)
      3. Semua hasil digabung jadi 1 JSON file

    Karena bisa sangat lama (banyak post), endpoint ini OTOMATIS berjalan
    sebagai background job dan langsung balik {job_id}.

    Pantau progress: GET /api/jobs/{job_id}
    Ambil hasil:     GET /api/jobs/{job_id}/result
    """
    username = extract_username(req.username)
    if not username:
        raise HTTPException(
            400,
            f"Tidak bisa menentukan username dari input: '{req.username}'"
        )

    # ── Guard: Deep Scrape WAJIB login Instagram ────────────────────────────
    # Tanpa cookie session, browser kena login-wall Instagram → job menggantung
    # sampai timeout (bisa jam-an) dan UI stuck "Menunggu respons dari server".
    # Tolak lebih awal dengan pesan jelas supaya user tahu harus login dulu.
    import session_manager as sm
    if not sm.session_exists():
        raise HTTPException(
            400,
            "Belum login Instagram. Buka menu Settings → tempel cookies login "
            "(sessionid, ds_user_id, csrftoken), lalu jalankan Deep Scrape lagi.",
        )

    params = req.model_dump()
    params["username"] = username

    job_id = job_manager.create_job(
        "profile_deep",
        params,
        _job_dispatch,
        label=f"@{username} deep scrape",
    )

    return success(
        {
            "job_id":   job_id,
            "kind":     "profile_deep",
            "username": username,
            "params":   params,
            "monitor": {
                "status_url": f"/api/jobs/{job_id}",
                "result_url": f"/api/jobs/{job_id}/result",
            },
        },
        f"Job deep scrape @{username} dimulai. Pantau: GET /api/jobs/{job_id}",
    )


@app.get("/api/scrape/profile/deep/{job_id}/progress")
def get_deep_scrape_progress(job_id: str):
    """
    Shortcut untuk lihat progress deep scrape job.
    """
    st = job_manager.get_job(job_id)
    if not st:
        return failure(f"Job '{job_id}' tidak ditemukan", {"status": "not_found"})

    result = job_manager.get_job_result(job_id)
    progress_data = {}
    if result and isinstance(result, dict):
        data = result.get("data", result)
        progress_data = {
            "total_posts_found":   data.get("total_posts_found", 0),
            "total_posts_scraped": data.get("total_posts_scraped", 0),
            "total_comments":      data.get("total_comments", 0),
            "total_likers":        data.get("total_likers", 0),
            "errors_count":        len(data.get("errors", [])),
        }

    return success({
        "job_id":   job_id,
        "status":   st.get("status"),
        "progress": st.get("progress"),
        "detail":   progress_data,
    })


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — OUTPUT FILES
# ════════════════════════════════════════════════════════════════════════════

@app.get("/api/output/list")
def list_output_files():
    files = []
    if os.path.exists(OUTPUT_DIR):
        for f in sorted(os.listdir(OUTPUT_DIR), reverse=True):
            if f.endswith(".json"):
                fp = os.path.join(OUTPUT_DIR, f)
                st = os.stat(fp)
                files.append({
                    "name":     f,
                    "size":     st.st_size,
                    "modified": datetime.fromtimestamp(st.st_mtime).isoformat(),
                })
    return success({"files": files, "count": len(files)})


@app.get("/api/output/{filename}")
def get_output_file(filename: str):
    if "/" in filename or "\\" in filename or not filename.endswith(".json"):
        raise HTTPException(400, "Nama file tidak valid")
    fp = os.path.join(OUTPUT_DIR, filename)
    if not os.path.exists(fp):
        raise HTTPException(404, "File tidak ditemukan")
    with open(fp, "r", encoding="utf-8") as f:
        return json.load(f)


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS — ANALYTICS / PROFILES
# ════════════════════════════════════════════════════════════════════════════

@app.get("/api/profiles")
def list_profiles():
    try:
        from storage_manager import StorageManager
        storage = StorageManager()
        users = storage.list_tracked_users()
        return success({"users": users, "count": len(users)})
    except ImportError:
        return success({"users": [], "count": 0}, "storage_manager tidak tersedia")
    except Exception as e:
        return success({"users": [], "count": 0}, f"Error: {str(e)}")


@app.get("/api/profiles/{username}/posts")
def get_profile_posts_files(username: str):
    username = extract_username(username)
    if not username:
        raise HTTPException(400, "Username tidak valid")
    files = []
    if os.path.exists(OUTPUT_DIR):
        prefix = f"api_posts_{username}_"
        for f in sorted(os.listdir(OUTPUT_DIR), reverse=True):
            if f.startswith(prefix) and f.endswith(".json"):
                fp = os.path.join(OUTPUT_DIR, f)
                st = os.stat(fp)
                files.append({
                    "name":     f,
                    "size":     st.st_size,
                    "modified": datetime.fromtimestamp(st.st_mtime).isoformat(),
                })
    return success({"username": username, "files": files, "count": len(files)})


@app.get("/api/profiles/{username}/history")
def profile_history(username: str, limit: int = Query(30)):
    try:
        from storage_manager import StorageManager
        storage = StorageManager()
        username = extract_username(username)
        history = storage.get_history(username, limit=limit)
        return success({"username": username, "history": history, "count": len(history)})
    except ImportError:
        raise HTTPException(503, "storage_manager tidak tersedia")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/profiles/{username}/growth")
def profile_growth(username: str):
    try:
        from storage_manager import StorageManager
        storage = StorageManager()
        username = extract_username(username)
        growth = storage.get_growth(username)
        return success({"username": username, "growth": growth})
    except ImportError:
        raise HTTPException(503, "storage_manager tidak tersedia")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/profiles/{username}/monthly")
def profile_monthly(username: str):
    try:
        from storage_manager import StorageManager
        storage = StorageManager()
        username = extract_username(username)
        monthly = storage.get_monthly(username)
        return success({"username": username, "monthly": monthly})
    except ImportError:
        raise HTTPException(503, "storage_manager tidak tersedia")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/profiles/{username}")
def get_profile_detail(username: str):
    try:
        from storage_manager import StorageManager
        storage = StorageManager()
        username = extract_username(username)
        profile = storage.get_profile(username)
        return success({"profile": profile, "username": username})
    except ImportError:
        raise HTTPException(503, "storage_manager tidak tersedia")
    except Exception as e:
        raise HTTPException(500, str(e))


# ════════════════════════════════════════════════════════════════════════════
# SEARCH (keyword / hashtag) — TEMPEL sebelum bagian ENTRYPOINT
# Memakai: ENGINE_DIR, _run_subprocess, success, failure, save_json_output,
#          sanitize_filename, _rows_to_csv_bytes, StreamingResponse, io, dll.
# ════════════════════════════════════════════════════════════════════════════

class DiscoverRequest(BaseModel):
    query: str

class SearchHashtagRequest(BaseModel):
    hashtag: str
    max_posts: int = 60
    include_top: bool = True
    include_recent: bool = True
    recent_pages: int = 5

class SearchKeywordRequest(BaseModel):
    keyword: str
    max_posts: int = 60
    max_hashtags: int = 3
    per_hashtag_pages: int = 1
    include_recent: bool = True

class DownloadSearchInlineRequest(BaseModel):
    posts: List[Any] = []
    filename_hint: str = "search"


def run_discover(query: str) -> dict:
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from search_scraper import InstagramSearchScraper
import json

with InstagramSearchScraper() as scraper:
    result = scraper.discover({json.dumps(query)})
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    return _run_subprocess(script, timeout=150)


def run_search_hashtag(hashtag: str, max_posts: int, include_top: bool,
                       include_recent: bool, recent_pages: int) -> dict:
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from search_scraper import InstagramSearchScraper
import json

with InstagramSearchScraper() as scraper:
    result = scraper.search_hashtag(
        {json.dumps(hashtag)},
        max_posts={max_posts},
        include_top={include_top},
        include_recent={include_recent},
        recent_pages={recent_pages},
    )
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    timeout = max(180, 120 + recent_pages * 90)
    return _run_subprocess(script, timeout=timeout)


def run_search_keyword(keyword: str, max_posts: int, max_hashtags: int,
                       per_hashtag_pages: int, include_recent: bool) -> dict:
    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from search_scraper import InstagramSearchScraper
import json

with InstagramSearchScraper() as scraper:
    result = scraper.search_keyword(
        {json.dumps(keyword)},
        max_posts={max_posts},
        max_hashtags={max_hashtags},
        per_hashtag_pages={per_hashtag_pages},
        include_recent={include_recent},
    )
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    timeout = max(300, 120 + max_hashtags * (per_hashtag_pages * 90 + 60))
    return _run_subprocess(script, timeout=timeout)


SEARCH_POST_CSV_FIELDS = [
    "rank", "source", "hashtag", "shortcode", "url", "owner_username",
    "owner_full_name", "owner_is_verified", "media_type", "product_type",
    "like_count", "comment_count", "view_count", "play_count",
    "taken_at", "taken_at_iso", "caption",
]


def _search_posts_to_csv_rows(posts: list) -> list:
    rows = []
    for p in posts:
        rows.append({
            "rank":              p.get("rank", ""),
            "source":            p.get("source", ""),
            "hashtag":           p.get("hashtag", ""),
            "shortcode":         p.get("shortcode", ""),
            "url":               p.get("url", ""),
            "owner_username":    p.get("owner_username", ""),
            "owner_full_name":   p.get("owner_full_name", ""),
            "owner_is_verified": p.get("owner_is_verified", False),
            "media_type":        p.get("media_type", ""),
            "product_type":      p.get("product_type", ""),
            "like_count":        p.get("like_count", 0),
            "comment_count":     p.get("comment_count", 0),
            "view_count":        p.get("view_count", 0),
            "play_count":        p.get("play_count", 0),
            "taken_at":          p.get("taken_at", 0),
            "taken_at_iso":      p.get("taken_at_iso", ""),
            "caption":           p.get("caption", ""),
        })
    return rows


@app.post("/api/search/discover")
def search_discover(req: DiscoverRequest):
    q = (req.query or "").strip()
    if not q:
        return failure("Query kosong", {"query": q, "hashtags": [], "users": [], "places": []})
    try:
        t0 = time.time()
        result = run_discover(q)
        result.setdefault("_meta", {})["elapsed_seconds"] = round(time.time() - t0, 2)
        if not result.get("success"):
            return failure(result.get("error") or "Pencarian gagal", result)
        return success(result, f"{len(result.get('hashtags', []))} hashtag · {len(result.get('users', []))} akun")
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"Discover failed: {str(e)}")


@app.post("/api/search/hashtag")
def search_hashtag_endpoint(req: SearchHashtagRequest):
    max_posts    = max(1, min(req.max_posts, 300))
    recent_pages = max(1, min(req.recent_pages, 12))
    try:
        t0 = time.time()
        result = run_search_hashtag(req.hashtag, max_posts, req.include_top, req.include_recent, recent_pages)
        elapsed = round(time.time() - t0, 2)
        if result.get("success"):
            filename = f"api_search_tag_{sanitize_filename(result.get('hashtag', 'tag'))}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            save_json_output(result, filename)
            result["_meta"] = {"elapsed_seconds": elapsed, "saved_file": filename}
            return success(result,
                           f"#{result.get('hashtag')}: {result.get('total_fetched', 0)} post "
                           f"(top {result.get('top_count', 0)} · recent {result.get('recent_count', 0)})")
        result.setdefault("_meta", {})["elapsed_seconds"] = elapsed
        return failure(result.get("error") or "Pencarian hashtag gagal", result)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"Hashtag search failed: {str(e)}")


@app.post("/api/search/keyword")
def search_keyword_endpoint(req: SearchKeywordRequest):
    max_posts         = max(1, min(req.max_posts, 300))
    max_hashtags      = max(1, min(req.max_hashtags, 6))
    per_hashtag_pages = max(1, min(req.per_hashtag_pages, 5))
    try:
        t0 = time.time()
        result = run_search_keyword(req.keyword, max_posts, max_hashtags, per_hashtag_pages, req.include_recent)
        elapsed = round(time.time() - t0, 2)
        if result.get("success"):
            filename = f"api_search_kw_{sanitize_filename(req.keyword)[:40]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            save_json_output(result, filename)
            result["_meta"] = {"elapsed_seconds": elapsed, "saved_file": filename}
            tags = ", ".join(
                "#" + (t["hashtag"] if isinstance(t, dict) else t)
                for t in result.get("searched_hashtags", [])
            )
            return success(result, f"'{req.keyword}': {result.get('total_fetched', 0)} post dari {tags or '—'}")
        result.setdefault("_meta", {})["elapsed_seconds"] = elapsed
        return failure(result.get("error") or "Pencarian keyword gagal", result)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"Keyword search failed: {str(e)}")


@app.post("/api/download/search-csv")
def download_search_csv_inline(req: DownloadSearchInlineRequest):
    rows = _search_posts_to_csv_rows(req.posts)
    csv_bytes = _rows_to_csv_bytes(rows, SEARCH_POST_CSV_FIELDS)
    fname = sanitize_filename(f"{req.filename_hint}_posts.csv")
    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ════════════════════════════════════════════════════════════════════════════
# BACKGROUND JOBS — scraping berat dijalankan sebagai job (tahan refresh)
# ════════════════════════════════════════════════════════════════════════════
#
# Alur:
#   POST /api/jobs/start  {kind, params}  → {job_id}  (langsung balik, worker jalan di thread)
#   GET  /api/jobs/{id}                   → status (pending/running/completed/error)
#   GET  /api/jobs/{id}/result            → ApiResponse hasil (sama persis seperti endpoint sync)
#   DELETE /api/jobs/{id}                 → hapus job
#
# Worker memanggil kembali fungsi endpoint sync yang sudah ada (satu sumber
# logika: tetap menyimpan output file, _meta, pesan, dll).

class StartJobRequest(BaseModel):
    kind: str
    params: dict = {}


def _job_dispatch(kind: str, params: dict) -> dict:
    """Map kind → fungsi endpoint sync. Mengembalikan ApiResponse dict."""
    try:
        if kind == "post":
            return scrape_post(ScrapePostRequest(**params))
        if kind == "batch":
            return scrape_posts_batch(ScrapePostsRequest(**params))
        if kind == "unified":
            return scrape_post_unified(ScrapeUnifiedRequest(**params))
        if kind == "likers":
            return scrape_post_likers(ScrapePostLikersRequest(**params))
        if kind == "profile":
            return scrape_profile(ScrapeProfileRequest(**params))
        if kind == "followers":
            return scrape_followers(ScrapeFollowersRequest(**params))
        if kind == "following":
            return scrape_following(ScrapeFollowingRequest(**params))
        if kind == "verified":
            return scrape_following_verified(ScrapeFollowingVerifiedRequest(**params))
        if kind == "mutual":
            # Followers + Following sekaligus untuk analisis mutual follow.
            uname    = extract_username(params.get("username", ""))
            max_count = int(params.get("max_count", 500))
            followers = run_followers_scraper(uname, max_count)
            following = run_following_scraper(uname, max_count)
            return success(
                {
                    "username":  uname,
                    "followers": followers.get("items", []),
                    "following": following.get("items", []),
                },
                f"Mutual @{uname}: {len(followers.get('items', []))} followers · "
                f"{len(following.get('items', []))} following",
            )
        if kind == "search_hashtag":
            return search_hashtag_endpoint(SearchHashtagRequest(**params))
        if kind == "search_keyword":
            return search_keyword_endpoint(SearchKeywordRequest(**params))
        if kind == "profile_deep":
            p = ScrapeProfileDeepRequest(**params)
            username = extract_username(p.username)
            if not username:
                return failure(f"Username tidak valid: '{p.username}'")
            try:
                result = run_profile_deep_scraper(
                    username=username,
                    date_from=p.date_from,
                    date_to=p.date_to,
                    max_posts=p.max_posts,
                    max_comments=p.max_comments,
                    include_replies=p.include_replies,
                    max_replies_per_comment=p.max_replies_per_comment,
                    scrape_likers=p.scrape_likers,
                    max_likers=p.max_likers,
                    aggressive_likers=p.aggressive_likers,
                    delay_between_posts=p.delay_between_posts,
                )
                if not result.get("success"):
                    return failure(
                        result.get("errors", [{}])[-1].get("error", "Deep scrape gagal"),
                        result,
                    )
                return success(
                    result,
                    f"Deep scrape @{username}: {result['total_posts_scraped']}/{result['total_posts_found']} posts, "
                    f"{result['total_comments']} comments, {result['total_likers']} likers",
                )
            except Exception as e:
                traceback.print_exc()
                return failure(str(e))
        return failure(f"Job kind tidak dikenal: {kind}")
    except HTTPException as he:
        return failure(str(he.detail))
    except Exception as e:
        traceback.print_exc()
        return failure(str(e))


@app.post("/api/jobs/start")
def start_job(req: StartJobRequest):
    label = (
        req.params.get("url")
        or req.params.get("username")
        or req.params.get("hashtag")
        or req.params.get("keyword")
        or req.kind
    )
    job_id = job_manager.create_job(req.kind, req.params, _job_dispatch, label=str(label))
    return success({"job_id": job_id, "kind": req.kind}, f"Job {req.kind} dimulai")


@app.get("/api/jobs")
def list_jobs():
    return success({"jobs": job_manager.list_jobs()})


@app.get("/api/jobs/{job_id}")
def get_job_status(job_id: str):
    st = job_manager.get_job(job_id)
    if not st:
        return failure(f"Job '{job_id}' tidak ditemukan", {"status": "not_found"})
    return success(st)


@app.get("/api/jobs/{job_id}/result")
def get_job_result(job_id: str):
    st = job_manager.get_job(job_id)
    if not st:
        return failure(f"Job '{job_id}' tidak ditemukan", {"status": "not_found"})
    if st.get("status") == job_manager.JobStatus.ERROR:
        return failure(st.get("error") or "Job error", {"status": "error"})
    if st.get("status") != job_manager.JobStatus.COMPLETED:
        return failure(f"Job belum selesai (status: {st.get('status')})",
                       {"status": st.get("status")})
    result = job_manager.get_job_result(job_id)
    if result is None:
        return failure("Hasil job tidak ditemukan", {"status": "missing_result"})
    # result sudah berbentuk ApiResponse {success, message, data} — kirim apa adanya.
    return result


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    ok = job_manager.delete_job(job_id)
    return success({"job_id": job_id, "deleted": ok})


# ════════════════════════════════════════════════════════════════════════════
# ENTRYPOINT
# ════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)