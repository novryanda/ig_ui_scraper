import type {
  ApiResponse,
  SessionInfo,
  AuthStatus,
  PostResult,
  UnifiedResult,
  Profile,
  OutputFile,
  HealthData,
  FollowerListResult,
  FollowingVerifiedResult,
  MutualFollowAnalysis,
  MutualFollowItem,
  FollowerItem,
  LikersResult,
  ScrapeLikersRequest,
  ScrapeUnifiedRequest,
  ScrapePostRequest,
  ActiveCommenter,
} from '@/types'

const BASE =
  typeof window === 'undefined'
    ? process.env.INTERNAL_API_URL || 'http://backend:8000'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

async function apiFetch<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error(err.message || `HTTP ${res.status}`)
  }
  return res.json()
}

// ── Health ──────────────────────────────────────────────────────
export const getHealth = () => apiFetch<HealthData>('/api/health')

// ── Auth ────────────────────────────────────────────────────────
export const getSession    = () => apiFetch<SessionInfo>('/api/auth/session')
export const getAuthStatus = () => apiFetch<AuthStatus>('/api/auth/status')
export const triggerLogin  = () => apiFetch('/api/auth/login', { method: 'POST', body: '{}' })
export const triggerLogout = () => apiFetch('/api/auth/logout', { method: 'POST', body: '{}' })
export const saveCookies   = (cookies_json: string) =>
  apiFetch('/api/auth/cookies', { method: 'POST', body: JSON.stringify({ cookies_json }) })

// ── Scrape Post ─────────────────────────────────────────────────

export interface ScrapePostOptions {
  include_replies?: boolean
  max_replies_per_comment?: number
}

/**
 * Scrape komentar satu post Instagram.
 *
 * @param url           - URL post/reel Instagram
 * @param max_comments  - Jumlah komentar. **0 = unlimited** (ambil semua hingga batas aman server).
 * @param opts          - Opsi tambahan: include_replies, max_replies_per_comment
 */
export const scrapePost = (
  url: string,
  max_comments = 100,
  opts: ScrapePostOptions = {},
) =>
  apiFetch<PostResult>('/api/scrape/post', {
    method: 'POST',
    body: JSON.stringify({
      url,
      max_comments,           // 0 = unlimited — diteruskan langsung ke backend
      include_replies: opts.include_replies ?? true,
      max_replies_per_comment: opts.max_replies_per_comment ?? 20,
    } satisfies ScrapePostRequest),
  })

/**
 * Scrape komentar beberapa post sekaligus (batch).
 *
 * @param urls          - Array URL post Instagram
 * @param max_comments  - 0 = unlimited per post
 * @param delay_between - Jeda antar post (detik)
 * @param opts          - Opsi replies
 */
export const scrapePosts = (
  urls: string[],
  max_comments = 100,
  delay_between = 8,
  opts: ScrapePostOptions = {},
) =>
  apiFetch('/api/scrape/posts/batch', {
    method: 'POST',
    body: JSON.stringify({
      urls,
      max_comments,
      delay_between,
      include_replies: opts.include_replies ?? true,
      max_replies_per_comment: opts.max_replies_per_comment ?? 20,
    }),
  })

/**
 * Unified scrape: komentar + likers dalam satu sesi browser.
 * max_comments=0 dalam req → unlimited.
 */
export const scrapeUnified = (req: ScrapeUnifiedRequest) =>
  apiFetch<PostResult | UnifiedResult>('/api/scrape/post/unified', {
    method: 'POST',
    body: JSON.stringify(req),
  })

// ── Scrape Likers ───────────────────────────────────────────────
export const scrapePostLikers = (req: ScrapeLikersRequest) =>
  apiFetch<LikersResult>('/api/scrape/post/likers', {
    method: 'POST',
    body: JSON.stringify(req),
  })

// ── Download ────────────────────────────────────────────────────

/**
 * Download JSON hasil scrape post dari server (berdasarkan nama file di output dir).
 */
export const downloadPostJson = (filename: string) =>
  `${BASE}/api/download/post/${encodeURIComponent(filename)}`

/**
 * Download CSV komentar dari hasil scrape post.
 * @param replies  true = sertakan balasan (default), false = hanya komentar utama
 */
export const downloadPostCommentsCsv = (filename: string, replies = true) =>
  `${BASE}/api/download/post/${encodeURIComponent(filename)}/comments.csv?replies=${replies}`

/**
 * Download JSON hasil scrape likers dari server.
 */
export const downloadLikersJson = (filename: string) =>
  `${BASE}/api/download/likers/${encodeURIComponent(filename)}`

/**
 * Download CSV daftar likers dari hasil scrape.
 */
