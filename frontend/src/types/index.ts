// ── API Response Wrapper ──────────────────────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean
  message: string
  timestamp: string
  data: T
}

// ── Auth / Session ────────────────────────────────────────────
export interface SessionInfo {
  has_session: boolean
  user_id: string | null
  cookie_count: number
  saved_at: string
  is_expired: boolean
  is_valid: boolean
  missing_cookies: string[]
}

export interface AuthStatus {
  is_running: boolean
  login_detected: boolean
  username: string | null
  is_logged_in: boolean
  profile_exists: boolean
}

// ── Comment & Sentiment ───────────────────────────────────────
export interface Comment {
  number: number
  username: string
  text: string
  comment_id: string
  like_count: number
  created_at: number
  reply_count: number
  category: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'HATE_SPEECH' | 'TOXIC' | 'HUMOR'
  sentiment: string
  language: string
  is_hate_speech: boolean
  is_toxic: boolean
  is_sarcasm: boolean
  is_wellwish: boolean
  hate_score: number
  hate_words: string[]
  toxic_words: string[]
  positive_words: string[]
  negative_words: string[]
  humor_words: string[]
  emojis: string[]
  ml_confidence: number
  decision_source: string
  vader_compound: number

  // replies (child_comments)
  is_reply?: boolean
  parent_comment_id?: string
  replies?: Comment[]
  replies_fetched?: number
}

export interface RepliesSentimentBreakdown {
  positive_count: number
  negative_count: number
  neutral_count: number
  humor_count: number
  toxic_count: number
  hate_speech_count: number
  positive_percentage: number
  negative_percentage: number
  neutral_percentage: number
  humor_percentage: number
  toxic_percentage: number
  hate_percentage: number
}

export interface SentimentSummary {
  total_comments: number
  total_replies?: number
  hate_speech_count: number
  hate_percentage: number
  toxic_count: number
  toxic_percentage: number
  positive_count: number
  positive_percentage: number
  negative_count: number
  negative_percentage: number
  neutral_count: number
  neutral_percentage: number
  humor_count: number
  humor_percentage: number
  sarcasm_count: number
  sarcasm_percentage: number
  wellwish_count: number
  wellwish_percentage: number
  avg_ml_confidence: number
  decision_source_breakdown?: Record<string, number>
  top_liked: TopComment[]
  top_hate_liked?: TopComment[]
  hate_examples: HateExample[]
  toxic_examples?: ToxicExample[]
  most_active_users: ActiveUser[]
  engagement?: EngagementSummary
  replies_sentiment_breakdown?: RepliesSentimentBreakdown
}

export interface TopComment {
  username: string
  text: string
  like_count: number
  category: string
  sentiment: string
}

export interface HateExample {
  username: string
  text: string
  hate_words: string[]
  like_count: number
}

export interface ToxicExample {
  username: string
  text: string
  toxic_words: string[]
}

export interface ActiveUser {
  username: string
  comment_count: number
}

// ── Active Commenters (komentator teraktif per post) ──────────
/** Balasan yang menempel pada satu komentar utama. */
export interface ActiveCommenterReplyOnComment {
  username: string
  text: string
  like_count: number
  category: string
  sentiment: string
}

/** Rincian satu komentar utama milik komentator. */
export interface ActiveCommenterComment {
  text: string
  like_count: number
  reply_count?: number
  category: string
  sentiment: string
  comment_id?: string
  created_at?: number
  replies?: ActiveCommenterReplyOnComment[]
}

/** Balasan yang DITULIS oleh komentator (ke komentar orang lain). */
export interface ActiveCommenterReply {
  text: string
  like_count: number
  category: string
  sentiment: string
  comment_id?: string
  parent_comment_id?: string
  reply_to: string
  created_at?: number
}

/** Agregasi satu akun: berapa kali komentar/balas, total like, dll. */
export interface ActiveCommenter {
  username: string
  comment_count: number
  reply_count: number
  total_interactions: number
  total_likes: number
  dominant_category: string
  dominant_sentiment: string
  comments: ActiveCommenterComment[]
  replies: ActiveCommenterReply[]
}

