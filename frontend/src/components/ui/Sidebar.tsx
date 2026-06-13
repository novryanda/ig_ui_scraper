'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Search, Users, BarChart2, FileJson,
  Settings, Wifi, WifiOff, ChevronRight, Hash, Layers, PanelLeftClose,
} from 'lucide-react'
import { IGLogoFilled } from '@/components/ui/IGLogo'
import { clsx } from 'clsx'
import { getHealth, getSession } from '@/lib/api'

const NAV = [
  { href: '/main/dashboard',    label: 'Dashboard',     icon: LayoutDashboard },
  { href: '/main/scrapes',      label: 'Scrape Post',   icon: Search },
  { href: '/main/search',       label: 'Search',        icon: Hash },
  { href: '/main/deep-scrape',  label: 'Deep Scrape',   icon: Layers },
  { href: '/main/profiles',     label: 'Profiles',      icon: Users },
  { href: '/main/analytics',    label: 'Analytics',     icon: BarChart2 },
  { href: '/main/files',        label: 'Output Files',  icon: FileJson },
  { href: '/main/settings',     label: 'Settings',      icon: Settings },
]

export function Sidebar({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const pathname = usePathname()
  const [engineOk, setEngineOk]       = useState(false)
  const [sessionUser, setSessionUser] = useState<string | null>(null)

  const check = useCallback(async () => {
    try {
      const res = await getHealth()
      setEngineOk(res.success === true && res.data?.api === 'running')
    } catch {
      setEngineOk(false)
    }
    try {
      const s = await getSession()
      setSessionUser(s.data?.user_id ?? null)
    } catch {
      setSessionUser(null)
    }
  }, [])

  useEffect(() => {
    check()
    const id = setInterval(check, 30_000)
    return () => clearInterval(id)
  }, [check])

  return (
    <aside
      className={clsx(
        'fixed left-0 top-0 h-full w-64 flex flex-col z-50 transition-transform duration-300',
        open ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="absolute inset-0 glass border-r border-white/[0.07]" />

      <div className="relative flex flex-col h-full px-4 py-6">

        {/* ── Logo + tombol sembunyikan ── */}
        <div className="flex items-center justify-between mb-8 px-2 gap-2">
          <Link href="/main/dashboard" className="flex items-center gap-3 min-w-0">
            <IGLogoFilled size={40} />
            <div className="min-w-0">
              <p
                className="font-display font-800 text-lg leading-none"
                style={{ fontFamily: 'var(--font-display)', fontWeight: 800 }}
              >
                <span className="ig-text">IG Scraper</span>
              </p>
              <p className="text-[11px] text-white/40 mt-0.5">Analytics Dashboard</p>
            </div>
          </Link>
          <button
            onClick={onToggle}
            title="Sembunyikan sidebar"
            aria-label="Sembunyikan sidebar"
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>

        {/* ── Engine badge ── */}
        <div className="glass rounded-xl px-3 py-2.5 mb-6 flex items-center gap-2.5">
          <div
            className={clsx(
              'w-2 h-2 rounded-full shrink-0',
              engineOk
                ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]'
                : 'bg-red-400',
            )}
          />
          <div className="min-w-0">
            <p className="text-[11px] text-white/40 leading-none mb-0.5">Engine</p>
            <p className="text-xs font-medium truncate">
              {engineOk ? (sessionUser ?? 'Connected') : 'Disconnected'}
            </p>
          </div>
          {engineOk
            ? <Wifi size={14} className="text-emerald-400 ml-auto shrink-0" />
            : <WifiOff size={14} className="text-red-400 ml-auto shrink-0" />
          }
        </div>

        {/* ── Nav ── */}
        <nav className="flex-1 space-y-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active =
              pathname === href ||
              (href !== '/main/dashboard' && pathname.startsWith(href))

            const isSearch = href === '/main/search'
            const isDeepScrape = href === '/main/deep-scrape'

            return (
              <Link
                key={href}
                href={href}
                className={clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 group relative',
                  active
                    ? 'bg-white/8 border border-white/12'
                    : 'hover:bg-white/4 border border-transparent',
                )}
              >
                {/* Left accent bar */}
                {active && (
                  <div
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r-full"
                    style={{ background: 'var(--ig-grad)' }}
                  />
                )}

                <Icon
                  size={18}
                  className={clsx(
                    'shrink-0 transition-colors',
                    active
                      ? 'text-white'
                      : isSearch
                        ? 'text-pink-400/70 group-hover:text-pink-300'
                        : isDeepScrape
                          ? 'text-purple-400/70 group-hover:text-purple-300'
                          : 'text-white/40 group-hover:text-white/70',
                  )}
                />

                <span
                  className={clsx(
                    'text-sm font-medium flex-1',
                    active
                      ? 'text-white'
                      : isSearch
                        ? 'text-pink-300/80 group-hover:text-pink-200'
                        : isDeepScrape
                          ? 'text-purple-300/80 group-hover:text-purple-200'
                          : 'text-white/50 group-hover:text-white/80',
                  )}
                >
                  {label}
                </span>

                {/* Badge "NEW" untuk Search & Deep Scrape (hanya kalau tidak active) */}
                {isSearch && !active && (
                  <span
                    className="text-[9px] font-bold px-1.5 py-0.5 rounded-full
                               bg-pink-500/20 border border-pink-500/30 text-pink-300
                               tracking-wide"
                  >
                    NEW
                  </span>
                )}
                {isDeepScrape && !active && (
                  <span
                    className="text-[9px] font-bold px-1.5 py-0.5 rounded-full
                               bg-purple-500/20 border border-purple-500/30 text-purple-300
                               tracking-wide"
                  >
                    NEW
                  </span>
                )}

                {active && <ChevronRight size={14} className="text-white/30" />}
              </Link>
            )
          })}
        </nav>

        {/* ── Footer ── */}
        <div className="pt-4 border-t border-white/6">
          <div className="text-[10px] text-white/20 text-center">
            IG Scraper v16.1 · FastAPI Bridge
          </div>
        </div>
      </div>
    </aside>
  )
}