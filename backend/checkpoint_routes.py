"""
checkpoint_routes.py — taruh di ROOT backend (sejajar main.py, BUKAN di engine/)

Router FastAPI untuk scraping komentar BERBASIS CHECKPOINT (batch + resume):

  POST /api/scrape/session/start            → mulai sesi, ambil batch pertama
  POST /api/scrape/session/continue         → lanjut dari checkpoint (cursor) terakhir
  GET  /api/scrape/session/list             → daftar semua sesi
  GET  /api/scrape/session/{sid}            → detail sesi (komentar gabungan + summary)
  POST /api/scrape/session/{sid}/finalize   → tandai selesai + simpan file JSON gabungan
  GET  /api/scrape/session/{sid}/download    → unduh JSON gabungan
  GET  /api/scrape/session/{sid}/comments.csv → unduh CSV komentar gabungan
  DELETE /api/scrape/session/{sid}          → hapus sesi

Konsep:
  - Tiap batch dijalankan lewat SUBPROCESS (sama pola dgn main.py): Playwright
    dibuka, navigasi ke post, lalu memanggil InstagramScraperV16.scrape_checkpoint_batch.
  - State sesi (cursor + komentar gabungan + summary) disimpan ke FILE JSON di
    output/sessions/. Subprocess sendiri stateless: diberi cursor → balas batch + cursor baru.
  - Dedup global per comment_id saat merge. Komentar dinomori ulang tiap merge.
  - File JSON gabungan = SATU file berisi semua komentar dari semua batch.

Pasang di main.py:
    from checkpoint_routes import router as checkpoint_router
    app.include_router(checkpoint_router)
"""
import os
import re
import io
import csv
import sys
import json
import time
import uuid
import tempfile
import subprocess
import traceback
from datetime import datetime
from collections import Counter
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

# ── PATH SETUP (self-contained, tidak impor dari main.py → hindari circular) ──
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR   = os.path.join(BASE_DIR, "engine")
OUTPUT_DIR   = os.path.join(ENGINE_DIR, "output")
SESSIONS_DIR = os.path.join(OUTPUT_DIR, "sessions")

os.makedirs(SESSIONS_DIR, exist_ok=True)

router = APIRouter(prefix="/api/scrape/session", tags=["checkpoint"])


# ════════════════════════════════════════════════════════════════════════════
# MODELS
# ════════════════════════════════════════════════════════════════════════════

class StartSessionRequest(BaseModel):
    url: str
    batch_size: int = 300              # jumlah komentar per batch
    include_replies: bool = False
    max_replies_per_comment: int = 20

    @field_validator("batch_size")
    @classmethod
    def _validate_batch(cls, v: int) -> int:
        if v < 10 or v > 1000:
            raise ValueError("batch_size harus antara 10 dan 1000")
        return v


class ContinueSessionRequest(BaseModel):
    session_id: str


# ════════════════════════════════════════════════════════════════════════════
# SUBPROCESS RUNNER (copy mandiri dari main.py)
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