// ── Post Scrape Result ────────────────────────────────────────
export interface PostResult {
  url: string
  shortcode: string
  scraped_at: string
  sentiment_mode: string

  /**
   * Mode scrape: "unified" | "post" | "likers"
   * Sesuai field scrape_mode di scraper_post.py
   */
  scrape_mode?: string

  /**
   * true jika max_comments=0 (unlimited mode) saat scraping
   * Field dari scraper_post.py: is_unlimited_comments
   */
  is_unlimited_comments?: boolean

  caption: string
  likes: number
  owner_username: string
  media_id: string
  method: string
  media_type: 'PHOTO' | 'VIDEO' | 'CAROUSEL' | 'UNKNOWN'
  product_type: string
  video_views: number
  play_count: number
  shares_count: number
  reshare_count: number
  direct_send_count: number
  saves_count: number
  thumbnail_url?: string
  comments: Comment[]
  comments_count: number
  replies_count?: number

  /** Komentator teraktif (di-rank per total interaksi). */
  active_commenters?: ActiveCommenter[]
  active_commenters_count?: number

  include_replies?: boolean
  max_replies_per_comment?: number
  sentiment_summary: SentimentSummary
  error?: string
  _meta?: { saved_file?: string; elapsed_seconds?: number }
}

// ── Unified Scrape Result ─────────────────────────────────────
export interface UnifiedResult extends PostResult {
  /** Data likers (hanya ada kalau scrape_likers=true) */
  likers: LikerItem[]
  likers_fetched: number
  likes_count: number
  likers_method: string
  likers_error: string | null
  likers_enabled?: boolean
  /** "aggressive" | "safe" */
  likers_mode?: 'aggressive' | 'safe'
}

/**
 * Request ke endpoint /api/scrape/post
 * max_comments=0 → unlimited (scraper ambil semua hingga SAFE_MAX_COMMENTS)
 */
export interface ScrapePostRequest {
  url: string
  /** 0 = unlimited, >0 = batas komentar */
  max_comments: number
  include_replies?: boolean
  max_replies_per_comment?: number
}

/**
 * Request ke endpoint /api/scrape/post/unified
 * max_comments=0 → unlimited comments
 */
export interface ScrapeUnifiedRequest {
  url: string
  /** 0 = unlimited (ambil semua komentar) */
  max_comments: number
  include_replies: boolean
  max_replies_per_comment: number
  scrape_likers: boolean
  /** 0 = ambil semua likers */
  max_likers: number
  aggressive_likers: boolean
  checkpoint_size: number
  checkpoint_delay_min: number
  checkpoint_delay_max: number
  page_delay_min: number
  page_delay_max: number
}

// ── Likers ────────────────────────────────────────────────────
export interface LikerItem {
  user_id: string
  username: string
  full_name: string
  is_verified: boolean
  is_private: boolean
  profile_pic_url: string
}

export interface LikersResult {
  url: string
  shortcode: string
  scraped_at: string
  media_id: string
  owner_username: string
  /** Total likes di post (angka dari IG) */
  likes_count: number
  /** Berapa liker yang berhasil diambil */
  likers_fetched: number
  /** rest | graphql | rest+graphql | graphql_aggressive | rest+graphql_aggressive */
  method: string
  /** "aggressive" | "safe" */
  likers_mode?: 'aggressive' | 'safe'
  likers: LikerItem[]
  error: string | null
  _meta?: { saved_file?: string; elapsed_seconds?: number }
}

/** Request ke endpoint /api/scrape/post/likers */
export interface ScrapeLikersRequest {
  url: string
  /** 0 = ambil semua likers */
  max_likers?: number
  aggressive_likers?: boolean
  checkpoint_size?: number
  checkpoint_delay_min?: number
  checkpoint_delay_max?: number
  page_delay_min?: number
  page_delay_max?: number
}

