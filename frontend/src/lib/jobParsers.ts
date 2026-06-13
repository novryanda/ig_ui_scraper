// lib/jobParsers.ts
// ------------------------------------------------------------------
// Pemetaan hasil job backend (ApiResponse) → bentuk data yang dipakai
// tiap halaman. Dipisah di sini supaya scrapeStore bisa mem-parse hasil
// job SAAT REHYDRATE (setelah refresh) tanpa perlu komponen halaman mount.
//
// Di-key berdasarkan `jobKind` (kind dispatch backend), bukan task key.
// ------------------------------------------------------------------

import type {
  ApiResponse,
  PostResult,
  UnifiedResult,
  Profile,
  LikersResult,
  FollowingVerifiedResult,
  FollowerItem,
  HashtagSearchResult,
  KeywordSearchResult,
  MutualFollowAnalysis,
  DeepScrapeResult,
} from '@/types'
import { computeMutualFollow } from '@/lib/api'

/** Ambil data dari ApiResponse, lempar error bila success=false. */
function ok<T>(resp: ApiResponse<T>): T {
  if (!resp.success) throw new Error(resp.message || 'Gagal')
  return resp.data
}

export type JobParser = (resp: ApiResponse<unknown>) => unknown

export const JOB_PARSERS: Record<string, JobParser> = {
  post: (r) => ({ mode: 'post', result: ok(r as ApiResponse<PostResult>) }),

  unified: (r) => ({ mode: 'unified', result: ok(r as ApiResponse<UnifiedResult>) }),

  batch: (r) => {
    if (!r.success) throw new Error(r.message || 'Gagal')
    const d = (r.data ?? {}) as {
      total?: number; success?: number; failed?: number
      results?: Array<{ success: boolean }>
    }
    return {
      mode: 'batch',
      results: d.results || [],
      summary: {
        total:   d.total   ?? (d.results?.length || 0),
        success: d.success ?? (d.results?.filter(x => x.success).length || 0),
        failed:  d.failed  ?? (d.results?.filter(x => !x.success).length || 0),
      },
    }
  },

  likers: (r) => ok(r as ApiResponse<LikersResult>),

  profile: (r) => {
    if (!r.success) throw new Error(r.message || 'Gagal scrape profile')
    const prof = (r.data as Record<string, unknown>)?.profile ?? r.data
    if (!prof || !(prof as Profile).username) {
      throw new Error('Data profile kosong / format tidak dikenali')
    }
    return prof as Profile
  },

  verified: (r) => {
    if (!r.success) throw new Error(r.message || 'Gagal')
    const payload = r.data as
      | ({ following_verified?: FollowingVerifiedResult } & FollowingVerifiedResult)
      | undefined
    const data = payload?.following_verified ?? payload
    if (!data) throw new Error('Response kosong')
    return data as FollowingVerifiedResult
  },

  mutual: (r): MutualFollowAnalysis => {
    const d = ok(r as ApiResponse<{
      username: string; followers: FollowerItem[]; following: FollowerItem[]
    }>)
    return computeMutualFollow(d.username, d.followers ?? [], d.following ?? [])
  },

  search_hashtag: (r) => {
    const d = (r as ApiResponse<HashtagSearchResult>).data
    if (!d?.success) throw new Error(d?.error ?? r.message ?? 'Gagal')
    return d
  },

  search_keyword: (r) => {
    const d = (r as ApiResponse<KeywordSearchResult>).data
    if (!d?.success) throw new Error(d?.error ?? r.message ?? 'Gagal')
    return d
  },

  profile_deep: (r) => {
    const resp = r as ApiResponse<DeepScrapeResult>
    if (!resp.success) throw new Error(resp.message || 'Deep scrape gagal')
    return resp.data
  },
}
