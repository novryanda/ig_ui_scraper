'use client'

import { useState, useEffect, useSyncExternalStore, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, Link2, Loader2, AlertCircle, ChevronDown, ChevronUp,
  Plus, Trash2, CheckCircle, XCircle, Clock, MessageCircle,
  Hash, MessagesSquare, Heart, Download, Zap, Shield, Users,
  BarChart2, Layers, Infinity, AlertTriangle, Info,
} from 'lucide-react'
import {
  scrapePost,
  scrapePosts,
  scrapeUnified,
  downloadCommentsInline,
  downloadLikersInline,
  downloadUnifiedJson,
  downloadUnifiedCommentsCsv,
  downloadUnifiedLikersCsv,
  downloadPostJson,
  downloadPostCommentsCsv,
  downloadActiveCommentersInline,
} from '@/lib/api'
import type { PostResult, Comment, UnifiedResult, ActiveCommenter } from '@/types'
import { StatCard } from '@/components/ui/StatCard'
import { SentimentChart } from '@/components/features/SentimentChart'
import { CommentList } from '@/components/features/CommentList'
import { IGLogoFilled } from '@/components/ui/IGLogo'
import { scrapeStore } from '@/lib/scrapeStore'
import { CheckpointPanel } from '@/components/features/CheckpointPanel'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

// FIX: Mode tidak mencakup 'checkpoint' karena scrapeStore.begin() hanya
//      menerima 'single' | 'batch' | 'unified'. Checkpoint dikelola terpisah.
type Mode = 'single' | 'batch' | 'unified' | 'checkpoint'