// ── Profile ───────────────────────────────────────────────────
export interface Profile {
  username: string
  full_name: string
  followers: number
  following: number
  posts_count: number
  bio: string
  is_verified: boolean
  is_private: boolean
  category: string
  profile_pic_url: string
  recent_posts?: ProfilePost[]
  engagement_summary?: {
    posts_analyzed: number
    avg_likes: number
    avg_comments: number
    engagement_rate: number
  }
}

export interface EngagementSummary {
  media_type: string
  product_type: string
  likes: number
  video_views: number
  play_count: number
  shares_count: number
  reshare_count: number
  direct_send_count: number
  saves_count: number
}

// ── Output Files ──────────────────────────────────────────────
export interface OutputFile {
  name: string
  size: number
  modified: string
}

// ── Health ────────────────────────────────────────────────────
export interface HealthData {
  api: string
  version?: string
  engine_dir: string
  output_dir: string
  engine_files_found: boolean
  safe_max_comments?: number
}

// ── Follower / Following Item ───────────────────────────────
export interface FollowerItem {
  username: string
  full_name: string
  user_id: string
  is_verified: boolean
  is_private: boolean
  profile_pic_url: string
}

export interface FollowerListResult {
  username: string
  kind: 'followers' | 'following' | 'following_verified'
  scraped_at: string
  scraped_date: string
  success: boolean
  count: number
  items: FollowerItem[]
  total_scanned?: number
  error: string
  _meta?: { saved_file?: string; elapsed_seconds?: number }
}

export interface FollowingVerifiedResult {
  username: string
  kind: 'following_verified'
  scraped_at: string
  scraped_date: string
  success: boolean
  count: number
  total_scanned: number
  items: FollowerItem[]
  error: string
  _meta?: { saved_file?: string; elapsed_seconds?: number }
}

// ── Mutual Follow Analysis ────────────────────────────────────
export interface MutualFollowItem extends FollowerItem {
  follows_back: true
}

export interface MutualFollowAnalysis {
  target_username: string
  scraped_at: string
  followers_count: number
  following_count: number
  mutual_count: number
  mutuals: MutualFollowItem[]
  not_following_back: FollowerItem[]
  not_followed_back: FollowerItem[]
}

// ── Profile Post Item ─────────────────────────────────────────
export interface PostComment {
  username: string
  text: string
  comment_id: string
  like_count: number
  created_at: number
  reply_count: number
  replies: Array<{
    username: string
    text: string
    comment_id: string
    like_count: number
    created_at: number
    parent_comment_id: string
  }>
}

export interface ProfilePost {
  media_id: string
  shortcode: string
  url: string
  media_type: 'PHOTO' | 'VIDEO' | 'CAROUSEL'
  product_type: string
  taken_at: number
  taken_at_iso: string
  caption: string
  like_count: number
  comment_count: number
  view_count: number
  play_count: number
  thumbnail_url: string
  is_video: boolean
  location: string
  comments: PostComment[]
  comments_fetched: number
}

export interface ProfilePostsResult {
  username: string
  date_from: string | null
  date_to: string | null
  scraped_at: string
  scraped_date: string
  success: boolean
  total_posts: number
  posts: ProfilePost[]
  error: string
  _meta?: { saved_file?: string; elapsed_seconds?: number }
}

export interface ScrapeProfilePostsRequest {
  username: string
  date_from?: string
  date_to?: string
  max_posts?: number
  include_comments?: boolean
  max_comments_per_post?: number
  max_replies_per_comment?: number
}

// ════════════════════════════════════════════════════════════════
// CHECKPOINT SESSION TYPES
// ════════════════════════════════════════════════════════════════

/** Cursor posisi scraping (titik lanjut tanpa duplikat). */
export interface CheckpointCursor {
  /** "graphql" | "cdp" | "rest" — dikunci setelah batch pertama */
  method: string
  /** end_cursor (GraphQL) atau next_min_id (CDP/REST) */
  value: string | null
}

/** Ringkasan satu batch dalam riwayat sesi. */
export interface CheckpointBatchInfo {
  batch_num: number
  count: number
  replies: number
  scraped_at: string
}

