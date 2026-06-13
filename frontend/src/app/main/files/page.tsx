'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  FileJson,
  Eye,
  RefreshCw,
  Search,
  X,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  CheckCircle,
  XCircle,
  Users,
  ShieldCheck,
  Lock,
  Download,
  Clock,
  MessageSquare,
  Heart,
  Layers,
  Play,
  Image as ImageIcon,
} from 'lucide-react'
import { listOutputFiles, getOutputFile } from '@/lib/api'
import type { OutputFile, FollowerItem } from '@/types'
import { SentimentChart } from '@/components/features/SentimentChart'
import { CommentList } from '@/components/features/CommentList'

// Tipe gabungan: file bisa berisi data POST, PROFILE, BATCH, atau FOLLOWER LIST
type AnyResult = Record<string, any>

// ─────────────────────────────────────────────────────────────────────────────
// Helper deteksi tipe file
// ─────────────────────────────────────────────────────────────────────────────
const isBatch = (d: AnyResult) =>
  d && Array.isArray(d.results)

const isFollowerList = (d: AnyResult) =>
  d &&
  !isBatch(d) &&
  Array.isArray(d.items) &&
  ['followers', 'following', 'following_verified'].includes(d.kind ?? '')

const isProfile = (d: AnyResult) =>
  d &&
  !isBatch(d) &&
  !isFollowerList(d) &&
  (d.followers !== undefined ||
    d.posts_count !== undefined ||
    d.method === 'web_profile_api')

const isDeepScrape = (d: AnyResult) =>
  d &&
  !isBatch(d) &&
  !isFollowerList(d) &&
  typeof d.total_posts_found === 'number' &&
  Array.isArray(d.posts) &&
  typeof d.success === 'boolean'