interface BatchItem {
  url: string
  success: boolean
  data?: PostResult
  error?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrape Store hook
// ─────────────────────────────────────────────────────────────────────────────

function useScrapeStatus() {
  return useSyncExternalStore(
    scrapeStore.subscribe,
    () => scrapeStore.isBusy(),
    () => false,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// UnlimitedToggle
// ─────────────────────────────────────────────────────────────────────────────

interface UnlimitedToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}

function UnlimitedToggle({ checked, onChange, disabled }: UnlimitedToggleProps) {
  return (
    <div
      className={`
        rounded-2xl border transition-all duration-300 overflow-hidden
        ${checked ? 'border-orange-500/40 bg-orange-500/5' : 'border-white/10 bg-white/3'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      <label
        className={`flex items-center justify-between gap-3 px-4 py-3.5 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <div className="flex items-center gap-2.5">
          <div
            className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-colors
              ${checked ? 'bg-orange-500/20 text-orange-400' : 'bg-white/8 text-white/40'}`}
          >
            <Infinity size={16} />
          </div>
          <div>
            <p className="text-sm font-medium text-white/90">Scrape Semua Komentar</p>
            <p className="text-[11px] text-white/40 mt-0.5 leading-relaxed">
              {checked
                ? 'max_comments=0 — ambil semua hingga batas aman server'
                : 'Aktifkan untuk mengambil seluruh komentar (unlimited mode)'}
            </p>
          </div>
        </div>
        <div className="relative shrink-0">
          <input
            type="checkbox" checked={checked}
            onChange={e => onChange(e.target.checked)}
            disabled={disabled} className="sr-only peer"
          />
          <div className={`w-11 h-6 rounded-full transition-colors ${checked ? 'bg-orange-500/70' : 'bg-white/10'}`} />
          <div className="absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
        </div>
      </label>

      {checked && (
        <div className="px-4 pb-4 space-y-3">
          <div className="border-t border-orange-500/15 pt-3 space-y-2.5">
            <div className="flex items-start gap-2.5 glass rounded-xl px-3 py-2.5 border border-orange-500/20">
              <AlertTriangle size={14} className="text-orange-400 shrink-0 mt-0.5" />
              <div className="space-y-1.5 flex-1">
                <p className="text-xs font-semibold text-orange-300">Risiko & Estimasi</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                  <div className="glass rounded-lg px-2.5 py-2 text-center">
                    <p className="text-orange-400 font-bold text-sm">2–7 jam</p>
                    <p className="text-white/40 mt-0.5">Estimasi durasi</p>
                  </div>
                  <div className="glass rounded-lg px-2.5 py-2 text-center">
                    <p className="text-yellow-400 font-bold text-sm">2.000+</p>
                    <p className="text-white/40 mt-0.5">Target komentar</p>
                  </div>
                  <div className="glass rounded-lg px-2.5 py-2 text-center">
                    <p className="text-red-400 font-bold text-sm">Tinggi</p>
                    <p className="text-white/40 mt-0.5">Risiko rate-limit</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="space-y-1.5 text-[11px] text-white/50">
              {[
                { icon: '⚡', text: 'Jangan tutup tab atau pindah halaman selama proses berlangsung.' },
                { icon: '🌐', text: 'Pastikan koneksi internet stabil dan tidak terputus.' },
                { icon: '⏸️', text: 'Server akan otomatis jeda jika terdeteksi rate-limit dari Instagram.' },
                { icon: '💾', text: 'Hasil disimpan otomatis di output — aman jika browser tidak sengaja tertutup.' },
              ].map((tip, i) => (
                <p key={i} className="flex items-start gap-1.5">
                  <span className="shrink-0">{tip.icon}</span>
                  {tip.text}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// NumberInput
// ─────────────────────────────────────────────────────────────────────────────

interface NumberInputProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  accentColor: 'pink' | 'purple' | 'blue' | 'orange'
  onChange: (v: number) => void
  description?: string
}

function NumberInput({
  label, value, min, max, step, disabled, accentColor, onChange, description,
}: NumberInputProps) {
  const [raw, setRaw] = useState(String(value))
  useEffect(() => { setRaw(String(value)) }, [value])

  function handleRawChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value; setRaw(v)
    const n = parseInt(v, 10)
    if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
  }
  function handleBlur() {
    const n = parseInt(raw, 10)
    const clamped = isNaN(n) ? min : Math.min(max, Math.max(min, n))
    setRaw(String(clamped)); onChange(clamped)
  }

  const accentMap = { pink: 'accent-pink-500', purple: 'accent-purple-500', blue: 'accent-blue-500', orange: 'accent-orange-500' }
  const borderMap = {
    pink:   'border-pink-500/40 focus:border-pink-500',
    purple: 'border-purple-500/40 focus:border-purple-500',
    blue:   'border-blue-500/40 focus:border-blue-500',
    orange: 'border-orange-500/40 focus:border-orange-500',
  }

  return (
    <div>
      <label className="block text-xs text-white/50 mb-1 uppercase tracking-widest">{label}</label>
      {description && <p className="text-[11px] text-white/30 mb-2 leading-relaxed">{description}</p>}
      <div className="flex items-center gap-3">
        <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
          onChange={e => onChange(Number(e.target.value))}
          className={`flex-1 ${accentMap[accentColor]} h-1.5 disabled:opacity-30 cursor-pointer`} />
        <input type="number" min={min} max={max} step={step} value={raw} disabled={disabled}
          onChange={handleRawChange} onBlur={handleBlur}
          className={`w-20 shrink-0 bg-white/5 border rounded-xl px-3 py-1.5 text-sm text-white text-center
            outline-none transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${borderMap[accentColor]}`} />
      </div>
      <div className="flex justify-between text-[10px] text-white/20 mt-1">
        <span>{min}</span><span>{Math.round((min + max) / 2)}</span><span>{max}</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Toggle
// ─────────────────────────────────────────────────────────────────────────────

function Toggle({
  checked, onChange, disabled, label, icon, description,
}: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
  label: string; icon?: React.ReactNode; description?: string
}) {
  return (
    <label className={`flex items-start gap-3 cursor-pointer select-none group ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
      <div className="relative mt-0.5 shrink-0">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
          disabled={disabled} className="sr-only peer" />
        <div className="w-10 h-5 rounded-full bg-white/10 peer-checked:bg-pink-500/70 transition-colors" />
        <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
      </div>
      <div>
        <div className="flex items-center gap-1.5 text-sm text-white/70 group-hover:text-white/90 transition-colors">
          {icon}<span>{label}</span>
        </div>
        {description && <p className="text-[11px] text-white/30 mt-0.5 leading-relaxed">{description}</p>}
      </div>
    </label>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// LikersButton
// ─────────────────────────────────────────────────────────────────────────────

function LikersButton({ postUrl, likes, size = 'normal' }: { postUrl: string; likes?: number; size?: 'normal' | 'small' }) {
  const router = useRouter()
  const handleClick = () => router.push(`/main/likers?url=${encodeURIComponent(postUrl)}`)

  if (size === 'small') {
    return (
      <button onClick={handleClick}
        className="btn-glass text-xs flex items-center gap-1.5 text-pink-300 border border-pink-500/20
          hover:border-pink-500/40 hover:text-pink-200 transition-all"
        title="Lihat siapa yang like postingan ini">
        <Heart size={11} className="fill-pink-400 text-pink-400" />
        Lihat Likers
        {likes != null && likes > 0 && (
          <span className="text-white/30 font-normal">({likes.toLocaleString('id-ID')})</span>
        )}
      </button>
    )
  }

  return (
    <button onClick={handleClick}
      className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
        bg-pink-500/10 hover:bg-pink-500/20 text-pink-300 border border-pink-500/25
        hover:border-pink-500/50 transition-all">
      <Heart size={14} className="fill-pink-400 text-pink-400" />
      Siapa yang Like
      {likes != null && likes > 0 && (
        <span className="text-pink-400/60 text-xs font-normal">{likes.toLocaleString('id-ID')} likes</span>
      )}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DownloadBar
// ─────────────────────────────────────────────────────────────────────────────

function DownloadBar({
  savedFile, comments, likers, mode, filenameHint, includeReplies,
}: {
  savedFile?: string; comments?: PostResult['comments']; likers?: UnifiedResult['likers']
  mode: 'post' | 'unified'; filenameHint?: string; includeReplies?: boolean
}) {
  const [dlState, setDlState] = useState<Record<string, 'idle' | 'loading' | 'done' | 'error'>>({})
  const setItemState = (key: string, state: 'idle' | 'loading' | 'done' | 'error') =>
    setDlState(prev => ({ ...prev, [key]: state }))
  const dlIcon = (key: string) => {
    const s = dlState[key] ?? 'idle'
    if (s === 'loading') return <Loader2 size={12} className="animate-spin" />
    if (s === 'done')    return <CheckCircle size={12} className="text-emerald-400" />
    if (s === 'error')   return <XCircle size={12} className="text-red-400" />
    return <Download size={12} />
  }

  async function handleInlineComments() {
    if (!comments?.length) return; setItemState('csv_comments', 'loading')
    try { await downloadCommentsInline(comments, filenameHint || 'comments', includeReplies ?? true); setItemState('csv_comments', 'done') }
    catch { setItemState('csv_comments', 'error') }
  }
  async function handleInlineLikers() {
    if (!likers?.length) return; setItemState('csv_likers', 'loading')
    try { await downloadLikersInline(likers, filenameHint || 'likers'); setItemState('csv_likers', 'done') }
    catch { setItemState('csv_likers', 'error') }
  }
  function openUrl(url: string) { window.open(url, '_blank') }

  const hasComments = (comments?.length ?? 0) > 0
  const hasLikers   = (likers?.length ?? 0) > 0
  const hasSaved    = Boolean(savedFile)

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <span className="text-xs text-white/30 uppercase tracking-wider mr-1">Download:</span>
      {hasComments && (
        <button onClick={handleInlineComments} disabled={dlState['csv_comments'] === 'loading'}
          className="btn-glass text-xs flex items-center gap-1.5 hover:border-purple-500/40 disabled:opacity-50">
          {dlIcon('csv_comments')} CSV Komentar
        </button>
      )}
      {hasLikers && (
        <button onClick={handleInlineLikers} disabled={dlState['csv_likers'] === 'loading'}
          className="btn-glass text-xs flex items-center gap-1.5 hover:border-pink-500/40 disabled:opacity-50">
          {dlIcon('csv_likers')} CSV Likers
        </button>
      )}
      {hasSaved && mode === 'unified' && (
        <>
          <button onClick={() => openUrl(downloadUnifiedJson(savedFile!))}
            className="btn-glass text-xs flex items-center gap-1.5 hover:border-blue-500/40">
            <Download size={12} /> JSON Lengkap
          </button>
          {hasComments && (
            <button onClick={() => openUrl(downloadUnifiedCommentsCsv(savedFile!, includeReplies ?? true))}
              className="btn-glass text-xs flex items-center gap-1.5">
              <Download size={12} /> CSV Komentar (Server)
            </button>
          )}
          {hasLikers && (
            <button onClick={() => openUrl(downloadUnifiedLikersCsv(savedFile!))}
              className="btn-glass text-xs flex items-center gap-1.5">
              <Download size={12} /> CSV Likers (Server)
            </button>
          )}
        </>
      )}
      {hasSaved && mode === 'post' && (
        <>
          <button onClick={() => openUrl(downloadPostJson(savedFile!))}
            className="btn-glass text-xs flex items-center gap-1.5">
            <Download size={12} /> JSON Lengkap
          </button>
          {hasComments && (
            <button onClick={() => openUrl(downloadPostCommentsCsv(savedFile!, includeReplies ?? true))}
              className="btn-glass text-xs flex items-center gap-1.5">
              <Download size={12} /> CSV Komentar (Server)
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SentimentDetailGrid
// ─────────────────────────────────────────────────────────────────────────────

function SentimentDetailGrid({ s }: { s: PostResult['sentiment_summary'] }) {
  const items = [
    { label: '😊 Positif',     count: s.positive_count,    pct: s.positive_percentage,  color: '#22c55e' },
    { label: '😞 Negatif',     count: s.negative_count,    pct: s.negative_percentage,  color: '#f87171' },
    { label: '😐 Netral',      count: s.neutral_count,     pct: s.neutral_percentage,   color: '#94a3b8' },
    { label: '😂 Humor',       count: s.humor_count,       pct: s.humor_percentage,     color: '#818cf8' },
    { label: '⚠️ Toxic',       count: s.toxic_count,       pct: s.toxic_percentage,     color: '#fde047' },
    { label: '🚨 Hate Speech', count: s.hate_speech_count, pct: s.hate_percentage,      color: '#ef4444' },
  ]
  return (
    <div className="space-y-3">
      {items.map(item => (
        <div key={item.label}>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-white/70">{item.label}</span>
            <span className="text-white/50">{item.count} ({item.pct}%)</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${item.pct}%`, background: item.color }} />
          </div>
        </div>
      ))}
      {(s.sarcasm_count ?? 0) > 0 && (
        <p className="text-xs text-white/40 mt-2">
          🎭 Sarkasme: {s.sarcasm_count} ({s.sarcasm_percentage}%) &nbsp;
          🙏 Doa/Wellwish: {s.wellwish_count} ({s.wellwish_percentage}%)
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TopCommentsList
// ─────────────────────────────────────────────────────────────────────────────

function TopCommentsList({ items }: { items: PostResult['sentiment_summary']['top_liked'] }) {
  if (!items?.length) return null
  return (
    <div className="space-y-3">
      {items.slice(0, 5).map((c, i) => (
        <div key={i} className="flex gap-3 items-start py-2 border-b border-white/4 last:border-0">
          <span className="text-lg font-bold text-white/20 w-6 shrink-0">#{i + 1}</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white/80 mb-0.5">@{c.username}</p>
            <p className="text-sm text-white/50 wrap-break-word">{c.text}</p>
          </div>
          <p className="text-pink-400 font-bold text-sm shrink-0">❤ {c.like_count}</p>
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// LikersPreview
// ─────────────────────────────────────────────────────────────────────────────

function LikersPreview({ likers, fetched, total }: { likers: UnifiedResult['likers']; fetched: number; total: number }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? likers : likers.slice(0, 10)
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm uppercase tracking-widest text-white/50">
          👍 Likers ({fetched.toLocaleString('id-ID')} dari {total.toLocaleString('id-ID')} likes)
        </h3>
        {likers.length > 10 && (
          <button onClick={() => setExpanded(v => !v)}
            className="text-xs text-white/40 hover:text-white/70 flex items-center gap-1 transition-colors">
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? 'Sembunyikan' : `Lihat semua ${likers.length}`}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {shown.map((l, i) => (
          <a key={l.user_id || i} href={`https://www.instagram.com/${l.username}/`}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2.5 glass rounded-xl px-3 py-2 hover:bg-white/5 transition-colors group">
            <div className="w-7 h-7 rounded-full bg-linear-to-br from-pink-500/30 to-purple-500/30 flex items-center justify-center shrink-0 text-xs font-bold text-white/60">
              {l.username?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white/80 truncate group-hover:text-white transition-colors">
                @{l.username}
                {l.is_verified && <span className="ml-1 text-blue-400 text-[10px]">✓</span>}
              </p>
              {l.full_name && <p className="text-[11px] text-white/30 truncate">{l.full_name}</p>}
            </div>
            {l.is_private && <span className="text-[10px] text-white/20 shrink-0">🔒</span>}
          </a>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// UnlimitedBadge
// ─────────────────────────────────────────────────────────────────────────────

function UnlimitedBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full
      bg-orange-500/15 text-orange-300 border border-orange-500/25">
      <Infinity size={9} /> UNLIMITED
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ActiveCommentersPanel — komentator teraktif per post
// ─────────────────────────────────────────────────────────────────────────────

const CAT_COLOR: Record<string, string> = {
  POSITIVE: 'text-emerald-400', NEGATIVE: 'text-rose-400', NEUTRAL: 'text-white/60',
  HUMOR: 'text-indigo-400', TOXIC: 'text-yellow-400', HATE_SPEECH: 'text-red-400',
}
const CAT_EMOJI: Record<string, string> = {
  POSITIVE: '😊', NEGATIVE: '😞', NEUTRAL: '😐', HUMOR: '😂', TOXIC: '⚠️', HATE_SPEECH: '🚨',
}

function ActiveCommentersPanel({ commenters, filenameHint }: {
  commenters: ActiveCommenter[]; filenameHint?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [openUser, setOpenUser] = useState<string | null>(null)
  const [dl, setDl] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')

  if (!commenters?.length) return null

  const frequent = commenters.filter(c => c.total_interactions > 1)
  const base = frequent.length ? frequent : commenters
  const list = expanded ? commenters : base.slice(0, 5)

  async function handleDownload() {
    setDl('loading')
    try { await downloadActiveCommentersInline(commenters, filenameHint || 'active_commenters'); setDl('done') }
    catch { setDl('error') }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-semibold text-sm uppercase tracking-widest text-white/50 flex items-center gap-2">
          <Users size={14} className="text-purple-400" />
          Komentator Teraktif ({commenters.length})
        </h3>
        <div className="flex items-center gap-2">
          <button onClick={handleDownload} disabled={dl === 'loading'}
            className="btn-glass text-xs flex items-center gap-1.5 hover:border-purple-500/40 disabled:opacity-50">
            {dl === 'loading' ? <Loader2 size={12} className="animate-spin" />
              : dl === 'done' ? <CheckCircle size={12} className="text-emerald-400" />
              : dl === 'error' ? <XCircle size={12} className="text-red-400" />
              : <Download size={12} />}
            CSV
          </button>
          {commenters.length > list.length && (
            <button onClick={() => setExpanded(v => !v)}
              className="text-xs text-white/40 hover:text-white/70 flex items-center gap-1 transition-colors">
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? 'Sembunyikan' : `Lihat semua ${commenters.length}`}
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {list.map((u, i) => {
          const isOpen = openUser === u.username
          return (
            <div key={u.username} className="glass rounded-xl overflow-hidden">
              <button onClick={() => setOpenUser(isOpen ? null : u.username)}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/5 transition-colors text-left">
                <span className="text-sm font-bold text-white/20 w-6 shrink-0 text-center">#{i + 1}</span>
                <div className="w-8 h-8 rounded-full bg-linear-to-br from-purple-500/30 to-pink-500/30 flex items-center justify-center shrink-0 text-xs font-bold text-white/70">
                  {u.username?.[0]?.toUpperCase() || '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <a href={`https://www.instagram.com/${u.username}/`} target="_blank" rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="text-sm font-medium text-white/85 hover:text-pink-300 transition-colors truncate inline-block max-w-full">
                    @{u.username}
                  </a>
                  <div className="flex items-center gap-2 text-[11px] text-white/40 mt-0.5 flex-wrap">
                    <span className="flex items-center gap-1">
                      <MessageCircle size={10} className="text-pink-400" />{u.comment_count} komentar
                    </span>
                    {u.reply_count > 0 && (
                      <span className="flex items-center gap-1">
                        <MessagesSquare size={10} className="text-purple-400" />{u.reply_count} balasan
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Heart size={10} className="fill-pink-400 text-pink-400" />{u.total_likes.toLocaleString('id-ID')}
                    </span>
                    <span className={CAT_COLOR[u.dominant_category] || 'text-white/50'}>
                      {CAT_EMOJI[u.dominant_category] || ''} {u.dominant_category?.toLowerCase()}
                    </span>
                  </div>
                </div>
                <span className="shrink-0 text-xs font-bold text-purple-300 bg-purple-500/15 rounded-lg px-2 py-1">
                  {u.total_interactions}×
                </span>
                {isOpen ? <ChevronUp size={14} className="shrink-0 text-white/40" />
                        : <ChevronDown size={14} className="shrink-0 text-white/40" />}
              </button>

              {isOpen && (
                <div className="px-3 pb-3 pt-1 space-y-2 border-t border-white/5">
                  {u.comments.map((c, ci) => (
                    <div key={`c-${ci}`} className="text-xs flex items-start gap-2">
                      <span className="text-pink-400/70 shrink-0 mt-0.5">💬</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-white/70 wrap-break-word">{c.text}</p>
                        <div className="flex items-center gap-2 text-[10px] text-white/30 mt-0.5">
                          {c.like_count > 0 && <span>❤ {c.like_count}</span>}
                          <span className={CAT_COLOR[c.category] || ''}>{c.category?.toLowerCase()}</span>
                        </div>
                        {(c.replies?.length ?? 0) > 0 && (
                          <div className="mt-1.5 pl-3 border-l border-white/10 space-y-1">
                            {c.replies!.map((r, ri) => (
                              <div key={`rep-${ri}`} className="text-[11px]">
                                <span className="text-white/40">↳ @{r.username}: </span>
                                <span className="text-white/55 wrap-break-word">{r.text}</span>
                                {r.like_count > 0 && <span className="text-white/25 ml-1">❤{r.like_count}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {u.replies.length > 0 && (
                    <div className="pt-1">
                      <p className="text-[10px] uppercase tracking-wider text-white/25 mb-1">Balasan yang ditulis</p>
                      {u.replies.map((r, ri) => (
                        <div key={`mine-${ri}`} className="text-xs flex items-start gap-2">
                          <span className="text-purple-400/70 shrink-0 mt-0.5">↪</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-white/65 wrap-break-word">{r.text}</p>
                            <div className="flex items-center gap-2 text-[10px] text-white/30 mt-0.5">
                              <span>ke @{r.reply_to}</span>
                              {r.like_count > 0 && <span>❤ {r.like_count}</span>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PostResultView
// ─────────────────────────────────────────────────────────────────────────────

function PostResultView({ result, mode }: { result: PostResult | UnifiedResult; mode: 'post' | 'unified' }) {
  const [showComments, setShowComments] = useState(false)
  const [showLikers, setShowLikers]     = useState(false)
  const s = result.sentiment_summary
  const totalReplies = result.replies_count ??
    (result.comments || []).reduce((acc, c) => acc + (c.replies?.length || 0), 0)
  const unified       = mode === 'unified' ? (result as UnifiedResult) : null
  const likersFetched = unified?.likers_fetched ?? 0
  const likersList    = unified?.likers ?? []
  const savedFile     = result._meta?.saved_file
  const isUnlimited   = result.is_unlimited_comments ?? false

  return (
    <div className="space-y-6">
      <div className="glass-card p-6">
        <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-semibold text-lg" style={{ fontFamily: 'var(--font-display)' }}>
                @{result.owner_username || 'unknown'}
              </h2>
              {isUnlimited && <UnlimitedBadge />}
            </div>
            <p className="text-xs text-white/40 mt-0.5">
              {result.media_type} · {result.product_type || 'feed'} · {result.method}
              {unified && ` · likers: ${unified.likers_method || '—'}`}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <LikersButton postUrl={result.url} likes={result.likes} />
            <a href={result.url} target="_blank" rel="noopener noreferrer"
              className="btn-glass text-xs flex items-center gap-1.5">
              <Link2 size={12} /> Buka Post
            </a>
          </div>
        </div>
        {result.caption && (
          <p className="text-sm text-white/50 leading-relaxed line-clamp-3 mb-4 border-l-2 border-white/10 pl-3">
            {result.caption}
          </p>
        )}
        <div className="pt-3 border-t border-white/5">
          <DownloadBar savedFile={savedFile} comments={result.comments} likers={likersList}
            mode={mode} filenameHint={result.owner_username || result.shortcode}
            includeReplies={result.include_replies ?? true} />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        <StatCard label="Likes"       value={result.likes}          color="pink"   />
        <StatCard label="Komentar"    value={result.comments_count} color="purple" />
        {totalReplies > 0 && <StatCard label="Balasan"        value={totalReplies}   color="blue"   />}
        {likersFetched > 0 && <StatCard label="Likers Diambil" value={likersFetched} color="pink"   />}
        {result.video_views > 0 && <StatCard label="Video Views" value={result.video_views} color="blue" />}
        {result.saves_count  > 0 && <StatCard label="Saves"  value={result.saves_count}  color="orange" />}
        {result.shares_count > 0 && <StatCard label="Shares" value={result.shares_count} color="yellow" />}
        {result.play_count   > 0 && <StatCard label="Play"   value={result.play_count}   color="blue"   />}
      </div>

      {s && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="glass-card p-6">
            <h3 className="font-semibold mb-4 text-sm uppercase tracking-widest text-white/50">Distribusi Sentimen</h3>
            <SentimentChart summary={s} />
          </div>
          <div className="glass-card p-6">
            <h3 className="font-semibold mb-4 text-sm uppercase tracking-widest text-white/50">Detail Sentimen</h3>
            <SentimentDetailGrid s={s} />
          </div>
        </div>
      )}

      {s?.replies_sentiment_breakdown && (s.total_replies ?? 0) > 0 && (
        <div className="glass-card p-6">
          <h3 className="font-semibold mb-4 text-sm uppercase tracking-widest text-white/50">
            💬 Sentimen Balasan — {s.total_replies} balasan
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {[
              { label: '😊 Positif', pct: s.replies_sentiment_breakdown.positive_percentage, n: s.replies_sentiment_breakdown.positive_count,    cls: 'text-emerald-400' },
              { label: '😞 Negatif', pct: s.replies_sentiment_breakdown.negative_percentage, n: s.replies_sentiment_breakdown.negative_count,    cls: 'text-rose-400'   },
              { label: '😐 Netral',  pct: s.replies_sentiment_breakdown.neutral_percentage,  n: s.replies_sentiment_breakdown.neutral_count,     cls: 'text-white/60'   },
              { label: '😂 Humor',   pct: s.replies_sentiment_breakdown.humor_percentage,    n: s.replies_sentiment_breakdown.humor_count,       cls: 'text-indigo-400' },
              { label: '⚠️ Toxic',   pct: s.replies_sentiment_breakdown.toxic_percentage,    n: s.replies_sentiment_breakdown.toxic_count,       cls: 'text-yellow-400' },
              { label: '🚨 Hate',    pct: s.replies_sentiment_breakdown.hate_percentage,     n: s.replies_sentiment_breakdown.hate_speech_count, cls: 'text-red-400'    },
            ].map(item => (
              <div key={item.label} className="glass rounded-xl p-3 text-center">
                <p className={`text-base font-bold ${item.cls}`}>{item.pct}%</p>
                <p className="text-[11px] text-white/40 mt-0.5 leading-tight">{item.label} ({item.n})</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {s?.top_liked?.length > 0 && (
        <div className="glass-card p-6">
          <h3 className="font-semibold mb-4 text-sm uppercase tracking-widest text-white/50">🔥 Top Komentar by Likes</h3>
          <TopCommentsList items={s.top_liked} />
        </div>
      )}

      {result.active_commenters && result.active_commenters.length > 0 && (
        <div className="glass-card p-6">
          <ActiveCommentersPanel commenters={result.active_commenters}
            filenameHint={result.owner_username || result.shortcode} />
        </div>
      )}

      {unified && likersList.length > 0 && (
        <div className="glass-card p-6">
          <button onClick={() => setShowLikers(v => !v)}
            className="w-full flex items-center justify-between text-sm font-medium mb-2">
            <span className="flex items-center gap-2">
              <Heart size={15} className="fill-pink-400 text-pink-400" />
              Daftar Likers ({likersFetched.toLocaleString('id-ID')})
            </span>
            {showLikers ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {showLikers && (
            <div className="mt-4">
              <LikersPreview likers={likersList} fetched={likersFetched} total={result.likes} />
            </div>
          )}
        </div>
      )}

      <div className="glass-card p-6">
        <button onClick={() => setShowComments(v => !v)}
          className="w-full flex items-center justify-between font-semibold text-sm">
          <span className="flex items-center gap-2">
            💬 Semua Komentar ({result.comments_count})
            {isUnlimited && <UnlimitedBadge />}
            {totalReplies > 0 && <span className="text-white/40 font-normal">+ {totalReplies} balasan</span>}
          </span>
          {showComments ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        {showComments && <div className="mt-4"><CommentList comments={result.comments} /></div>}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// BatchResultItem
// ─────────────────────────────────────────────────────────────────────────────

function BatchResultItem({ item, idx, openIdx, setOpenIdx }: {
  item: BatchItem; idx: number; openIdx: number | null; setOpenIdx: (i: number | null) => void
}) {
  const d  = item.data
  const ss = d?.sentiment_summary
  const isOpen = openIdx === idx
  const replyTotal = d ? (d.replies_count ?? (d.comments || []).reduce((acc, c) => acc + (c.replies?.length || 0), 0)) : 0

  if (!item.success || !d) {
    return (
      <div className="glass-card p-5 border border-red-500/20">
        <div className="flex items-center gap-2 text-red-400 text-sm mb-1">
          <XCircle size={16} className="shrink-0" /><span className="font-medium">Gagal</span>
        </div>
        <p className="text-xs text-white/40 break-all">{item.url}</p>
        {item.error && <p className="text-xs text-red-400/70 mt-1">{item.error}</p>}
      </div>
    )
  }

  const isUnlimited = d.is_unlimited_comments ?? false
  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold">@{d.owner_username || 'unknown'}</h3>
            {isUnlimited && <UnlimitedBadge />}
          </div>
          <p className="text-xs text-white/40 mt-0.5">{d.media_type} · {d.product_type || 'feed'} · {d.method || '—'}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <LikersButton postUrl={d.url} likes={d.likes} size="small" />
          <a href={d.url} target="_blank" rel="noopener noreferrer"
            className="btn-glass text-xs flex items-center gap-1.5">
            <Link2 size={12} /> Buka
          </a>
        </div>
      </div>
      {d.caption && (
        <p className="text-sm text-white/50 leading-relaxed line-clamp-2 border-l-2 border-white/10 pl-3">
          {d.caption}
        </p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Likes',    value: d.likes || 0,          cls: 'ig-text' },
          { label: 'Komentar', value: d.comments_count || 0, cls: 'ig-text' },
          ...(replyTotal > 0 ? [{ label: 'Balasan', value: replyTotal, cls: 'text-blue-400' }] : []),
          ...(ss ? [{ label: 'Positif', value: `${ss.positive_percentage}%` as unknown as number, cls: 'text-emerald-400' }] : []),
        ].map((item, i) => (
          <div key={i} className="glass rounded-xl p-3 text-center">
            <p className={`text-lg font-bold ${item.cls}`}>
              {typeof item.value === 'number' ? item.value.toLocaleString('id-ID') : item.value}
            </p>
            <p className="text-[11px] text-white/40">{item.label}</p>
          </div>
        ))}
      </div>
      {ss && ss.total_comments > 0 && (
        <div>
          <p className="text-xs font-medium text-white/40 uppercase tracking-widest mb-2">Sentimen</p>
          <SentimentChart summary={ss} />
        </div>
      )}
      {Array.isArray(d.active_commenters) && d.active_commenters.length > 0 && (
        <ActiveCommentersPanel commenters={d.active_commenters}
          filenameHint={d.owner_username || d.shortcode} />
      )}
      <DownloadBar comments={d.comments} mode="post" savedFile={d._meta?.saved_file}
        filenameHint={d.owner_username || d.shortcode} includeReplies={d.include_replies ?? true} />
      {Array.isArray(d.comments) && d.comments.length > 0 && (
        <div>
          <button onClick={() => setOpenIdx(isOpen ? null : idx)}
            className="w-full flex items-center justify-between text-sm font-medium">
            <span>
              💬 Komentar ({d.comments_count})
              {replyTotal > 0 && <span className="text-white/40 font-normal ml-1">+ {replyTotal} balasan</span>}
            </span>
            {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {isOpen && <div className="mt-3"><CommentList comments={d.comments} /></div>}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// LikersConfig
// ─────────────────────────────────────────────────────────────────────────────

interface LikersConfig {
  scrapelikers: boolean; maxLikers: number; aggressiveLikers: boolean
  checkpointSize: number; checkpointDelayMin: number; checkpointDelayMax: number
  pageDelayMin: number; pageDelayMax: number
}

function LikersConfigPanel({ config, onChange, disabled, forceEnabled }: {
  config: LikersConfig; onChange: (c: LikersConfig) => void; disabled?: boolean; forceEnabled?: boolean
}) {
  const set = <K extends keyof LikersConfig>(key: K, value: LikersConfig[K]) => onChange({ ...config, [key]: value })
  const active = forceEnabled || config.scrapelikers

  return (
    <div className="space-y-5">
      {!forceEnabled && (
        <Toggle checked={config.scrapelikers} onChange={v => set('scrapelikers', v)} disabled={disabled}
          label="Scrape Likers" icon={<Heart size={13} className="text-pink-400" />}
          description="Ambil daftar akun yang menyukai post ini (gunakan unified scrape)" />
      )}
      {active && (
        <>
          <div className="glass rounded-xl p-4 space-y-4">
            <Toggle checked={config.aggressiveLikers} onChange={v => set('aggressiveLikers', v)} disabled={disabled}
              label="Aggressive Mode ⚡" icon={<Zap size={13} className="text-yellow-400" />}
              description="Jeda lebih pendek, push ke 1000+ likers. Risiko rate limit lebih tinggi." />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <NumberInput label="Max Likers" description="0 = ambil semua (unlimited)"
              value={config.maxLikers} min={0} max={5000} step={100} disabled={disabled} accentColor="pink"
              onChange={v => set('maxLikers', v)} />
            <NumberInput label="Checkpoint Size" description="Jeda setiap N likers (anti-deteksi)"
              value={config.checkpointSize} min={50} max={500} step={50} disabled={disabled} accentColor="orange"
              onChange={v => set('checkpointSize', v)} />
            <NumberInput label="Checkpoint Delay Min (detik)"
              value={config.checkpointDelayMin} min={3} max={60} step={1} disabled={disabled} accentColor="blue"
              onChange={v => set('checkpointDelayMin', v)} />
            <NumberInput label="Checkpoint Delay Max (detik)"
              value={config.checkpointDelayMax} min={5} max={120} step={1} disabled={disabled} accentColor="blue"
              onChange={v => set('checkpointDelayMax', v)} />
          </div>
          <div className="glass rounded-xl px-4 py-3 flex flex-wrap gap-4 text-xs text-white/40">
            <span className="flex items-center gap-1.5">
              <Shield size={11} className="text-blue-400" />
              Mode: <span className="text-white/70 font-medium ml-1">{config.aggressiveLikers ? '⚡ Aggressive' : '🛡 Safe'}</span>
            </span>
            <span>Target: <span className="text-white/70 font-medium">{config.maxLikers === 0 ? 'Semua' : config.maxLikers.toLocaleString('id-ID')}</span></span>
            <span>Checkpoint jeda: <span className="text-white/70 font-medium">{config.checkpointDelayMin}–{config.checkpointDelayMax}s</span></span>
          </div>
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LIKERS_CONFIG: LikersConfig = {
  scrapelikers: true, maxLikers: 1000, aggressiveLikers: false,
  checkpointSize: 200, checkpointDelayMin: 8, checkpointDelayMax: 15,
  pageDelayMin: 1.5, pageDelayMax: 3.0,
}

const CLIENT_SAFE_MAX = 2000

export default function ScrapePage() {
  const router = useRouter()

  // ── Mode ──────────────────────────────────────────────────────────
  // 'checkpoint' ditambahkan ke sini hanya sebagai UI state — bukan
  // dikirim ke scrapeStore (yang hanya mengenal 'single'|'batch'|'unified').
  const [mode, setMode] = useState<Mode>('single')

  // ── Comments config ───────────────────────────────────────────────
  const [url, setUrl]                       = useState('')
  const [batchUrls, setBatchUrls]           = useState<string[]>(['', ''])
  const [unlimitedComments, setUnlimited]   = useState(false)
  const [maxComments, setMaxComments]       = useState(100)
  const [includeReplies, setIncludeReplies] = useState(true)
  const [maxReplies, setMaxReplies]         = useState(20)

  // ── Likers config ─────────────────────────────────────────────────
  const [likersConfig, setLikersConfig] = useState<LikersConfig>(DEFAULT_LIKERS_CONFIG)

  // ── Checkpoint state ──────────────────────────────────────────────
  const [checkpointSessionActive, setCheckpointSessionActive] = useState(false)

  // ── UI state ──────────────────────────────────────────────────────
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [warning, setWarning]       = useState('')

  // ── Results ───────────────────────────────────────────────────────
  const [result, setResult]             = useState<PostResult | UnifiedResult | null>(null)
  const [resultMode, setResultMode]     = useState<'post' | 'unified'>('post')
  const [batchResults, setBatchResults] = useState<BatchItem[] | null>(null)
  const [batchSummary, setBatchSummary] = useState<{ total: number; success: number; failed: number } | null>(null)
  const [openComments, setOpenComments] = useState<number | null>(null)

  const globalBusy = useScrapeStatus()

  const effectiveMaxComments = unlimitedComments ? 0 : maxComments

  useEffect(() => {
    if (scrapeStore.isBusy()) {
      const st = scrapeStore.get()
      setWarning(`Masih ada proses scraping berjalan (${st.kind}: ${st.label}). Tunggu sampai selesai.`)
    }
  }, [])

  // ── Scrape handler — hanya untuk mode non-checkpoint ──────────────
  const handleScrape = useCallback(async () => {
    if (mode === 'checkpoint') return // handled by CheckpointPanel

    if (scrapeStore.isBusy()) {
      setWarning('Tunggu dulu — proses scraping sebelumnya belum selesai.')
      return
    }

    const singleUrl  = url.trim()
    const validBatch = batchUrls.filter(u => u.trim())

    if (mode === 'single'  && !singleUrl)        { setError('Masukkan URL post/reel Instagram'); return }
    if (mode === 'unified' && !singleUrl)        { setError('Masukkan URL post/reel Instagram'); return }
    if (mode === 'batch'   && !validBatch.length) { setError('Masukkan minimal 1 URL'); return }

    setError(''); setWarning(''); setResult(null)
    setBatchResults(null); setBatchSummary(null); setOpenComments(null)

    const label = mode === 'batch' ? `${validBatch.length} URL` : singleUrl
    if (!scrapeStore.begin(mode as 'single' | 'batch' | 'unified', label)) {
      setWarning('Tunggu dulu — proses scraping sebelumnya belum selesai.')
      return
    }

    setLoading(true)
    try {
      const opts = { include_replies: includeReplies, max_replies_per_comment: maxReplies }

      if (mode === 'single') {
        const resp = await scrapePost(singleUrl, effectiveMaxComments, opts)
        if (!resp.success) throw new Error(resp.message)
        setResult(resp.data); setResultMode('post')

      } else if (mode === 'unified') {
        const resp = await scrapeUnified({
          url: singleUrl, max_comments: effectiveMaxComments,
          include_replies: includeReplies, max_replies_per_comment: maxReplies,
          scrape_likers: likersConfig.scrapelikers, max_likers: likersConfig.maxLikers,
          aggressive_likers: likersConfig.aggressiveLikers, checkpoint_size: likersConfig.checkpointSize,
          checkpoint_delay_min: likersConfig.checkpointDelayMin, checkpoint_delay_max: likersConfig.checkpointDelayMax,
          page_delay_min: likersConfig.pageDelayMin, page_delay_max: likersConfig.pageDelayMax,
        })
        if (!resp.success) throw new Error(resp.message)
        setResult(resp.data); setResultMode('unified')

      } else {
        const resp = await scrapePosts(validBatch, effectiveMaxComments, 8, opts)
        if (!resp.success) throw new Error(resp.message)
        const data = resp.data as { total?: number; success?: number; failed?: number; results?: BatchItem[] }
        setBatchResults(data.results || [])
        setBatchSummary({
          total:   data.total   ?? (data.results?.length || 0),
          success: data.success ?? (data.results?.filter(r => r.success).length || 0),
          failed:  data.failed  ?? (data.results?.filter(r => !r.success).length || 0),
        })
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Terjadi kesalahan')
    } finally {
      setLoading(false); scrapeStore.finish()
    }
  }, [mode, url, batchUrls, effectiveMaxComments, includeReplies, maxReplies, likersConfig])

  const disabled = loading || globalBusy

  // ── Mode tabs ─────────────────────────────────────────────────────
  const tabs: { key: Mode; label: string; icon: React.ReactNode; desc: string; badge?: string }[] = [
    { key: 'single',     label: 'Single Post',      icon: <MessageCircle size={14} />, desc: 'Komentar + balasan satu post' },
    { key: 'unified',    label: 'Unified Scrape',   icon: <Layers size={14} />,        desc: 'Komentar + likers sekaligus', badge: 'NEW' },
    { key: 'batch',      label: 'Batch',            icon: <BarChart2 size={14} />,     desc: 'Multiple URL sekaligus' },
    { key: 'checkpoint', label: 'Checkpoint',       icon: <Zap size={14} />,           desc: 'Scrape batch per batch, bisa resume', badge: 'RESUME' },
  ]

  function getTimeEstimate(): string {
    if (unlimitedComments) {
      const extra = mode === 'unified' && likersConfig.scrapelikers ? ' + likers' : ''
      return `Mode UNLIMITED aktif — bisa 2–7 jam${extra}. Pastikan koneksi stabil.`
    }
    if (mode === 'unified' && likersConfig.scrapelikers)
      return `Komentar + likers (est. target ${likersConfig.maxLikers === 0 ? 'semua' : likersConfig.maxLikers.toLocaleString('id-ID')} likers) — bisa 5–15 menit`
    if (includeReplies) return 'Komentar + balasan, bisa 1–3 menit'
    if (mode === 'batch') return 'Batch bisa makan beberapa menit'
    return 'Sekitar 30–60 detik'
  }

  // ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-8 max-w-5xl">

      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <IGLogoFilled size={36} />
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>
            Scrape Post
          </h1>
          <p className="text-sm text-white/40">Komentar · Balasan · Sentimen · Likers · Checkpoint</p>
        </div>
      </div>

      {/* Busy banner */}
      {globalBusy && !loading && (
        <div className="glass-card p-4 mb-6 flex items-start gap-3 border border-yellow-500/20">
          <Clock size={18} className="text-yellow-400 shrink-0 mt-0.5 animate-pulse" />
          <div className="flex-1">
            <p className="text-sm text-yellow-300 font-medium">Scraping masih berjalan</p>
            <p className="text-xs text-white/50 mt-0.5">
              Tunggu hingga selesai sebelum memulai scrape baru. Hasil tersimpan otomatis.
            </p>
            <button onClick={() => router.push('/main/files')} className="btn-glass text-xs mt-2">
              Lihat Output Files
            </button>
          </div>
        </div>
      )}

      {/* ── Mode tabs ── */}
      <div className="glass-card p-1.5 inline-flex mb-6 gap-1 flex-wrap">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => !disabled && setMode(tab.key)}
            disabled={disabled}
            className={`
              flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all
              ${mode === tab.key ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'}
              ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              ${tab.key === 'checkpoint' && mode === tab.key ? 'bg-blue-500/15 text-blue-300' : ''}
            `}
            title={tab.desc}
          >
            {tab.icon}
            {tab.label}
            {tab.badge && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-normal
                ${tab.key === 'checkpoint'
                  ? 'bg-blue-500/20 text-blue-300'
                  : 'bg-pink-500/20 text-pink-300'
                }`}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════
          CHECKPOINT MODE — render CheckpointPanel, tidak ada form biasa
          ══════════════════════════════════════════════════════════ */}
      {mode === 'checkpoint' ? (
        <div className="space-y-4">
          {/* Info callout */}
          <div className="glass-card p-4 flex items-start gap-3 border border-blue-500/15">
            <Zap size={16} className="text-blue-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-blue-300 font-medium">Mode Checkpoint</p>
              <p className="text-xs text-white/50 mt-0.5">
                Scrape komentar secara batch per batch. Bisa dijeda dan dilanjutkan kapan saja.
                Cocok untuk postingan dengan ribuan komentar tanpa risiko timeout.
              </p>
            </div>
          </div>

          <CheckpointPanel
            currentUrl={url}
            onSessionActive={setCheckpointSessionActive}
            globalBusy={globalBusy}
          />
        </div>
      ) : (
        /* ══════════════════════════════════════════════════════════
           MODE BIASA — form input + scrape
           ══════════════════════════════════════════════════════════ */
        <>
          {/* Input card */}
          <div className="glass-card p-6 mb-6 space-y-6">

            {/* URL input */}
            {(mode === 'single' || mode === 'unified') ? (
              <div>
                <label className="block text-xs text-white/50 mb-2 uppercase tracking-widest">URL Post / Reel</label>
                <div className="relative">
                  <Link2 size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                  <input type="url" value={url} onChange={e => setUrl(e.target.value)}
                    placeholder="https://www.instagram.com/p/xxxxxxx/"
                    className="input-glass pl-10" disabled={disabled}
                    onKeyDown={e => e.key === 'Enter' && handleScrape()} />
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-xs text-white/50 mb-2 uppercase tracking-widest">Daftar URL</label>
                <div className="space-y-2">
                  {batchUrls.map((u, i) => (
                    <div key={i} className="flex gap-2">
                      <div className="relative flex-1">
                        <Link2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                        <input type="url" value={u} disabled={disabled}
                          onChange={e => { const copy = [...batchUrls]; copy[i] = e.target.value; setBatchUrls(copy) }}
                          placeholder={`URL #${i + 1}`} className="input-glass pl-9 text-sm" />
                      </div>
                      {batchUrls.length > 1 && (
                        <button onClick={() => !disabled && setBatchUrls(batchUrls.filter((_, idx) => idx !== i))}
                          disabled={disabled}
                          className="glass rounded-xl p-2.5 text-white/40 hover:text-red-400 transition-colors disabled:opacity-50">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button onClick={() => !disabled && setBatchUrls([...batchUrls, ''])} disabled={disabled}
                    className="btn-glass flex items-center gap-2 text-sm w-full justify-center disabled:opacity-50">
                    <Plus size={14} /> Tambah URL
                  </button>
                </div>
              </div>
            )}

            {/* Comments settings */}
            <div>
              <p className="text-xs text-white/40 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Hash size={12} /> Pengaturan Komentar
              </p>
              <div className="mb-5">
                <UnlimitedToggle checked={unlimitedComments} onChange={setUnlimited} disabled={disabled} />
              </div>
              {!unlimitedComments && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-5">
                  <NumberInput label="Max Komentar" description="Jumlah komentar utama yang diambil"
                    value={maxComments} min={10} max={500} step={10} disabled={disabled} accentColor="pink"
                    onChange={setMaxComments} />
                  <NumberInput label="Max Balasan / Komentar"
                    description={includeReplies ? 'Maks. balasan per komentar' : 'Aktifkan toggle balasan dulu'}
                    value={maxReplies} min={0} max={100} step={5}
                    disabled={disabled || !includeReplies} accentColor="purple" onChange={setMaxReplies} />
                </div>
              )}
              {unlimitedComments && includeReplies && (
                <div className="mb-5 max-w-xs">
                  <NumberInput label="Max Balasan / Komentar" description="Maks. balasan per komentar"
                    value={maxReplies} min={0} max={100} step={5} disabled={disabled} accentColor="purple"
                    onChange={setMaxReplies} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-4">
                <div className="glass rounded-xl px-4 py-2.5 flex flex-wrap gap-4 text-xs text-white/40 flex-1">
                  <span className="flex items-center gap-1.5">
                    <MessageCircle size={11} className="text-pink-400" />
                    Komentar:{' '}
                    <span className="text-white/70 font-medium ml-1">
                      {unlimitedComments
                        ? <span className="text-orange-300 font-semibold flex items-center gap-1">
                            <Infinity size={11} /> Semua (hingga {CLIENT_SAFE_MAX.toLocaleString('id-ID')})
                          </span>
                        : maxComments
                      }
                    </span>
                  </span>
                  {includeReplies && (
                    <span className="flex items-center gap-1.5">
                      <MessagesSquare size={11} className="text-purple-400" />
                      Balasan: <span className="text-white/70 font-medium ml-1">{maxReplies}/komentar</span>
                    </span>
                  )}
                </div>
                <Toggle checked={includeReplies} onChange={setIncludeReplies} disabled={disabled}
                  label="Sertakan balasan" icon={<MessageCircle size={13} className="text-white/40" />} />
              </div>
            </div>

            {/* Likers config (unified only) */}
            {mode === 'unified' && (
              <>
                <div className="border-t border-white/5" />
                <div>
                  <p className="text-xs text-white/40 uppercase tracking-widest mb-4 flex items-center gap-2">
                    <Users size={12} /> Pengaturan Likers
                  </p>
                  <LikersConfigPanel config={likersConfig} onChange={setLikersConfig} disabled={disabled} />
                </div>
              </>
            )}

            {/* Warning / Error */}
            {warning && (
              <div className="flex items-start gap-2 text-yellow-300 text-sm glass rounded-xl px-4 py-3">
                <Clock size={16} className="shrink-0 mt-0.5" /> {warning}
              </div>
            )}
            {error && (
              <div className="flex items-center gap-2 text-red-400 text-sm glass rounded-xl px-4 py-3">
                <AlertCircle size={16} className="shrink-0" /> {error}
              </div>
            )}

            {/* Submit */}
            <div className="flex items-center justify-between gap-4">
              {/* Shortcut ke checkpoint jika URL sudah ada */}
              {url.trim() && (
                <button
                  onClick={() => setMode('checkpoint')}
                  disabled={disabled}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-medium
                    bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/20
                    hover:border-blue-500/40 transition-all disabled:opacity-50"
                  title="Buka mode checkpoint dengan URL ini"
                >
                  <Zap size={13} /> Pakai Checkpoint
                </button>
              )}

              <button
                onClick={handleScrape} disabled={disabled}
                className={`
                  btn-ig flex items-center gap-2 px-6 py-3 ml-auto
                  disabled:opacity-50 disabled:cursor-not-allowed
                  ${unlimitedComments ? 'ring-1 ring-orange-500/30' : ''}
                `}
              >
                {disabled ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                {loading
                  ? 'Memproses...'
                  : globalBusy
                  ? 'Menunggu...'
                  : mode === 'unified'
                  ? 'Unified Scrape'
                  : mode === 'batch'
                  ? 'Scrape Batch'
                  : unlimitedComments
                  ? 'Scrape Semua Komentar ♾️'
                  : 'Scrape'}
              </button>
            </div>
          </div>

          {/* Loading state */}
          {loading && (
            <div className="glass-card p-12 text-center mb-6">
              <div className="relative w-16 h-16 mx-auto mb-4">
                <IGLogoFilled size={64} className="opacity-30" />
                <div className="absolute inset-0 animate-spin-slow">
                  <div className="w-full h-full rounded-full border-2 border-transparent border-t-pink-500" />
                </div>
              </div>
              <p className="text-white/60 text-sm">Sedang scraping Instagram...</p>
              <p className="text-white/30 text-xs mt-1">{getTimeEstimate()}</p>
              {unlimitedComments && (
                <div className="mt-3 glass rounded-xl px-4 py-2.5 inline-flex items-center gap-2 text-orange-300 text-xs">
                  <Infinity size={13} />
                  Mode unlimited — scraper akan terus berjalan hingga semua komentar selesai diambil
                </div>
              )}
              <p className="text-white/20 text-xs mt-2">Jangan pindah halaman agar hasil langsung tampil.</p>
              <div className="flex justify-center gap-3 mt-4 flex-wrap">
                {[
                  'Buka browser', 'Ambil komentar',
                  ...(includeReplies ? ['Ambil balasan'] : []),
                  ...(mode === 'unified' && likersConfig.scrapelikers ? ['Scrape likers'] : []),
                  'Analisis sentimen',
                ].map((step, i) => (
                  <div key={i} className="flex items-center gap-1 text-xs text-white/30">
                    <div className="w-1.5 h-1.5 rounded-full bg-pink-500 animate-pulse"
                      style={{ animationDelay: `${i * 0.3}s` }} />
                    {step}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Result: single / unified */}
          {result && <PostResultView result={result} mode={resultMode} />}

          {/* Result: batch */}
          {batchResults && batchSummary && (
            <div className="space-y-5">
              <div className="glass-card p-5 flex items-center gap-6 flex-wrap">
                <div>
                  <p className="text-2xl font-bold ig-text">{batchSummary.success}/{batchSummary.total}</p>
                  <p className="text-xs text-white/40">post berhasil</p>
                </div>
                <div className="flex items-center gap-2 text-sm text-emerald-400">
                  <CheckCircle size={16} /> {batchSummary.success} sukses
                </div>
                {batchSummary.failed > 0 && (
                  <div className="flex items-center gap-2 text-sm text-red-400">
                    <XCircle size={16} /> {batchSummary.failed} gagal
                  </div>
                )}
                {unlimitedComments && <UnlimitedBadge />}
              </div>
              {batchResults.map((item, idx) => (
                <BatchResultItem key={idx} item={item} idx={idx}
                  openIdx={openComments} setOpenIdx={setOpenComments} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}