// The account bar: a rounded panel along the bottom of the sidebar, under both
// the team rail and the agent column. Who the dashboard stands for, how that is
// known, and the two controls a person reaches for from anywhere: the theme
// switch and Settings.
//
// The name is never made up. Behind a sign-in proxy, or from the app that
// started this engine (its app link), it is the person the server verified
// (GET /api/access/identity). Otherwise it is the install's own built-in
// person, "You", which is all a local install knows. Until the server has
// answered, the bar names no one.

import { Settings, UserRound } from 'lucide-react'

import { ACCOUNT_PERSON_PREFIX, isAccountPerson, isLocalPerson } from '@clawboo/board-core'

import { useBoardPersonIfKnown, type BoardPerson } from '@/features/board/useBoardPerson'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { useSettingsModalStore } from '@/stores/settingsModal'

export interface AccountLabel {
  /** The person's name, or the best the server has for it. */
  name: string
  /** One short true line about how this person is known. */
  detail: string
  /** True when the server verified the person (a proxy's or the app's token). */
  verified: boolean
}

/** What the account bar says for `person`, the server's answer to who "you" is. */
export function describeAccount(person: BoardPerson): AccountLabel {
  if (isLocalPerson(person.id)) {
    return { name: person.name ?? 'You', detail: 'Local install', verified: false }
  }
  if (isAccountPerson(person.id)) {
    return {
      name: person.name ?? person.id.slice(ACCOUNT_PERSON_PREFIX.length),
      detail: 'Signed in via the app',
      verified: true,
    }
  }
  return { name: person.name ?? person.id, detail: 'Signed in via your proxy', verified: true }
}

/** Up to two letters from the name, for the avatar. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words
  return letters
    .map((w) => Array.from(w)[0] ?? '')
    .join('')
    .toUpperCase()
}

function Avatar({ label }: { label: AccountLabel }) {
  return (
    <span
      aria-hidden
      data-testid="account-avatar"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[12px] font-semibold text-foreground"
    >
      {label.verified ? (
        initialsOf(label.name)
      ) : (
        <UserRound size={17} strokeWidth={2} className="text-foreground/70" />
      )}
    </span>
  )
}

function SettingsButton() {
  const settingsOpen = useSettingsModalStore((s) => s.open)
  return (
    <button
      type="button"
      data-testid="nav-settings"
      aria-label="Settings"
      title="Settings (⌘,)"
      onClick={() => useSettingsModalStore.getState().openSettings()}
      className={[
        'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors duration-150',
        settingsOpen
          ? 'bg-foreground/[0.06] text-primary'
          : 'text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground',
      ].join(' ')}
    >
      <Settings size={17} strokeWidth={2} aria-hidden />
    </button>
  )
}

/** While the server has not said who is here: no name, no claim. */
const PENDING: AccountLabel = { name: '', detail: '', verified: false }
const PENDING_WORDS = 'Checking who is signed in'

/** `compact` stacks it for a sidebar that is only the team rail (Boo Zero's view). */
export function AccountBar({ compact = false }: { compact?: boolean }) {
  const person = useBoardPersonIfKnown()
  const pending = person === null
  const label = pending ? PENDING : describeAccount(person)
  const whole = pending ? PENDING_WORDS : `${label.name}, ${label.detail}`

  if (compact) {
    return (
      <div
        role="group"
        aria-label="Account"
        data-testid="account-bar"
        data-layout="stacked"
        aria-busy={pending || undefined}
        title={whole}
        className="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface px-1 py-2 shadow-[var(--shadow-raised)]"
      >
        <Avatar label={label} />
        <span className="sr-only" data-testid="account-name">
          {whole}
        </span>
        <ThemeToggle orientation="vertical" />
        <SettingsButton />
      </div>
    )
  }

  return (
    <div
      role="group"
      aria-label="Account"
      data-testid="account-bar"
      data-layout="row"
      aria-busy={pending || undefined}
      className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-surface py-1.5 pl-1.5 pr-1 shadow-[var(--shadow-raised)]"
    >
      <Avatar label={label} />
      {pending ? (
        <div className="min-w-0 flex-1" data-testid="account-pending">
          <span className="sr-only">{PENDING_WORDS}</span>
          <div aria-hidden className="h-2.5 w-16 rounded-full bg-foreground/[0.08]" />
          <div aria-hidden className="mt-1.5 h-2 w-20 rounded-full bg-foreground/[0.06]" />
        </div>
      ) : (
        <div className="min-w-0 flex-1" title={whole}>
          <div
            data-testid="account-name"
            className="truncate text-[13px] font-semibold leading-tight text-foreground"
          >
            {label.name}
          </div>
          <div
            data-testid="account-detail"
            className="truncate text-[11px] leading-tight text-muted-foreground"
          >
            {label.detail}
          </div>
        </div>
      )}
      <ThemeToggle />
      <SettingsButton />
    </div>
  )
}
