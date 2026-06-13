'use client'

import { useState, useEffect } from 'react'
import {
  Layers, Loader2, AlertCircle, CheckCircle, XCircle, Clock,
  MessageCircle, Heart, FileJson, Users, ChevronDown, ChevronUp,
  Infinity, AlertTriangle, Info, Zap, Link2, ExternalLink,
  CornerDownRight, BadgeCheck, Lock, Play, Image,
} from 'lucide-react'
import {
  scrapeProfileDeep,
  getDeepScrapeProgress,
  getDeepScrapeResult,
} from '@/lib/api'
import type { DeepScrapeResult, DeepScrapePostEntry, DeepScrapeComment, DeepScrapeLiker, DeepScrapePostData } from '@/types'
import { IGLogoFilled } from '@/components/ui/IGLogo'
import { StatCard } from '@/components/ui/StatCard'
import { scrapeStore, useScrapeTask, useScrapeBusy } from '@/lib/scrapeStore'

const DEEP_KEY = 'deep-scrape:main'

interface ProgressDetail {
  total_posts_found: number
  total_posts_scraped: number
  total_comments: number
  total_likers: number
  errors_count: number
}

// Module-level: persist across component unmount (navigation).
// The scrapeStore.run() closure keeps the job alive in the background;
// these vars let the UI resume progress polling when the user comes back.
let _deepJobId: string | null = null
let _deepProgress: ProgressDetail | null = null
let _deepJobStatus = ''

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractUsername(raw: string): string {
  const s = (raw || '').trim()
  if (s.toLowerCase().includes('instagram.com')) {
    const m = s.match(/instagram\.com\/([^/?#]+)/i)
    if (m) return m[1].replace(/^@/, '').toLowerCase()
    return ''
  }
  return s.replace(/^@/, '').toLowerCase()
}

// ── Sentiment badge helper ──
function SentimentBadge({ sentiment, category, isHateSpeech, isToxic, isSarcasm, isWellwish }: {
  sentiment: string; category: string; isHateSpeech: boolean; isToxic: boolean;
  isSarcasm: boolean; isWellwish: boolean;
}) {
  if (isHateSpeech) return <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-red-500/30 text-red-300">HATE</span>
  if (isToxic) return <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-yellow-500/30 text-yellow-300">TOXIC</span>
  if (isSarcasm) return <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-cyan-500/20 text-cyan-300">SARCASTIC</span>
  if (isWellwish) return <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-emerald-500/20 text-emerald-300">WISH</span>
  const map: Record<string, { bg: string; text: string; label: string }> = {
    POSITIVE:  { bg: 'bg-emerald-500/20', text: 'text-emerald-300', label: 'POS' },
    NEGATIVE:  { bg: 'bg-purple-500/20',  text: 'text-purple-300',  label: 'NEG' },
    NEUTRAL:   { bg: 'bg-white/10',       text: 'text-white/40',    label: 'NEU' },
    HUMOR:     { bg: 'bg-cyan-500/20',    text: 'text-cyan-300',    label: 'HUMOR' },
  }
  const s = map[category] || map[category.toUpperCase()] || map.NEUTRAL
  return <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${s.bg} ${s.text}`}>{s.label}</span>
}

// ── Reply item ──
function ReplyItem({ reply }: { reply: DeepScrapeComment }) {
  return (
    <div className="pl-4 border-l-2 border-white/5 py-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <CornerDownRight size={10} className="text-white/20 shrink-0" />
        <span className="text-[11px] font-semibold text-pink-300">@{reply.username}</span>
        {reply.is_toxic && <span className="px-1 py-0 text-[8px] font-bold rounded bg-yellow-500/20 text-yellow-400">TOXIC</span>}
        <SentimentBadge
          sentiment={reply.sentiment} category={reply.category}
          isHateSpeech={reply.is_hate_speech} isToxic={reply.is_toxic}
          isSarcasm={reply.is_sarcasm} isWellwish={reply.is_wellwish}
        />
        {(reply.like_count ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-pink-400/60 ml-auto">
            <Heart size={9} /> {reply.like_count}
          </span>
        )}
      </div>
      <p className="text-xs text-white/50 mt-0.5 pl-5 break-words">{reply.text}</p>
      {reply.emojis && reply.emojis.length > 0 && (
        <span className="text-[10px] text-white/30 pl-5">{reply.emojis.join(' ')}</span>
      )}
    </div>
  )
}

// ── Comment item (with nested replies) ──
function CommentItem({ comment }: { comment: DeepScrapeComment }) {
  const [showReplies, setShowReplies] = useState(false)
  const replies = comment.replies || []
  const REPLY_SHOW = 5

  return (
    <div className="py-2 space-y-1">
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-[10px] font-bold text-white/50">{comment.username[0]?.toUpperCase() || '?'}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-purple-300">@{comment.username}</span>
            <SentimentBadge
              sentiment={comment.sentiment} category={comment.category}
              isHateSpeech={comment.is_hate_speech} isToxic={comment.is_toxic}
              isSarcasm={comment.is_sarcasm} isWellwish={comment.is_wellwish}
            />
            {(comment.like_count ?? 0) > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-pink-400/60">
                <Heart size={9} /> {comment.like_count}
              </span>
            )}
            {comment.created_at > 0 && (
              <span className="text-[10px] text-white/20 ml-auto">
                {new Date(comment.created_at * 1000).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}
              </span>
            )}
          </div>
          <p className="text-xs text-white/60 mt-0.5 break-words">{comment.text}</p>
          {comment.emojis && comment.emojis.length > 0 && (
            <span className="text-[10px] text-white/30">{comment.emojis.join(' ')}</span>
          )}
          {replies.length > 0 && (
            <button
              onClick={() => setShowReplies(!showReplies)}
              className="text-[11px] text-blue-400 hover:text-blue-300 mt-1 flex items-center gap-1"
            >
              <CornerDownRight size={10} />
              {showReplies ? 'Sembunyikan' : 'Lihat'} {replies.length} balasan
            </button>
          )}
          {showReplies && (
            <div className="mt-1 space-y-1">
              {replies.slice(0, REPLY_SHOW).map((r, i) => (
                <ReplyItem key={r.comment_id || i} reply={r} />
              ))}
              {replies.length > REPLY_SHOW && (
                <p className="text-[10px] text-white/30 pl-4">...dan {replies.length - REPLY_SHOW} balasan lainnya</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── PostEntryCard ──
function PostEntryCard({ entry }: { entry: DeepScrapePostEntry }) {
  const [open, setOpen] = useState(false)
  const [showAllComments, setShowAllComments] = useState(false)
  const [showLikers, setShowLikers] = useState(false)
  const data = entry.data as DeepScrapePostData | null

  const comments = data?.comments || []
  const likers = data?.likers || []
  const commentsCount = (data?.comments_count as number) ?? 0
  const repliesCount  = (data?.replies_count as number) ?? 0
  const likersFetched = (data?.likers_fetched as number) ?? 0
  const COMMENT_SHOW = 10

  return (
    <div className="glass rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left"
      >
        <span className="text-xs font-bold text-white/20 w-8 shrink-0 text-center">
          #{entry.index}
        </span>
        {/* Thumbnail */}
        <div className="w-12 h-12 rounded-lg overflow-hidden bg-white/5 shrink-0 relative">
          {entry.thumbnail_url ? (
            <img src={entry.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Image size={16} className="text-white/20" />
            </div>
          )}
          {entry.media_type === 'VIDEO' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <Play size={14} className="text-white/80" fill="white" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {entry.scraped
              ? <CheckCircle size={13} className="text-emerald-400 shrink-0" />
              : <XCircle size={13} className="text-red-400 shrink-0" />
            }
            <span className="text-sm font-medium text-white/80 truncate">
              {entry.shortcode || entry.url}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-white/40 mt-0.5">
            <span className="flex items-center gap-1">
              <Heart size={10} className="text-pink-400" />
              {entry.feed_like_count}
            </span>
            <span className="flex items-center gap-1">
              <MessageCircle size={10} className="text-purple-400" />
              {entry.feed_comment_count}
            </span>
            <span>{entry.media_type}</span>
            {entry.taken_at_iso && <span>{entry.taken_at_iso.slice(0, 10)}</span>}
          </div>
        </div>
        {entry.scraped && (
          <div className="flex items-center gap-2 text-[11px] shrink-0">
            <span className="text-emerald-400">{commentsCount} kom</span>
            {repliesCount > 0 && <span className="text-blue-400">{repliesCount} bls</span>}
            {likersFetched > 0 && <span className="text-pink-400">{likersFetched} likers</span>}
          </div>
        )}
        {open ? <ChevronUp size={14} className="text-white/40" /> : <ChevronDown size={14} className="text-white/40" />}
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 border-t border-white/5 space-y-3">
          {/* Caption & link */}
          {entry.feed_caption && (
            <p className="text-xs text-white/40 line-clamp-3 border-l-2 border-white/10 pl-3">
              {entry.feed_caption}
            </p>
          )}
          <div className="flex items-center gap-3">
            {entry.url && (
              <a href={entry.url} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-pink-300 hover:text-pink-200">
                <ExternalLink size={11} /> Buka Post
              </a>
            )}
          </div>
          {entry.error && <p className="text-xs text-red-400/80">{entry.error}</p>}

          {/* ── Comments Section ── */}
          {comments.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-2 pt-2 border-t border-white/5">
                <MessageCircle size={12} className="text-purple-400" />
                <span className="text-xs font-semibold text-white/60">Komentar ({comments.length})</span>
              </div>
              <div className="space-y-0.5">
                {(showAllComments ? comments : comments.slice(0, COMMENT_SHOW)).map((c, i) => (
                  <CommentItem key={c.comment_id || i} comment={c} />
                ))}
              </div>
              {comments.length > COMMENT_SHOW && (
                <button onClick={() => setShowAllComments(!showAllComments)}
                  className="text-xs text-purple-400 hover:text-purple-300 py-1">
                  {showAllComments ? `Sembunyikan (${comments.length - COMMENT_SHOW} lainnya)` : `Lihat semua ${comments.length} komentar`}
                </button>
              )}
            </div>
          )}

          {/* ── Likers Section ── */}
          {likers.length > 0 && (
            <div className="space-y-1">
              <button onClick={() => setShowLikers(!showLikers)}
                className="flex items-center gap-2 pt-2 border-t border-white/5 w-full text-left">
                <Heart size={12} className="text-pink-400" />
                <span className="text-xs font-semibold text-white/60">Likers ({likers.length})</span>
                {showLikers ? <ChevronUp size={12} className="text-white/40" /> : <ChevronDown size={12} className="text-white/40" />}
              </button>
              {showLikers && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1 max-h-48 overflow-y-auto">
                  {likers.map((l, i) => (
                    <div key={l.user_id || i} className="flex items-center gap-1.5 text-[11px] py-0.5">
                      <span className="text-white/60 truncate">@{l.username}</span>
                      {l.is_verified && <BadgeCheck size={10} className="text-blue-400 shrink-0" />}
                      {l.is_private && <Lock size={9} className="text-white/20 shrink-0" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

export default function DeepScrapePage() {
  // ── Form state ──
  const [usernameInput, setUsernameInput] = useState('')
  const [maxPosts, setMaxPosts] = useState(50)
  const [maxComments, setMaxComments] = useState(100)
  const [includeReplies, setIncludeReplies] = useState(true)
  const [maxReplies, setMaxReplies] = useState(20)
  const [scrapeLikers, setScrapeLikers] = useState(true)
  const [maxLikers, setMaxLikers] = useState(500)
  const [aggressiveLikers, setAggressiveLikers] = useState(false)
  const [delayBetween, setDelayBetween] = useState(15)
  const [unlimitedPosts, setUnlimitedPosts] = useState(false)
  const [unlimitedComments, setUnlimitedComments] = useState(false)

  // ── Task state (persistent across navigation via scrapeStore) ──
  const task = useScrapeTask<DeepScrapeResult>(DEEP_KEY)
  const loading = task.status === 'running'
  const result = task.status === 'success' ? task.data : null
  const [localError, setLocalError] = useState('')
  const error = localError || (task.status === 'error' ? (task.error ?? '') : '')
  const [validationError, setValidationError] = useState('')

  // ── Global busy lock — blokir saat ada scrape LAIN yang berjalan ──
  // Sama seperti halaman lain (Scrape Post / Profiles / Likers): backend hanya
  // punya satu sesi browser, jadi dua scrape berat bersamaan akan tabrakan.
  const globalBusy = useScrapeBusy()
  const busyInfo = scrapeStore.get()
  const foreignBusy = globalBusy && task.status !== 'running'
  const busyWarning = foreignBusy
    ? `Masih ada proses scraping berjalan (${busyInfo.kind}: ${busyInfo.label}). Tunggu sampai selesai.`
    : ''

  // ── Progress polling (module-level, resumes after navigation) ──
  const [progress, setProgress] = useState<ProgressDetail | null>(_deepProgress)
  const [jobStatus, setJobStatus] = useState(_deepJobStatus)

  useEffect(() => {
    const jid = _deepJobId
    if (!jid || !loading) return

    // Seed from module-level in case this is a remount
    if (_deepProgress) setProgress(_deepProgress)
    if (_deepJobStatus) setJobStatus(_deepJobStatus)

    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null

    const poll = async () => {
      if (cancelled) return
      try {
        const res = await getDeepScrapeProgress(jid)
        if (cancelled) return
        if (res.success && res.data) {
          const st = res.data.status || ''
          const det = res.data.detail || null
          setJobStatus(st); _deepJobStatus = st
          setProgress(det); _deepProgress = det
        }
        if (res.data?.status === 'completed' || res.data?.status === 'error') {
          if (interval) { clearInterval(interval); interval = null }
        }
      } catch { /* ignore */ }
    }

    poll()
    interval = setInterval(poll, 5000)
    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
    }
  }, [loading])

  // ── Submit handler (scrapeStore.run keeps job alive across navigation) ──
  const handleStart = async () => {
    const username = extractUsername(usernameInput)
    if (!username) {
      setValidationError('Masukkan username atau URL profil Instagram yang valid')
      return
    }
    setValidationError('')
    setLocalError('')

    // Tolak bila ada proses scraping lain yang sedang berjalan.
    if (scrapeStore.isBusy()) {
      setLocalError('Tunggu dulu — proses scraping sebelumnya belum selesai.')
      return
    }

    // Reset module-level progress for new job
    _deepJobId = null
    _deepProgress = null
    _deepJobStatus = ''
    setProgress(null)
    setJobStatus('')

    const res = await scrapeStore.run<DeepScrapeResult>(
      DEEP_KEY,
      'profile_deep',
      `Deep: @${username}`,
      async () => {
        const apiRes = await scrapeProfileDeep({
          username,
          max_posts: unlimitedPosts ? 0 : maxPosts,
          max_comments: unlimitedComments ? 0 : maxComments,
          include_replies: includeReplies,
          max_replies_per_comment: maxReplies,
          scrape_likers: scrapeLikers,
          max_likers: maxLikers,
          aggressive_likers: aggressiveLikers,
          delay_between_posts: delayBetween,
        })
        if (!apiRes.success || !apiRes.data?.job_id) {
          throw new Error(apiRes.message || 'Gagal memulai job')
        }
        const jid = apiRes.data.job_id
        _deepJobId = jid

        // Poll progress until job finishes
        while (true) {
          await new Promise(r => setTimeout(r, 5000))
          try {
            const pRes = await getDeepScrapeProgress(jid)
            if (pRes.success && pRes.data) {
              _deepJobStatus = pRes.data.status || ''
              _deepProgress = pRes.data.detail || null
            }
            if (pRes.data?.status === 'completed' || pRes.data?.status === 'error') break
          } catch { /* keep polling */ }
        }

        if (_deepJobStatus === 'error') {
          throw new Error('Job gagal — cek log backend untuk detail')
        }

        // Fetch final result
        const rRes = await getDeepScrapeResult(jid)
        if (!rRes.success || !rRes.data) {
          throw new Error(rRes.message || 'Gagal mengambil hasil')
        }
        return rRes.data
      },
    )
    if (res.busy) {
      setLocalError(res.error || 'Proses scraping lain sedang berjalan.')
    }
  }

  const handleClear = () => {
    scrapeStore.resetTask(DEEP_KEY)
    _deepJobId = null
    _deepProgress = null
    _deepJobStatus = ''
    setProgress(null)
    setJobStatus('')
    setLocalError('')
  }

  const disabled = loading || globalBusy

  return (
    <div className="p-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center">
          <Layers size={22} className="text-purple-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>
            Deep Scrape
          </h1>
          <p className="text-sm text-white/40">Scrape SEMUA post dari profil — komentar + balasan + likers per post</p>
        </div>
      </div>

      {/* Info callout */}
      <div className="glass-card p-4 mb-6 flex items-start gap-3 border border-purple-500/15">
        <Info size={16} className="text-purple-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm text-purple-300 font-medium">Cara Kerja</p>
          <p className="text-xs text-white/50 mt-0.5 leading-relaxed">
            Deep Scrape mengambil daftar semua post dari profil, lalu untuk setiap post menjalankan
            unified scrape (komentar + balasan + likers). Proses berjalan di background sebagai job —
            Anda bisa menutup tab dan kembali lagi nanti.
          </p>
        </div>
      </div>

      {/* ── Form ── */}
      <div className="glass-card p-6 mb-6 space-y-6">
        {/* Username */}
        <div>
          <label className="block text-xs text-white/50 mb-2 uppercase tracking-widest">Username / URL Profil</label>
          <div className="relative">
            <Users size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
            <input
              type="text"
              value={usernameInput}
              onChange={e => setUsernameInput(e.target.value)}
              placeholder="@username atau https://www.instagram.com/username/"
              className="input-glass pl-10"
              disabled={disabled}
              onKeyDown={e => e.key === 'Enter' && handleStart()}
            />
          </div>
        </div>

        {/* Posts config */}
        <div>
          <p className="text-xs text-white/40 uppercase tracking-widest mb-4 flex items-center gap-2">
            <FileJson size={12} /> Pengaturan Post
          </p>
          <div className="space-y-4">
            {/* Unlimited posts toggle */}
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={unlimitedPosts}
                  onChange={e => setUnlimitedPosts(e.target.checked)}
                  disabled={disabled}
                  className="sr-only peer"
                />
                <div className="w-10 h-5 rounded-full bg-white/10 peer-checked:bg-orange-500/70 transition-colors" />
                <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
              </div>
              <div className="flex items-center gap-2 text-sm text-white/70">
                <Infinity size={13} className="text-orange-400" />
                <span>Semua Post (unlimited)</span>
              </div>
            </label>

            {!unlimitedPosts && (
              <div>
                <label className="block text-xs text-white/50 mb-1 uppercase tracking-widest">Max Posts</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={1} max={200} step={1} value={maxPosts}
                    disabled={disabled} onChange={e => setMaxPosts(Number(e.target.value))}
                    className="flex-1 accent-purple-500 h-1.5 disabled:opacity-30 cursor-pointer"
                  />
                  <input
                    type="number" min={1} max={500} value={maxPosts}
                    disabled={disabled}
                    onChange={e => setMaxPosts(Math.min(500, Math.max(1, Number(e.target.value))))}
                    className="w-20 shrink-0 bg-white/5 border border-purple-500/40 focus:border-purple-500 rounded-xl px-3 py-1.5 text-sm text-white text-center outline-none transition-colors disabled:opacity-30"
                  />
                </div>
              </div>
            )}

            {/* Delay */}
            <div>
              <label className="block text-xs text-white/50 mb-1 uppercase tracking-widest">Jeda Antar Post (detik)</label>
              <div className="flex items-center gap-3">
                <input
                  type="range" min={5} max={60} step={1} value={delayBetween}
                  disabled={disabled} onChange={e => setDelayBetween(Number(e.target.value))}
                  className="flex-1 accent-blue-500 h-1.5 disabled:opacity-30 cursor-pointer"
                />
                <span className="w-12 text-center text-sm text-white/70">{delayBetween}s</span>
              </div>
            </div>
          </div>
        </div>

        {/* Comments config */}
        <div>
          <p className="text-xs text-white/40 uppercase tracking-widest mb-4 flex items-center gap-2">
            <MessageCircle size={12} /> Pengaturan Komentar (per Post)
          </p>
          <div className="space-y-4">
            {/* Unlimited comments */}
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={unlimitedComments}
                  onChange={e => setUnlimitedComments(e.target.checked)}
                  disabled={disabled}
                  className="sr-only peer"
                />
                <div className="w-10 h-5 rounded-full bg-white/10 peer-checked:bg-orange-500/70 transition-colors" />
                <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
              </div>
              <div className="flex items-center gap-2 text-sm text-white/70">
                <Infinity size={13} className="text-orange-400" />
                <span>Semua Komentar (unlimited)</span>
              </div>
            </label>

            {!unlimitedComments && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-white/50 mb-1 uppercase tracking-widest">Max Komentar</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={10} max={500} step={10} value={maxComments}
                      disabled={disabled} onChange={e => setMaxComments(Number(e.target.value))}
                      className="flex-1 accent-pink-500 h-1.5 disabled:opacity-30 cursor-pointer"
                    />
                    <input
                      type="number" min={10} max={2000} value={maxComments}
                      disabled={disabled}
                      onChange={e => setMaxComments(Math.min(2000, Math.max(10, Number(e.target.value))))}
                      className="w-20 shrink-0 bg-white/5 border border-pink-500/40 focus:border-pink-500 rounded-xl px-3 py-1.5 text-sm text-white text-center outline-none transition-colors disabled:opacity-30"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1 uppercase tracking-widest">Max Balasan / Komentar</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={0} max={100} step={5} value={maxReplies}
                      disabled={disabled || !includeReplies} onChange={e => setMaxReplies(Number(e.target.value))}
                      className="flex-1 accent-purple-500 h-1.5 disabled:opacity-30 cursor-pointer"
                    />
                    <span className="w-12 text-center text-sm text-white/70">{maxReplies}</span>
                  </div>
                </div>
              </div>
            )}

            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={includeReplies}
                  onChange={e => setIncludeReplies(e.target.checked)}
                  disabled={disabled}
                  className="sr-only peer"
                />
                <div className="w-10 h-5 rounded-full bg-white/10 peer-checked:bg-pink-500/70 transition-colors" />
                <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
              </div>
              <span className="text-sm text-white/70">Sertakan balasan</span>
            </label>
          </div>
        </div>

        {/* Likers config */}
        <div>
          <p className="text-xs text-white/40 uppercase tracking-widest mb-4 flex items-center gap-2">
            <Heart size={12} /> Pengaturan Likers (per Post)
          </p>
          <div className="space-y-4">
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={scrapeLikers}
                  onChange={e => setScrapeLikers(e.target.checked)}
                  disabled={disabled}
                  className="sr-only peer"
                />
                <div className="w-10 h-5 rounded-full bg-white/10 peer-checked:bg-pink-500/70 transition-colors" />
                <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
              </div>
              <span className="text-sm text-white/70">Scrape Likers</span>
            </label>

            {scrapeLikers && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-white/50 mb-1 uppercase tracking-widest">Max Likers</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={0} max={2000} step={100} value={maxLikers}
                      disabled={disabled} onChange={e => setMaxLikers(Number(e.target.value))}
                      className="flex-1 accent-pink-500 h-1.5 disabled:opacity-30 cursor-pointer"
                    />
                    <span className="w-16 text-center text-sm text-white/70">
                      {maxLikers === 0 ? 'All' : maxLikers}
                    </span>
                  </div>
                </div>
                <label className="flex items-center gap-3 cursor-pointer select-none pt-5">
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={aggressiveLikers}
                      onChange={e => setAggressiveLikers(e.target.checked)}
                      disabled={disabled}
                      className="sr-only peer"
                    />
                    <div className="w-10 h-5 rounded-full bg-white/10 peer-checked:bg-yellow-500/70 transition-colors" />
                    <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
                  </div>
                  <div className="flex items-center gap-2 text-sm text-white/70">
                    <Zap size={13} className="text-yellow-400" />
                    <span>Aggressive Mode</span>
                  </div>
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Warnings */}
        {(unlimitedPosts || unlimitedComments) && (
          <div className="glass rounded-xl px-4 py-3 flex items-start gap-2.5 border border-orange-500/20">
            <AlertTriangle size={14} className="text-orange-400 shrink-0 mt-0.5" />
            <div className="text-xs text-orange-300/80 leading-relaxed">
              Mode unlimited aktif — proses bisa berjalan sangat lama (berjam-jam).
              Pastikan koneksi stabil. Hasil tersimpan otomatis di server.
            </div>
          </div>
        )}

        {/* Busy warning — ada proses scraping lain yang masih berjalan */}
        {busyWarning && (
          <div className="flex items-start gap-2 text-yellow-300 text-sm glass rounded-xl px-4 py-3">
            <Clock size={16} className="shrink-0 mt-0.5" /> {busyWarning}
          </div>
        )}

        {/* Errors */}
        {validationError && (
          <div className="flex items-center gap-2 text-red-400 text-sm glass rounded-xl px-4 py-3">
            <AlertCircle size={16} className="shrink-0" /> {validationError}
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm glass rounded-xl px-4 py-3">
            <XCircle size={16} className="shrink-0" /> {error}
          </div>
        )}

        {/* Submit */}
        <div className="flex items-center justify-end gap-4">
          <button
            onClick={handleStart}
            disabled={disabled}
            className="btn-ig flex items-center gap-2 px-6 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Layers size={16} />}
            {loading ? 'Memproses...' : foreignBusy ? 'Menunggu proses lain...' : 'Mulai Deep Scrape'}
          </button>
        </div>
      </div>

      {/* ── Running Progress ── */}
      {loading && (
        <div className="glass-card p-6 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="relative">
              <IGLogoFilled size={32} className="opacity-40" />
              <div className="absolute inset-0 animate-spin-slow">
                <div className="w-full h-full rounded-full border-2 border-transparent border-t-purple-500" />
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-white/80">Deep Scrape Berjalan...</p>
              <p className="text-xs text-white/40">Job ID: {_deepJobId?.slice(0, 8)}... — Proses tetap berjalan walau pindah menu</p>
            </div>
          </div>

          {progress && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="glass rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-white/80">{progress.total_posts_found ?? 0}</p>
                  <p className="text-[11px] text-white/40">Post Ditemukan</p>
                </div>
                <div className="glass rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-emerald-400">{progress.total_posts_scraped ?? 0}</p>
                  <p className="text-[11px] text-white/40">Post Selesai</p>
                </div>
                <div className="glass rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-purple-400">{(progress.total_comments ?? 0).toLocaleString('id-ID')}</p>
                  <p className="text-[11px] text-white/40">Komentar</p>
                </div>
                <div className="glass rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-pink-400">{(progress.total_likers ?? 0).toLocaleString('id-ID')}</p>
                  <p className="text-[11px] text-white/40">Likers</p>
                </div>
              </div>

              {(progress.total_posts_found ?? 0) > 0 && (
                <div>
                  <div className="flex justify-between text-xs text-white/50 mb-1">
                    <span>Progress</span>
                    <span>
                      {progress.total_posts_scraped ?? 0}/{progress.total_posts_found}
                      {' '}({Math.round(((progress.total_posts_scraped ?? 0) / (progress.total_posts_found || 1)) * 100)}%)
                    </span>
                  </div>
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${((progress.total_posts_scraped ?? 0) / (progress.total_posts_found || 1)) * 100}%`,
                        background: 'linear-gradient(90deg, #a855f7, #ec4899)',
                      }}
                    />
                  </div>
                </div>
              )}

              {(progress.errors_count ?? 0) > 0 && (
                <p className="text-xs text-red-400/70 flex items-center gap-1">
                  <XCircle size={12} /> {progress.errors_count} post gagal di-scrape
                </p>
              )}
            </div>
          )}

          {!progress && (
            <div className="text-center py-4">
              <Clock size={16} className="text-yellow-400 animate-pulse inline-block" />
              <p className="text-xs text-white/40 mt-1">Menunggu respons dari server...</p>
            </div>
          )}
        </div>
      )}

      {/* ── Result ── */}
      {result && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="glass-card p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-lg" style={{ fontFamily: 'var(--font-display)' }}>
                  @{result.username}
                </h2>
                <p className="text-xs text-white/40 mt-0.5">
                  Selesai dalam {result.elapsed_seconds}s — {result.saved_file}
                </p>
              </div>
              {result.saved_file && (
                <a
                  href={`${typeof window !== 'undefined' ? (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000') : 'http://backend:8000'}/api/output/${result.saved_file}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-glass text-xs flex items-center gap-1.5"
                >
                  <FileJson size={12} /> Download JSON
                </a>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
              <StatCard label="Post Ditemukan"  value={result.total_posts_found}   color="blue"   />
              <StatCard label="Post Selesai"    value={result.total_posts_scraped} color="purple" />
              <StatCard label="Komentar"        value={result.total_comments}      color="pink"   />
              <StatCard label="Balasan"         value={result.total_replies}       color="blue"   />
              <StatCard label="Likers"          value={result.total_likers}        color="pink"   />
            </div>
          </div>

          {/* Errors summary */}
          {result.errors.length > 0 && (
            <div className="glass-card p-5 border border-red-500/15">
              <p className="text-sm text-red-400 font-medium mb-2 flex items-center gap-2">
                <AlertCircle size={14} /> {result.errors.length} Error
              </p>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {result.errors.slice(0, 10).map((err, i) => (
                  <p key={i} className="text-xs text-white/40">
                    {err.phase && <span className="text-red-400/60">[{err.phase}] </span>}
                    {err.url && <span className="text-white/60">{err.url} — </span>}
                    {err.error}
                  </p>
                ))}
                {result.errors.length > 10 && (
                  <p className="text-xs text-white/30">...dan {result.errors.length - 10} lainnya</p>
                )}
              </div>
            </div>
          )}

          {/* Posts list */}
          {result.posts.length > 0 && (
            <div className="glass-card p-5">
              <h3 className="font-semibold text-sm uppercase tracking-widest text-white/50 mb-4">
                Detail Per Post ({result.posts.length})
              </h3>
              <div className="space-y-2">
                {result.posts.map((entry) => (
                  <PostEntryCard key={entry.index} entry={entry} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
