import { useContext } from 'react'
import { ThemeContext, type ThemeContextValue } from './ThemeProvider'

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    throw new Error(
      'useTheme() called outside of <ThemeProvider>. Wrap your tree in <ThemeProvider> in providers.tsx.',
    )
  }
  return ctx
}