def _batch_timeout(batch_size: int, include_replies: bool) -> int:
    """Estimasi timeout untuk SATU batch (bukan keseluruhan sesi)."""
    base = max(600, 300 + (batch_size // 50) * 90)
    base = min(3600, base)
    if include_replies:
        base *= 2
    return base


def run_checkpoint_batch(
    url: str,
    batch_size: int,
    cursor: Optional[Dict],
    include_replies: bool,
    max_replies_per_comment: int,
    fetch_meta: bool,
) -> dict:
    """Jalankan satu batch checkpoint via subprocess."""
    # cursor di-pass aman lewat double-encode JSON
    if cursor:
        cursor_line = f"cursor = json.loads({json.dumps(json.dumps(cursor))})"
    else:
        cursor_line = "cursor = None"

    script = f"""
import sys
sys.path.insert(0, r'{ENGINE_DIR}')
from scraper_post import InstagramScraperV16
import json

{cursor_line}

with InstagramScraperV16() as scraper:
    result = scraper.scrape_checkpoint_batch(
        {json.dumps(url)},
        batch_size={batch_size},
        cursor=cursor,
        include_replies={include_replies},
        max_replies_per_comment={max_replies_per_comment},
        fetch_meta={fetch_meta},
    )
    print("___RESULT_START___")
    print(json.dumps(result, ensure_ascii=False, default=str))
"""
    timeout = _batch_timeout(batch_size, include_replies)
    return _run_subprocess(script, timeout=timeout)


# ════════════════════════════════════════════════════════════════════════════
# SESSION STORE (file-based)
# ════════════════════════════════════════════════════════════════════════════

_SID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _session_path(session_id: str) -> str:
    if not _SID_RE.match(session_id or ""):
        raise HTTPException(400, "session_id tidak valid")
    return os.path.join(SESSIONS_DIR, f"{session_id}.json")


def _load_session(session_id: str) -> dict:
    fp = _session_path(session_id)
    if not os.path.exists(fp):
        raise HTTPException(404, f"Sesi '{session_id}' tidak ditemukan")
    with open(fp, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_session(session: dict) -> None:
    session["updated_at"] = datetime.now().isoformat()
    fp = _session_path(session["session_id"])
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False, indent=2, default=str)


def _new_session(url: str, shortcode: str, batch_size: int,
                 include_replies: bool, max_replies_per_comment: int) -> dict:
    ts  = datetime.now().strftime("%Y%m%d_%H%M%S")
    sid = f"{shortcode}_{ts}_{uuid.uuid4().hex[:6]}"
    now = datetime.now().isoformat()
    return {
        "session_id":              sid,
        "url":                     url,
        "shortcode":               shortcode,
        "status":                  "active",          # active | completed | error
        "batch_size":              batch_size,
        "include_replies":         include_replies,
        "max_replies_per_comment": max_replies_per_comment,
        "created_at":              now,
        "updated_at":              now,
        "cursor":                  None,              # {"method","value"} | None
        "has_more":                True,
        "method":                  "",
        "batches":                 [],                # riwayat batch
        "total_comments":          0,
        "total_replies":           0,
        # meta postingan (diisi di batch pertama)
        "owner_username":          "",
        "caption":                 "",
        "media_id":                "",
        "likes":                   0,
        "media_type":              "UNKNOWN",
        "product_type":            "",
        "video_views":             0,
        "play_count":              0,
        "shares_count":            0,
        "reshare_count":           0,
        "direct_send_count":       0,
        "saves_count":             0,
        # data gabungan
        "comments":                [],
        "sentiment_summary":       {},
        "error":                   None,
    }


def _apply_meta(session: dict, meta: dict) -> None:
    """Salin metadata postingan dari batch pertama ke sesi."""
    if not meta:
        return
    for key in ("owner_username", "caption", "media_id", "likes",
                "media_type", "product_type", "video_views", "play_count",
                "shares_count", "reshare_count", "direct_send_count", "saves_count"):
        if meta.get(key) not in (None, "", 0) or key not in session:
            if key in meta:
                session[key] = meta[key]


def _merge_batch(session: dict, batch_comments: List[dict]):
    """Gabung komentar batch baru ke sesi (dedup by comment_id, nomori ulang)."""
    existing_ids = {c.get("comment_id") for c in session["comments"] if c.get("comment_id")}
    added = 0
    added_replies = 0

    for c in batch_comments:
        cid = c.get("comment_id", "")
        if cid and cid in existing_ids:
            continue
        if cid:
            existing_ids.add(cid)
        session["comments"].append(c)
        added += 1
        added_replies += len(c.get("replies", []) or [])

    # nomori ulang berurutan
    for i, c in enumerate(session["comments"], 1):
        c["number"] = i

    session["total_comments"] = len(session["comments"])
    session["total_replies"]  = sum(len(c.get("replies", []) or []) for c in session["comments"])
    return added, added_replies


# ════════════════════════════════════════════════════════════════════════════
# SUMMARY (port dari InstagramScraperV16._summarize agar identik dgn single-shot)
# ════════════════════════════════════════════════════════════════════════════

def _engagement_summary(session: dict) -> dict:
    return {
        "media_type":        session.get("media_type", "UNKNOWN"),
        "product_type":      session.get("product_type", ""),
        "likes":             session.get("likes", 0),
        "video_views":       session.get("video_views", 0),
        "play_count":        session.get("play_count", 0),
        "shares_count":      session.get("shares_count", 0),
        "reshare_count":     session.get("reshare_count", 0),
        "direct_send_count": session.get("direct_send_count", 0),
        "saves_count":       session.get("saves_count", 0),
    }


def summarize_comments(comments: List[dict], session: Optional[dict] = None) -> dict:
    if not comments:
        base: dict = {"total_comments": 0}
        if session:
            base.update(_engagement_summary(session))
        return base

    total = len(comments)
    counts = {k: 0 for k in ("HATE_SPEECH", "TOXIC", "POSITIVE", "NEGATIVE", "NEUTRAL", "HUMOR")}
    hate_ex: List[dict] = []
    toxic_ex: List[dict] = []
    sarcasm_count = 0
    wellwish_count = 0
    decision_sources: Counter = Counter()
    ml_confidences: List[float] = []
    total_replies = 0
    replies_counts = {k: 0 for k in ("HATE_SPEECH", "TOXIC", "POSITIVE", "NEGATIVE", "NEUTRAL", "HUMOR")}

    for c in comments:
        cat = c.get("category", "NEUTRAL")
        if cat in counts:
            counts[cat] += 1
        if c.get("is_hate_speech"):
            hate_ex.append({
                "username": c.get("username", ""), "text": c.get("text", ""),
                "hate_words": c.get("hate_words", []), "like_count": c.get("like_count", 0),
            })
        if c.get("is_toxic"):
            toxic_ex.append({
                "username": c.get("username", ""), "text": c.get("text", ""),
                "toxic_words": c.get("toxic_words", []),
            })
        if c.get("is_sarcasm"):  sarcasm_count += 1
        if c.get("is_wellwish"): wellwish_count += 1

        decision_sources[c.get("decision_source", "unknown")] += 1
        mlc = c.get("ml_confidence", 0)
        if mlc and mlc > 0:
            ml_confidences.append(mlc)

        for r in c.get("replies", []) or []:
            total_replies += 1
            rcat = r.get("category", "NEUTRAL")
            if rcat in replies_counts:
                replies_counts[rcat] += 1

    sorted_by_likes = sorted(comments, key=lambda x: x.get("like_count", 0), reverse=True)
    top_likes = [{
        "username": c.get("username", ""), "text": (c.get("text", "") or "")[:150],
        "like_count": c.get("like_count", 0),
        "category": c.get("category", ""), "sentiment": c.get("sentiment", ""),
    } for c in sorted_by_likes[:10] if c.get("like_count", 0) > 0]

    top_hate = sorted(
        [c for c in comments if c.get("is_hate_speech")],
        key=lambda x: x.get("like_count", 0), reverse=True
    )[:5]

    commenter_stats = Counter([c.get("username", "") for c in comments])
    most_active = [{"username": u, "comment_count": n}
                   for u, n in commenter_stats.most_common(5) if n > 1]

    def pct(n):   return round(n / total * 100, 1)
    def pct_r(n): return round(n / total_replies * 100, 1) if total_replies > 0 else 0.0

    avg_conf = round(sum(ml_confidences) / len(ml_confidences), 3) if ml_confidences else 0.0

    s = {
        "total_comments":       total,
        "total_replies":        total_replies,
        "hate_speech_count":    counts["HATE_SPEECH"], "hate_percentage":     pct(counts["HATE_SPEECH"]),
        "toxic_count":          counts["TOXIC"],       "toxic_percentage":    pct(counts["TOXIC"]),
        "positive_count":       counts["POSITIVE"],    "positive_percentage": pct(counts["POSITIVE"]),
        "negative_count":       counts["NEGATIVE"],    "negative_percentage": pct(counts["NEGATIVE"]),
        "neutral_count":        counts["NEUTRAL"],     "neutral_percentage":  pct(counts["NEUTRAL"]),
        "humor_count":          counts["HUMOR"],       "humor_percentage":    pct(counts["HUMOR"]),
        "sarcasm_count":        sarcasm_count,         "sarcasm_percentage":  pct(sarcasm_count),
        "wellwish_count":       wellwish_count,        "wellwish_percentage": pct(wellwish_count),
        "avg_ml_confidence":    avg_conf,
        "decision_source_breakdown": dict(decision_sources),
        "hate_examples":        hate_ex[:10],
        "toxic_examples":       toxic_ex[:10],
        "top_liked":            top_likes,
        "top_hate_liked":       [{"username": c.get("username", ""), "text": (c.get("text", "") or "")[:150],
                                   "like_count": c.get("like_count", 0)} for c in top_hate],
        "most_active_users":    most_active,
        "replies_sentiment_breakdown": {
            "positive_count":    replies_counts["POSITIVE"],
            "negative_count":    replies_counts["NEGATIVE"],
            "neutral_count":     replies_counts["NEUTRAL"],
            "humor_count":       replies_counts["HUMOR"],
            "toxic_count":       replies_counts["TOXIC"],
            "hate_speech_count": replies_counts["HATE_SPEECH"],
            "positive_percentage":    pct_r(replies_counts["POSITIVE"]),
            "negative_percentage":    pct_r(replies_counts["NEGATIVE"]),
            "neutral_percentage":     pct_r(replies_counts["NEUTRAL"]),
            "humor_percentage":       pct_r(replies_counts["HUMOR"]),
            "toxic_percentage":       pct_r(replies_counts["TOXIC"]),
            "hate_percentage":        pct_r(replies_counts["HATE_SPEECH"]),
        },
    }

    if session:
        s["engagement"] = _engagement_summary(session)
    return s


def _recompute_summary(session: dict) -> None:
    session["sentiment_summary"] = summarize_comments(session["comments"], session)


# ════════════════════════════════════════════════════════════════════════════
# CSV HELPERS (copy dari main.py)
# ════════════════════════════════════════════════════════════════════════════

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


def _rows_to_csv_bytes(rows: list, fieldnames: list) -> bytes:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8-sig")


# ════════════════════════════════════════════════════════════════════════════
# RESPONSE WRAPPER
# ════════════════════════════════════════════════════════════════════════════

def _ok(session: dict, message: str, last_added: int = 0, last_added_replies: int = 0) -> dict:
    payload = dict(session)
    payload["last_batch_added"]         = last_added
    payload["last_batch_added_replies"] = last_added_replies
    return {
        "success":   True,
        "message":   message,
        "timestamp": datetime.now().isoformat(),
        "data":      payload,
    }


# ════════════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ════════════════════════════════════════════════════════════════════════════

@router.post("/start")
def start_session(req: StartSessionRequest):
    """Mulai sesi checkpoint baru + ambil batch pertama (sekalian metadata)."""
    m = re.search(r"/(p|reel|tv)/([A-Za-z0-9_-]+)", req.url)
    shortcode = m.group(2) if m else "unknown"

    session = _new_session(
        req.url, shortcode, req.batch_size,
        req.include_replies, req.max_replies_per_comment,
    )

    try:
        t0 = time.time()
        batch = run_checkpoint_batch(
            req.url,
            batch_size=req.batch_size,
            cursor=None,
            include_replies=req.include_replies,
            max_replies_per_comment=req.max_replies_per_comment,
            fetch_meta=True,
        )
        elapsed = round(time.time() - t0, 2)

        if batch.get("error"):
            session["status"] = "error"
            session["error"]  = batch["error"]
            _save_session(session)
            raise HTTPException(500, f"Batch pertama gagal: {batch['error']}")

        _apply_meta(session, batch.get("meta", {}))
        session["method"]   = batch.get("method", "")
        session["cursor"]   = batch.get("next_cursor")
        session["has_more"] = bool(batch.get("has_more"))

        added, added_replies = _merge_batch(session, batch.get("batch_comments", []))
        session["batches"].append({
            "batch_num":  len(session["batches"]) + 1,
            "count":      added,
            "replies":    added_replies,
            "scraped_at": datetime.now().isoformat(),
        })

        _recompute_summary(session)
        _save_session(session)

        return _ok(
            session,
            f"Batch 1 selesai: +{added} komentar (+{added_replies} balasan) dalam {elapsed}s",
            added, added_replies,
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        session["status"] = "error"
        session["error"]  = str(e)
        try:
            _save_session(session)
        except Exception:
            pass
        raise HTTPException(500, f"Start session gagal: {str(e)}")


@router.post("/continue")
def continue_session(req: ContinueSessionRequest):
    """Lanjut scrape satu batch dari cursor terakhir sesi."""
    session = _load_session(req.session_id)

    if session.get("status") == "completed":
        raise HTTPException(400, "Sesi sudah selesai (completed). Tidak ada yang perlu dilanjutkan.")
    if not session.get("has_more"):
        raise HTTPException(400, "Tidak ada komentar tersisa (has_more=false). Silakan finalize.")
    if not session.get("cursor"):
        raise HTTPException(400, "Cursor tidak tersedia — tidak bisa melanjutkan. Silakan finalize.")

    try:
        t0 = time.time()
        batch = run_checkpoint_batch(
            session["url"],
            batch_size=session["batch_size"],
            cursor=session["cursor"],
            include_replies=session["include_replies"],
            max_replies_per_comment=session["max_replies_per_comment"],
            fetch_meta=False,
        )
        elapsed = round(time.time() - t0, 2)

        if batch.get("error"):
            session["status"] = "error"
            session["error"]  = batch["error"]
            _save_session(session)
            raise HTTPException(500, f"Batch lanjutan gagal: {batch['error']}")

        session["cursor"]   = batch.get("next_cursor")
        session["has_more"] = bool(batch.get("has_more"))
        if batch.get("method"):
            session["method"] = batch["method"]

        added, added_replies = _merge_batch(session, batch.get("batch_comments", []))
        session["batches"].append({
            "batch_num":  len(session["batches"]) + 1,
            "count":      added,
            "replies":    added_replies,
            "scraped_at": datetime.now().isoformat(),
        })

        _recompute_summary(session)
        _save_session(session)

        batch_no = len(session["batches"])
        return _ok(
            session,
            f"Batch {batch_no} selesai: +{added} komentar (+{added_replies} balasan) dalam {elapsed}s",
            added, added_replies,
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        session["status"] = "error"
        session["error"]  = str(e)
        try:
            _save_session(session)
        except Exception:
            pass
        raise HTTPException(500, f"Continue session gagal: {str(e)}")


@router.get("/list")
def list_sessions():
    """Daftar semua sesi (ringkasan, tanpa isi komentar)."""
    sessions = []
    if os.path.exists(SESSIONS_DIR):
        for fn in sorted(os.listdir(SESSIONS_DIR), reverse=True):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(SESSIONS_DIR, fn), "r", encoding="utf-8") as f:
                    s = json.load(f)
                sessions.append({
                    "session_id":     s.get("session_id"),
                    "url":            s.get("url"),
                    "shortcode":      s.get("shortcode"),
                    "owner_username": s.get("owner_username"),
                    "status":         s.get("status"),
                    "has_more":       s.get("has_more"),
                    "total_comments": s.get("total_comments", 0),
                    "total_replies":  s.get("total_replies", 0),
                    "batch_count":    len(s.get("batches", [])),
                    "created_at":     s.get("created_at"),
                    "updated_at":     s.get("updated_at"),
                })
            except Exception:
                continue
    return {
        "success":   True,
        "message":   f"{len(sessions)} sesi",
        "timestamp": datetime.now().isoformat(),
        "data":      {"sessions": sessions, "count": len(sessions)},
    }


@router.get("/{session_id}")
def get_session(session_id: str):
    """Ambil detail sesi lengkap (komentar gabungan + summary)."""
    session = _load_session(session_id)
    return _ok(session, "Session retrieved")


@router.post("/{session_id}/finalize")
def finalize_session(session_id: str):
    """Tandai sesi selesai, hitung ulang summary, simpan file JSON gabungan."""
    session = _load_session(session_id)

    session["status"] = "completed"
    _recompute_summary(session)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    final_name = f"checkpoint_{session['shortcode']}_{ts}.json"
    final_fp   = os.path.join(OUTPUT_DIR, final_name)

    # file JSON gabungan: semua komentar dari semua batch dalam satu file
    final_doc = {
        "url":              session["url"],
        "shortcode":        session["shortcode"],
        "scraped_at":       datetime.now().isoformat(),
        "scrape_mode":      "checkpoint",
        "session_id":       session["session_id"],
        "owner_username":   session.get("owner_username", ""),
        "caption":          session.get("caption", ""),
        "media_id":         session.get("media_id", ""),
        "likes":            session.get("likes", 0),
        "method":           session.get("method", ""),
        "media_type":       session.get("media_type", "UNKNOWN"),
        "product_type":     session.get("product_type", ""),
        "video_views":      session.get("video_views", 0),
        "play_count":       session.get("play_count", 0),
        "shares_count":     session.get("shares_count", 0),
        "reshare_count":    session.get("reshare_count", 0),
        "direct_send_count": session.get("direct_send_count", 0),
        "saves_count":      session.get("saves_count", 0),
        "include_replies":  session.get("include_replies", False),
        "max_replies_per_comment": session.get("max_replies_per_comment", 20),
        "batch_size":       session.get("batch_size", 300),
        "total_batches":    len(session.get("batches", [])),
        "batches":          session.get("batches", []),
        "comments":         session["comments"],
        "comments_count":   session.get("total_comments", 0),
        "replies_count":    session.get("total_replies", 0),
        "sentiment_summary": session["sentiment_summary"],
    }

    with open(final_fp, "w", encoding="utf-8") as f:
        json.dump(final_doc, f, ensure_ascii=False, indent=2, default=str)

    session["_meta"] = {"saved_file": final_name}
    _save_session(session)

    return _ok(
        session,
        f"Sesi selesai: {session['total_comments']} komentar + "
        f"{session['total_replies']} balasan tersimpan di {final_name}",
    )


@router.get("/{session_id}/download")
def download_session_json(session_id: str):
    """Unduh JSON gabungan sesi (semua batch jadi satu)."""
    session = _load_session(session_id)

    doc = {
        "url":              session["url"],
        "shortcode":        session["shortcode"],
        "scrape_mode":      "checkpoint",
        "session_id":       session["session_id"],
        "owner_username":   session.get("owner_username", ""),
        "caption":          session.get("caption", ""),
        "media_id":         session.get("media_id", ""),
        "likes":            session.get("likes", 0),
        "method":           session.get("method", ""),
        "media_type":       session.get("media_type", "UNKNOWN"),
        "product_type":     session.get("product_type", ""),
        "video_views":      session.get("video_views", 0),
        "play_count":       session.get("play_count", 0),
        "shares_count":     session.get("shares_count", 0),
        "saves_count":      session.get("saves_count", 0),
        "total_batches":    len(session.get("batches", [])),
        "comments":         session["comments"],
        "comments_count":   session.get("total_comments", 0),
        "replies_count":    session.get("total_replies", 0),
        "sentiment_summary": session["sentiment_summary"],
    }
    content = json.dumps(doc, ensure_ascii=False, indent=2, default=str)
    fname = f"checkpoint_{session['shortcode']}_{session['session_id']}.json"

    return StreamingResponse(
        io.BytesIO(content.encode("utf-8")),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{session_id}/comments.csv")
def download_session_comments_csv(session_id: str, replies: bool = Query(True)):
    """Unduh CSV komentar gabungan sesi."""
    session = _load_session(session_id)
    rows = _comments_to_csv_rows(session["comments"], include_replies=replies)
    csv_bytes = _rows_to_csv_bytes(rows, COMMENT_CSV_FIELDS)
    fname = f"checkpoint_{session['shortcode']}_{session['session_id']}_comments.csv"

    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.delete("/{session_id}")
def delete_session(session_id: str):
    """Hapus file sesi."""
    fp = _session_path(session_id)
    if not os.path.exists(fp):
        raise HTTPException(404, f"Sesi '{session_id}' tidak ditemukan")
    os.unlink(fp)
    return {
        "success":   True,
        "message":   f"Sesi '{session_id}' dihapus",
        "timestamp": datetime.now().isoformat(),
        "data":      {"deleted": True, "session_id": session_id},
    }