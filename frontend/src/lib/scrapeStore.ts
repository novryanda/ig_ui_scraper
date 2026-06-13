'use client'

// lib/scrapeStore.ts
// ------------------------------------------------------------------
// Store status scraping di level MODULE (bukan di dalam komponen),
// supaya proses + hasilnya tetap hidup walau halaman di-unmount ketika
// user pindah ke halaman lain, lalu kembali lagi.
//
// Dua lapis:
//  1) Global busy lock (kompat lama): hanya satu scrape "exclusive" boleh
//     jalan sekaligus — karena backend memakai satu sesi browser, dua
//     scrape berat bersamaan akan saling tabrakan. Search (REST, ringan)
//     berjalan non-exclusive sehingga tidak ikut terkunci.
//
//  2) Per-key task state (BARU): setiap halaman/aliran scraping menyimpan
//     status + hasil + error-nya pada sebuah key. Karena ini hidup di
//     module, maka:
//       - Mulai scrape post → pindah ke Search/Profile → scrape JALAN TERUS.
//       - Saat selesai, hasil ditulis ke store (bukan ke komponen yang sudah
//         unmount), jadi tidak hilang.
//       - Balik ke halaman semula → langsung lihat loading/hasil terakhir.
//
// Catatan: ini bertahan selama navigasi client-side (SPA). Refresh penuh
// browser tetap mereset module — untuk itu hasil sudah otomatis tersimpan
// di server (lihat halaman Output Files).
// ------------------------------------------------------------------

import { useSyncExternalStore } from 'react'
import type { ApiResponse } from '@/types'
import { startJob, getJob, getJobResult } from '@/lib/api'
import { JOB_PARSERS } from '@/lib/jobParsers'

export type ScrapeKind =
  | 'single' | 'batch' | 'unified'
  | 'profile' | 'followers' | 'following'
  | 'search' | 'likers' | 'profile_deep' | null

export type TaskStatus = 'idle' | 'running' | 'success' | 'error'

export interface TaskState<T = unknown> {
  status: TaskStatus
  data: T | null
  error: string | null
  kind: ScrapeKind
  label: string
  startedAt: number | null
  finishedAt: number | null
}

export interface RunResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  /** true bila ditolak karena masih ada proses lain yang berjalan */
  busy?: boolean
}

// Snapshot default — HARUS satu referensi konstan supaya useSyncExternalStore
// tidak menganggap ada perubahan tiap render (mencegah infinite loop).
const IDLE_TASK: TaskState = Object.freeze({
  status: 'idle',
  data: null,
  error: null,
  kind: null,
  label: '',
  startedAt: null,
  finishedAt: null,
})

interface GlobalState {
  isScraping: boolean
  kind: ScrapeKind
  startedAt: number | null
  label: string
}

const globalState: GlobalState = {
  isScraping: false,
  kind: null,
  startedAt: null,
  label: '',
}

const tasks = new Map<string, TaskState>()

type Listener = () => void
const listeners = new Set<Listener>()

function emit() {
  listeners.forEach((l) => {
    try { l() } catch { /* ignore */ }
  })
}

