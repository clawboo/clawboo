import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon — must stay as a server-side external
  serverExternalPackages: ['better-sqlite3'],
}

export default nextConfig
