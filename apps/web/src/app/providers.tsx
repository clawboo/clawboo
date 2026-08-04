import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { useState } from 'react'
import { ThemeProvider } from '@/features/theme/ThemeProvider'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )

  return (
    <ThemeProvider>
      {/* Framer Motion does NOT honour `prefers-reduced-motion` on its own:
          `MotionConfigContext` ships `reducedMotion: "never"`, and
          `useReducedMotionConfig` short-circuits to `false` on that value. Every
          `motion.*` in the app therefore animated at full amplitude for users who
          asked for less, and several comments in this repo asserted the opposite.
          `"user"` defers to the OS setting, which suppresses transform/layout
          animation while still allowing opacity — so overlays keep a legible
          fade-in instead of popping, which is the documented framer behaviour and
          the accessible default. One provider covers every animated surface;
          per-component `useReducedMotion` checks stay valid on top of it. */}
      <MotionConfig reducedMotion="user">
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MotionConfig>
    </ThemeProvider>
  )
}