export const downloadLikersCsv = (filename: string) =>
  `${BASE}/api/download/likers/${encodeURIComponent(filename)}/likers.csv`

export const downloadUnifiedJson = (filename: string) =>
  `${BASE}/api/download/unified/${encodeURIComponent(filename)}`

export const downloadUnifiedCommentsCsv = (filename: string, replies = true) =>
  `${BASE}/api/download/unified/${encodeURIComponent(filename)}/comments.csv?replies=${replies}`

export const downloadUnifiedLikersCsv = (filename: string) =>
  `${BASE}/api/download/unified/${encodeURIComponent(filename)}/likers.csv`

/**
 * Download CSV komentar langsung dari data yang sudah ada di client
 * (tidak perlu nama file — POST data langsung ke backend).
 */
export async function downloadCommentsInline(
  comments: PostResult['comments'],
  filenameHint = 'comments',
  includeReplies = true,
): Promise<void> {
  const res = await fetch(`${BASE}/api/download/comments-csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      comments,
      include_replies: includeReplies,
      filename_hint: filenameHint,
    }),
  })
  if (!res.ok) throw new Error(`Download gagal: HTTP ${res.status}`)
  const blob = await res.blob()
  _triggerDownload(blob, `${filenameHint}_comments.csv`)
}

/**
 * Download CSV likers langsung dari data yang sudah ada di client.
 */
export async function downloadLikersInline(
  likers: LikersResult['likers'],
  filenameHint = 'likers',
): Promise<void> {
  const res = await fetch(`${BASE}/api/download/likers-csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ likers, filename_hint: filenameHint }),
  })
  if (!res.ok) throw new Error(`Download gagal: HTTP ${res.status}`)
  const blob = await res.blob()
  _triggerDownload(blob, `${filenameHint}_likers.csv`)
}

/**
 * Download CSV komentator teraktif langsung dari data di client.
 */
