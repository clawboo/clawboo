// What the board remembers in this browser (its view, what the person last saw,
// whether Earlier is open) is wiped before each test. The board opens on Kanban
// for a first visit, but most suites here test the calendar, so they start on a
// Week the person picked; a test of the first visit passes `{ view: null }`. The
// page counts as focused, as a board in use is; tests of the away case say
// otherwise themselves.

import { vi } from 'vitest'

export function resetBoardStorage({ view = 'week' }: { view?: string | null } = {}): void {
  const keys: string[] = []
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i)
    if (key?.startsWith('clawboo.board.')) keys.push(key)
  }
  for (const key of keys) window.localStorage.removeItem(key)
  if (view) {
    window.localStorage.setItem(
      'clawboo.board.calendar',
      JSON.stringify({ mode: view, modePicked: true }),
    )
  }
  window.sessionStorage.clear()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
}
