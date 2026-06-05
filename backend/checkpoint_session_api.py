"""
checkpoint_session_api.py
──────────────────────────────────────────────────────────────────────────────
ENDPOINT untuk Checkpoint Scraping Session.

FIX: TypeError: __bases__ assignment: 'CheckpointMixin' deallocator differs from 'object'
─────────────────────────────────────────────────────────────────────────────
PENYEBAB:
    Kode lama di subprocess melakukan runtime patching:
        InstagramScraperV16.__bases__ = (CheckpointMixin,) + InstagramScraperV16.__bases__
    Python melarang ini karena CPython mengalokasikan memory layout berbeda
    untuk setiap class dan tidak bisa diubah setelah class dibuat.

SOLUSI:
    Buat subclass saja di dalam subprocess:
        class CheckpointScraper(CheckpointMixin, InstagramScraperV16):
            pass
    Ini 100% valid Python dan tidak memerlukan patching apapun.
──────────────────────────────────────────────────────────────────────────────

Cara integrasi ke main.py:
  1. Taruh file ini di folder yang sama dengan main.py
  2. Di main.py, tambahkan TEPAT di bawah baris `app = FastAPI(...)`:

       from checkpoint_session_api import router as checkpoint_router
       app.include_router(checkpoint_router)
──────────────────────────────────────────────────────────────────────────────
"""
import os
import re
import sys
import csv
import json
import io
import time
import traceback
from datetime import datetime
from typing import Optional, Dict, List, Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

# ── PATH helper ───────────────────────────────────────────────────────────────
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR  = os.path.join(BASE_DIR, "engine")
OUTPUT_DIR  = os.path.join(ENGINE_DIR, "output")
SESSION_DIR = os.path.join(ENGINE_DIR, "checkpoint_sessions")

sys.path.insert(0, ENGINE_DIR)
os.makedirs(SESSION_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR,  exist_ok=True)

router = APIRouter(prefix="/api/scrape/session", tags=["checkpoint"])


# ─────────────────────────────────────────────────────────────────────────────
# PYDANTIC MODELS
# ─────────────────────────────────────────────────────────────────────────────

class StartCheckpointRequest(BaseModel):
    url: str
    batch_size: int = 300
    include_replies: bool = False
    max_replies_per_comment: int = 20

    @field_validator("batch_size")
    @classmethod
    def validate_batch_size(cls, v: int) -> int:
        if not (10 <= v <= 1000):
            raise ValueError("batch_size harus antara 10–1000")
        return v


class ContinueCheckpointRequest(BaseModel):
    session_id: str


# ─────────────────────────────────────────────────────────────────────────────
# SESSION STORAGE HELPERS
# ─────────────────────────────────────────────────────────────────────────────

_SID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _session_path(session_id: str) -> str:
    if not _SID_RE.match(session_id or ""):
        raise HTTPException(400, "session_id tidak valid")
    return os.path.join(SESSION_DIR, f"{session_id}.json")


def _load_session(session_id: str) -> dict:
    p = _session_path(session_id)
    if not os.path.exists(p):
        raise HTTPException(404, f"Sesi '{session_id}' tidak ditemukan")
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_session(session: dict) -> None:
    p = _session_path(session["session_id"])
    with open(p, "w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False, indent=2, default=str)


def _make_session_id(url: str) -> str:
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = re.sub(r"[^A-Za-z0-9]", "_", url)[-30:]
    return f"cp_{ts}_{slug}"


def _session_summary(s: dict) -> dict:
    return {
        "session_id":     s["session_id"],
        "url":            s["url"],
        "shortcode":      s.get("shortcode", ""),
        "owner_username": s.get("owner_username", ""),
        "status":         s["status"],
        "has_more":       s["has_more"],
        "total_comments": s["total_comments"],
        "total_replies":  s["total_replies"],
        "batch_count":    len(s.get("batches", [])),
        "created_at":     s["created_at"],
        "updated_at":     s["updated_at"],
    }


# ─────────────────────────────────────────────────────────────────────────────
# SUBPROCESS RUNNER
# ─────────────────────────────────────────────────────────────────────────────

import tempfile
import subprocess


def _run_checkpoint_subprocess(script: str, timeout: int = 900) -> dict:
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
            f"STDERR: {stderr_tail}\nSTDOUT: {stdout_tail}"
        )
    finally:
        try:
            os.unlink(script_path)
        except Exception:
            pass


