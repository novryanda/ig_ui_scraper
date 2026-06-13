'use client'

import { useState } from 'react'
import {
  Layers, Loader2, ChevronDown, ChevronUp, Clock, AlertCircle,
  Download, Heart, MessageCircle, Users, BadgeCheck, Trophy, Search,
} from 'lucide-react'
import { scrapeProfileDeep, getDeepScrapeProgress, getDeepScrapeResult } from '@/lib/api'
import { scrapeStore, useScrapeTask } from '@/lib/scrapeStore'
import type { DeepScrapeResult, DeepScrapePostData } from '@/types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const fmt = (n: number | undefined) => (n ?? 0).toLocaleString('id-ID')

type CommentSort = 'recent' | 'top'

function cleanUsername(raw: string): string {
  return raw.trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\/$/, '')
}

// ── Toggle kecil ──────────────────────────────────────────────────
function Toggle({ checked, onChange, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-40 ${
        checked ? 'bg-pink-500' : 'bg-white/15'
      }`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
        checked ? 'translate-x-5' : ''
      }`} />
    </button>
  )
}

function NumberField({ label, value, onChange, disabled, hint, min = 0 }: {
  label: string; value: number; onChange: (v: number) => void
  disabled?: boolean; hint?: string; min?: number
}) {
  return (
    <div>
      <label className="block text-xs text-white/50 mb-1 uppercase tracking-widest">{label}</label>
      <input
        type="number"
        min={min}
        value={value}
        disabled={disabled}
        onChange={e => onChange(Math.max(min, parseInt(e.target.value || '0', 10)))}
        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-pink-500/50 disabled:opacity-40"
      />
      {hint && <p className="text-[11px] text-white/30 mt-1">{hint}</p>}
    </div>
  )
}

