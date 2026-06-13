'use client'

import { useState, useMemo, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, Hash, Loader2, Heart, MessageCircle, Eye,
  ExternalLink, Download, AlertCircle, BadgeCheck, Settings2,
  ChevronDown, ChevronUp, Sparkles, Film, Layers,
  X, Clock, Zap, LayoutGrid, List,
  Image as ImageIcon, Filter, TrendingUp,
  CheckCircle2, Pause, Trash2, RefreshCw,
  Database, Globe,
} from 'lucide-react'
import {
  searchHashtag,
  searchKeyword,
  downloadSearchPostsInline,
} from '@/lib/api'
import type {
  SearchPostItem,
  HashtagSearchResult,
  KeywordSearchResult,
  HashtagSuggestion,
  UserSuggestion,
} from '@/types'
import { scrapeStore, useScrapeTask, useScrapeBusy } from '@/lib/scrapeStore'

// ── Constants ────────────────────────────────────────────────────
const SCRAPE_ROUTE = '/main/scrapes'
const LIKERS_ROUTE = '/main/likers'
// Keyword & hashtag = 2 fitur terpisah, masing-masing punya output yang
// dipersist sendiri lintas-navigasi.
const SEARCH_KEY_HASHTAG = 'search:hashtag'
const SEARCH_KEY_KEYWORD = 'search:keyword'

type SearchTaskData = HashtagSearchResult | KeywordSearchResult

type SearchMode = 'keyword' | 'hashtag'
type SortBy     = 'top' | 'likes' | 'comments' | 'recent'
type ViewMode   = 'grid' | 'list'

// Mode terakhir (keyword/hashtag) disimpan di module agar bertahan saat
// pindah halaman lalu kembali.
let lastSearchMode: SearchMode = 'hashtag'

