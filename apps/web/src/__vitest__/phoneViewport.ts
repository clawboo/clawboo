// A controllable `window.matchMedia` for the phone layout's breakpoint.
//
// jsdom has no layout, so a component test says which side of the line the
// window is on. Only the phone query answers `phone`; every other query (the
// colour scheme, reduced motion) keeps the setup shim's `false`.

import { PHONE_LAYOUT_QUERY } from '@/features/layout/phoneLayout'

export interface PhoneViewport {
  /** Cross the breakpoint, telling every listener, as a resize would. */
  set: (phone: boolean) => void
  restore: () => void
}

export function mockPhoneViewport(phone: boolean): PhoneViewport {
  const original = window.matchMedia
  let matches = phone
  const listeners = new Set<(e: MediaQueryListEvent) => void>()

  window.matchMedia = ((query: string) => {
    const isPhoneQuery = query === PHONE_LAYOUT_QUERY
    return {
      get matches() {
        return isPhoneQuery && matches
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => {
        if (isPhoneQuery) listeners.add(fn)
      },
      removeEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => {
        listeners.delete(fn)
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }
  }) as unknown as typeof window.matchMedia

  return {
    set(next) {
      matches = next
      for (const fn of [...listeners]) {
        fn({ matches: next, media: PHONE_LAYOUT_QUERY } as MediaQueryListEvent)
      }
    },
    restore() {
      window.matchMedia = original
      listeners.clear()
    },
  }
}