// ─────────────────────────────────────────────────────────────────────────────
// Sub-komponen: Top 5 komentar paling banyak like
// ─────────────────────────────────────────────────────────────────────────────
function TopComments({ topLiked }: { topLiked?: any[] }) {
  if (!Array.isArray(topLiked) || topLiked.length === 0) return null
  return (
    <div className="glass-card p-5">
      <h4 className="text-xs font-medium text-white/50 uppercase tracking-widest mb-3">
        🔥 Top Komentar (Likes)
      </h4>
      <div className="space-y-2">
        {topLiked.slice(0, 5).map((c, i) => (
          <div
            key={i}
            className="flex gap-3 items-start py-2 border-b border-white/4 last:border-0"
          >
            <span className="text-base font-bold text-white/20 w-6 shrink-0">
              #{i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white/80 mb-0.5">
                @{c.username}
              </p>
              <p className="text-sm text-white/50 line-clamp-2">{c.text}</p>
            </div>
            <p className="text-pink-400 font-bold text-sm shrink-0">
              ❤ {(c.like_count || 0).toLocaleString('id-ID')}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-komponen: Preview Follower / Following / Verified Following
// ─────────────────────────────────────────────────────────────────────────────
function FollowerListPreview({ data }: { data: AnyResult }) {
  const [search, setSearch] = useState('')
  const [onlyPublic, setOnlyPublic] = useState(false)

  const isVerified = data.kind === 'following_verified'
  const isFollowing = data.kind === 'following'

  // Dedup + filter
  const filteredItems = useMemo<FollowerItem[]>(() => {
    if (!Array.isArray(data.items)) return []

    const seen = new Set<string>()
    const deduped = data.items.filter((it: FollowerItem) => {
      const key = it.user_id || it.username
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })

    const q = search.trim().toLowerCase()
    return deduped.filter((it: FollowerItem) => {
      if (onlyPublic && it.is_private) return false
      if (!q) return true
      return (
        it.username.toLowerCase().includes(q) ||
        (it.full_name || '').toLowerCase().includes(q)
      )
    })
  }, [data.items, search, onlyPublic])

  function downloadCSV() {
    if (!data.items?.length) return
    const headers = [
      'username',
      'full_name',
      'user_id',
      'is_verified',
      'is_private',
      'profile_url',
    ]
    const rows = (data.items as FollowerItem[]).map((it) =>
      [
        it.username,
        `"${(it.full_name || '').replace(/"/g, '""')}"`,
        it.user_id,
        it.is_verified,
        it.is_private,
        `https://www.instagram.com/${it.username}/`,
      ].join(','),
    )
    const csv = [headers.join(','), ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.kind}_${data.username}_${data.scraped_date}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function downloadJSON() {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.kind}_${data.username}_${data.scraped_date}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const kindLabel = isVerified
    ? 'Verified Following'
    : isFollowing
    ? 'Following'
    : 'Followers'

  const scanRatio =
    isVerified && data.total_scanned
      ? ((data.count / data.total_scanned) * 100).toFixed(2)
      : null

  return (
    <div className="space-y-4">
      {/* Header stats */}
      <div className="glass-card p-5">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-bold">@{data.username}</h3>
              {isVerified && (
                <ShieldCheck size={18} className="text-blue-400" />
              )}
            </div>
            <p className="text-xs text-white/40">
              {kindLabel} · Di-scrape{' '}
              {new Date(data.scraped_at).toLocaleString('id-ID')}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={downloadCSV}
              disabled={!data.items?.length}
              className="btn-glass text-xs flex items-center gap-1.5 disabled:opacity-40"
            >
              <Download size={12} /> CSV
            </button>
            <button
              onClick={downloadJSON}
              disabled={!data.items?.length}
              className="btn-glass text-xs flex items-center gap-1.5 disabled:opacity-40"
            >
              <Download size={12} /> JSON
            </button>
          </div>
        </div>

        <div
          className={`grid gap-3 ${isVerified ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2'}`}
        >
          <div className="glass rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-blue-400">
              {(data.count ?? data.items?.length ?? 0).toLocaleString('id-ID')}
            </p>
            <p className="text-xs text-white/40 mt-1">
              {isVerified ? 'Verified found' : kindLabel}
            </p>
          </div>

          {isVerified && (
            <div className="glass rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-white/80">
                {(data.total_scanned || 0).toLocaleString('id-ID')}
              </p>
              <p className="text-xs text-white/40 mt-1">Total scanned</p>
            </div>
          )}

          {isVerified && scanRatio !== null && (
            <div className="glass rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-emerald-400">
                {scanRatio}%
              </p>
              <p className="text-xs text-white/40 mt-1">Verified ratio</p>
            </div>
          )}

          <div className="glass rounded-xl p-4 text-center">
            <p
              className={`text-2xl font-bold ${data.success ? 'text-emerald-400' : 'text-red-400'}`}
            >
              {data.success ? '✓' : '✗'}
            </p>
            <p className="text-xs text-white/40 mt-1">
              {data.success ? 'Success' : 'Failed'}
            </p>
          </div>
        </div>

        {data.error && (
          <div className="mt-3 flex items-center gap-2 text-red-400 text-sm glass rounded-xl px-4 py-2.5">
            <XCircle size={14} /> {data.error}
          </div>
        )}
      </div>

      {/* Filter bar */}
      {data.items?.length > 0 && (
        <div className="glass-card p-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-40">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari username / nama..."
              className="input-glass pl-9 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyPublic}
              onChange={(e) => setOnlyPublic(e.target.checked)}
              className="accent-blue-500"
            />
            Public only
          </label>
          <span className="text-xs text-white/40">
            {filteredItems.length} dari {data.items.length}
          </span>
        </div>
      )}

      {/* Grid list */}
      <div className="glass-card p-5">
        <h2 className="font-semibold mb-4 flex items-center gap-2 text-sm">
          {isVerified ? (
            <ShieldCheck size={16} className="text-blue-400" />
          ) : (
            <Users size={16} className="text-white/50" />
          )}
          {kindLabel}
          <span className="text-white/30 font-normal">
            ({filteredItems.length})
          </span>
        </h2>

        {filteredItems.length === 0 ? (
          <div className="text-center py-10 text-white/30 text-sm">
            <Users size={36} className="mx-auto mb-3 opacity-20" />
            <p>
              {data.items?.length === 0
                ? `Tidak ada ${kindLabel.toLowerCase()} ditemukan.`
                : 'Tidak ada hasil sesuai filter.'}
            </p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-2 max-h-120 overflow-y-auto pr-1">
            {filteredItems.map((item, idx) => (
              <a
                key={`${item.user_id || item.username}-${idx}`}
                href={`https://www.instagram.com/${item.username}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="glass rounded-xl p-3 flex items-center gap-3 hover:bg-white/[0.07] transition-colors group"
              >
                {/* Avatar */}
                <div className="w-10 h-10 rounded-full overflow-hidden glass shrink-0 flex items-center justify-center">
                  {item.profile_pic_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.profile_pic_url}
                      alt={item.username}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        ;(e.target as HTMLImageElement).style.display = 'none'
                      }}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <Users size={16} className="text-white/30" />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-sm truncate">
                      @{item.username}
                    </span>
                    {item.is_verified && (
                      <CheckCircle size={12} className="text-blue-400 shrink-0" />
                    )}
                    {item.is_private && (
                      <Lock size={11} className="text-yellow-400 shrink-0" />
                    )}
                  </div>
                  {item.full_name && (
                    <p className="text-xs text-white/40 truncate">
                      {item.full_name}
                    </p>
                  )}
                </div>

                <ExternalLink
                  size={13}
                  className="text-white/20 group-hover:text-white/60 transition-colors shrink-0"
                />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-komponen: Preview Deep Scrape
// ─────────────────────────────────────────────────────────────────────────────
function DeepScrapePreview({ data }: { data: AnyResult }) {
  const [openPosts, setOpenPosts] = useState<Set<number>>(new Set())

  const togglePost = (idx: number) => {
    setOpenPosts(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }

  const posts: AnyResult[] = Array.isArray(data.posts) ? data.posts : []
  const errors: AnyResult[] = Array.isArray(data.errors) ? data.errors : []
  const fmt = (n: any) => typeof n === 'number' ? n.toLocaleString('id-ID') : (n ?? '—')

  return (
    <div className="space-y-4">
      {/* Summary header */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-1">
          <Layers size={18} className="text-purple-400" />
          <h3 className="text-lg font-bold">@{data.username || '—'}</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-bold">DEEP SCRAPE</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-white/40 mt-1">
          {data.scraped_at && (
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {new Date(data.scraped_at).toLocaleString('id-ID')}
            </span>
          )}
          {typeof data.elapsed_seconds === 'number' && (
            <span>{data.elapsed_seconds}s</span>
          )}
          {data.saved_file && (
            <span className="font-mono truncate max-w-48">{data.saved_file}</span>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-4">
          {[
            { l: 'Post Ditemukan', v: fmt(data.total_posts_found), color: 'text-blue-400' },
            { l: 'Post Selesai', v: fmt(data.total_posts_scraped), color: 'text-emerald-400' },
            { l: 'Komentar', v: fmt(data.total_comments), color: 'text-purple-400' },
            { l: 'Balasan', v: fmt(data.total_replies), color: 'text-cyan-400' },
            { l: 'Likers', v: fmt(data.total_likers), color: 'text-pink-400' },
          ].map(s => (
            <div key={s.l} className="glass rounded-xl p-3 text-center">
              <p className={`text-lg font-bold ${s.color}`}>{s.v}</p>
              <p className="text-[10px] text-white/40 mt-0.5">{s.l}</p>
            </div>
          ))}
        </div>

        {data.success === false && (
          <div className="mt-3 flex items-center gap-2 text-red-400 text-sm glass rounded-xl px-4 py-2.5">
            <XCircle size={14} /> Scrape gagal
          </div>
        )}
      </div>

      {/* Errors */}
      {errors.length > 0 && (
        <div className="glass-card p-4 border border-red-500/15">
          <p className="text-xs font-medium text-red-400 mb-2 flex items-center gap-1.5">
            <XCircle size={12} /> {errors.length} Error
          </p>
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {errors.map((err: AnyResult, i: number) => (
              <p key={i} className="text-[11px] text-white/40">
                {err.phase && <span className="text-red-400/60">[{err.phase}] </span>}
                {err.url && <span className="text-white/60">{err.url} — </span>}
                {err.error}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Per-post list */}
      {posts.length > 0 && (
        <div className="glass-card p-5">
          <h4 className="text-xs font-medium text-white/50 uppercase tracking-widest mb-3 flex items-center gap-2">
            <MessageSquare size={12} /> Detail Per Post ({posts.length})
          </h4>
          <div className="space-y-2">
            {posts.map((post: AnyResult, idx: number) => {
              const isOpen = openPosts.has(idx)
              const postComments: any[] = Array.isArray(post.data?.comments) ? post.data.comments : []
              const postLikers: any[] = Array.isArray(post.data?.likers) ? post.data.likers : []
              const commentsCount = post.data?.comments_count ?? 0
              const repliesCount = post.data?.replies_count ?? 0
              const likersFetched = post.data?.likers_fetched ?? 0

              return (
                <div key={idx} className="glass rounded-xl overflow-hidden">
                  <button
                    onClick={() => togglePost(idx)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 transition-colors text-left"
                  >
                    <span className="text-xs font-bold text-white/20 w-6 shrink-0">#{post.index ?? idx + 1}</span>
                    {/* Thumbnail */}
                    <div className="w-10 h-10 rounded-lg overflow-hidden bg-white/5 shrink-0 relative">
                      {post.thumbnail_url ? (
                        <img src={post.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <ImageIcon size={12} className="text-white/20" />
                        </div>
                      )}
                      {post.media_type === 'VIDEO' && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                          <Play size={10} className="text-white/80" fill="white" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {post.scraped
                          ? <CheckCircle size={12} className="text-emerald-400 shrink-0" />
                          : <XCircle size={12} className="text-red-400 shrink-0" />
                        }
                        <span className="text-xs font-medium text-white/80 truncate">
                          {post.shortcode || post.url}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-white/40 mt-0.5">
                        <span className="flex items-center gap-0.5"><Heart size={9} className="text-pink-400" />{fmt(post.feed_like_count)}</span>
                        <span className="flex items-center gap-0.5"><MessageSquare size={9} className="text-purple-400" />{fmt(post.feed_comment_count)}</span>
                        <span>{post.media_type}</span>
                        {post.taken_at_iso && <span>{post.taken_at_iso.slice(0, 10)}</span>}
                      </div>
                    </div>
                    {post.scraped && (
                      <div className="flex items-center gap-2 text-[10px] shrink-0">
                        <span className="text-emerald-400">{commentsCount} kom</span>
                        {repliesCount > 0 && <span className="text-blue-400">{repliesCount} bls</span>}
                        {likersFetched > 0 && <span className="text-pink-400">{likersFetched} likers</span>}
                      </div>
                    )}
                    {isOpen ? <ChevronUp size={12} className="text-white/40" /> : <ChevronDown size={12} className="text-white/40" />}
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-3 pt-1 border-t border-white/5 space-y-3">
                      {post.feed_caption && (
                        <p className="text-xs text-white/40 line-clamp-3 border-l-2 border-white/10 pl-3">{post.feed_caption}</p>
                      )}
                      {post.url && (
                        <a href={post.url} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-pink-300 hover:text-pink-200">
                          <ExternalLink size={10} /> Buka Post
                        </a>
                      )}
                      {post.error && <p className="text-xs text-red-400/80">{post.error}</p>}

                      {/* Comments */}
                      {postComments.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-white/50 mb-2 flex items-center gap-1.5">
                            <MessageSquare size={11} className="text-purple-400" /> Komentar ({postComments.length})
                          </p>
                          <CommentList comments={postComments} maxHeight="360px" />
                        </div>
                      )}

                      {/* Likers */}
                      {postLikers.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-white/50 mb-2 flex items-center gap-1.5">
                            <Heart size={11} className="text-pink-400" /> Likers ({postLikers.length})
                          </p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 max-h-32 overflow-y-auto">
                            {postLikers.map((l: AnyResult, i: number) => (
                              <div key={l.user_id || i} className="flex items-center gap-1.5 text-[10px] py-0.5">
                                <span className="text-white/60 truncate">@{l.username}</span>
                                {l.is_verified && <ShieldCheck size={9} className="text-blue-400 shrink-0" />}
                                {l.is_private && <Lock size={8} className="text-white/20 shrink-0" />}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────
export default function FilesPage() {
  const [files, setFiles] = useState<OutputFile[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<AnyResult | null>(null)
  const [selectedName, setSelectedName] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [showComments, setShowComments] = useState(false)
  const [openBatchComment, setOpenBatchComment] = useState<number | null>(null)

  const load = () => {
    setLoading(true)
    listOutputFiles()
      .then((r) => {
        if (r.success) setFiles(r.data.files)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  const filtered = files.filter((f) =>
    f.name.toLowerCase().includes(search.toLowerCase()),
  )

  async function preview(filename: string) {
    setPreviewLoading(true)
    setSelected(null)
    setSelectedName(filename)
    setShowComments(false)
    setOpenBatchComment(null)
    try {
      const data = await getOutputFile(filename)

      // Normalisasi wrapper:
      // - File followers/following/verified: data langsung ATAU dibungkus {followers:{...}} / {following:{...}} / {following_verified:{...}}
      // - File profile: data langsung ATAU dibungkus {profile:{...}}
      // - File batch: punya results[]
      let normalized: AnyResult = data

      if (data && !Array.isArray(data.results)) {
        // Cek apakah ada wrapper following_verified / followers / following
        if (data.following_verified && typeof data.following_verified === 'object') {
          normalized = { ...data.following_verified, ...data, ...data.following_verified }
        } else if (data.followers && typeof data.followers === 'object' && data.followers.kind) {
          normalized = { ...data.followers }
        } else if (data.following && typeof data.following === 'object' && data.following.kind) {
          normalized = { ...data.following }
        } else if (data.profile && typeof data.profile === 'object' && !data.kind) {
          // profile wrapper
          normalized = { ...data.profile, ...data }
        }
      }

      setSelected(normalized)
    } catch {
      /* skip */
    } finally {
      setPreviewLoading(false)
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const displayUsername = (d: AnyResult) =>
    d?.username || d?.owner_username || d?.profile?.username || '—'

  const fmtNum = (n: any) =>
    typeof n === 'number' ? n.toLocaleString('id-ID') : (n ?? '—')

  // Icon warna per jenis file
  const fileIconColor = (name: string) => {
    if (name.includes('batch')) return 'text-purple-400'
    if (name.includes('deep')) return 'text-purple-400'
    if (name.includes('following_verified') || name.includes('api_following_verified'))
      return 'text-blue-400'
    if (name.includes('followers')) return 'text-emerald-400'
    if (name.includes('following')) return 'text-cyan-400'
    if (name.includes('profile')) return 'text-blue-400'
    if (name.includes('post')) return 'text-pink-400'
    return 'text-white/40'
  }

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1
            className="text-2xl font-bold"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Output Files
          </h1>
          <p className="text-sm text-white/40 mt-0.5">
            Semua hasil scraping tersimpan di sini
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="btn-glass flex items-center gap-2 text-sm"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── File List ── */}
        <div>
          <div className="relative mb-4">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari file..."
              className="input-glass pl-9 text-sm"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2"
              >
                <X size={14} className="text-white/30" />
              </button>
            )}
          </div>

          <div className="glass-card p-4">
            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="skeleton h-12 rounded-lg" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-12 text-white/30 text-sm">
                <FileJson size={40} className="mx-auto mb-3 opacity-20" />
                {files.length === 0
                  ? 'Belum ada file output.'
                  : 'Tidak ada file yang cocok.'}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-150 overflow-y-auto pr-1">
                {filtered.map((f) => (
                  <button
                    key={f.name}
                    onClick={() => preview(f.name)}
                    className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                      selectedName === f.name
                        ? 'bg-white/10 border border-white/15'
                        : 'hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <FileJson
                      size={16}
                      className={fileIconColor(f.name)}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-white/80 truncate">
                        {f.name}
                      </p>
                      <p className="text-[10px] text-white/30 mt-0.5">
                        {formatSize(f.size)} ·{' '}
                        {new Date(f.modified).toLocaleString('id-ID')}
                      </p>
                    </div>
                    <Eye size={13} className="text-white/20 shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Preview Panel ── */}
        <div>
          {previewLoading && (
            <div className="glass-card p-12 text-center">
              <div className="animate-pulse text-white/30 text-sm">
                Memuat file...
              </div>
            </div>
          )}

          {/* ══ PREVIEW: FOLLOWER LIST (followers / following / following_verified) ══ */}
          {selected && !previewLoading && isFollowerList(selected) && (
            <FollowerListPreview data={selected} />
          )}

          {/* ══ PREVIEW: BATCH ══ */}
          {selected && !previewLoading && isBatch(selected) && (
            <div className="space-y-4">
              <div className="glass-card p-5 flex items-center gap-6">
                <div>
                  <p className="text-2xl font-bold ig-text">
                    {selected.success ?? 0}/
                    {selected.total ?? selected.results.length}
                  </p>
                  <p className="text-xs text-white/40">post berhasil</p>
                </div>
                <div className="flex items-center gap-2 text-sm text-emerald-400">
                  <CheckCircle size={16} /> {selected.success ?? 0} sukses
                </div>
                {(selected.failed ?? 0) > 0 && (
                  <div className="flex items-center gap-2 text-sm text-red-400">
                    <XCircle size={16} /> {selected.failed} gagal
                  </div>
                )}
              </div>

              {selected.results.map((item: AnyResult, idx: number) => {
                const d = item.data
                const ss = d?.sentiment_summary
                const isOpen = openBatchComment === idx

                if (!item.success || !d) {
                  return (
                    <div
                      key={idx}
                      className="glass-card p-4 border border-red-500/20"
                    >
                      <div className="flex items-center gap-2 text-red-400 text-sm">
                        <XCircle size={15} className="shrink-0" /> Gagal
                      </div>
                      <p className="text-xs text-white/40 mt-1 break-all">
                        {item.url}
                      </p>
                      {item.error && (
                        <p className="text-xs text-red-400/70 mt-1">
                          {item.error}
                        </p>
                      )}
                    </div>
                  )
                }

                return (
                  <div key={idx} className="glass-card p-5 space-y-3">
                    <div className="flex items-start gap-3">
                      {/* Thumbnail */}
                      <div className="w-14 h-14 rounded-lg overflow-hidden bg-white/5 shrink-0 relative">
                        {d.thumbnail_url ? (
                          <img src={d.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <ImageIcon size={14} className="text-white/20" />
                          </div>
                        )}
                        {d.media_type === 'VIDEO' && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                            <Play size={12} className="text-white/80" fill="white" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-semibold">
                              @{d.owner_username || 'unknown'}
                            </h3>
                            <p className="text-xs text-white/40 mt-0.5">
                              {d.media_type} · {d.product_type || 'feed'} ·{' '}
                              {d.method || '—'}
                            </p>
                          </div>
                          {d.url && (
                            <a
                              href={d.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="btn-glass text-xs flex items-center gap-1.5 shrink-0"
                            >
                              <ExternalLink size={12} /> Buka
                            </a>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { l: 'Likes', v: fmtNum(d.likes) },
                        { l: 'Komentar', v: fmtNum(d.comments_count) },
                        { l: 'Media', v: d.media_type || '—' },
                      ].map((s) => (
                        <div
                          key={s.l}
                          className="glass rounded-xl p-3 text-center"
                        >
                          <p className="text-base font-bold ig-text">{s.v}</p>
                          <p className="text-[11px] text-white/40">{s.l}</p>
                        </div>
                      ))}
                    </div>

                    {ss && ss.total_comments > 0 && (
                      <SentimentChart summary={ss} />
                    )}

                    {ss?.top_liked?.length > 0 && (
                      <div>
                        <h4 className="text-xs font-medium text-white/50 uppercase tracking-widest mb-2">
                          🔥 Top Komentar (Likes)
                        </h4>
                        <div className="space-y-2">
                          {ss.top_liked
                            .slice(0, 5)
                            .map((c: any, i: number) => (
                              <div
                                key={i}
                                className="flex gap-3 items-start py-1.5 border-b border-white/4 last:border-0"
                              >
                                <span className="text-sm font-bold text-white/20 w-5 shrink-0">
                                  #{i + 1}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-medium text-white/80">
                                    @{c.username}
                                  </p>
                                  <p className="text-xs text-white/50 line-clamp-2">
                                    {c.text}
                                  </p>
                                </div>
                                <p className="text-pink-400 font-bold text-xs shrink-0">
                                  ❤ {(c.like_count || 0).toLocaleString('id-ID')}
                                </p>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}

                    {Array.isArray(d.comments) && d.comments.length > 0 && (
                      <div>
                        <button
                          onClick={() =>
                            setOpenBatchComment(isOpen ? null : idx)
                          }
                          className="w-full flex items-center justify-between text-sm font-medium"
                        >
                          <span>
                            💬 Semua Komentar ({d.comments_count})
                          </span>
                          {isOpen ? (
                            <ChevronUp size={16} />
                          ) : (
                            <ChevronDown size={16} />
                          )}
                        </button>
                        {isOpen && (
                          <div className="mt-3">
                            <CommentList comments={d.comments} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ══ PREVIEW: PROFILE ══ */}
          {selected &&
            !previewLoading &&
            !isBatch(selected) &&
            !isFollowerList(selected) &&
            isProfile(selected) && (
              <div className="space-y-4">
                <div className="glass-card p-5">
                  <div className="flex items-start gap-4 mb-4">
                    <div className="w-16 h-16 rounded-full overflow-hidden glass flex items-center justify-center shrink-0">
                      {selected.profile_pic_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={selected.profile_pic_url}
                          alt={selected.username}
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            ;(e.target as HTMLImageElement).style.display =
                              'none'
                          }}
                        />
                      ) : (
                        <Users size={24} className="text-white/30" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-lg truncate">
                          @{displayUsername(selected)}
                        </h3>
                        {selected.is_verified && (
                          <CheckCircle
                            size={16}
                            className="text-blue-400 shrink-0"
                          />
                        )}
                      </div>
                      <p className="text-sm text-white/50 truncate">
                        {selected.full_name || '—'}
                      </p>
                      {selected.category && (
                        <p className="text-xs text-white/30 mt-0.5">
                          {selected.category}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { l: 'Followers', v: fmtNum(selected.followers) },
                      { l: 'Following', v: fmtNum(selected.following) },
                      { l: 'Posts', v: fmtNum(selected.posts_count) },
                    ].map((s) => (
                      <div
                        key={s.l}
                        className="glass rounded-xl p-3 text-center"
                      >
                        <p className="text-lg font-bold ig-text">{s.v}</p>
                        <p className="text-[11px] text-white/40">{s.l}</p>
                      </div>
                    ))}
                  </div>

                  {selected.scraped_at && (
                    <p className="text-[11px] text-white/30 mt-3">
                      Scraped:{' '}
                      {new Date(selected.scraped_at).toLocaleString('id-ID')} ·
                      Method: {selected.method || '—'}
                    </p>
                  )}
                </div>

                {selected.engagement_summary && (
                  <div className="glass-card p-5">
                    <h4 className="text-xs font-medium text-white/50 uppercase tracking-widest mb-3">
                      Engagement
                    </h4>
                    {selected.engagement_summary.posts_analyzed > 0 ? (
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div className="glass rounded-xl p-3">
                          <p className="text-white/40 text-xs">
                            Engagement Rate
                          </p>
                          <p className="font-bold text-emerald-400">
                            {selected.engagement_summary.engagement_rate}%
                          </p>
                        </div>
                        <div className="glass rounded-xl p-3">
                          <p className="text-white/40 text-xs">
                            Post dianalisis
                          </p>
                          <p className="font-bold">
                            {selected.engagement_summary.posts_analyzed}
                          </p>
                        </div>
                        <div className="glass rounded-xl p-3">
                          <p className="text-white/40 text-xs">Rata-rata Likes</p>
                          <p className="font-bold">
                            {fmtNum(selected.engagement_summary.avg_likes)}
                          </p>
                        </div>
                        <div className="glass rounded-xl p-3">
                          <p className="text-white/40 text-xs">
                            Rata-rata Komentar
                          </p>
                          <p className="font-bold">
                            {fmtNum(selected.engagement_summary.avg_comments)}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-white/40">
                        Belum ada post yang dianalisis (recent_posts kosong).
                      </p>
                    )}
                  </div>
                )}

                {/* Recent Posts Grid */}
                {Array.isArray(selected.recent_posts) && selected.recent_posts.length > 0 && (
                  <div className="glass-card p-5">
                    <h4 className="text-xs font-medium text-white/50 uppercase tracking-widest mb-3 flex items-center gap-2">
                      <ImageIcon size={12} className="text-white/40" />
                      Recent Posts ({selected.recent_posts.length})
                    </h4>
                    <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                      {selected.recent_posts.slice(0, 12).map((post: any, i: number) => (
                        <div key={post.shortcode || i} className="relative aspect-square rounded-lg overflow-hidden bg-white/5">
                          {post.thumbnail_url ? (
                            <img src={post.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy"
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <ImageIcon size={12} className="text-white/15" />
                            </div>
                          )}
                          {(post.is_video || post.media_type === 'VIDEO') && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
                              <Play size={12} className="text-white/80" fill="white" />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

          {/* ══ PREVIEW: DEEP SCRAPE ══ */}
          {selected && !previewLoading && isDeepScrape(selected) && (
            <DeepScrapePreview data={selected} />
          )}

          {/* ══ PREVIEW: POST ══ */}
          {selected &&
            !previewLoading &&
            !isBatch(selected) &&
            !isFollowerList(selected) &&
            !isProfile(selected) &&
            !isDeepScrape(selected) && (
              <div className="space-y-4">
                <div className="glass-card p-5">
                  <div className="flex items-start gap-4 mb-3">
                    {/* Thumbnail */}
                    <div className="w-16 h-16 rounded-xl overflow-hidden bg-white/5 shrink-0 relative">
                      {selected.thumbnail_url ? (
                        <img src={selected.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <ImageIcon size={16} className="text-white/20" />
                        </div>
                      )}
                      {selected.media_type === 'VIDEO' && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                          <Play size={14} className="text-white/80" fill="white" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="font-semibold">
                            @{displayUsername(selected)}
                          </h3>
                          <p className="text-xs text-white/40 mt-0.5 font-mono">
                            {selected.shortcode || '—'}
                          </p>
                        </div>
                        {selected.url && (
                          <a
                            href={selected.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-glass text-xs flex items-center gap-1.5"
                          >
                            <ExternalLink size={12} /> Buka
                          </a>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3 mb-3">
                    {[
                      { l: 'Likes', v: fmtNum(selected.likes) },
                      { l: 'Komentar', v: fmtNum(selected.comments_count) },
                      { l: 'Media', v: selected.media_type || '—' },
                    ].map((s) => (
                      <div
                        key={s.l}
                        className="glass rounded-xl p-3 text-center"
                      >
                        <p className="text-lg font-bold ig-text">{s.v}</p>
                        <p className="text-[11px] text-white/40">{s.l}</p>
                      </div>
                    ))}
                  </div>

                  {selected.scraped_at && (
                    <p className="text-[11px] text-white/30">
                      Scraped:{' '}
                      {new Date(selected.scraped_at).toLocaleString('id-ID')} ·
                      Mode: {selected.sentiment_mode || '—'}
                    </p>
                  )}
                </div>

                {selected.sentiment_summary && (
                  <div className="glass-card p-5">
                    <h4 className="text-xs font-medium text-white/50 uppercase tracking-widest mb-3">
                      Sentimen
                    </h4>
                    <SentimentChart summary={selected.sentiment_summary} />
                  </div>
                )}

                <TopComments
                  topLiked={selected.sentiment_summary?.top_liked}
                />

                {Array.isArray(selected.comments) &&
                  selected.comments.length > 0 && (
                    <div className="glass-card p-5">
                      <button
                        onClick={() => setShowComments((v) => !v)}
                        className="w-full flex items-center justify-between text-sm font-medium"
                      >
                        <span>
                          💬 Semua Komentar ({selected.comments.length})
                        </span>
                        {showComments ? (
                          <ChevronUp size={16} />
                        ) : (
                          <ChevronDown size={16} />
                        )}
                      </button>
                      {showComments && (
                        <div className="mt-4">
                          <CommentList comments={selected.comments} />
                        </div>
                      )}
                    </div>
                  )}
              </div>
            )}

          {/* ══ Empty state ══ */}
          {!selected && !previewLoading && (
            <div className="glass-card p-12 text-center text-white/20">
              <FileJson size={48} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Pilih file untuk preview</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}