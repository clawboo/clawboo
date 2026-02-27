import type { Metadata } from 'next'
import { DM_Sans } from 'next/font/google'
import { GeistMono } from 'geist/font/mono'
import { FleetSidebar } from '@/features/fleet/FleetSidebar'
import { GatewayBootstrap } from '@/features/connection/GatewayBootstrap'
import { Providers } from './providers'
import './globals.css'

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Clawboo',
  description: 'Multi-agent mission control for OpenClaw',
  icons: {
    icon: '/favicon.svg',
    apple: '/favicon.svg',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${GeistMono.variable}`}>
      <head>
        {/* Cabinet Grotesk — display font via Fontshare */}
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@800,700,500,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          {/* Gateway connection overlay — mounts once for the whole app */}
          <GatewayBootstrap />
          <div className="flex h-screen overflow-hidden bg-background text-foreground">
            {/* Fleet sidebar */}
            <aside className="w-64 shrink-0 border-r border-border bg-surface">
              <FleetSidebar />
            </aside>
            {/* Main content area */}
            <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  )
}