def _run_checkpoint_batch(
    post_url: str,
    batch_size: int,
    cursor: Optional[dict],
    include_replies: bool,
    max_replies_per_comment: int,
    fetch_meta: bool,
) -> dict:
    # ─────────────────────────────────────────────────────────────────────────
    # FIX UTAMA: 
    #   SEBELUM (ERROR):
    #       InstagramScraperV16.__bases__ = (CheckpointMixin,) + InstagramScraperV16.__bases__
    #   
    #   SESUDAH (BENAR):
    #       class CheckpointScraper(CheckpointMixin, InstagramScraperV16): pass
    #
    # Python tidak mengizinkan modifikasi __bases__ saat class sudah dikompilasi
    # (CPython melarang ini karena memory layout class berbeda).
    # Solusi: buat subclass yang menggabungkan kedua class — ini cara OOP yang benar.
    # CheckpointMixin harus di kiri agar method MRO-nya lebih prioritas.
    # ─────────────────────────────────────────────────────────────────────────

    # Encode cursor dengan aman via double-encode JSON
    if cursor:
        cursor_line = f"cursor = json.loads({json.dumps(json.dumps(cursor))})"
    else:
        cursor_line = "cursor = None"

    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
import json

# Import kedua class
from scraper_post import InstagramScraperV16
from scraper_checkpoint import CheckpointMixin

# BENAR: subclass biasa — tidak perlu patching __bases__
class CheckpointScraper(CheckpointMixin, InstagramScraperV16):
    pass

{cursor_line}

with CheckpointScraper() as scraper:
    result = scraper.scrape_checkpoint_batch(
        {json.dumps(post_url)},
        batch_size={batch_size},
        cursor=cursor,
        include_replies={include_replies},
        max_replies_per_comment={max_replies_per_comment},
        fetch_meta={fetch_meta},
    )
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    timeout = 600 if include_replies else 300
    return _run_checkpoint_subprocess(script, timeout=timeout)


# ─────────────────────────────────────────────────────────────────────────────
# SENTIMENT SUMMARY
# ─────────────────────────────────────────────────────────────────────────────

