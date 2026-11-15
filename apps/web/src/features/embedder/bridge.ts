// The object an app gives the dashboard when it shows it in a window of its own.
// The Clawboo desktop app's preload exposes it as `window.clawbooDesktop`. A
// plain browser tab never has one.
//
// The dashboard reads two things from it: that it is there (`isDesktop: true`),
// which the browser alerts use to stay quiet while the app raises its own, and,
// from apps that have it, `onOpenTarget`: where a notification the person
// clicked should take the dashboard.

/** Where a notification the person clicked should take the dashboard. */
export type OpenTarget =
  /** One task: its drawer on the board. */
  | { kind: 'task'; taskId: string }
  /** Several tasks: Needs you on the board. */
  | { kind: 'needs-you' }
  /** One pending approval: its card under Needs you. */
  | { kind: 'approval'; approvalId: string }
  /** Several pending approvals: Needs you, where they are listed first. */
  | { kind: 'approvals' }

export interface EmbedderBridge {
  readonly isDesktop: true
  /**
   * Calls `listener` with each target the person clicks a notification for. A
   * click from before the dashboard subscribed is delivered once, on subscribe.
   * Apps from before deep links do not have it.
   */
  onOpenTarget?: (listener: (target: unknown) => void) => unknown
}

/** The app's bridge, or null in a browser (or a page the app gave none). */
export function embedderBridge(): EmbedderBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as { clawbooDesktop?: unknown }).clawbooDesktop
  if (!bridge || typeof bridge !== 'object') return null
  return (bridge as { isDesktop?: unknown }).isDesktop === true ? (bridge as EmbedderBridge) : null
}

/** Task and approval ids are short and printable; anything else is not one. */
const MAX_ID_LENGTH = 256

function printable(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    printable(value)
    ? value
    : null
}

/** A target as the dashboard can use it, or null for anything it does not know. */
export function parseOpenTarget(raw: unknown): OpenTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  switch (r['kind']) {
    case 'task': {
      const taskId = idOf(r['taskId'])
      return taskId ? { kind: 'task', taskId } : null
    }
    case 'approval': {
      const approvalId = idOf(r['approvalId'])
      return approvalId ? { kind: 'approval', approvalId } : null
    }
    case 'needs-you':
      return { kind: 'needs-you' }
    case 'approvals':
      return { kind: 'approvals' }
    default:
      return null
  }
}