// ── Helpers ──────────────────────────────────────────────────────
function formatNum(n?: number): string {
  const x = n ?? 0
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (x >= 1_000)     return (x / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(x)
}

function timeAgo(ts?: number): string {
  if (!ts) return ''
  const diff = Math.floor((Date.now() / 1000) - ts)
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function mediaIcon(type?: string) {
  if (type === 'VIDEO')    return <Film      className="w-3 h-3" />
  if (type === 'CAROUSEL') return <Layers    className="w-3 h-3" />
  return                          <ImageIcon className="w-3 h-3" />
}

// ─────────────────────────────────────────────────────────────────
// Reusable sub-components
// ─────────────────────────────────────────────────────────────────

function Toggle({
  checked, onChange, label, disabled,
}: {
  checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean
}) {
  return (
    <label className={`flex items-center gap-2.5 cursor-pointer select-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
      <div className="relative shrink-0">
        <input type="checkbox" checked={checked} disabled={disabled}
          onChange={e => onChange(e.target.checked)} className="sr-only peer" />
        <div className="w-10 h-5 rounded-full bg-white/10 peer-checked:bg-pink-500/70 transition-colors" />
        <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
      </div>
      <span className="text-sm text-white/70">{label}</span>
    </label>
  )
}

function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const cls = size === 'sm' ? 'w-4 h-4' : size === 'lg' ? 'w-8 h-8' : 'w-5 h-5'
  return <Loader2 className={`${cls} animate-spin text-pink-400`} />
}

function NumberInput({
  label, value, onChange, min, max,
}: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-white/50 font-medium tracking-wide uppercase">{label}</label>
      <input
        type="number" value={value} min={min} max={max}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white
                   focus:outline-none focus:border-pink-500/50 focus:bg-white/8 transition-all
                   [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none
                   [&::-webkit-inner-spin-button]:appearance-none"
      />
    </div>
  )
}

function HashtagBadge({
  tag, count, active, onClick,
}: {
  tag: string; count?: number; active?: boolean; onClick?: () => void
}) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                  transition-all border
                  ${active
                    ? 'bg-pink-500/20 border-pink-500/50 text-pink-300'
                    : 'bg-white/5 border-white/10 text-white/60 hover:border-pink-500/30 hover:text-white/80'
                  }`}
    >
      <Hash className="w-3 h-3" />
      <span>{tag}</span>
      {count != null && <span className="text-white/40 text-[10px]">{formatNum(count)}</span>}
    </button>
  )
}

// ── PostCard (grid) ───────────────────────────────────────────────
function PostCard({ post, onScrape, onLikers }: {
  post: SearchPostItem; onScrape: (url: string) => void; onLikers: (url: string) => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="group relative rounded-xl overflow-hidden border border-white/8 bg-white/3
                 hover:border-pink-500/30 transition-all duration-300 hover:shadow-lg
                 hover:shadow-pink-500/10 hover:-translate-y-0.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="relative aspect-square bg-white/5 overflow-hidden">
        {post.thumbnail_url ? (
          <img src={post.thumbnail_url} alt={post.owner_username}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-white/20" />
          </div>
        )}
        <div className={`absolute inset-0 bg-black/60 flex flex-col items-center justify-center
                         gap-2 transition-opacity duration-200 ${hovered ? 'opacity-100' : 'opacity-0'}`}>
          <a href={post.url} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 rounded-lg text-xs
                       text-white hover:bg-white/20 transition-colors"
            onClick={e => e.stopPropagation()}>
            <ExternalLink className="w-3 h-3" /> Buka Post
          </a>
          <button onClick={() => onScrape(post.url)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-pink-500/20 border border-pink-500/30
                       rounded-lg text-xs text-pink-300 hover:bg-pink-500/30 transition-colors">
            <MessageCircle className="w-3 h-3" /> Scrape Komentar
          </button>
          <button onClick={() => onLikers(post.url)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-500/20 border border-purple-500/30
                       rounded-lg text-xs text-purple-300 hover:bg-purple-500/30 transition-colors">
            <Heart className="w-3 h-3" /> Scrape Likers
          </button>
        </div>
        <div className="absolute top-2 left-2 flex gap-1">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/50 text-[10px] text-white/60">
            {mediaIcon(post.media_type)}
          </span>
          {post.source === 'top' && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-yellow-500/20
                             text-[10px] text-yellow-300 border border-yellow-500/20">
              <Zap className="w-2.5 h-2.5" /> Top
            </span>
          )}
        </div>
        <div className="absolute top-2 right-2">
          <span className="w-5 h-5 flex items-center justify-center rounded-full bg-black/50
                           text-[10px] font-bold text-white/50">{post.rank}</span>
        </div>
        {post.hashtag && (
          <div className="absolute bottom-2 left-2">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-pink-500/20
                             border border-pink-500/20 text-[10px] text-pink-300">
              <Hash className="w-2.5 h-2.5" />{post.hashtag}
            </span>
          </div>
        )}
      </div>
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-white/80 truncate">@{post.owner_username}</span>
          {post.owner_is_verified && <BadgeCheck className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
        </div>
        {post.caption && (
          <p className="text-[11px] text-white/40 leading-relaxed line-clamp-2">{post.caption}</p>
        )}
        <div className="flex items-center justify-between pt-0.5">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-[11px] text-pink-400/80">
              <Heart className="w-3 h-3" /> {formatNum(post.like_count)}
            </span>
            <span className="flex items-center gap-1 text-[11px] text-white/40">
              <MessageCircle className="w-3 h-3" /> {formatNum(post.comment_count)}
            </span>
            {(post.view_count ?? 0) > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-white/40">
                <Eye className="w-3 h-3" /> {formatNum(post.view_count)}
              </span>
            )}
          </div>
          {post.taken_at > 0 && (
            <span className="text-[10px] text-white/25">{timeAgo(post.taken_at)}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── PostRow (list) ────────────────────────────────────────────────
function PostRow({ post, onScrape, onLikers }: {
  post: SearchPostItem; onScrape: (url: string) => void; onLikers: (url: string) => void
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 rounded-xl border border-white/8 bg-white/3
                    hover:border-pink-500/20 hover:bg-white/5 transition-all group">
      <span className="w-6 text-center text-xs font-bold text-white/30 shrink-0">{post.rank}</span>
      <div className="w-12 h-12 rounded-lg overflow-hidden bg-white/5 shrink-0">
        {post.thumbnail_url
          ? <img src={post.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy" />
          : <div className="w-full h-full flex items-center justify-center">
              <ImageIcon className="w-4 h-4 text-white/20" />
            </div>
        }
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-sm font-semibold text-white/80 truncate">@{post.owner_username}</span>
          {post.owner_is_verified && <BadgeCheck className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
          <span className="shrink-0">{mediaIcon(post.media_type)}</span>
          {post.source === 'top' && (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-yellow-500/15
                             text-[10px] text-yellow-300 border border-yellow-500/15">
              <Zap className="w-2.5 h-2.5" />Top
            </span>
          )}
          {post.hashtag && (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-pink-500/15
                             text-[10px] text-pink-300">#{post.hashtag}</span>
          )}
        </div>
        <p className="text-xs text-white/35 truncate">{post.caption || '(tanpa caption)'}</p>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <span className="flex items-center gap-1 text-xs text-pink-400/70">
          <Heart className="w-3.5 h-3.5" />{formatNum(post.like_count)}
        </span>
        <span className="flex items-center gap-1 text-xs text-white/40">
          <MessageCircle className="w-3.5 h-3.5" />{formatNum(post.comment_count)}
        </span>
        {(post.view_count ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-xs text-white/30">
            <Eye className="w-3.5 h-3.5" />{formatNum(post.view_count)}
          </span>
        )}
        {post.taken_at > 0 && (
          <span className="text-xs text-white/25 w-16 text-right">{timeAgo(post.taken_at)}</span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <a href={post.url} target="_blank" rel="noopener noreferrer"
          className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/50 hover:text-white transition-colors"
          title="Buka di Instagram"><ExternalLink className="w-3.5 h-3.5" /></a>
        <button onClick={() => onScrape(post.url)}
          className="p-1.5 rounded-lg bg-pink-500/10 hover:bg-pink-500/20 text-pink-400 transition-colors"
          title="Scrape komentar"><MessageCircle className="w-3.5 h-3.5" /></button>
        <button onClick={() => onLikers(post.url)}
          className="p-1.5 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 transition-colors"
          title="Scrape likers"><Heart className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  )
}

function RelatedHashtagsPanel({ tags, onSelect }: {
  tags: HashtagSuggestion[]; onSelect: (name: string) => void
}) {
  if (!tags.length) return null
  return (
    <div className="rounded-xl border border-white/8 bg-white/3 p-4">
      <p className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-3">Hashtag Terkait</p>
      <div className="flex flex-wrap gap-2">
        {tags.slice(0, 15).map(t => (
          <HashtagBadge key={t.id || t.name} tag={t.name} count={t.media_count} onClick={() => onSelect(t.name)} />
        ))}
      </div>
    </div>
  )
}

function SuggestedUsersPanel({ users }: { users: UserSuggestion[] }) {
  if (!users.length) return null
  return (
    <div className="rounded-xl border border-white/8 bg-white/3 p-4">
      <p className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-3">Akun Relevan</p>
      <div className="flex flex-col gap-2">
        {users.slice(0, 6).map(u => (
          <a key={u.username} href={`https://www.instagram.com/${u.username}/`}
            target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-full bg-white/10 overflow-hidden shrink-0">
              {u.profile_pic_url
                ? <img src={u.profile_pic_url} alt={u.username} className="w-full h-full object-cover" />
                : <div className="w-full h-full flex items-center justify-center text-white/30 text-xs">
                    {u.username[0]?.toUpperCase()}
                  </div>
              }
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                <span className="text-xs font-medium text-white/70 group-hover:text-white/90 transition-colors truncate">
                  @{u.username}
                </span>
                {u.is_verified && <BadgeCheck className="w-3 h-3 text-blue-400 shrink-0" />}
              </div>
              {u.follower_count > 0 && (
                <span className="text-[10px] text-white/30">{formatNum(u.follower_count)} followers</span>
              )}
            </div>
            <ExternalLink className="w-3.5 h-3.5 text-white/20 group-hover:text-white/50 transition-colors" />
          </a>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Main Page (only Quick Search)
// ─────────────────────────────────────────────────────────────────
export default function SearchPage() {
  const router = useRouter()

  // Quick Search states
  const [mode, setModeState] = useState<SearchMode>(() => lastSearchMode)
  const setMode = useCallback((m: SearchMode) => { lastSearchMode = m; setModeState(m) }, [])
  const [query, setQuery] = useState('')

  // Hashtag options
  const [maxPosts,      setMaxPosts]      = useState(60)
  const [includeTop,    setIncludeTop]    = useState(true)
  const [includeRecent, setIncludeRecent] = useState(true)
  const [recentPages,   setRecentPages]   = useState(5)

  // Keyword options
  const [maxHashtags,     setMaxHashtags]     = useState(3)
  const [perHashtagPages, setPerHashtagPages] = useState(1)
  const [kwMaxPosts,      setKwMaxPosts]      = useState(60)
  const [kwIncludeRecent, setKwIncludeRecent] = useState(true)

  const [showAdvanced, setShowAdvanced] = useState(false)

  // Tiap mode punya key sendiri → hasil hashtag & keyword persist terpisah.
  const searchKey  = mode === 'hashtag' ? SEARCH_KEY_HASHTAG : SEARCH_KEY_KEYWORD
  const task       = useScrapeTask<SearchTaskData>(searchKey)
  const globalBusy = useScrapeBusy()
  const loading    = task.status === 'running'
  const result     = task.status === 'success' ? task.data : null
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const error = downloadError ?? (task.status === 'error' ? task.error : null)

  // Search ikut global lock: tidak bisa jalan saat ada scraping lain berjalan.
  const disabled    = loading || globalBusy
  const foreignBusy = globalBusy && !loading

  function clearResult() {
    scrapeStore.resetTask(searchKey)
    setDownloadError(null)
  }

  // UI
  const [sortBy,       setSortBy]       = useState<SortBy>('top')
  const [viewMode,     setViewMode]     = useState<ViewMode>('grid')
  const [filterSource, setFilterSource] = useState<'all' | 'top' | 'recent'>('all')
  const [filterType,   setFilterType]   = useState<'all' | 'PHOTO' | 'VIDEO' | 'CAROUSEL'>('all')
  const [downloading,  setDownloading]  = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

  // ── Quick Search sorted posts ────────────────────────────────
  const sortedPosts = useMemo<SearchPostItem[]>(() => {
    if (!result?.posts) return []
    let posts = [...result.posts]
    if (filterSource !== 'all') posts = posts.filter(p => p.source === filterSource)
    if (filterType   !== 'all') posts = posts.filter(p => p.media_type === filterType)
    if (sortBy === 'likes')    posts.sort((a, b) => (b.like_count ?? 0) - (a.like_count ?? 0))
    else if (sortBy === 'comments') posts.sort((a, b) => (b.comment_count ?? 0) - (a.comment_count ?? 0))
    else if (sortBy === 'recent')   posts.sort((a, b) => (b.taken_at ?? 0) - (a.taken_at ?? 0))
    else posts.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    return posts
  }, [result, sortBy, filterSource, filterType])

  const relatedTags: HashtagSuggestion[] = useMemo(() => {
    if (!result) return []
    if ('related_hashtags' in result) return result.related_hashtags ?? []
    if ('suggested_hashtags' in result) return result.suggested_hashtags ?? []
    return []
  }, [result])

  const suggestedUsers: UserSuggestion[] = useMemo(() => {
    if (!result || !('suggested_users' in result)) return []
    return result.suggested_users ?? []
  }, [result])

  const stats = useMemo(() => {
    if (!result?.posts) return null
    const posts = result.posts
    return {
      totalLikes:    posts.reduce((s, p) => s + (p.like_count ?? 0), 0),
      totalComments: posts.reduce((s, p) => s + (p.comment_count ?? 0), 0),
      videos:        posts.filter(p => p.media_type === 'VIDEO').length,
      total:         posts.length,
    }
  }, [result])

  // ── Handlers ───────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    // Ikut global lock: kalau ada scraping lain berjalan, jangan jalankan.
    if (scrapeStore.isBusy()) return
    setSortBy('top'); setFilterSource('all'); setFilterType('all')

    const key = mode === 'hashtag' ? SEARCH_KEY_HASHTAG : SEARCH_KEY_KEYWORD
    await scrapeStore.run<SearchTaskData>(
      key,
      'search',
      mode === 'hashtag' ? `#${q}` : q,
      async (): Promise<SearchTaskData> => {
        if (mode === 'hashtag') {
          const resp = await searchHashtag({
            hashtag: q, max_posts: maxPosts,
            include_top: includeTop, include_recent: includeRecent, recent_pages: recentPages,
          })
          if (!resp.data?.success) throw new Error(resp.data?.error ?? resp.message ?? 'Gagal')
          return resp.data
        }
        const resp = await searchKeyword({
          keyword: q, max_posts: kwMaxPosts, max_hashtags: maxHashtags,
          per_hashtag_pages: perHashtagPages, include_recent: kwIncludeRecent,
        })
        if (!resp.data?.success) throw new Error(resp.data?.error ?? resp.message ?? 'Gagal')
        return resp.data
      },
    )
  }, [query, mode, maxPosts, includeTop, includeRecent, recentPages,
      kwMaxPosts, maxHashtags, perHashtagPages, kwIncludeRecent])

  const handleScrapeComments = useCallback((url: string) => {
    router.push(`${SCRAPE_ROUTE}?url=${encodeURIComponent(url)}`)
  }, [router])

  const handleScrapeLikers = useCallback((url: string) => {
    router.push(`${LIKERS_ROUTE}?url=${encodeURIComponent(url)}`)
  }, [router])

  const handleTagClick = useCallback((tagName: string) => {
    setMode('hashtag'); setQuery(tagName)
    scrapeStore.resetTask(SEARCH_KEY_HASHTAG); setDownloadError(null)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const handleDownloadCsv = async () => {
    if (!sortedPosts.length) return
    setDownloading(true)
    setDownloadError(null)
    try {
      const hint = result
        ? ('hashtag' in result ? `search_tag_${result.hashtag}` : `search_kw_${query}`)
        : 'search'
      await downloadSearchPostsInline(sortedPosts, hint)
    } catch (e: unknown) { setDownloadError(e instanceof Error ? e.message : 'Download gagal') }
    finally { setDownloading(false) }
  }

  const renderPostsGrid = (posts: SearchPostItem[], vm: ViewMode) =>
    vm === 'grid' ? (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {posts.map(post => (
          <PostCard key={post.media_id || post.shortcode} post={post}
            onScrape={handleScrapeComments} onLikers={handleScrapeLikers} />
        ))}
      </div>
    ) : (
      <div className="space-y-2">
        {posts.map(post => (
          <PostRow key={post.media_id || post.shortcode} post={post}
            onScrape={handleScrapeComments} onLikers={handleScrapeLikers} />
        ))}
      </div>
    )

  // ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-20%] left-[-10%] w-[60vw] h-[60vw] rounded-full bg-pink-600/5 blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50vw] h-[50vw] rounded-full bg-purple-600/5 blur-[120px]" />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">

        {/* ── Header ──────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-linear-to-br from-pink-500/20 to-purple-500/20
                            border border-pink-500/20">
              <Search className="w-5 h-5 text-pink-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Instagram Search</h1>
              <p className="text-xs text-white/40">Cari postingan via keyword atau hashtag</p>
            </div>
          </div>
        </div>

        {/* ── Banner: scraping lain sedang berjalan ─────────────── */}
        {foreignBusy && (
          <div className="flex items-start gap-3 p-4 rounded-xl border border-yellow-500/20 bg-yellow-500/10">
            <Clock className="w-4 h-4 mt-0.5 shrink-0 text-yellow-400 animate-pulse" />
            <div className="flex-1">
              <p className="text-sm text-yellow-300 font-medium">Scraping masih berjalan</p>
              <p className="text-xs text-white/50 mt-0.5">
                Tunggu sampai proses scraping yang sedang berjalan selesai sebelum mencari.
              </p>
            </div>
          </div>
        )}

        {/* ── Quick Search Card ────────────────────────────────── */}
        <div className="rounded-2xl border border-white/8 bg-white/3 backdrop-blur-sm p-5 space-y-4">
          {/* Mode toggle */}
          <div className="flex gap-1 p-1 bg-white/5 rounded-xl w-fit">
            {(['hashtag', 'keyword'] as SearchMode[]).map(m => (
              <button key={m}
                onClick={() => { if (!disabled) { setMode(m); setQuery(''); setDownloadError(null) } }}
                disabled={disabled}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all
                            disabled:opacity-50 disabled:cursor-not-allowed
                            ${mode === m
                              ? 'bg-pink-500/20 text-pink-300 border border-pink-500/30'
                              : 'text-white/50 hover:text-white/70'}`}>
                {m === 'hashtag' ? <><Hash className="w-3.5 h-3.5" /> Hashtag</> : <><Sparkles className="w-3.5 h-3.5" /> Keyword</>}
              </button>
            ))}
          </div>

          {/* Input */}
          <div className="flex gap-2">
            <div className="flex-1 relative">
              {mode === 'hashtag'
                ? <Hash className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
                : <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
              }
              <input ref={inputRef} type="text" value={query} disabled={disabled}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder={mode === 'hashtag' ? 'Ketik hashtag (tanpa #)...' : 'Ketik keyword...'}
                className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-10 py-3
                           text-sm text-white placeholder:text-white/25 disabled:opacity-50
                           focus:outline-none focus:border-pink-500/50 focus:bg-white/8 transition-all" />
              {query && (
                <button onClick={() => { setQuery(''); clearResult() }}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <button onClick={handleSearch} disabled={disabled || !query.trim()}
              className="flex items-center gap-2 px-6 py-3 bg-pink-500/20 border border-pink-500/30
                         text-pink-300 rounded-xl text-sm font-medium hover:bg-pink-500/30 active:scale-95
                         disabled:opacity-50 disabled:cursor-not-allowed transition-all">
              {loading ? <Spinner size="sm" /> : <Search className="w-4 h-4" />}
              {loading ? 'Mencari...' : globalBusy ? 'Menunggu...' : 'Cari'}
            </button>
          </div>

          {/* Advanced toggle */}
          <button onClick={() => setShowAdvanced(v => !v)}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/60 transition-colors">
            <Settings2 className="w-3.5 h-3.5" />
            Pengaturan lanjutan
            {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>

          {showAdvanced && (
            <div className="border-t border-white/8 pt-4">
              {mode === 'hashtag' ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <NumberInput label="Max Posts" value={maxPosts} onChange={setMaxPosts} min={1} max={300} />
                    <NumberInput label="Recent Pages" value={recentPages} onChange={setRecentPages} min={1} max={12} />
                  </div>
                  <div className="flex flex-wrap gap-5">
                    <Toggle label="Sertakan Top Posts" checked={includeTop} onChange={setIncludeTop} />
                    <Toggle label="Sertakan Recent Posts" checked={includeRecent} onChange={setIncludeRecent} />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <NumberInput label="Max Posts" value={kwMaxPosts} onChange={setKwMaxPosts} min={1} max={300} />
                    <NumberInput label="Max Hashtags" value={maxHashtags} onChange={setMaxHashtags} min={1} max={6} />
                    <NumberInput label="Pages/Hashtag" value={perHashtagPages} onChange={setPerHashtagPages} min={1} max={5} />
                  </div>
                  <Toggle label="Sertakan Recent Posts" checked={kwIncludeRecent} onChange={setKwIncludeRecent} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 p-4 rounded-xl border border-red-500/20 bg-red-500/10 text-red-300 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1"><p className="font-medium">Pencarian gagal</p>
              <p className="text-red-300/70 text-xs mt-0.5">{error}</p></div>
            <button onClick={clearResult} className="text-red-300/50 hover:text-red-300 transition-colors">
              <X className="w-4 h-4" /></button>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm text-white/40">
              <Spinner size="sm" /><span>Mengambil postingan dari Instagram...</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="rounded-xl overflow-hidden border border-white/8 bg-white/3 animate-pulse">
                  <div className="aspect-square bg-white/5" />
                  <div className="p-3 space-y-2">
                    <div className="h-3 bg-white/5 rounded w-3/4" />
                    <div className="h-2 bg-white/5 rounded w-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        {!loading && result && (
          <div className="space-y-5">
            {/* Result header */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base font-bold text-white">{result.total_fetched} postingan</span>
                  {'hashtag' in result && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-pink-500/15 border border-pink-500/20 text-xs text-pink-300">
                      <Hash className="w-3 h-3" />{result.hashtag}
                      {result.formatted_media_count && <span className="text-pink-300/50">· {result.formatted_media_count}</span>}
                    </span>
                  )}
                  {'searched_hashtags' in result && result.searched_hashtags.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {result.searched_hashtags.map(t => {
                        const tagName = typeof t === 'string' ? t : t.hashtag
                        return (
                          <span key={tagName} className="flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-pink-500/15 border border-pink-500/20 text-xs text-pink-300">
                            <Hash className="w-3 h-3" />{tagName}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>
                {stats && (
                  <div className="flex items-center gap-3 text-xs text-white/35">
                    <span className="flex items-center gap-1"><Heart className="w-3 h-3" /> {formatNum(stats.totalLikes)} total likes</span>
                    <span className="flex items-center gap-1"><MessageCircle className="w-3 h-3" /> {formatNum(stats.totalComments)} total komentar</span>
                    {stats.videos > 0 && <span className="flex items-center gap-1"><Film className="w-3 h-3" /> {stats.videos} video</span>}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleDownloadCsv} disabled={downloading || !sortedPosts.length}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/10 bg-white/5
                             text-xs text-white/60 hover:text-white/90 hover:border-white/20
                             disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                  {downloading ? <Spinner size="sm" /> : <Download className="w-3.5 h-3.5" />} CSV
                </button>
                <div className="flex gap-1 p-1 bg-white/5 rounded-lg">
                  <button onClick={() => setViewMode('grid')}
                    className={`p-1.5 rounded transition-colors ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'}`}>
                    <LayoutGrid className="w-3.5 h-3.5" /></button>
                  <button onClick={() => setViewMode('list')}
                    className={`p-1.5 rounded transition-colors ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'}`}>
                    <List className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            </div>

            {/* Sort & filter bar */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 p-1 bg-white/5 rounded-lg">
                {([
                  { key: 'top', label: 'Top', icon: <Zap className="w-3 h-3" /> },
                  { key: 'likes', label: 'Likes', icon: <Heart className="w-3 h-3" /> },
                  { key: 'comments', label: 'Komentar', icon: <MessageCircle className="w-3 h-3" /> },
                  { key: 'recent', label: 'Terbaru', icon: <Clock className="w-3 h-3" /> },
                ] as { key: SortBy; label: string; icon: React.ReactNode }[]).map(s => (
                  <button key={s.key} onClick={() => setSortBy(s.key)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-all
                                ${sortBy === s.key ? 'bg-pink-500/20 text-pink-300 border border-pink-500/25' : 'text-white/40 hover:text-white/70'}`}>
                    {s.icon}{s.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 p-1 bg-white/5 rounded-lg">
                {(['all', 'top', 'recent'] as const).map(f => (
                  <button key={f} onClick={() => setFilterSource(f)}
                    className={`px-2.5 py-1.5 rounded text-xs font-medium transition-all
                                ${filterSource === f ? 'bg-white/10 text-white' : 'text-white/35 hover:text-white/60'}`}>
                    {f === 'all' ? 'Semua' : f === 'top' ? '⚡ Top' : '🕒 Recent'}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 p-1 bg-white/5 rounded-lg">
                {(['all', 'PHOTO', 'VIDEO', 'CAROUSEL'] as const).map(f => (
                  <button key={f} onClick={() => setFilterType(f)}
                    className={`px-2.5 py-1.5 rounded text-xs font-medium transition-all
                                ${filterType === f ? 'bg-white/10 text-white' : 'text-white/35 hover:text-white/60'}`}>
                    {f === 'all' ? 'Semua' : f === 'PHOTO' ? '🖼 Foto' : f === 'VIDEO' ? '🎥 Video' : '🎞 Carousel'}
                  </button>
                ))}
              </div>
              {(filterSource !== 'all' || filterType !== 'all') && (
                <button onClick={() => { setFilterSource('all'); setFilterType('all') }}
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-white/40 hover:text-white/70 transition-colors">
                  <X className="w-3 h-3" /> Reset filter
                </button>
              )}
              <span className="text-xs text-white/30 ml-auto">{sortedPosts.length} dari {result.total_fetched}</span>
            </div>

            {/* Posts + sidebar */}
            <div className="flex gap-5">
              <div className="flex-1 min-w-0">
                {sortedPosts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Search className="w-10 h-10 text-white/15 mb-3" />
                    <p className="text-white/40 text-sm">Tidak ada postingan yang cocok</p>
                  </div>
                ) : renderPostsGrid(sortedPosts, viewMode)}
              </div>
              {(relatedTags.length > 0 || suggestedUsers.length > 0) && (
                <div className="w-60 shrink-0 hidden lg:flex flex-col gap-4">
                  <RelatedHashtagsPanel tags={relatedTags} onSelect={handleTagClick} />
                  <SuggestedUsersPanel users={suggestedUsers} />
                </div>
              )}
            </div>

            {/* Mobile sidebar */}
            {(relatedTags.length > 0 || suggestedUsers.length > 0) && (
              <div className="lg:hidden space-y-4">
                <RelatedHashtagsPanel tags={relatedTags} onSelect={handleTagClick} />
                <SuggestedUsersPanel users={suggestedUsers} />
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!loading && !result && !error && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-linear-to-br from-pink-500/20 to-purple-500/20
                            border border-pink-500/20 flex items-center justify-center">
              {mode === 'hashtag' ? <Hash className="w-7 h-7 text-pink-400/70" /> : <Sparkles className="w-7 h-7 text-pink-400/70" />}
            </div>
            <div className="space-y-1">
              <p className="text-white/50 font-medium text-sm">
                {mode === 'hashtag' ? 'Masukkan hashtag untuk melihat postingan' : 'Masukkan keyword untuk mencari postingan relevan'}
              </p>
              <p className="text-white/25 text-xs">
                {mode === 'hashtag' ? 'Contoh: kuliner, exploreindonesia, ootd' : 'Contoh: baju batik, wisata bali, resep masakan'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center pt-2">
              {(mode === 'hashtag'
                ? ['exploreindonesia', 'kuliner', 'ootd', 'travel', 'photography']
                : ['baju batik', 'wisata bali', 'resep kue', 'startup indonesia']
              ).map(ex => (
                <button key={ex}
                  onClick={() => { setQuery(ex); setTimeout(() => inputRef.current?.focus(), 0) }}
                  className="px-3 py-1.5 rounded-full border border-white/8 bg-white/3
                             text-xs text-white/40 hover:text-white/70 hover:border-white/20 transition-all">
                  {mode === 'hashtag' ? `#${ex}` : ex}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}