export async function downloadActiveCommentersInline(
  active_commenters: ActiveCommenter[],
  filenameHint = 'active_commenters',
): Promise<void> {
  const res = await fetch(`${BASE}/api/download/active-commenters-csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active_commenters, filename_hint: filenameHint }),
  })
  if (!res.ok) throw new Error(`Download gagal: HTTP ${res.status}`)
  const blob = await res.blob()
  _triggerDownload(blob, `${filenameHint}_active_commenters.csv`)
}

/** Helper: trigger browser download dari Blob */
function _triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a   = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Profile ─────────────────────────────────────────────────────
export const scrapeProfile = (username: string, save_snapshot = true) =>
  apiFetch<{ profile: Profile }>('/api/scrape/profile', {
    method: 'POST',
    body: JSON.stringify({ username, save_snapshot }),
  })

// ── Followers / Following / Verified Following ──────────────────
export const scrapeFollowers = (username: string, max_count = 200) =>
  apiFetch<{ followers: FollowerListResult } & FollowerListResult>(
    '/api/scrape/profile/followers',
    { method: 'POST', body: JSON.stringify({ username, max_count }) },
  )

export const scrapeFollowing = (username: string, max_count = 200) =>
  apiFetch<{ following: FollowerListResult } & FollowerListResult>(
    '/api/scrape/profile/following',
    { method: 'POST', body: JSON.stringify({ username, max_count }) },
  )

export const scrapeFollowingVerified = (username: string, max_count = 500) =>
  apiFetch<{ following_verified: FollowingVerifiedResult } & FollowingVerifiedResult>(
    '/api/scrape/profile/following-verified',
    { method: 'POST', body: JSON.stringify({ username, max_count }) },
  )

// ── Followers + Following sekaligus (untuk analisis mutual) ─────
/**
 * Scrape followers DAN following secara paralel, lalu hitung mutual follow.
 */
export async function scrapeAndAnalyzeMutuals(
  username: string,
  max_count = 500,
): Promise<MutualFollowAnalysis> {
  const [followersResp, followingResp] = await Promise.all([
    scrapeFollowers(username, max_count),
    scrapeFollowing(username, max_count),
  ])

  const followers: FollowerItem[] = followersResp.data?.items ?? []
  const following: FollowerItem[] = followingResp.data?.items ?? []

  return computeMutualFollow(username, followers, following)
}

/**
 * Hitung mutual follow dari dua array yang sudah ada.
 */
export function computeMutualFollow(
  target_username: string,
  followers: FollowerItem[],
  following: FollowerItem[],
): MutualFollowAnalysis {
  const followerSet  = new Set(followers.map(f => f.username.toLowerCase()))
  const followingSet = new Set(following.map(f => f.username.toLowerCase()))

  const mutuals: MutualFollowItem[] = followers
    .filter(f => followingSet.has(f.username.toLowerCase()))
    .map(f => ({ ...f, follows_back: true as const }))

  const not_following_back: FollowerItem[] = followers.filter(
    f => !followingSet.has(f.username.toLowerCase()),
  )

  const not_followed_back: FollowerItem[] = following.filter(
    f => !followerSet.has(f.username.toLowerCase()),
  )

  return {
    target_username,
    scraped_at: new Date().toISOString(),
    followers_count: followers.length,
    following_count: following.length,
    mutual_count: mutuals.length,
    mutuals,
    not_following_back,
    not_followed_back,
  }
}

// ── Analytics ───────────────────────────────────────────────────
export const listProfiles   = () => apiFetch<{ users: Profile[]; count: number }>('/api/profiles')
export const getProfile     = (username: string) => apiFetch<{ profile: Profile }>(`/api/profiles/${username}`)
export const profileHistory = (username: string, limit = 30) =>
  apiFetch(`/api/profiles/${username}/history?limit=${limit}`)
export const profileGrowth  = (username: string) => apiFetch(`/api/profiles/${username}/growth`)
export const profileMonthly = (username: string) => apiFetch(`/api/profiles/${username}/monthly`)

// ── Output files ─────────────────────────────────────────────────
export const listOutputFiles = () => apiFetch<{ files: OutputFile[]; count: number }>('/api/output/list')
export const getOutputFile   = (filename: string) => fetch(`${BASE}/api/output/${filename}`).then(r => r.json())

// ── Profile Posts ────────────────────────────────────────────────
import type { ProfilePostsResult, ScrapeProfilePostsRequest } from '@/types'

export const scrapeProfilePosts = (req: ScrapeProfilePostsRequest) =>
  apiFetch<ProfilePostsResult>('/api/scrape/profile/posts', {
    method: 'POST',
    body: JSON.stringify(req),
  })

export const getProfilePostsFiles = (username: string) =>
  apiFetch<{ username: string; files: Array<{ name: string; size: number; modified: string }>; count: number }>(
    `/api/profiles/${username}/posts`
  )




  // ════════════════════════════════════════════════════════════════
// CHECKPOINT SESSION API
// → TEMPEL di akhir file frontend/src/lib/api.ts
//   Memakai `BASE` & `apiFetch` yang sudah ada di api.ts.
// ════════════════════════════════════════════════════════════════

import type {
  CheckpointSession,
  CheckpointSessionSummary,
  StartCheckpointRequest,
} from '@/types'

/**
 * Mulai sesi checkpoint baru — langsung mengambil batch pertama
 * (sekaligus metadata postingan).
 */
export const startCheckpointSession = (req: StartCheckpointRequest) =>
  apiFetch<CheckpointSession>('/api/scrape/session/start', {
    method: 'POST',
    body: JSON.stringify(req),
  })

/**
 * Lanjut scrape satu batch berikutnya dari cursor terakhir.
 */
export const continueCheckpointSession = (session_id: string) =>
  apiFetch<CheckpointSession>('/api/scrape/session/continue', {
    method: 'POST',
    body: JSON.stringify({ session_id }),
  })

/**
 * Ambil detail sesi (komentar gabungan + summary terkini).
 */
export const getCheckpointSession = (session_id: string) =>
  apiFetch<CheckpointSession>(`/api/scrape/session/${encodeURIComponent(session_id)}`)

/**
 * Tandai sesi selesai + simpan file JSON gabungan di server.
 */
export const finalizeCheckpointSession = (session_id: string) =>
  apiFetch<CheckpointSession>(
    `/api/scrape/session/${encodeURIComponent(session_id)}/finalize`,
    { method: 'POST', body: '{}' },
  )

/**
 * Daftar semua sesi checkpoint (ringkasan).
 */
export const listCheckpointSessions = () =>
  apiFetch<{ sessions: CheckpointSessionSummary[]; count: number }>(
    '/api/scrape/session/list',
  )

/**
 * Hapus sesi.
 */
export const deleteCheckpointSession = (session_id: string) =>
  apiFetch<{ deleted: boolean; session_id: string }>(
    `/api/scrape/session/${encodeURIComponent(session_id)}`,
    { method: 'DELETE' },
  )

/**
 * URL unduh JSON gabungan sesi (semua batch jadi satu file).
 */
export const downloadCheckpointJson = (session_id: string) =>
  `${BASE}/api/scrape/session/${encodeURIComponent(session_id)}/download`

/**
 * URL unduh CSV komentar gabungan sesi.
 * @param replies true = sertakan balasan (default)
 */
export const downloadCheckpointCommentsCsv = (session_id: string, replies = true) =>
  `${BASE}/api/scrape/session/${encodeURIComponent(session_id)}/comments.csv?replies=${replies}`