/** State lengkap sebuah sesi checkpoint (response dari backend). */
export interface CheckpointSession {
  session_id: string
  url: string
  shortcode: string
  /** active = masih bisa lanjut · completed = sudah finalize · error = gagal */
  status: 'active' | 'completed' | 'error'

  batch_size: number
  include_replies: boolean
  max_replies_per_comment: number

  created_at: string
  updated_at: string

  /** Cursor lanjutan; null jika sudah habis */
  cursor: CheckpointCursor | null
  /** true selama masih ada komentar yang belum diambil */
  has_more: boolean
  /** Metode yang dipakai: graphql | cdp | rest */
  method: string

  /** Riwayat tiap batch */
  batches: CheckpointBatchInfo[]

  total_comments: number
  total_replies: number

  // ── Metadata postingan (diisi di batch pertama) ──
  owner_username: string
  caption: string
  media_id: string
  likes: number
  media_type: 'PHOTO' | 'VIDEO' | 'CAROUSEL' | 'UNKNOWN'
  product_type: string
  video_views: number
  play_count: number
  shares_count: number
  reshare_count: number
  direct_send_count: number
  saves_count: number

  // ── Data gabungan ──
  comments: Comment[]
  sentiment_summary: SentimentSummary

  /** Berapa komentar baru yang ditambahkan pada batch terakhir */
  last_batch_added?: number
  last_batch_added_replies?: number

  error?: string | null
  _meta?: { saved_file?: string }
}

/** Ringkasan sesi untuk daftar (GET /list). */
export interface CheckpointSessionSummary {
  session_id: string
  url: string
  shortcode: string
  owner_username: string
  status: 'active' | 'completed' | 'error'
  has_more: boolean
  total_comments: number
  total_replies: number
  batch_count: number
  created_at: string
  updated_at: string
}

/** Request mulai sesi checkpoint baru. */
export interface StartCheckpointRequest {
  url: string
  /** Jumlah komentar per batch (10–1000) */
  batch_size: number
  include_replies: boolean
  max_replies_per_comment: number
}

// ════════════════════════════════════════════════════════════════
// SEARCH (keyword / hashtag) TYPES
// ════════════════════════════════════════════════════════════════

export interface SearchPostItem {
  media_id: string
  shortcode: string
  url: string
  owner_username: string
  owner_full_name: string
  owner_is_verified: boolean
  caption: string
  like_count: number
  comment_count: number
  view_count: number
  play_count: number
  taken_at: number
  taken_at_iso: string
  media_type: 'PHOTO' | 'VIDEO' | 'CAROUSEL' | 'UNKNOWN'
  product_type: string
  thumbnail_url: string
  is_video: boolean
  source: 'top' | 'recent'
  rank: number
  /** Hanya ada di hasil keyword (agregasi multi-hashtag) */
  hashtag?: string
}

export interface HashtagSuggestion {
  name: string
  media_count: number
  formatted_media_count: string
  id: string
  search_result_subtitle: string
}

export interface UserSuggestion {
  username: string
  full_name: string
  profile_pic_url: string
  is_verified: boolean
  is_private: boolean
  follower_count: number
}

export interface PlaceSuggestion {
  name: string
  address: string
  city: string
}

export interface DiscoverResult {
  query: string
  scraped_at: string
  success: boolean
  hashtags: HashtagSuggestion[]
  users: UserSuggestion[]
  places: PlaceSuggestion[]
  error: string | null
  _meta?: { elapsed_seconds?: number }
}

export interface HashtagSearchResult {
  query: string
  hashtag: string
  media_count: number
  formatted_media_count: string
  scraped_at: string
  scraped_date: string
  success: boolean
  top_count: number
  recent_count: number
  total_fetched: number
  posts: SearchPostItem[]
  related_hashtags: HashtagSuggestion[]
  error: string | null
  _meta?: { saved_file?: string; elapsed_seconds?: number }
}

export type KeywordSearchedHashtag = {
  hashtag: string
  method?: string
  fetched?: number
}

