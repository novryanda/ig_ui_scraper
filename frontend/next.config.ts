// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',  // ← BARIS BARU, WAJIB untuk Docker
  turbopack: {
    // Pin the project root so Next.js stops guessing between this folder
    // and the stray package-lock.json in the home directory.
    root: __dirname,
  },
  async redirects() {
    return [
      {
        source: '/dashboard',
        destination: '/main/dashboard',
        permanent: true,
      },
    ]
  },
}

export default nextConfig