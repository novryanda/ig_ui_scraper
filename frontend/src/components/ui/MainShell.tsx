'use client'

import { useState, useEffect, type ReactNode } from 'react'
import { PanelLeft } from 'lucide-react'
import { clsx } from 'clsx'
import { Sidebar } from '@/components/ui/Sidebar'

/**
 * Wrapper client untuk seluruh halaman /main:
 *  - Menyimpan state sidebar (terbuka/tersembunyi).
 *  - Responsive: di layar kecil sidebar jadi overlay (default tertutup),
 *    di layar besar sidebar menggeser konten (default terbuka).
 */
export function MainShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true)

  // Default: tertutup di mobile, terbuka di desktop (≥ lg / 1024px).
  useEffect(() => {
    setOpen(window.innerWidth >= 1024)
  }, [])

  const toggle = () => setOpen(v => !v)

  return (
    <div className="min-h-screen">
      {/* Backdrop gelap saat sidebar terbuka di layar kecil */}
      {open && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <Sidebar open={open} onToggle={toggle} />

      {/* Tombol munculkan sidebar — tampil saat sidebar tersembunyi */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Tampilkan sidebar"
        title="Tampilkan sidebar"
        className={clsx(
          'fixed top-4 left-4 z-50 glass rounded-xl p-2.5 text-white/70 hover:text-white',
          'border border-white/10 shadow-lg transition-all',
          open ? 'opacity-0 pointer-events-none -translate-x-2' : 'opacity-100',
        )}
      >
        <PanelLeft size={20} />
      </button>

      <main
        className={clsx(
          'min-h-screen transition-[margin] duration-300',
          open ? 'lg:ml-64' : 'ml-0',
        )}
      >
        {children}
      </main>
    </div>
  )
}