// ── Detail satu post ─────────────────────────────────────────────
function PostRow({ post, index }: { post: DeepScrapeResult['posts'][number]; index: number }) {
  const [open, setOpen] = useState(index === 0)
  const d = post.data as unknown as DeepScrapePostData | null
  const comments = d?.comments ?? []
  const isTop = d?.comment_selection === 'top_by_likes'

  return (
    <div className="glass rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/4 transition-colors text-left"
      >
        <span className="text-xs text-white/30 w-6 shrink-0">#{index + 1}</span>
        {post.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.thumbnail_url} alt={post.shortcode}
            className="w-10 h-10 rounded-lg object-cover bg-white/5 shrink-0"
            onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-white/5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white/80 truncate">{post.shortcode}</p>
          <div className="flex items-center gap-3 text-[11px] text-white/40 mt-0.5">
            <span className="flex items-center gap-1"><Heart size={11} /> {fmt(post.feed_like_count)}</span>
            <span className="flex items-center gap-1"><MessageCircle size={11} /> {fmt(post.feed_comment_count)}</span>
            <span>{post.taken_at_iso?.slice(0, 10)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] shrink-0">
          {post.scraped ? (
            <>
              <span className="text-pink-300">{fmt(d?.comments_count)} kom</span>
              <span className="text-indigo-300">{fmt(d?.replies_count)} bls</span>
              <span className="text-rose-300">{fmt(d?.likers_fetched)} likers</span>
            </>
          ) : (
            <span className="text-red-400">gagal</span>
          )}
          {open ? <ChevronUp size={15} className="text-white/40" /> : <ChevronDown size={15} className="text-white/40" />}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-white/5">
          {post.error && (
            <p className="text-red-400 text-xs mt-3 flex items-center gap-1.5">
              <AlertCircle size={13} /> {post.error}
            </p>
          )}
          {isTop && (
            <p className="text-[11px] text-amber-300/80 mt-3 flex items-center gap-1.5">
              <Trophy size={12} /> {comments.length} komentar dengan like terbanyak
              {d?.comment_pool_fetched ? ` (dari ${fmt(d.comment_pool_fetched)} komentar)` : ''}
            </p>
          )}
          <div className="mt-3 space-y-3">
            {comments.length === 0 && (
              <p className="text-white/30 text-xs">Tidak ada komentar.</p>
            )}
            {comments.map((c, i) => (
              <div key={c.comment_id || i}>
                <div className="flex items-start gap-2 text-sm">
                  <span className="text-[10px] text-white/20 w-5 shrink-0 text-right mt-0.5">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white/70 font-medium text-xs">@{c.username}</span>
                      <span className="flex items-center gap-0.5 text-[11px] text-rose-300">
                        <Heart size={10} /> {fmt(c.like_count)}
                      </span>
                      {c.reply_count > 0 && (
                        <span className="text-[11px] text-white/30">{fmt(c.reply_count)} balasan</span>
                      )}
                    </div>
                    <p className="text-white/55 text-xs wrap-break-word">{c.text}</p>
                  </div>
                </div>
                {/* Balasan dari komentar top */}
                {Array.isArray(c.replies) && c.replies.length > 0 && (
                  <div className="ml-7 mt-1.5 space-y-1.5 border-l border-white/10 pl-3">
                    {c.replies.map((r, ri) => (
                      <div key={r.comment_id || ri} className="text-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-white/55 font-medium text-[11px]">↳ @{r.username}</span>
                          <span className="flex items-center gap-0.5 text-[10px] text-rose-300/80">
                            <Heart size={9} /> {fmt(r.like_count)}
                          </span>
                        </div>
                        <p className="text-white/40 text-[11px] wrap-break-word">{r.text}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Panel utama ───────────────────────────────────────────────────
export function ProfileDeepScrapePanel({ initialUsername = '', locked = false }: {
  initialUsername?: string
  locked?: boolean
}) {
  const [username, setUsername] = useState(initialUsername)
  const user = cleanUsername(username)
  const key = `profile-deep:${locked ? (initialUsername || 'locked') : 'main'}`

  const task = useScrapeTask<DeepScrapeResult>(key)
  const running = task.status === 'running'
  const result = task.status === 'success' ? task.data : null
  const taskError = task.status === 'error' ? (task.error ?? '') : ''

  // Filter (tanpa tanggal) — default efisien.
  const [maxPosts, setMaxPosts] = useState(12)
  const [allPosts, setAllPosts] = useState(false)
  const [commentSort, setCommentSort] = useState<CommentSort>('top')
  const [maxComments, setMaxComments] = useState(10)
  const [includeReplies, setIncludeReplies] = useState(true)
  const [maxReplies, setMaxReplies] = useState(10)
  const [scrapeLikers, setScrapeLikers] = useState(true)
  const [maxLikers, setMaxLikers] = useState(100)
  const [localError, setLocalError] = useState('')
  const [elapsed, setElapsed] = useState(0)

  const error = localError || taskError

  async function handleStart() {
    setLocalError('')
    if (!user) { setLocalError('Masukkan username Instagram dulu.'); return }
    if (scrapeStore.isBusy()) {
      setLocalError('Tunggu dulu — masih ada proses scraping lain berjalan.')
      return
    }

    const t0 = Date.now()
    setElapsed(0)
    const ticker = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)

    const res = await scrapeStore.run<DeepScrapeResult>(
      key, 'profile_deep', `@${user} deep scrape`,
      async () => {
        const start = await scrapeProfileDeep({
          username: user,
          max_posts: allPosts ? 0 : maxPosts,
          comment_sort: commentSort,
          max_comments: maxComments,
          include_replies: includeReplies,
          max_replies_per_comment: maxReplies,
          scrape_likers: scrapeLikers,
          max_likers: maxLikers,
          include_profile_info: true,
          delay_between_posts: 5,
        })
        if (!start.success || !start.data?.job_id) {
          throw new Error(start.message || 'Gagal memulai deep scrape')
        }
        const jobId = start.data.job_id

        for (;;) {
          await sleep(4000)
          const pr = await getDeepScrapeProgress(jobId).catch(() => null)
          const status = pr?.data?.status
          if (status === 'completed') {
            const r = await getDeepScrapeResult(jobId)
            if (!r.success || !r.data) throw new Error(r.message || 'Hasil kosong')
            return r.data
          }
          if (status === 'error') {
            throw new Error('Job gagal di server. Pastikan sudah login Instagram di Settings.')
          }
        }
      },
    )

    clearInterval(ticker)
    if (res.busy) setLocalError('Tunggu dulu — masih ada proses scraping lain berjalan.')
  }

  const prof = result?.profile

  return (
    <div className={locked ? 'glass-card p-5 border border-pink-500/15' : ''}>
      {!locked && (
        <div className="flex items-center gap-2 mb-4">
          <Layers size={20} className="text-pink-400" />
          <div>
            <h2 className="font-bold text-lg" style={{ fontFamily: 'var(--font-display)' }}>
              Scrape Profil + Postingan
            </h2>
            <p className="text-xs text-white/40">
              Satu klik: ambil info profil + komentar, balasan & likers tiap postingan
            </p>
          </div>
        </div>
      )}

      {/* Username (hanya saat tidak locked) */}
      {!locked && (
        <div className="flex gap-3 mb-4">
          <input
            type="text"
            value={username}
            disabled={running}
            onChange={e => setUsername(e.target.value)}
            placeholder="username atau URL instagram.com/username"
            className="input-glass flex-1 disabled:opacity-50"
            onKeyDown={e => e.key === 'Enter' && handleStart()}
          />
          <button
            onClick={handleStart}
            disabled={running}
            className="btn-ig flex items-center gap-2 px-6 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            {running ? 'Memproses...' : 'Scrape'}
          </button>
        </div>
      )}

      {locked && (
        <div className="flex items-center gap-2 mb-4">
          <Layers size={18} className="text-pink-400" />
          <h3 className="font-semibold text-sm">Deep Scrape @{cleanUsername(initialUsername)}</h3>
        </div>
      )}

      {/* ── Filter ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Jumlah post */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-white/50 uppercase tracking-widest">Jumlah Post</label>
            <label className="flex items-center gap-2 text-xs text-white/50">
              Semua post <Toggle checked={allPosts} onChange={setAllPosts} disabled={running} />
            </label>
          </div>
          <input type="number" min={1} value={maxPosts} disabled={running || allPosts}
            onChange={e => setMaxPosts(Math.max(1, parseInt(e.target.value || '1', 10)))}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-pink-500/50 disabled:opacity-40" />
          {allPosts && <p className="text-[11px] text-yellow-300/70 mt-1">⚠️ Semua post bisa lama untuk akun besar.</p>}
        </div>

        {/* Mode komentar */}
        <div>
          <label className="block text-xs text-white/50 mb-1 uppercase tracking-widest">Mode Komentar</label>
          <select value={commentSort} disabled={running}
            onChange={e => setCommentSort(e.target.value as CommentSort)}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-pink-500/50 disabled:opacity-40">
            <option value="top">🏆 Top — like terbanyak (+ balasannya)</option>
            <option value="recent">🕒 Terbaru — urutan Instagram</option>
          </select>
          <p className="text-[11px] text-white/30 mt-1">
            {commentSort === 'top'
              ? 'Ambil komentar dengan like terbanyak di tiap post, lengkap dengan balasannya.'
              : 'Ambil komentar sesuai urutan Instagram.'}
          </p>
        </div>

        {/* Jumlah komentar */}
        <NumberField
          label={commentSort === 'top' ? 'Top Komentar / Post' : 'Max Komentar / Post'}
          value={maxComments} onChange={setMaxComments} disabled={running} min={1}
          hint={commentSort === 'top' ? 'Cth: 10 = 10 komentar paling banyak like.' : '0 = semua komentar.'}
        />

        {/* Balasan */}
        <div className="space-y-2">
          <div className="flex items-center justify-between glass rounded-xl px-4 py-2.5">
            <span className="text-sm text-white/70">Sertakan Balasan</span>
            <Toggle checked={includeReplies} onChange={setIncludeReplies} disabled={running} />
          </div>
          {includeReplies && (
            <NumberField label="Max Balasan / Komentar" value={maxReplies} onChange={setMaxReplies} disabled={running} />
          )}
        </div>

        {/* Likers */}
        <div className="space-y-2">
          <div className="flex items-center justify-between glass rounded-xl px-4 py-2.5">
            <span className="text-sm text-white/70">Scrape Likers</span>
            <Toggle checked={scrapeLikers} onChange={setScrapeLikers} disabled={running} />
          </div>
          {scrapeLikers && (
            <NumberField label="Max Likers / Post" value={maxLikers} onChange={setMaxLikers} disabled={running} hint="0 = semua likers (lebih lama)." />
          )}
        </div>
      </div>

      {/* ── Action (tombol di bawah hanya untuk mode locked / atau ulang) ── */}
      <div className="mt-4 flex items-center gap-3 flex-wrap">
        {locked && (
          <button
            onClick={handleStart}
            disabled={running}
            className="btn-ig flex items-center gap-2 px-6 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Layers size={16} />}
            {running ? 'Memproses...' : 'Mulai Deep Scrape'}
          </button>
        )}
        {running && (
          <span className="text-xs text-white/40 flex items-center gap-1.5">
            <Clock size={13} /> {elapsed}s — jalan di background, mohon tunggu
          </span>
        )}
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 text-red-400 text-sm glass rounded-xl px-4 py-2.5">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* ── Hasil ── */}
      {result && (
        <div className="mt-5 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              {prof?.is_verified && <BadgeCheck size={16} className="text-blue-400" />}
              <span className="font-bold">@{result.username}</span>
              <span className="text-xs text-white/40">
                selesai {result.elapsed_seconds}s · mode {result.comment_sort === 'top' ? 'top by likes' : 'terbaru'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {result.saved_file && (
                <a
                  href={`${API_BASE}/api/output/${result.saved_file}`}
                  target="_blank" rel="noopener noreferrer"
                  className="btn-glass text-xs flex items-center gap-1.5"
                >
                  <Download size={13} /> JSON
                </a>
              )}
            </div>
          </div>

          {/* Stat profil */}
          {prof && (
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Followers', value: fmt(prof.followers) },
                { label: 'Following', value: fmt(prof.following) },
                { label: 'Posts', value: fmt(prof.posts_count) },
              ].map(s => (
                <div key={s.label} className="glass rounded-xl p-3 text-center">
                  <p className="text-lg font-bold ig-text">{s.value}</p>
                  <p className="text-[11px] text-white/40">{s.label}</p>
                </div>
              ))}
            </div>
          )}

          {/* Stat hasil */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: 'Post Ditemukan', value: fmt(result.total_posts_found), color: 'text-white' },
              { label: 'Post Selesai', value: fmt(result.total_posts_scraped), color: 'text-emerald-300' },
              { label: 'Komentar', value: fmt(result.total_comments), color: 'text-pink-300' },
              { label: 'Balasan', value: fmt(result.total_replies), color: 'text-indigo-300' },
              { label: 'Likers', value: fmt(result.total_likers), color: 'text-rose-300' },
            ].map(s => (
              <div key={s.label} className="glass rounded-xl p-3 text-center">
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-[11px] text-white/40">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Per-post */}
          <div>
            <p className="text-xs uppercase tracking-widest text-white/40 mb-2">
              Detail per Post ({result.posts.length})
            </p>
            <div className="space-y-2">
              {result.posts.map((p, i) => <PostRow key={p.shortcode || i} post={p} index={i} />)}
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="glass rounded-xl px-4 py-3 text-xs text-yellow-300/80">
              {result.errors.length} error saat scraping (lihat JSON untuk detail).
            </div>
          )}
        </div>
      )}
    </div>
  )
}
