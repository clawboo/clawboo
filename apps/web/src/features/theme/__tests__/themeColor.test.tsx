// An installed dashboard (and a phone browser's toolbar) tints its title bar
// with `<meta name="theme-color">`. The shell ships the light background, the
// default for a fresh install; the theme provider keeps it on the background of
// whichever theme is showing, so a dark dashboard never sits under a light bar.

import { act, cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { THEME_COLORS, ThemeProvider, THEME_STORAGE_KEY } from '../ThemeProvider'
import { useTheme } from '../useTheme'

let setTheme: ((next: 'light' | 'dark' | 'system') => void) | null = null

function Grab() {
  setTheme = useTheme().setTheme
  return null
}

const themeColor = () =>
  document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null

beforeEach(() => {
  localStorage.clear()
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = THEME_COLORS.light
  document.head.append(meta)
})
afterEach(() => {
  cleanup()
  document.querySelector('meta[name="theme-color"]')?.remove()
  document.documentElement.classList.remove('dark')
})

describe('the theme-color meta', () => {
  it('follows the theme the person picked', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    render(
      <ThemeProvider>
        <Grab />
      </ThemeProvider>,
    )
    expect(themeColor()).toBe(THEME_COLORS.dark)
    act(() => setTheme!('light'))
    expect(themeColor()).toBe(THEME_COLORS.light)
  })

  it('is each theme’s own background token', () => {
    const css = readFileSync(path.resolve(__dirname, '../../../app/globals.css'), 'utf8')
    const token = (selector: string) => {
      const start = css.indexOf(`${selector} {`)
      const block = css.slice(start, css.indexOf('}', start))
      return /--background:\s*([^;]+);/.exec(block)?.[1]?.trim().toLowerCase()
    }
    expect(THEME_COLORS.light).toBe(token(':root'))
    expect(THEME_COLORS.dark).toBe(token('.dark'))
  })
})