def _compute_mini_sentiment(comments: list) -> dict:
    total = len(comments)
    if total == 0:
        return {
            "total_comments": 0,
            "top_liked": [],
            "hate_examples": [],
            "most_active_users": [],
        }

    cats: Dict[str, int] = {
        "POSITIVE": 0, "NEGATIVE": 0, "NEUTRAL": 0,
        "HUMOR": 0, "HATE_SPEECH": 0, "TOXIC": 0,
    }
    hate = 0; toxic = 0; sarcasm = 0; wellwish = 0
    user_counts: Dict[str, int] = {}

    for c in comments:
        cat = c.get("category", "NEUTRAL")
        cats[cat] = cats.get(cat, 0) + 1
        if c.get("is_hate_speech"): hate    += 1
        if c.get("is_toxic"):       toxic   += 1
        if c.get("is_sarcasm"):     sarcasm += 1
        if c.get("is_wellwish"):    wellwish += 1
        u = c.get("username", "")
        if u:
            user_counts[u] = user_counts.get(u, 0) + 1

    def pct(n: int) -> float:
        return round(n / total * 100, 1) if total else 0.0

    top_liked   = sorted(comments, key=lambda c: c.get("like_count", 0), reverse=True)[:5]
    most_active = sorted(user_counts.items(), key=lambda x: x[1], reverse=True)[:5]

    return {
        "total_comments":       total,
        "positive_count":       cats["POSITIVE"],
        "negative_count":       cats["NEGATIVE"],
        "neutral_count":        cats["NEUTRAL"],
        "humor_count":          cats["HUMOR"],
        "hate_speech_count":    cats["HATE_SPEECH"],
        "toxic_count":          cats["TOXIC"],
        "positive_percentage":  pct(cats["POSITIVE"]),
        "negative_percentage":  pct(cats["NEGATIVE"]),
        "neutral_percentage":   pct(cats["NEUTRAL"]),
        "humor_percentage":     pct(cats["HUMOR"]),
        "hate_percentage":      pct(cats["HATE_SPEECH"]),
        "toxic_percentage":     pct(cats["TOXIC"]),
        "sarcasm_count":        sarcasm,
        "sarcasm_percentage":   pct(sarcasm),
        "wellwish_count":       wellwish,
        "wellwish_percentage":  pct(wellwish),
        "avg_ml_confidence":    0,
        "top_liked": [
            {
                "username":   c.get("username", ""),
                "text":       c.get("text", ""),
                "like_count": c.get("like_count", 0),
                "category":   c.get("category", ""),
                "sentiment":  c.get("sentiment", ""),
            }
            for c in top_liked
        ],
        "hate_examples":    [],
        "toxic_examples":   [],
        "most_active_users": [
            {"username": u, "comment_count": n}
            for u, n in most_active
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
# RESPONSE WRAPPERS
# ─────────────────────────────────────────────────────────────────────────────

def _ok(data: dict, msg: str = "OK") -> dict:
    return {
        "success":   True,
        "message":   msg,
        "timestamp": datetime.now().isoformat(),
        "data":      data,
    }


def _fail(msg: str, data: Optional[dict] = None) -> dict:
    return {
        "success":   False,
        "message":   msg,
        "timestamp": datetime.now().isoformat(),
        "data":      data or {},
    }


# ─────────────────────────────────────────────────────────────────────────────
# CSV HELPERS
# ─────────────────────────────────────────────────────────────────────────────

COMMENT_CSV_FIELDS = [
    "type", "number", "username", "text", "comment_id",
    "like_count", "reply_count", "created_at",
    "category", "sentiment", "language",
    "is_hate_speech", "is_toxic", "is_sarcasm", "is_wellwish",
    "hate_score", "ml_confidence", "vader_compound", "decision_source",
    "hate_words", "toxic_words", "positive_words", "negative_words",
    "humor_words", "emojis", "parent_comment_id",
]


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
            "hate_words":        "|".join(c.get("hate_words",     []) or []),
            "toxic_words":       "|".join(c.get("toxic_words",    []) or []),
            "positive_words":    "|".join(c.get("positive_words", []) or []),
            "negative_words":    "|".join(c.get("negative_words", []) or []),
            "humor_words":       "|".join(c.get("humor_words",    []) or []),
            "emojis":            "|".join(c.get("emojis",         []) or []),
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
                    "hate_words":        "|".join(r.get("hate_words",     []) or []),
                    "toxic_words":       "|".join(r.get("toxic_words",    []) or []),
                    "positive_words":    "|".join(r.get("positive_words", []) or []),
                    "negative_words":    "|".join(r.get("negative_words", []) or []),
                    "humor_words":       "|".join(r.get("humor_words",    []) or []),
                    "emojis":            "|".join(r.get("emojis",         []) or []),
                    "parent_comment_id": r.get("parent_comment_id", ""),
                })
    return rows


def _rows_to_csv_bytes(rows: list, fieldnames: list) -> bytes:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8-sig")


