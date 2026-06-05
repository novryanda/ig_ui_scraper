'use client'

/**
 * CheckpointPanel.tsx
 * Panel checkpoint scraping — diintegrasikan ke ScrapePage.
 *
 * FIX: scrapeStore.begin() hanya menerima Mode = 'single' | 'batch' | 'unified'
 *      Sebelumnya kode memanggil scrapeStore.begin('checkpoint', ...) → TYPE ERROR
 *      Solusi: checkpoint tidak menggunakan scrapeStore (ia punya state sendiri),
 *              atau cast ke as any. Di sini kita skip scrapeStore sepenuhnya untuk
 *              checkpoint karena checkpoint bersifat stateful per-batch (bukan
 *              satu-kali fire-and-forget seperti mode lain).
 *
 * Letakkan di: frontend/src/components/features/CheckpointPanel.tsx
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Layers, Play, Square, RotateCcw, Download, ChevronDown, ChevronUp,
  CheckCircle, XCircle, Clock, Loader2, AlertTriangle,
  MessageCircle, MessagesSquare, Zap, Database, Plus, Trash2,
  RefreshCw, Link2, BarChart2, Info, ChevronRight, Infinity,
} from 'lucide-react'
import {
  startCheckpointSession,
  continueCheckpointSession,
  getCheckpointSession,
  finalizeCheckpointSession,
  listCheckpointSessions,
  deleteCheckpointSession,
  downloadCheckpointJson,
  downloadCheckpointCommentsCsv,
} from '@/lib/api'
import type {
  CheckpointSession,
  CheckpointSessionSummary,
} from '@/types'
import { SentimentChart } from '@/components/features/SentimentChart'
import { CommentList } from '@/components/features/CommentList'

// ─────────────────────────────────────────────────────────────────────────────
// Types & helpers
// ─────────────────────────────────────────────────────────────────────────────

type PanelTab = 'new' | 'sessions'

function fmt(n: number) { return n.toLocaleString('id-ID') }
function elapsed(from: string) {
  const s = Math.round((Date.now() - new Date(from).getTime()) / 1000)
  if (s < 60) return `${s}d`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}j ${Math.floor((s % 3600) / 60)}m`
}

// ─────────────────────────────────────────────────────────────────────────────
// NumberInput
// ─────────────────────────────────────────────────────────────────────────────

function CpNumberInput({
  label, value, min, max, step, onChange, disabled, accent = 'blue',
}: {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void; disabled?: boolean; accent?: 'blue' | 'purple' | 'pink'
}) {
  const acc = { blue: 'accent-blue-500', purple: 'accent-purple-500', pink: 'accent-pink-500' }
  const bdr = {
    blue:   'border-blue-500/40 focus:border-blue-500',
    purple: 'border-purple-500/40 focus:border-purple-500',
    pink:   'border-pink-500/40 focus:border-pink-500',
  }
  const [raw, setRaw] = useState(String(value))
  useEffect(() => setRaw(String(value)), [value])

  return (
    <div>
      <label className="block text-[11px] text-white/40 mb-1.5 uppercase tracking-widest">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="range" min={min} max={max} step={step} value={value} disabled={disabled}
          onChange={e => onChange(Number(e.target.value))}
          className={`flex-1 h-1.5 ${acc[accent]} disabled:opacity-30`}
        />
        <input
          type="number" min={min} max={max} step={step} value={raw} disabled={disabled}
          onChange={e => {
            setRaw(e.target.value)
            const n = parseInt(e.target.value, 10)
            if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
          }}
          onBlur={() => {
            const n = parseInt(raw, 10)
            const c = isNaN(n) ? min : Math.min(max, Math.max(min, n))
            setRaw(String(c))
            onChange(c)
          }}
          className={`w-16 shrink-0 bg-white/5 border rounded-lg px-2 py-1 text-xs text-white text-center outline-none transition-colors disabled:opacity-30 ${bdr[accent]}`}
        />
      </div>
      <div className="flex justify-between text-[9px] text-white/20 mt-0.5">
        <span>{min}</span><span>{max}</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// StatusBadge
// ─────────────────────────────────────────────────────────────────────────────

function StatusBadge({ status, hasMore }: { status: string; hasMore?: boolean }) {
  if (status === 'completed') return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
      <CheckCircle size={9} /> Selesai
    </span>
  )
  if (status === 'error') return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/25">
      <XCircle size={9} /> Error
    </span>
  )
  if (hasMore === false) return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/25">
      <CheckCircle size={9} /> Habis
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-300 border border-yellow-500/25 animate-pulse">
      <Clock size={9} /> Aktif
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SessionDetailView
// ─────────────────────────────────────────────────────────────────────────────

function SessionDetailView({
  session,
  onContinue,
  onFinalize,
  onBack,
  running,
}: {
  session: CheckpointSession
  onContinue: () => void
  onFinalize: () => void
  onBack: () => void
  running: boolean
}) {
  const [showComments, setShowComments] = useState(false)
  const [showSentiment, setShowSentiment] = useState(false)
  const s = session.sentiment_summary
  const canContinue = session.status === 'active' && session.has_more
  const canFinalize = session.status === 'active'

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={onBack}
          className="glass rounded-lg p-1.5 text-white/40 hover:text-white/80 transition-colors"
        >
          <ChevronRight size={14} className="rotate-180" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">@{session.owner_username || session.shortcode}</p>
          <p className="text-[11px] text-white/40">Sesi checkpoint aktif</p>
        </div>
        <StatusBadge status={session.status} hasMore={session.has_more} />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Komentar', value: fmt(session.total_comments), color: 'text-purple-400' },
          { label: 'Balasan',  value: fmt(session.total_replies),  color: 'text-blue-400' },
          { label: 'Batch',    value: session.batches.length,      color: 'text-orange-400' },
        ].map(item => (
          <div key={item.label} className="glass rounded-xl p-3 text-center">
            <p className={`text-base font-bold ${item.color}`}>{item.value}</p>
            <p className="text-[10px] text-white/40 mt-0.5">{item.label}</p>
          </div>
        ))}
      </div>

      {/* Last batch info */}
      {session.last_batch_added != null && (
        <div className="glass rounded-xl px-3 py-2.5 flex items-center gap-2 border border-blue-500/15">
          <Zap size={12} className="text-blue-400 shrink-0" />
          <p className="text-xs text-white/60">
            Batch terakhir:{' '}
            <span className="text-white/80 font-medium">+{session.last_batch_added} komentar</span>
            {session.last_batch_added_replies ? ` + ${session.last_batch_added_replies} balasan` : ''}
          </p>
        </div>
      )}

      {/* Batch history */}
      {session.batches.length > 0 && (
        <div className="glass rounded-xl p-3 space-y-1.5">
          <p className="text-[11px] text-white/40 uppercase tracking-widest mb-2">Riwayat Batch</p>
          <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
            {[...session.batches].reverse().map(b => (
              <div key={b.batch_num} className="flex items-center justify-between text-xs text-white/60">
                <span className="text-white/30">Batch #{b.batch_num}</span>
                <span>{fmt(b.count)} komentar {b.replies > 0 ? `+ ${b.replies} balasan` : ''}</span>
                <span className="text-white/30">{elapsed(b.scraped_at)} lalu</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Method + cursor info */}
      {session.method && (
        <div className="flex items-center gap-2 text-[11px] text-white/30">
          <Database size={10} className="text-white/20" />
          Metode: <span className="text-white/50">{session.method}</span>
          {session.cursor?.value && (
            <span className="truncate text-white/20 max-w-24" title={session.cursor.value}>
              · cursor: {session.cursor.value.slice(0, 12)}…
            </span>
          )}
        </div>
      )}

      {/* Sentiment toggle */}
      {s && s.total_comments > 0 && (
        <div className="glass rounded-xl overflow-hidden">
          <button
            onClick={() => setShowSentiment(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-xs font-medium text-white/60 hover:text-white/80 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <BarChart2 size={12} /> Sentimen ({fmt(s.total_comments)})
            </span>
            {showSentiment ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showSentiment && (
            <div className="px-4 pb-4">
              <SentimentChart summary={s} />
            </div>
          )}
        </div>
      )}

      {/* Comments toggle */}
      {session.comments.length > 0 && (
        <div className="glass rounded-xl overflow-hidden">
          <button
            onClick={() => setShowComments(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-xs font-medium text-white/60 hover:text-white/80 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <MessageCircle size={12} /> Komentar ({fmt(session.comments.length)})
            </span>
            {showComments ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showComments && (
            <div className="px-4 pb-4 max-h-64 overflow-y-auto">
              <CommentList comments={session.comments} />
            </div>
          )}
        </div>
      )}

      {/* Download buttons */}
      {session.total_comments > 0 && (
        <div className="flex flex-wrap gap-2">
          <span className="text-[11px] text-white/30 uppercase tracking-wider self-center">Download:</span>
          <a
            href={downloadCheckpointJson(session.session_id)}
            target="_blank" rel="noopener noreferrer"
            className="btn-glass text-xs flex items-center gap-1.5"
          >
            <Download size={11} /> JSON
          </a>
          <a
            href={downloadCheckpointCommentsCsv(session.session_id, true)}
            target="_blank" rel="noopener noreferrer"
            className="btn-glass text-xs flex items-center gap-1.5"
          >
            <Download size={11} /> CSV Komentar
          </a>
          <a
            href={downloadCheckpointCommentsCsv(session.session_id, false)}
            target="_blank" rel="noopener noreferrer"
            className="btn-glass text-xs flex items-center gap-1.5 text-white/40"
          >
            <Download size={11} /> CSV (no reply)
          </a>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 pt-1">
        {canContinue && (
          <button
            onClick={onContinue}
            disabled={running}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold
              bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30
              hover:border-blue-500/60 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {running ? 'Scraping…' : 'Lanjut Batch'}
          </button>
        )}

        {canFinalize && !session.has_more && (
          <button
            onClick={onFinalize}
            disabled={running}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold
              bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30
              hover:border-emerald-500/60 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
            Finalisasi
          </button>
        )}

        {/* Stop / finalize early */}
        {canFinalize && session.has_more && (
          <button
            onClick={onFinalize}
            disabled={running}
            className="px-3 py-2.5 rounded-xl text-xs text-white/40 glass
              hover:text-orange-300 hover:border-orange-500/30 transition-all disabled:opacity-50"
            title="Stop & finalisasi sekarang"
          >
            <Square size={12} />
          </button>
        )}
      </div>

      {!session.has_more && session.status === 'active' && (
        <p className="text-[11px] text-emerald-400/70 text-center">
          ✅ Semua komentar sudah diambil — klik Finalisasi untuk menyimpan.
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SessionListCard
// ─────────────────────────────────────────────────────────────────────────────

function SessionListCard({
  s,
  onOpen,
  onDelete,
}: {
  s: CheckpointSessionSummary
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div className="glass rounded-xl p-3.5 space-y-2.5 border border-white/5 hover:border-white/10 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white/80 truncate">
            @{s.owner_username || s.shortcode}
          </p>
          <p className="text-[11px] text-white/30 truncate mt-0.5">{s.url}</p>
        </div>
        <StatusBadge status={s.status} hasMore={s.has_more} />
      </div>

      <div className="flex items-center gap-3 text-[11px] text-white/40">
        <span className="flex items-center gap-1">
          <MessageCircle size={9} /> {fmt(s.total_comments)}
        </span>
        <span className="flex items-center gap-1">
          <MessagesSquare size={9} /> {fmt(s.total_replies)}
        </span>
        <span className="flex items-center gap-1">
          <Layers size={9} /> {s.batch_count} batch
        </span>
        <span className="ml-auto text-white/25">{elapsed(s.updated_at)} lalu</span>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onOpen}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs
            bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/90 transition-all border border-white/5"
        >
          {s.status === 'active' && s.has_more
            ? <><Play size={11} /> Lanjutkan</>
            : <><Info size={11} /> Detail</>
          }
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-2 rounded-lg text-xs glass text-white/30 hover:text-red-400
            hover:border-red-500/30 transition-all"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// NewSessionForm
// ─────────────────────────────────────────────────────────────────────────────

function NewSessionForm({
  initialUrl,
  disabled,
  onStart,
}: {
  initialUrl: string
  disabled: boolean
  onStart: (session: CheckpointSession) => void
}) {
  const [url, setUrl]               = useState(initialUrl)
  const [batchSize, setBatchSize]   = useState(300)
  const [replies, setReplies]       = useState(false)
  const [maxReplies, setMaxReplies] = useState(20)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')

  useEffect(() => { if (initialUrl) setUrl(initialUrl) }, [initialUrl])

  async function handleStart() {
    if (!url.trim()) { setError('Masukkan URL post/reel'); return }
    setError('')
    setLoading(true)
    try {
      const resp = await startCheckpointSession({
        url: url.trim(),
        batch_size: batchSize,
        include_replies: replies,
        max_replies_per_comment: maxReplies,
      })
      if (!resp.success) throw new Error(resp.message)
      onStart(resp.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memulai sesi')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Info box */}
      <div className="glass rounded-xl px-3.5 py-3 border border-blue-500/15 space-y-1">
        <p className="text-xs font-semibold text-blue-300 flex items-center gap-1.5">
          <Layers size={12} /> Apa itu Checkpoint Scraping?
        </p>
        <p className="text-[11px] text-white/40 leading-relaxed">
          Scrape komentar <strong className="text-white/60">batch per batch</strong> — bisa jeda dan lanjut kapan saja tanpa mengulang dari awal. Cocok untuk postingan dengan komentar sangat banyak.
        </p>
      </div>

      {/* URL */}
      <div>
        <label className="block text-[11px] text-white/40 mb-1.5 uppercase tracking-widest">URL Post / Reel</label>
        <div className="relative">
          <Link2 size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://www.instagram.com/p/..."
            disabled={disabled || loading}
            className="input-glass pl-9 text-sm"
            onKeyDown={e => e.key === 'Enter' && handleStart()}
          />
        </div>
      </div>

      {/* Batch size */}
      <CpNumberInput
        label="Komentar per Batch"
        value={batchSize} min={50} max={1000} step={50}
        accent="blue" disabled={disabled || loading}
        onChange={setBatchSize}
      />

      {/* Replies toggle */}
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <div className="relative">
          <input
            type="checkbox" checked={replies}
            onChange={e => setReplies(e.target.checked)}
            disabled={disabled || loading}
            className="sr-only peer"
          />
          <div className="w-9 h-5 rounded-full bg-white/10 peer-checked:bg-purple-500/70 transition-colors" />
          <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
        </div>
        <span className="text-xs text-white/60">Sertakan balasan</span>
      </label>

      {replies && (
        <CpNumberInput
          label="Max Balasan / Komentar"
          value={maxReplies} min={0} max={100} step={5}
          accent="purple" disabled={disabled || loading}
          onChange={setMaxReplies}
        />
      )}

      {/* Summary */}
      <div className="glass rounded-xl px-3 py-2 flex flex-wrap gap-3 text-[11px] text-white/40">
        <span>Batch: <span className="text-white/70 font-medium">{fmt(batchSize)}</span></span>
        <span>Balasan: <span className="text-white/70 font-medium">{replies ? `${maxReplies}/komentar` : 'Tidak'}</span></span>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-xs glass rounded-xl px-3 py-2.5 border border-red-500/20">
          <XCircle size={12} /> {error}
        </div>
      )}

      <button
        onClick={handleStart}
        disabled={disabled || loading}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold
          bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30
          hover:border-blue-500/60 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
        {loading ? 'Memulai…' : 'Mulai Sesi Checkpoint'}
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CheckpointPanel — main export
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckpointPanelProps {
  /** URL dari input utama ScrapePage (di-pass biar auto-filled) */
  currentUrl?: string
  /** Callback setelah sesi aktif, bisa untuk disable tombol scrape utama */
  onSessionActive?: (active: boolean) => void
  /** Jika true, scrape utama sedang berjalan → disable tombol continue */
  globalBusy?: boolean
}

export function CheckpointPanel({ currentUrl = '', onSessionActive, globalBusy = false }: CheckpointPanelProps) {
  const [tab, setTab]                           = useState<PanelTab>('new')
  const [activeSession, setActive]              = useState<CheckpointSession | null>(null)
  const [sessions, setSessions]                 = useState<CheckpointSessionSummary[]>([])
  const [loadingSessions, setLoadingSessions]   = useState(false)
  const [runningBatch, setRunningBatch]         = useState(false)
  const [batchError, setBatchError]             = useState('')

  // notify parent
  useEffect(() => {
    onSessionActive?.(activeSession !== null && activeSession.status === 'active')
  }, [activeSession, onSessionActive])

  // load sessions list
  const loadSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const resp = await listCheckpointSessions()
      if (resp.success) setSessions(resp.data.sessions)
    } catch {
      // ignore
    } finally {
      setLoadingSessions(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'sessions') loadSessions()
  }, [tab, loadSessions])

  // open session from list
  async function openSession(id: string) {
    try {
      const resp = await getCheckpointSession(id)
      if (resp.success) {
        setActive(resp.data)
        setTab('new')
      }
    } catch {
      // ignore
    }
  }

  // delete session
  async function deleteSession(id: string) {
    if (!confirm('Hapus sesi ini?')) return
    try {
      await deleteCheckpointSession(id)
      setSessions(prev => prev.filter(s => s.session_id !== id))
      if (activeSession?.session_id === id) setActive(null)
    } catch {
      // ignore
    }
  }

  // ─── FIX: continue batch TIDAK pakai scrapeStore ──────────────────────────
  // scrapeStore.begin() hanya menerima 'single' | 'batch' | 'unified'.
  // Checkpoint punya kontrol sendiri via runningBatch state.
  // globalBusy (dari parent) digunakan untuk mencegah overlap dengan scrape lain.
  const continueBatch = useCallback(async () => {
    if (!activeSession || runningBatch) return

    if (globalBusy) {
      setBatchError('Proses scraping lain sedang berjalan. Tunggu selesai.')
      return
    }

    setBatchError('')
    setRunningBatch(true)

    try {
      const resp = await continueCheckpointSession(activeSession.session_id)
      if (!resp.success) throw new Error(resp.message)
      setActive(resp.data)
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : 'Gagal melanjutkan batch')
    } finally {
      setRunningBatch(false)
    }
  }, [activeSession, runningBatch, globalBusy])

  // finalize
  async function finalize() {
    if (!activeSession || runningBatch) return
    if (globalBusy) {
      setBatchError('Proses scraping lain sedang berjalan.')
      return
    }
    setRunningBatch(true)
    try {
      const resp = await finalizeCheckpointSession(activeSession.session_id)
      if (!resp.success) throw new Error(resp.message)
      setActive(resp.data)
      if (tab === 'sessions') loadSessions()
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : 'Gagal finalisasi')
    } finally {
      setRunningBatch(false)
    }
  }

  function handleSessionStarted(session: CheckpointSession) {
    setActive(session)
    setBatchError('')
  }

  const isCheckpointBusy = runningBatch

  return (
    <div className="glass-card overflow-hidden">
      {/* ── Panel header ── */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-blue-500/15 flex items-center justify-center">
            <Layers size={15} className="text-blue-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white/90">Checkpoint Scraping</h2>
            <p className="text-[11px] text-white/35">Batch per batch · Resume kapan saja</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Running indicator */}
          {isCheckpointBusy && (
            <span className="flex items-center gap-1.5 text-[10px] text-blue-300 animate-pulse">
              <Loader2 size={10} className="animate-spin" /> Scraping…
            </span>
          )}

          {/* Tab pills */}
          <div className="flex glass rounded-xl p-0.5 gap-0.5">
            {([
              { key: 'new',      label: 'Baru'  },
              { key: 'sessions', label: 'Sesi'  },
            ] as const).map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                  ${tab === t.key ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Panel body ── */}
      <div className="p-5">

        {/* Global busy warning */}
        {globalBusy && (
          <div className="flex items-center gap-2 text-yellow-300/80 text-xs glass rounded-xl px-3 py-2.5 mb-4 border border-yellow-500/15">
            <AlertTriangle size={11} /> Scrape utama sedang berjalan — checkpoint ditahan sementara.
          </div>
        )}

        {/* Batch error */}
        {batchError && (
          <div className="flex items-center gap-2 text-yellow-300 text-xs glass rounded-xl px-3 py-2.5 mb-4 border border-yellow-500/20">
            <AlertTriangle size={12} /> {batchError}
          </div>
        )}

        {/* ── Active session detail (override tabs) ── */}
        {activeSession ? (
          <SessionDetailView
            session={activeSession}
            onContinue={continueBatch}
            onFinalize={finalize}
            onBack={() => setActive(null)}
            running={isCheckpointBusy || globalBusy}
          />
        ) : tab === 'new' ? (
          <NewSessionForm
            initialUrl={currentUrl}
            disabled={isCheckpointBusy || globalBusy}
            onStart={handleSessionStarted}
          />
        ) : (
          /* ── Sessions list tab ── */
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-white/40 uppercase tracking-widest">
                {sessions.length} sesi tersimpan
              </p>
              <button
                onClick={loadSessions}
                disabled={loadingSessions}
                className="glass rounded-lg p-1.5 text-white/40 hover:text-white/70 transition-colors disabled:opacity-50"
              >
                <RefreshCw size={12} className={loadingSessions ? 'animate-spin' : ''} />
              </button>
            </div>

            {loadingSessions && (
              <div className="flex items-center justify-center py-8 text-white/30 text-sm gap-2">
                <Loader2 size={14} className="animate-spin" /> Memuat…
              </div>
            )}

            {!loadingSessions && sessions.length === 0 && (
              <div className="text-center py-8 text-white/25 text-sm">
                <Layers size={24} className="mx-auto mb-2 opacity-30" />
                Belum ada sesi checkpoint
              </div>
            )}

            {!loadingSessions && sessions.map(s => (
              <SessionListCard
                key={s.session_id}
                s={s}
                onOpen={() => openSession(s.session_id)}
                onDelete={() => deleteSession(s.session_id)}
              />
            ))}

            {/* New session shortcut */}
            <button
              onClick={() => setTab('new')}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs
                glass border border-dashed border-white/10 text-white/30 hover:text-white/60
                hover:border-white/20 transition-all"
            >
              <Plus size={12} /> Sesi Baru
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default CheckpointPanel