export const scrapeStore = {
  // ── Global busy lock (kompat lama) ──────────────────────────────
  get(): GlobalState {
    return { ...globalState }
  },

  isBusy(): boolean {
    return globalState.isScraping
  },

  begin(kind: Exclude<ScrapeKind, null>, label: string): boolean {
    if (globalState.isScraping) return false
    globalState.isScraping = true
    globalState.kind = kind
    globalState.startedAt = Date.now()
    globalState.label = label
    emit()
    return true
  },

  finish() {
    globalState.isScraping = false
    globalState.kind = null
    globalState.startedAt = null
    globalState.label = ''
    emit()
  },

  // ── Per-key task state (BARU) ───────────────────────────────────
  getTask<T = unknown>(key: string): TaskState<T> {
    return (tasks.get(key) as TaskState<T> | undefined) ?? (IDLE_TASK as TaskState<T>)
  },

  /** Reset task kembali ke idle (mis. saat user clear hasil / dismiss error). */
  resetTask(key: string) {
    if (tasks.has(key)) {
      tasks.delete(key)
      emit()
    }
  },

  /**
   * Set data task secara langsung tanpa menjalankan proses (status success).
   * Berguna mis. saat membuka sesi checkpoint dari daftar (fetch ringan) dan
   * ingin menjadikannya "aktif" tanpa mengunci global busy.
   */
  setTaskData<T = unknown>(
    key: string,
    data: T,
    kind: ScrapeKind = null,
    label = '',
  ) {
    tasks.set(key, {
      status: 'success', data, error: null,
      kind, label, startedAt: Date.now(), finishedAt: Date.now(),
    })
    emit()
  },

  /** Update sebagian field task tanpa mengganti status (mis. teks progress). */
  patchTask<T = unknown>(key: string, patch: Partial<TaskState<T>>) {
    const prev = (tasks.get(key) as TaskState<T> | undefined) ?? (IDLE_TASK as TaskState<T>)
    tasks.set(key, { ...prev, ...patch })
    emit()
  },

  /**
   * Jalankan satu pekerjaan scraping yang TAHAN navigasi.
   *
   * - Status (running/success/error) + hasil/error disimpan pada `key`,
   *   jadi tetap ada walau komponen pemanggil sudah unmount.
   * - `exclusive` (default true): ikut global busy lock — ditolak bila ada
   *   scrape exclusive lain yang sedang jalan. Set false untuk proses ringan
   *   yang boleh jalan berdampingan.
   * - `keepDataWhileRunning` (default false): pertahankan data sebelumnya
   *   selama running & saat error (mis. sesi checkpoint tetap tampil saat
   *   batch berikutnya diambil), alih-alih mengosongkannya.
   */
  async run<T = unknown>(
    key: string,
    kind: Exclude<ScrapeKind, null>,
    label: string,
    fn: () => Promise<T>,
    opts: { exclusive?: boolean; keepDataWhileRunning?: boolean } = {},
  ): Promise<RunResult<T>> {
    const exclusive = opts.exclusive ?? true
    const keepData  = opts.keepDataWhileRunning ?? false

    const prev = tasks.get(key) as TaskState<T> | undefined
    if (prev?.status === 'running') {
      return { ok: false, busy: true, error: 'Proses ini masih berjalan.' }
    }
    if (exclusive && globalState.isScraping) {
      return { ok: false, busy: true, error: 'Proses scraping lain sedang berjalan.' }
    }

    const startedAt = Date.now()
    const baseData = keepData ? (prev?.data ?? null) : null
    if (exclusive) {
      globalState.isScraping = true
      globalState.kind = kind
      globalState.startedAt = startedAt
      globalState.label = label
    }
    tasks.set(key, {
      status: 'running', data: baseData, error: null,
      kind, label, startedAt, finishedAt: null,
    })
    emit()

    let outcome: RunResult<T>
    try {
      const data = await fn()
      tasks.set(key, {
        status: 'success', data, error: null,
        kind, label, startedAt, finishedAt: Date.now(),
      })
      outcome = { ok: true, data }
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Terjadi kesalahan'
      tasks.set(key, {
        status: 'error', data: keepData ? baseData : null, error,
        kind, label, startedAt, finishedAt: Date.now(),
      })
      outcome = { ok: false, error }
    } finally {
      if (exclusive) {
        globalState.isScraping = false
        globalState.kind = null
        globalState.startedAt = null
        globalState.label = ''
      }
      emit()
    }
    return outcome
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

// ── React hooks ───────────────────────────────────────────────────

/** Subscribe ke task pada `key` — re-render saat status/hasil-nya berubah. */
export function useScrapeTask<T = unknown>(key: string): TaskState<T> {
  return useSyncExternalStore(
    scrapeStore.subscribe,
    () => scrapeStore.getTask<T>(key),
    () => IDLE_TASK as TaskState<T>,
  )
}

/** Subscribe ke global busy lock. */
export function useScrapeBusy(): boolean {
  return useSyncExternalStore(
    scrapeStore.subscribe,
    () => scrapeStore.isBusy(),
    () => false,
  )
}
