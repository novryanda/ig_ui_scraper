import type { ReactNode } from 'react'
import { MainShell } from '@/components/ui/MainShell'

export default function MainLayout({ children }: { children: ReactNode }) {
  return <MainShell>{children}</MainShell>
}
