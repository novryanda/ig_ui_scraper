'use client'

import { Suspense, useState, useSyncExternalStore, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Heart, Link2, Loader2, AlertCircle, Clock,
  Download, Search, Users, BadgeCheck, Lock,
  ChevronDown, ChevronUp, ExternalLink, ShieldCheck,
  FileJson, FileText,
} from 'lucide-react'
import {
  scrapePostLikers,
  downloadLikersInline,
  downloadLikersJson,
  downloadLikersCsv,
} from '@/lib/api'
import type { LikersResult, LikerItem } from '@/types'
import { IGLogoFilled } from '@/components/ui/IGLogo'
import { scrapeStore, useScrapeTask } from '@/lib/scrapeStore'

const LIKERS_KEY = 'likers:main'

function useScrapeStatus() {
  return useSyncExternalStore(
    scrapeStore.subscribe,
    () => scrapeStore.isBusy(),
    () => false,
  )
}

// ── Komponen NumberInput ────────────────────────────────────────
interface NumberInputProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  onChange: (v: number) => void
  description?: string
  accentColor?: 'pink' | 'red' | 'orange'
}

function NumberInput({
  label, value, min, max, step, disabled, onChange, description, accentColor = 'pink',
}: NumberInputProps) {
  const [raw, setRaw] = useState(String(value))
  const accentMap = {
    pink:   'accent-pink-500',
    red:    'accent-red-500',
    orange: 'accent-orange-500',
  }
  const borderMap = {
    pink:   'border-pink-500/40 focus:border-pink-500',
    red:    'border-red-500/40 focus:border-red-500',
    orange: 'border-orange-500/40 focus:border-orange-500',
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
    setRaw(v)
    const n = parseInt(v, 10)
    if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
  }

  function handleBlur() {
    const n = parseInt(raw, 10)
    const clamped = isNaN(n) ? min : Math.min(max, Math.max(min, n))
    setRaw(String(clamped))
    onChange(clamped)
  }

  return (
    <div>
      <label className="block text-xs text-white/50 mb-1 uppercase tracking-widest">{label}</label>
      {description && <p className="text-[11px] text-white/30 mb-2">{description}</p>}
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min} max={max} step={step} value={value}
          disabled={disabled}
          onChange={e => { onChange(Number(e.target.value)); setRaw(e.target.value) }}
          className={`flex-1 ${accentMap[accentColor]} h-1.5 disabled:opacity-30`}
        />
        <input
          type="number"
          min={min} max={max} step={step} value={raw}
          disabled={disabled}
          onChange={handleChange}
          onBlur={handleBlur}
          className={`w-20 shrink-0 bg-white/5 border rounded-xl px-3 py-1.5 text-sm text-white text-center outline-none transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${borderMap[accentColor]}`}
        />
      </div>
      <div className="flex justify-between text-[10px] text-white/20 mt-1">
        <span>{min === 0 ? 'semua' : min}</span>
        <span>{Math.round((min + max) / 2)}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

// ── Komponen StatCard kecil ─────────────────────────────────────
function StatBadge({
  icon, label, value, color,
}: {
  icon: React.ReactNode
  label: string
  value: string | number
  color: string
}) {
  return (
    <div className="glass rounded-xl p-4 flex flex-col items-center gap-1 text-center">
      <div className={color}>{icon}</div>
      <p className={`text-xl font-bold ${color}`}>
        {typeof value === 'number' ? value.toLocaleString('id-ID') : value}
      </p>
      <p className="text-[11px] text-white/40">{label}</p>
    </div>
  )
}

// ── Komponen LikerRow ───────────────────────────────────────────
function LikerRow({ liker, index }: { liker: LikerItem; index: number }) {
  const profileUrl = `https://www.instagram.com/${liker.username}/`
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-white/5 last:border-0 group">
      <span className="text-xs text-white/20 w-8 shrink-0 text-right">{index + 1}</span>

      {/* Avatar placeholder / foto profil */}
      {liker.profile_pic_url ? (
        <img
          src={liker.profile_pic_url}
          alt={liker.username}
          className="w-8 h-8 rounded-full object-cover bg-white/10 shrink-0"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ) : (
        <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center shrink-0">
          <Users size={14} className="text-white/30" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-white/80 truncate">
            @{liker.username}
          </span>
          {liker.is_verified && (
            <BadgeCheck size={14} className="text-blue-400 shrink-0" />
          )}
          {liker.is_private && (
            <Lock size={12} className="text-white/30 shrink-0" />
          )}
        </div>
        {liker.full_name && (
          <p className="text-xs text-white/35 truncate">{liker.full_name}</p>
        )}
      </div>

      <a
        href={profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="opacity-0 group-hover:opacity-100 transition-opacity btn-glass text-xs flex items-center gap-1 shrink-0 py-1"
      >
        <ExternalLink size={11} /> Profil
      </a>
    </div>
  )
}

// ── Download Button ─────────────────────────────────────────────
function DownloadBtn({
  label, icon, onClick, disabled, variant = 'glass',
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'glass' | 'primary'
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
        variant === 'primary'
          ? 'bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 border border-pink-500/30'
          : 'btn-glass'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════
function LikersContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // ── Form State ────────────────────────────────────────────────
  const [url, setUrl]             = useState('')
  const [maxLikers, setMaxLikers] = useState(0)          // 0 = semua
  const [checkpointSize, setCheckpointSize]               = useState(200)
  const [checkpointDelayMin, setCheckpointDelayMin]       = useState(8)
  const [checkpointDelayMax, setCheckpointDelayMax]       = useState(15)
  const [pageDelayMin, setPageDelayMin]                   = useState(1.5)
  const [pageDelayMax, setPageDelayMax]                   = useState(3.0)
  const [showAdvanced, setShowAdvanced]                   = useState(false)

  // ── Read ?url= param on mount ─────────────────────────────────
  useEffect(() => {
    const u = searchParams.get('url')
    if (u) setUrl(u)
  }, [searchParams])

  // ── UI State ──────────────────────────────────────────────────
  // Hasil + status persist lintas-navigasi via scrapeStore.
  const task    = useScrapeTask<LikersResult>(LIKERS_KEY)
  const loading = task.status === 'running'
  const result  = task.status === 'success' ? task.data : null
  const [localError, setLocalError] = useState('')   // error validasi / download
  const [warning, setWarning]       = useState('')
  const error = localError || (task.status === 'error' ? (task.error ?? '') : '')

  // ── Liker List UI ─────────────────────────────────────────────
  const [search, setSearch]                 = useState('')
  const [filterVerified, setFilterVerified] = useState(false)
  const [filterPrivate, setFilterPrivate]   = useState<'all' | 'public' | 'private'>('all')
  const [showAll, setShowAll]               = useState(false)

  // ── Download State ────────────────────────────────────────────
  const [downloading, setDownloading] = useState(false)

  const globalBusy = useScrapeStatus()
  const disabled   = loading || globalBusy

  // ── Filtered likers ──────────────────────────────────────────
  const filtered = (result?.likers ?? []).filter(l => {
    if (filterVerified && !l.is_verified) return false
    if (filterPrivate === 'public'  &&  l.is_private) return false
    if (filterPrivate === 'private' && !l.is_private) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        l.username.toLowerCase().includes(q) ||
        l.full_name.toLowerCase().includes(q)
      )
    }
    return true
  })

  const DISPLAY_LIMIT = 50
  const displayed = showAll ? filtered : filtered.slice(0, DISPLAY_LIMIT)

  // ── Scrape ───────────────────────────────────────────────────
  async function handleScrape() {
    if (scrapeStore.isBusy()) {
      setWarning('Tunggu dulu — proses scraping sebelumnya belum selesai.')
      return
    }
    if (!url.trim()) {
      setLocalError('Masukkan URL post Instagram')
      return
    }
    if (checkpointDelayMin > checkpointDelayMax) {
      setLocalError('Checkpoint delay min tidak boleh > max')
      return
    }

    setLocalError('')
    setWarning('')
    setSearch('')
    setFilterVerified(false)
    setFilterPrivate('all')
    setShowAll(false)

    const label = url.trim()
    // scrapeStore.run() menjaga proses + hasil tetap hidup walau pindah halaman.
    const res = await scrapeStore.run<LikersResult>(
      LIKERS_KEY,
      'likers',
      label,
      async () => {
        const resp = await scrapePostLikers({
          url: url.trim(),
          max_likers: maxLikers,
          checkpoint_size: checkpointSize,
          checkpoint_delay_min: checkpointDelayMin,
          checkpoint_delay_max: checkpointDelayMax,
          page_delay_min: pageDelayMin,
          page_delay_max: pageDelayMax,
        })
        if (!resp.success) throw new Error(resp.message)
        return resp.data
      },
    )

    if (res.busy) setWarning('Tunggu dulu — proses scraping sebelumnya belum selesai.')
  }

  // ── Download helpers ─────────────────────────────────────────
  async function handleDownloadCsvInline() {
    if (!result?.likers?.length) return
    setDownloading(true)
    try {
      const hint = result.owner_username
        ? `likers_${result.owner_username}_${result.shortcode}`
        : `likers_${result.shortcode}`
      await downloadLikersInline(result.likers, hint)
    } catch (e: unknown) {
      setLocalError(e instanceof Error ? e.message : 'Download gagal')
    } finally {
      setDownloading(false)
    }
  }

  function handleDownloadJsonServer() {
    const filename = result?._meta?.saved_file
    if (!filename) return
    window.open(downloadLikersJson(filename), '_blank')
  }

  function handleDownloadCsvServer() {
    const filename = result?._meta?.saved_file
    if (!filename) return
    window.open(downloadLikersCsv(filename), '_blank')
  }

  const verifiedCount = result?.likers.filter(l => l.is_verified).length ?? 0
  const privateCount  = result?.likers.filter(l => l.is_private).length  ?? 0
  const publicCount   = (result?.likers_fetched ?? 0) - privateCount

  return (
    <div className="p-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="relative">
          <IGLogoFilled size={36} />
          <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-pink-500 rounded-full flex items-center justify-center">
            <Heart size={9} className="text-white fill-white" />
          </div>
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>
            Scrape Likers
          </h1>
          <p className="text-sm text-white/40">Ambil daftar pengguna yang like sebuah postingan Instagram</p>
        </div>
      </div>

      {/* Banner proses masih berjalan */}
      {globalBusy && !loading && (
        <div className="glass-card p-4 mb-6 flex items-start gap-3 border border-yellow-500/20">
          <Clock size={18} className="text-yellow-400 shrink-0 mt-0.5 animate-pulse" />
          <div className="flex-1">
            <p className="text-sm text-yellow-300 font-medium">Scraping masih berjalan</p>
            <p className="text-xs text-white/50 mt-0.5">
              Proses sebelumnya belum selesai. Hasil otomatis tersimpan di Output Files.
            </p>
            <button onClick={() => router.push('/main/files')} className="btn-glass text-xs mt-2">
              Lihat Output Files
            </button>
          </div>
        </div>
      )}

      {/* ── Input Card ─────────────────────────────────────────── */}
      <div className="glass-card p-6 mb-6">

        {/* URL */}
        <div className="mb-6">
          <label className="block text-xs text-white/50 mb-2 uppercase tracking-widest">URL Post / Reel</label>
          <div className="relative">
            <Link2 size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://www.instagram.com/p/xxxxxxx/"
              className="input-glass pl-10"
              disabled={disabled}
              onKeyDown={e => e.key === 'Enter' && handleScrape()}
            />
          </div>
        </div>

        {/* Max Likers */}
        <div className="mb-6">
          <NumberInput
            label="Max Likers"
            description="0 = ambil semua yang bisa dijangkau endpoint (biasanya ~200–500 teratas)"
            value={maxLikers}
            min={0}
            max={2000}
            step={50}
            disabled={disabled}
            accentColor="pink"
            onChange={setMaxLikers}
          />
        </div>

        {/* Divider */}
        <div className="border-t border-white/5 mb-5" />

        {/* Advanced Settings Toggle */}
        <button
          onClick={() => setShowAdvanced(v => !v)}
          disabled={disabled}
          className="w-full flex items-center justify-between text-xs text-white/40 hover:text-white/60 transition-colors mb-2 disabled:opacity-50"
        >
          <span className="uppercase tracking-widest flex items-center gap-2">
            <ShieldCheck size={13} /> Pengaturan Anti-Deteksi
          </span>
          {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {showAdvanced && (
          <div className="space-y-5 pt-4 pb-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <NumberInput
                label="Checkpoint Size"
                description="Jeda panjang setiap N liker (anti-throttle)"
                value={checkpointSize}
                min={50}
                max={500}
                step={50}
                disabled={disabled}
                accentColor="orange"
                onChange={setCheckpointSize}
              />

              <div className="space-y-4">
                <NumberInput
                  label="Checkpoint Delay Min (detik)"
                  value={checkpointDelayMin}
                  min={3}
                  max={30}
                  step={1}
                  disabled={disabled}
                  accentColor="orange"
                  onChange={v => setCheckpointDelayMin(Math.min(v, checkpointDelayMax))}
                />
                <NumberInput
                  label="Checkpoint Delay Max (detik)"
                  value={checkpointDelayMax}
                  min={checkpointDelayMin}
                  max={60}
                  step={1}
                  disabled={disabled}
                  accentColor="orange"
                  onChange={setCheckpointDelayMax}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <NumberInput
                label="Page Delay Min (detik)"
                value={pageDelayMin}
                min={0.5}
                max={5}
                step={0.5}
                disabled={disabled}
                accentColor="red"
                onChange={v => setPageDelayMin(Math.min(v, pageDelayMax))}
              />
              <NumberInput
                label="Page Delay Max (detik)"
                value={pageDelayMax}
                min={pageDelayMin}
                max={10}
                step={0.5}
                disabled={disabled}
                accentColor="red"
                onChange={setPageDelayMax}
              />
            </div>

            {/* Info box */}
            <div className="glass rounded-xl px-4 py-3 text-xs text-white/35 leading-relaxed">
              <p className="font-medium text-white/50 mb-1">ℹ️ Tentang anti-deteksi</p>
              <p>
                Instagram membatasi scraping likers. Checkpoint = jeda panjang setiap {checkpointSize} liker
                ({checkpointDelayMin}–{checkpointDelayMax}s). Page delay = jeda antar halaman kecil
                ({pageDelayMin}–{pageDelayMax}s). Nilai lebih besar = lebih aman, lebih lambat.
              </p>
            </div>
          </div>
        )}

        <div className="border-t border-white/5 my-5" />

        {/* Scrape Button */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="glass rounded-xl px-3 py-2 text-xs text-white/40 flex items-center gap-2">
            <Heart size={12} className="text-pink-400" />
            <span>Max: <strong className="text-white/70">{maxLikers === 0 ? 'semua' : maxLikers.toLocaleString('id-ID')}</strong> liker</span>
          </div>
          <div className="flex-1" />
          <button
            onClick={handleScrape}
            disabled={disabled}
            className="btn-ig flex items-center gap-2 px-6 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {disabled ? <Loader2 size={16} className="animate-spin" /> : <Heart size={16} />}
            {loading ? 'Memproses...' : globalBusy ? 'Menunggu...' : 'Scrape Likers'}
          </button>
        </div>

        {warning && (
          <div className="mt-4 flex items-center gap-2 text-yellow-300 text-sm glass rounded-xl px-4 py-3">
            <Clock size={16} className="shrink-0" /> {warning}
          </div>
        )}
        {error && (
          <div className="mt-4 flex items-center gap-2 text-red-400 text-sm glass rounded-xl px-4 py-3">
            <AlertCircle size={16} className="shrink-0" /> {error}
          </div>
        )}
      </div>

      {/* ── Loading ─────────────────────────────────────────────── */}
      {loading && (
        <div className="glass-card p-12 text-center mb-6">
          <div className="relative w-16 h-16 mx-auto mb-4">
            <Heart size={64} className="text-pink-500/20" />
            <div className="absolute inset-0 animate-spin-slow">
              <div className="w-full h-full rounded-full border-2 border-transparent border-t-pink-500" />
            </div>
          </div>
          <p className="text-white/60 text-sm">Sedang mengambil daftar likers...</p>
          <p className="text-white/30 text-xs mt-1">
            {maxLikers === 0
              ? 'Mengambil semua liker yang tersedia — bisa makan waktu beberapa menit'
              : `Mengambil hingga ${maxLikers.toLocaleString('id-ID')} liker`}
          </p>
          <div className="flex justify-center gap-4 mt-4 flex-wrap">
            {['Buka halaman post', 'Ambil media ID', 'Fetch likers REST', 'Simpan hasil'].map((step, i) => (
              <div key={i} className="flex items-center gap-1 text-xs text-white/30">
                <div className="w-1.5 h-1.5 rounded-full bg-pink-500 animate-pulse" style={{ animationDelay: `${i * 0.4}s` }} />
                {step}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          HASIL
      ══════════════════════════════════════════════════════════ */}
      {result && (
        <div className="space-y-6">

          {/* Error / Warning dari backend */}
          {result.error && (
            <div className="glass-card p-4 border border-red-500/20 flex items-start gap-3">
              <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-red-300 font-medium">Backend error</p>
                <p className="text-xs text-white/40 mt-0.5">{result.error}</p>
              </div>
            </div>
          )}

          {/* Post Info */}
          <div className="glass-card p-6">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <h2 className="font-semibold text-lg" style={{ fontFamily: 'var(--font-display)' }}>
                  @{result.owner_username || 'unknown'}
                </h2>
                <p className="text-xs text-white/40 mt-0.5">
                  {result.shortcode} · Scraped {new Date(result.scraped_at).toLocaleString('id-ID')} · via {result.method}
                </p>
              </div>
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-glass text-xs flex items-center gap-1.5"
              >
                <Link2 size={12} /> Buka Post
              </a>
            </div>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatBadge
              icon={<Heart size={20} className="fill-current" />}
              label="Total Likes"
              value={result.likes_count}
              color="text-pink-400"
            />
            <StatBadge
              icon={<Users size={20} />}
              label="Liker Diambil"
              value={result.likers_fetched}
              color="text-purple-400"
            />
            <StatBadge
              icon={<BadgeCheck size={20} />}
              label="Akun Verified"
              value={verifiedCount}
              color="text-blue-400"
            />
            <StatBadge
              icon={<Lock size={20} />}
              label="Akun Private"
              value={privateCount}
              color="text-orange-400"
            />
          </div>

          {/* Coverage bar */}
          {result.likes_count > 0 && result.likers_fetched > 0 && (
            <div className="glass-card p-5">
              <div className="flex justify-between text-xs text-white/50 mb-2">
                <span>Coverage (liker diambil vs total likes)</span>
                <span className="text-pink-400 font-medium">
                  {Math.min(100, Math.round((result.likers_fetched / result.likes_count) * 100))}%
                </span>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${Math.min(100, (result.likers_fetched / result.likes_count) * 100)}%`,
                    background: 'linear-gradient(90deg, #ec4899, #a855f7)',
                  }}
                />
              </div>
              <p className="text-[11px] text-white/30 mt-2">
                IG hanya mengekspos ±200–500 liker teratas. Coverage penuh tidak mungkin untuk post dengan banyak likes.
              </p>
            </div>
          )}

          {/* Download Buttons */}
          {result.likers_fetched > 0 && (
            <div className="glass-card p-5">
              <p className="text-xs text-white/40 uppercase tracking-widest mb-3 flex items-center gap-2">
                <Download size={12} /> Unduh Data
              </p>
              <div className="flex flex-wrap gap-3">
                {/* CSV dari data client (selalu tersedia) */}
                <DownloadBtn
                  label="Download CSV (client)"
                  icon={<FileText size={14} />}
                  onClick={handleDownloadCsvInline}
                  disabled={downloading}
                  variant="primary"
                />

                {/* JSON & CSV dari server (tersedia jika ada saved_file) */}
                {result._meta?.saved_file && (
                  <>
                    <DownloadBtn
                      label="Download JSON (server)"
                      icon={<FileJson size={14} />}
                      onClick={handleDownloadJsonServer}
                    />
                    <DownloadBtn
                      label="Download CSV (server)"
                      icon={<FileText size={14} />}
                      onClick={handleDownloadCsvServer}
                    />
                  </>
                )}
              </div>
              {result._meta?.elapsed_seconds && (
                <p className="text-[11px] text-white/25 mt-3 flex items-center gap-1">
                  <Clock size={10} /> Selesai dalam {result._meta.elapsed_seconds}s
                  {result._meta.saved_file && ` · Disimpan: ${result._meta.saved_file}`}
                </p>
              )}
            </div>
          )}

          {/* Filter & Search */}
          {result.likers_fetched > 0 && (
            <div className="glass-card p-5">
              <div className="flex flex-wrap items-center gap-3 mb-5">
                {/* Search */}
                <div className="relative flex-1 min-w-50">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                  <input
                    type="text"
                    value={search}
                    onChange={e => { setSearch(e.target.value); setShowAll(false) }}
                    placeholder="Cari username atau nama..."
                    className="input-glass pl-9 text-sm py-2"
                  />
                </div>

                {/* Filter Verified */}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={filterVerified}
                      onChange={e => { setFilterVerified(e.target.checked); setShowAll(false) }}
                      className="sr-only peer"
                    />
                    <div className="w-8 h-4 rounded-full bg-white/10 peer-checked:bg-blue-500/60 transition-colors" />
                    <div className="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
                  </div>
                  <BadgeCheck size={13} className="text-blue-400" />
                  <span className="text-xs text-white/60">Verified only ({verifiedCount})</span>
                </label>

                {/* Filter Private/Public */}
                <div className="flex gap-1 glass rounded-xl p-1">
                  {(['all', 'public', 'private'] as const).map(opt => (
                    <button
                      key={opt}
                      onClick={() => { setFilterPrivate(opt); setShowAll(false) }}
                      className={`px-3 py-1 rounded-lg text-xs transition-all ${
                        filterPrivate === opt
                          ? 'bg-white/10 text-white'
                          : 'text-white/40 hover:text-white/60'
                      }`}
                    >
                      {opt === 'all' ? 'Semua' : opt === 'public' ? `Publik (${publicCount})` : `Private (${privateCount})`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Header info */}
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-white/40">
                  Menampilkan <strong className="text-white/60">{displayed.length}</strong>
                  {filtered.length !== result.likers_fetched && (
                    <span> dari <strong className="text-white/60">{filtered.length}</strong> hasil filter</span>
                  )}
                  {' '}(total {result.likers_fetched.toLocaleString('id-ID')} liker)
                </p>
                {filtered.length > DISPLAY_LIMIT && (
                  <button
                    onClick={() => setShowAll(v => !v)}
                    className="text-xs text-pink-400 hover:text-pink-300 flex items-center gap-1 transition-colors"
                  >
                    {showAll ? <><ChevronUp size={12} /> Tampilkan lebih sedikit</> : <><ChevronDown size={12} /> Tampilkan semua ({filtered.length})</>}
                  </button>
                )}
              </div>

              {/* List */}
              {displayed.length === 0 ? (
                <div className="text-center py-10 text-white/30 text-sm">
                  {search || filterVerified || filterPrivate !== 'all'
                    ? 'Tidak ada liker yang cocok dengan filter'
                    : 'Tidak ada liker'}
                </div>
              ) : (
                <div className="max-h-150 overflow-y-auto pr-1 space-y-0">
                  {displayed.map((liker, i) => (
                    <LikerRow key={liker.user_id || liker.username} liker={liker} index={i} />
                  ))}
                </div>
              )}

              {!showAll && filtered.length > DISPLAY_LIMIT && (
                <button
                  onClick={() => setShowAll(true)}
                  className="w-full mt-3 btn-glass text-sm py-2 flex items-center justify-center gap-2"
                >
                  <ChevronDown size={14} />
                  Tampilkan {filtered.length - DISPLAY_LIMIT} liker lainnya
                </button>
              )}
            </div>
          )}

          {/* Empty state */}
          {result.likers_fetched === 0 && !result.error && (
            <div className="glass-card p-10 text-center">
              <Heart size={40} className="text-white/15 mx-auto mb-3" />
              <p className="text-white/40 text-sm">Tidak ada liker yang berhasil diambil.</p>
              <p className="text-white/25 text-xs mt-1">
                Post mungkin privat, likes disembunyikan, atau session expired.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function LikersPage() {
  return (
    <Suspense fallback={null}>
      <LikersContent />
    </Suspense>
  )
}
