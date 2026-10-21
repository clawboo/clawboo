// What the board remembers in this browser (its view, what the person last saw,
// whether Earlier is open) is wiped before each test, so every test starts on a
// first look at the default view. The page counts as focused, as a board in use
// is; tests of the away case say otherwise themselves.

import { vi } from 'vitest'

export function resetBoardStorage(): void {
  const keys: string[] = []
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i)
    if (key?.startsWith('clawboo.board.')) keys.push(key)
  }
  for (const key of keys) window.localStorage.removeItem(key)
  window.sessionStorage.clear()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
}