# ─────────────────────────────────────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/start")
def start_checkpoint_session(req: StartCheckpointRequest):
    """
    Mulai sesi checkpoint baru — langsung scrape batch pertama
    (termasuk ambil metadata postingan).
    """
    try:
        t0 = time.time()
        batch_result = _run_checkpoint_batch(
            post_url=req.url,
            batch_size=req.batch_size,
            cursor=None,
            include_replies=req.include_replies,
            max_replies_per_comment=req.max_replies_per_comment,
            fetch_meta=True,
        )

        if batch_result.get("error"):
            raise Exception(batch_result["error"])

        # Ekstrak shortcode
        m = re.search(r"/(p|reel|tv)/([A-Za-z0-9_-]+)", req.url)
        shortcode = batch_result.get("shortcode") or (m.group(2) if m else "unknown")

        meta     = batch_result.get("meta", {})
        now      = datetime.now().isoformat()
        session_id = _make_session_id(req.url)

        comments:      List[dict] = batch_result.get("batch_comments", [])
        total_replies: int        = batch_result.get("batch_replies", 0)

        session: dict = {
            "session_id":              session_id,
            "url":                     req.url,
            "shortcode":               shortcode,
            "status":                  "active",
            "batch_size":              req.batch_size,
            "include_replies":         req.include_replies,
            "max_replies_per_comment": req.max_replies_per_comment,
            "created_at":              now,
            "updated_at":              now,
            "cursor":                  batch_result.get("next_cursor"),
            "has_more":                batch_result.get("has_more", False),
            "method":                  batch_result.get("method", ""),
            "batches": [{
                "batch_num":  1,
                "count":      len(comments),
                "replies":    total_replies,
                "scraped_at": now,
            }],
            "total_comments":    len(comments),
            "total_replies":     total_replies,
            # Metadata postingan
            "owner_username":    meta.get("owner_username", ""),
            "caption":           meta.get("caption", ""),
            "media_id":          meta.get("media_id", ""),
            "likes":             meta.get("likes", 0),
            "media_type":        meta.get("media_type", "UNKNOWN"),
            "product_type":      meta.get("product_type", ""),
            "video_views":       meta.get("video_views", 0),
            "play_count":        meta.get("play_count", 0),
            "shares_count":      meta.get("shares_count", 0),
            "reshare_count":     meta.get("reshare_count", 0),
            "direct_send_count": meta.get("direct_send_count", 0),
            "saves_count":       meta.get("saves_count", 0),
            # Komentar gabungan
            "comments":          comments,
            "sentiment_summary": _compute_mini_sentiment(comments),
            # Info batch terakhir
            "last_batch_added":         len(comments),
            "last_batch_added_replies": total_replies,
            "error":                    None,
        }

        _save_session(session)
        elapsed = round(time.time() - t0, 2)

        return _ok(
            session,
            f"Sesi dimulai: {len(comments)} komentar batch pertama dalam {elapsed}s",
        )

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"Gagal memulai sesi: {str(e)}")


@router.post("/continue")
def continue_checkpoint_session(req: ContinueCheckpointRequest):
    """Lanjut scrape satu batch berikutnya dari cursor terakhir."""
    try:
        session = _load_session(req.session_id)

        if session["status"] != "active":
            return _fail(
                f"Sesi status '{session['status']}' — tidak bisa dilanjutkan",
                session,
            )
        if not session.get("has_more"):
            return _fail(
                "Tidak ada komentar lagi — semua sudah diambil. Lakukan finalisasi.",
                session,
            )

        t0        = time.time()
        batch_num = len(session["batches"]) + 1

        batch_result = _run_checkpoint_batch(
            post_url=session["url"],
            batch_size=session["batch_size"],
            cursor=session.get("cursor"),
            include_replies=session.get("include_replies", False),
            max_replies_per_comment=session.get("max_replies_per_comment", 20),
            fetch_meta=False,
        )

        if batch_result.get("error"):
            session["status"]     = "error"
            session["updated_at"] = datetime.now().isoformat()
            _save_session(session)
            raise Exception(batch_result["error"])

        new_comments: List[dict] = batch_result.get("batch_comments", [])
        new_replies:  int        = batch_result.get("batch_replies", 0)

        # Dedupe terhadap komentar yang sudah ada
        existing_ids = {
            c.get("comment_id")
            for c in session["comments"]
            if c.get("comment_id")
        }
        unique_new = [
            c for c in new_comments
            if c.get("comment_id") not in existing_ids or not c.get("comment_id")
        ]
        added = len(unique_new)

        now = datetime.now().isoformat()
        session["comments"].extend(unique_new)
        session["total_comments"] += added
        session["total_replies"]  += new_replies
        session["cursor"]          = batch_result.get("next_cursor")
        session["has_more"]        = batch_result.get("has_more", False)
        session["method"]          = batch_result.get("method", session["method"])
        session["updated_at"]      = now
        session["batches"].append({
            "batch_num":  batch_num,
            "count":      added,
            "replies":    new_replies,
            "scraped_at": now,
        })
        session["sentiment_summary"]        = _compute_mini_sentiment(session["comments"])
        session["last_batch_added"]         = added
        session["last_batch_added_replies"] = new_replies

        _save_session(session)
        elapsed = round(time.time() - t0, 2)

        return _ok(
            session,
            f"Batch #{batch_num}: +{added} komentar baru | "
            f"total {session['total_comments']} dalam {elapsed}s",
        )

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"Gagal melanjutkan sesi: {str(e)}")