export interface KeywordSearchResult {
  query: string
  scraped_at: string
  scraped_date: string
  success: boolean
  searched_hashtags: Array<string | KeywordSearchedHashtag>
  suggested_hashtags: HashtagSuggestion[]
  suggested_users: UserSuggestion[]
  total_fetched: number
  posts: SearchPostItem[]
  error: string | null
  _meta?: { saved_file?: string; elapsed_seconds?: number }
}

export interface DiscoverRequest {
  query: string
}

export interface SearchHashtagRequest {
  hashtag: string
  max_posts?: number
  include_top?: boolean
  include_recent?: boolean
  recent_pages?: number
}

export interface SearchKeywordRequest {
  keyword: string
  max_posts?: number
  max_hashtags?: number
  per_hashtag_pages?: number
  include_recent?: boolean
}

// ════════════════════════════════════════════════════════════════
// DEEP SEARCH TYPES
// ════════════════════════════════════════════════════════════════

export type DeepJobStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'error'

export interface DeepSearchJob {
  job_id: string
  mode: 'hashtag' | 'keyword'
  query: string
  status: DeepJobStatus
  config: Record<string, unknown>
  created_at: string
  updated_at: string
  total_fetched: number
  error: string | null
}

export interface DeepSearchJobSummary {
  job_id: string
  mode: 'hashtag' | 'keyword'
  query: string
  status: DeepJobStatus
  total_fetched: number
  created_at: string
  updated_at: string
}

export interface DeepHashtagRequest {
  hashtag: string
  max_related_hashtags?: number
  include_top?: boolean
}

export interface DeepKeywordRequest {
  keyword: string
  max_hashtags?: number
}

// ════════════════════════════════════════════════════════════════
// PROFILE DEEP SCRAPE TYPES
// ════════════════════════════════════════════════════════════════

export interface ScrapeProfileDeepRequest {
  username: string
  date_from?: string | null
  date_to?: string | null
  max_posts?: number
  max_comments?: number
  include_replies?: boolean
  max_replies_per_comment?: number
  scrape_likers?: boolean
  max_likers?: number
  aggressive_likers?: boolean
  delay_between_posts?: number
}

export interface DeepScrapePostEntry {
  index: number
  url: string
  shortcode: string
  taken_at: number
  taken_at_iso: string
  media_type: string
  feed_like_count: number
  feed_comment_count: number
  feed_view_count: number
  feed_caption: string
  thumbnail_url?: string
  scraped: boolean
  error: string | null
  data: Record<string, unknown> | null
}

export interface DeepScrapeComment {
  number: number
  username: string
  text: string
  comment_id: string
  like_count: number
  created_at: number
  reply_count: number
  is_reply: boolean
  parent_comment_id: string
  category: string
  sentiment: string
  language: string
  is_hate_speech: boolean
  is_toxic: boolean
  is_sarcasm: boolean
  is_wellwish: boolean
  emojis: string[]
  hate_words: string[]
  toxic_words: string[]
  positive_words: string[]
  negative_words: string[]
  ml_confidence: number
  decision_source: string
  vader_compound: number
  replies?: DeepScrapeComment[]
}

export interface DeepScrapeLiker {
  user_id: string
  username: string
  full_name: string
  is_verified: boolean
  is_private: boolean
  profile_pic_url?: string
}

export interface DeepScrapePostData {
  url: string
  shortcode: string
  caption: string
  likes: number
  owner_username: string
  media_id: string
  media_type: string
  comments: DeepScrapeComment[]
  comments_count: number
  replies_count: number
  likers: DeepScrapeLiker[]
  likers_fetched: number
  [key: string]: unknown
}

export interface DeepScrapeError {
  phase?: string
  url?: string
  error: string
}

export interface DeepScrapeResult {
  success: boolean
  username: string
  date_from: string | null
  date_to: string | null
  scraped_at: string
  total_posts_found: number
  total_posts_scraped: number
  total_comments: number
  total_replies: number
  total_likers: number
  posts: DeepScrapePostEntry[]
  errors: DeepScrapeError[]
  saved_file: string
  elapsed_seconds: number
}