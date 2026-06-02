import type {
  ApiResponse,
  SessionInfo,
  AuthStatus,
  PostResult,
  Profile,
  OutputFile,
  HealthData,
  FollowerListResult,
  FollowingVerifiedResult,
} from '@/types'

const BASE =
  typeof window === 'undefined'
    ? process.env.INTERNAL_API_URL || 'http://backend:8000'   // server-side (dalam Docker)
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000' // browser (user)

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

// ── Scrape ──────────────────────────────────────────────────────
export interface ScrapePostOptions {
  include_replies?: boolean
  max_replies_per_comment?: number
}

export const scrapePost = (
  url: string,
  max_comments = 100,
  opts: ScrapePostOptions = {},
) =>
  apiFetch<PostResult>('/api/scrape/post', {
    method: 'POST',
    body: JSON.stringify({
      url,
      max_comments,
      include_replies: opts.include_replies ?? true,
      max_replies_per_comment: opts.max_replies_per_comment ?? 20,
    }),
  })

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