@router.get("/list")
def list_checkpoint_sessions():
    """Daftar semua sesi checkpoint (ringkasan)."""
    sessions = []
    if os.path.exists(SESSION_DIR):
        for f in sorted(os.listdir(SESSION_DIR), reverse=True):
            if f.endswith(".json"):
                fp = os.path.join(SESSION_DIR, f)
                try:
                    with open(fp, "r", encoding="utf-8") as fh:
                        s = json.load(fh)
                    sessions.append(_session_summary(s))
                except Exception:
                    pass
    return _ok({"sessions": sessions, "count": len(sessions)})


@router.get("/{session_id}")
def get_checkpoint_session(session_id: str):
    """Detail sesi lengkap (termasuk komentar gabungan)."""
    session = _load_session(session_id)
    return _ok(session)


@router.post("/{session_id}/finalize")
def finalize_checkpoint_session(session_id: str):
    """Tandai sesi selesai + simpan file JSON gabungan di output dir."""
    session = _load_session(session_id)
    if session["status"] == "completed":
        return _ok(session, "Sesi sudah selesai sebelumnya")

    now = datetime.now().isoformat()
    session["status"]     = "completed"
    session["updated_at"] = now

    # Simpan file gabungan di output dir
    fname = (
        f"checkpoint_{session_id}_"
        f"{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    )
    fpath = os.path.join(OUTPUT_DIR, fname)
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False, indent=2, default=str)
    session["_meta"] = {"saved_file": fname}

    _save_session(session)
    return _ok(
        session,
        f"Sesi difinalisasi — {session['total_comments']} komentar "
        f"disimpan ke {fname}",
    )


@router.delete("/{session_id}")
def delete_checkpoint_session(session_id: str):
    """Hapus sesi (file JSON sesi dihapus, file output tetap ada)."""
    p = _session_path(session_id)
    if not os.path.exists(p):
        raise HTTPException(404, f"Sesi '{session_id}' tidak ditemukan")
    os.unlink(p)
    return _ok({"deleted": True, "session_id": session_id})


@router.get("/{session_id}/download")
def download_checkpoint_json(session_id: str):
    """Download JSON gabungan sesi."""
    session = _load_session(session_id)
    content = json.dumps(session, ensure_ascii=False, indent=2, default=str)
    fname   = f"checkpoint_{session_id}.json"
    return StreamingResponse(
        io.BytesIO(content.encode("utf-8")),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{session_id}/comments.csv")
def download_checkpoint_csv(session_id: str, replies: bool = Query(True)):
    """Download CSV komentar gabungan sesi."""
    session   = _load_session(session_id)
    comments  = session.get("comments", [])
    rows      = _comments_to_csv_rows(comments, include_replies=replies)
    csv_bytes = _rows_to_csv_bytes(rows, COMMENT_CSV_FIELDS)
    fname     = f"checkpoint_{session_id}_comments.csv"
    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )