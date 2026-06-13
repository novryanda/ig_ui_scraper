'use client'

import { useState, useMemo, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle,
  Search,
  Loader2,
  AlertCircle,
  Clock,
  ShieldCheck,
  Lock,
  Download,
  ExternalLink,
  Filter,
  Users,
} from 'lucide-react'
import { scrapeFollowingVerified } from '@/lib/api'
import type { FollowerItem, FollowingVerifiedResult } from '@/types'
import { IGLogoFilled } from '@/components/ui/IGLogo'
import { scrapeStore, useScrapeTask } from '@/lib/scrapeStore'

const VERIFIED_KEY = 'verified-following:main'

function useScrapeStatus() {
  return useSyncExternalStore(
    scrapeStore.subscribe,
    () => scrapeStore.isBusy(),
    () => false,
  )
}

export default function VerifiedFollowingPage() {
  const router = useRouter()

  const [username, setUsername] = useState('')
  const [maxCount, setMaxCount] = useState(500)

  // Hasil + status persist lintas-navigasi via scrapeStore.
  const task     = useScrapeTask<FollowingVerifiedResult>(VERIFIED_KEY)
  const scraping = task.status === 'running'
  const result   = task.status === 'success' ? task.data : null
  const [validationError, setValidationError] = useState('')
  const [warning, setWarning] = useState('')
  const error = validationError || (task.status === 'error' ? (task.error ?? '') : '')

  const [search, setSearch] = useState('')
  const [onlyPublic, setOnlyPublic] = useState(false)

  const globalBusy = useScrapeStatus()

  // Peringatan derive reaktif (tanpa setState-in-effect): muncul saat ada
  // proses LAIN berjalan, dan hilang sendiri saat selesai.
  const busyInfo    = scrapeStore.get()
  const foreignBusy = globalBusy && task.status !== 'running'
  const warningMsg  = warning || (foreignBusy
    ? `Masih ada proses scraping berjalan (${busyInfo.kind}: ${busyInfo.label}). Tunggu sampai selesai sebelum memulai scrape baru.`
    : '')

  async function handleScrape() {
    if (scrapeStore.isBusy()) {
      setWarning('Tunggu dulu — proses scraping sebelumnya belum selesai.')
      return
    }

    const u = username.trim().replace('@', '')
    if (!u) {
      setValidationError('Masukkan username')
      return
    }
    if (maxCount < 1 || maxCount > 2000) {
      setValidationError('max_count harus antara 1 – 2000')
      return
    }

    setValidationError('')
    setWarning('')

    const res = await scrapeStore.run<FollowingVerifiedResult>(
      VERIFIED_KEY,
      'profile',
      `verified @${u}`,
      async () => {
        const resp = await scrapeFollowingVerified(u, maxCount)
        if (!resp.success) throw new Error(resp.message)

        const payload = resp.data as
          | ({ following_verified?: FollowingVerifiedResult } & FollowingVerifiedResult)
          | undefined
        const data = payload?.following_verified ?? payload
        if (!data) throw new Error('Response kosong')
        return data as FollowingVerifiedResult
      },
    )

    if (res.busy) setWarning('Tunggu dulu — proses scraping sebelumnya belum selesai.')
  }

  // ── FIX: dedup by user_id/username sebelum filter ──────────────────────
  const filteredItems = useMemo<FollowerItem[]>(() => {
    if (!result?.items) return []

    // Hapus duplikat berdasarkan user_id (atau username sebagai fallback)
    const seen = new Set<string>()
    const deduped = result.items.filter((it) => {
      const key = it.user_id || it.username
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })

    const q = search.trim().toLowerCase()
    return deduped.filter((it) => {
      if (onlyPublic && it.is_private) return false
      if (!q) return true
      return (
        it.username.toLowerCase().includes(q) ||
        (it.full_name || '').toLowerCase().includes(q)
      )
    })
  }, [result, search, onlyPublic])

  function downloadJSON() {
    if (!result) return
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `verified_following_${result.username}_${result.scraped_date}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function downloadCSV() {
    if (!result?.items?.length) return
    const headers = [
      'username',
      'full_name',
      'user_id',
      'is_verified',
      'is_private',
      'profile_url',
    ]
    const rows = result.items.map((it) =>
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
    a.download = `verified_following_${result.username}_${result.scraped_date}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const disabled = scraping || globalBusy
  const scanRatio = result?.total_scanned
    ? ((result.count / result.total_scanned) * 100).toFixed(2)
    : '0.00'

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center gap-3 mb-8">
        <IGLogoFilled size={36} />
        <div>
          <h1
            className="text-2xl font-bold flex items-center gap-2"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Verified Following
            <ShieldCheck size={22} className="text-blue-400" />
          </h1>
          <p className="text-sm text-white/40">
            Scrape akun verified yang di-follow oleh user tertentu
          </p>
        </div>
      </div>

      {globalBusy && !scraping && (
        <div className="glass-card p-4 mb-6 flex items-start gap-3 border border-yellow-500/20">
          <Clock size={18} className="text-yellow-400 shrink-0 mt-0.5 animate-pulse" />
          <div className="flex-1">
            <p className="text-sm text-yellow-300 font-medium">
              Scraping masih berjalan
            </p>
            <p className="text-xs text-white/50 mt-0.5">
              Proses scraping sebelumnya belum selesai. Tunggu dulu sebelum
              memulai scrape baru.
            </p>
            <button
              onClick={() => router.push('/main/files')}
              className="btn-glass text-xs mt-2"
            >
              Lihat Output Files
            </button>
          </div>
        </div>
      )}

      <div className="glass-card p-6 mb-6">
        <h2 className="font-semibold mb-4 text-sm uppercase tracking-widest text-white/50">
          Scrape Verified Following
        </h2>

        <div className="grid md:grid-cols-[1fr_180px_auto] gap-3">
          <div className="relative">
            <input
              type="text"
              value={username}
              disabled={disabled}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username atau URL profile (mis. @prabowo)"
              className="input-glass pl-8 disabled:opacity-50"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !disabled) handleScrape()
              }}
            />
          </div>

          <div className="relative">
            <input
              type="number"
              value={maxCount}
              disabled={disabled}
              min={1}
              max={2000}
              onChange={(e) => setMaxCount(parseInt(e.target.value) || 0)}
              placeholder="Target verified"
              className="input-glass disabled:opacity-50"
              title="Maksimal jumlah verified yang ingin diambil"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-white/30 pointer-events-none">
              max verified
            </span>
          </div>

          <button
            onClick={handleScrape}
            disabled={disabled}
            className="btn-ig flex items-center gap-2 px-5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {disabled ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Search size={16} />
            )}
            {scraping
              ? 'Scanning...'
              : globalBusy
              ? 'Menunggu...'
              : 'Scrape'}
          </button>
        </div>

        <p className="text-xs text-white/40 mt-3 leading-relaxed">
          💡 Backend akan scan sampai <b>10×</b> dari target untuk menemukan
          akun verified (cap 5000 following). Proses bisa <b>5–15 menit</b>{' '}
          untuk akun dengan following besar. Hindari nilai max terlalu tinggi
          agar tidak kena rate-limit.
        </p>

        {warningMsg && (
          <div className="mt-3 flex items-center gap-2 text-yellow-300 text-sm glass rounded-xl px-4 py-2.5">
            <Clock size={14} /> {warningMsg}
          </div>
        )}
        {error && (
          <div className="mt-3 flex items-center gap-2 text-red-400 text-sm glass rounded-xl px-4 py-2.5">
            <AlertCircle size={14} /> {error}
          </div>
        )}
      </div>

      {scraping && (
        <div className="glass-card p-8 mb-6 text-center">
          <Loader2 size={32} className="mx-auto mb-4 animate-spin text-blue-400" />
          <p className="text-sm text-white/70 font-medium mb-1">
            Sedang scanning following...
          </p>
          <p className="text-xs text-white/40">
            Ini bisa makan beberapa menit. Jangan tutup tab — tapi kamu bisa
            navigasi ke halaman lain, hasil tetap tersimpan di Output Files saat
            selesai.
          </p>
        </div>
      )}

      {result && (
        <>
          <div className="glass-card p-6 mb-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-lg font-bold">@{result.username}</h3>
                  <ShieldCheck size={18} className="text-blue-400" />
                </div>
                <p className="text-xs text-white/40">
                  Di-scrape pada{' '}
                  {new Date(result.scraped_at).toLocaleString('id-ID')}
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={downloadCSV}
                  disabled={!result.items?.length}
                  className="btn-glass text-xs flex items-center gap-1.5 disabled:opacity-40"
                >
                  <Download size={12} /> CSV
                </button>
                <button
                  onClick={downloadJSON}
                  disabled={!result.items?.length}
                  className="btn-glass text-xs flex items-center gap-1.5 disabled:opacity-40"
                >
                  <Download size={12} /> JSON
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="glass rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-blue-400">
                  {result.count.toLocaleString('id-ID')}
                </p>
                <p className="text-xs text-white/40 mt-1">Verified found</p>
              </div>
              <div className="glass rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-white/80">
                  {(result.total_scanned || 0).toLocaleString('id-ID')}
                </p>
                <p className="text-xs text-white/40 mt-1">Total scanned</p>
              </div>
              <div className="glass rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-emerald-400">
                  {scanRatio}%
                </p>
                <p className="text-xs text-white/40 mt-1">Verified ratio</p>
              </div>
              <div className="glass rounded-xl p-4 text-center">
                <p
                  className={`text-2xl font-bold ${
                    result.success ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {result.success ? '✓' : '✗'}
                </p>
                <p className="text-xs text-white/40 mt-1">
                  {result.success ? 'Success' : 'Failed'}
                </p>
              </div>
            </div>

            {result.error && (
              <div className="mt-4 flex items-center gap-2 text-red-400 text-sm glass rounded-xl px-4 py-2.5">
                <AlertCircle size={14} /> {result.error}
              </div>
            )}
          </div>

          {result.items?.length > 0 && (
            <div className="glass-card p-4 mb-4 flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-50">
                <Filter
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
                Menampilkan {filteredItems.length} dari {result.items.length}
              </span>
            </div>
          )}

          <div className="glass-card p-6">
            <h2
              className="font-semibold mb-4 flex items-center gap-2"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              <CheckCircle size={18} className="text-blue-400" />
              Verified Following
              <span className="text-white/30 font-normal text-sm">
                ({filteredItems.length})
              </span>
            </h2>

            {filteredItems.length === 0 ? (
              <div className="text-center py-12 text-white/30 text-sm">
                <Users size={40} className="mx-auto mb-3 opacity-20" />
                <p>
                  {result.items?.length === 0
                    ? 'Tidak ada verified following ditemukan.'
                    : 'Tidak ada hasil sesuai filter.'}
                </p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {/* FIX: key pakai kombinasi user_id + idx agar selalu unik */}
                {filteredItems.map((item, idx) => (
                  <a
                    key={`${item.user_id || item.username}-${idx}`}
                    href={`https://www.instagram.com/${item.username}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="glass rounded-xl p-4 flex items-center gap-3 hover:bg-white/[0.07] transition-colors group"
                  >
                    <div className="w-12 h-12 rounded-full overflow-hidden glass shrink-0 flex items-center justify-center">
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
                        <Users size={18} className="text-white/30" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-sm truncate">
                          @{item.username}
                        </span>
                        <CheckCircle
                          size={13}
                          className="text-blue-400 shrink-0"
                        />
                        {item.is_private && (
                          <Lock
                            size={11}
                            className="text-yellow-400 shrink-0"
                          />
                        )}
                      </div>
                      {item.full_name && (
                        <p className="text-xs text-white/40 truncate">
                          {item.full_name}
                        </p>
                      )}
                    </div>

                    <ExternalLink
                      size={14}
                      className="text-white/20 group-hover:text-white/60 transition-colors shrink-0"
                    />
                  </a>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}