"""
job_manager.py
==============
Job manager generik untuk scraping berat (post / unified / batch / likers /
profile / followers / following / verified / search hashtag & keyword).

Pola sama persis dengan Deep Search (engine/search_checkpoint.py):
  - create_job() menjalankan worker di BACKGROUND THREAD (daemon) dan
    menyimpan STATE + RESULT ke file JSON di engine/scrape_jobs/.
  - Karena state ada di disk, job tetap ada walau klien refresh / server
    restart → frontend tinggal polling get_job() lalu ambil get_job_result()
    saat statusnya "completed".

State file:   <job_id>.json         → {job_id, kind, label, status, ...}
Result file:  <job_id>_result.json  → ApiResponse {success, message, data}

Worker memanggil `runner(kind, params)` yang di-inject dari main.py (dispatch),
jadi tidak ada circular import dan semua logika scraper tetap satu sumber.
"""

import os
import json
import uuid
import threading
import traceback
from datetime import datetime
from typing import Optional, Callable, Dict, List

# ── Folder penyimpanan state job ────────────────────────────────────────────
_HERE     = os.path.dirname(os.path.abspath(__file__))
_JOBS_DIR = os.path.join(_HERE, "engine", "scrape_jobs")
os.makedirs(_JOBS_DIR, exist_ok=True)


class JobStatus:
    PENDING   = "pending"
    RUNNING   = "running"
    COMPLETED = "completed"   # worker selesai (lihat result.success utk sukses/gagal logis)
    ERROR     = "error"       # worker crash / exception tak terduga


# ── Path & lock helpers ─────────────────────────────────────────────────────
def _state_path(job_id: str) -> str:
    return os.path.join(_JOBS_DIR, f"{job_id}.json")

def _result_path(job_id: str) -> str:
    return os.path.join(_JOBS_DIR, f"{job_id}_result.json")


_locks: Dict[str, threading.Lock] = {}
_locks_lock = threading.Lock()

def _lock(job_id: str) -> threading.Lock:
    with _locks_lock:
        return _locks.setdefault(job_id, threading.Lock())


def _read_json(path: str) -> Optional[dict]:
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def _write_json(path: str, data) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, default=str)


def _update_state(job_id: str, **kw) -> None:
    with _lock(job_id):
        st = _read_json(_state_path(job_id)) or {}
        st.update(kw)
        st["updated_at"] = datetime.now().isoformat()
        _write_json(_state_path(job_id), st)


# ── Public API ──────────────────────────────────────────────────────────────
def get_job(job_id: str) -> Optional[dict]:
    """State job (tanpa result besar) — dipakai untuk polling status."""
    return _read_json(_state_path(job_id))


def get_job_result(job_id: str) -> Optional[dict]:
    """ApiResponse hasil job (hanya ada setelah status completed)."""
    return _read_json(_result_path(job_id))


def delete_job(job_id: str) -> bool:
    deleted = False
    for p in (_state_path(job_id), _result_path(job_id)):
        if os.path.exists(p):
            try:
                os.remove(p)
                deleted = True
            except Exception:
                pass
    return deleted


def list_jobs() -> List[dict]:
    jobs: List[dict] = []
    try:
        for fname in sorted(os.listdir(_JOBS_DIR), reverse=True):
            if fname.endswith("_result.json") or not fname.endswith(".json"):
                continue
            st = _read_json(os.path.join(_JOBS_DIR, fname))
            if st:
                jobs.append(st)
    except Exception:
        pass
    return jobs


def create_job(kind: str, params: dict, runner: Callable[[str, dict], dict],
               label: str = "") -> str:
    """
    Buat job baru → langsung jalankan worker di thread background. Return job_id.
    `runner(kind, params)` harus mengembalikan dict ApiResponse
    {success, message, data} (boleh juga success=False utk gagal logis).
    """
    job_id = str(uuid.uuid4())[:12]
    now = datetime.now().isoformat()
    _write_json(_state_path(job_id), {
        "job_id":     job_id,
        "kind":       kind,
        "label":      label,
        "status":     JobStatus.PENDING,
        "created_at": now,
        "updated_at": now,
        "error":      None,
        "message":    None,
    })

    t = threading.Thread(
        target=_run_worker,
        args=(job_id, kind, params, runner),
        daemon=True,
        name=f"scrape-job-{job_id}",
    )
    t.start()
    return job_id


# ── Worker ──────────────────────────────────────────────────────────────────
def _run_worker(job_id: str, kind: str, params: dict,
                runner: Callable[[str, dict], dict]) -> None:
    _update_state(job_id, status=JobStatus.RUNNING)
    try:
        resp = runner(kind, params) or {}
        _write_json(_result_path(job_id), resp)
        _update_state(
            job_id,
            status=JobStatus.COMPLETED,
            message=resp.get("message"),
        )
    except Exception as e:
        traceback.print_exc()
        _update_state(job_id, status=JobStatus.ERROR, error=str(e))
