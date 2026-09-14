import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'

import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Skeleton } from '@/features/shared/Skeleton'
import { StatusPill } from '@/features/shared/StatusPill'
import { confirm } from '@/stores/confirm'
import { useToastStore } from '@/stores/toast'
import {
  fetchExecAllowlist,
  revokeExecGrants,
  type ExecAllowlistRow,
  type ExecAllowlistState,
} from './execAllowlistClient'

// ─── ExecAllowlist ─────────────────────────────────────────────────────────
// Commands this Boo may run without asking, and the only way to take one back.
//
// An operator could already mint a standing grant by answering "Always" to a
// command prompt. Until now nothing showed what they had granted, which made
// "Always" a one-way door.
//
// THE HARD PART IS SAYING WHAT A ROW ACTUALLY IS, and the answer came from
// reading OpenClaw's matcher rather than from the fields:
//
//   - One "Always" mints TWO rows: a bound grant and a `=node-command:` companion
//     the node-host path requires. Deleting either half revokes, so they are
//     shown as ONE card with one verb. An operator should never have to reason
//     about sibling rows.
//   - Three shapes LOOK like grants and are skipped by the matcher. They carry
//     "Not in effect" rather than being hidden, because a row on disk that this
//     panel does not mention reads as a row this panel failed to find.
//   - A bound grant's command text is not recoverable. OpenClaw keeps only a
//     hash of the argv and the directory, so the card says so instead of showing
//     a truncated digest dressed up as a command.
//
// AND IT NEVER PRINTS A REASSURING EMPTY. "No standing grants" is a safety claim;
// a policy document that could not be read is not. Those arrive as different
// states and render differently.

const CLASS_LABEL: Record<ExecAllowlistRow['classification'], string> = {
  'bound-grant': 'One exact command, in one exact folder',
  'exact-command-grant': 'One exact command',
  'node-marker': 'Part of another grant on this computer',
  'path-rule': 'This program, any arguments, any folder',
  'arg-rule': 'This program, matching arguments',
  'catch-all': 'Any command at all',
  // The pill already says "Not in effect", so these say WHY rather than repeating
  // it. A row that states the same thing twice reads as two separate facts.
  'inert-allow-always': 'Kept on file, but OpenClaw skips it',
  inert: 'Kept on file, but OpenClaw skips it',
}

const LOUD = new Set<ExecAllowlistRow['classification']>(['catch-all', 'path-rule'])

/**
 * Built as one string rather than assembled from JSX fragments.
 *
 * The count comes from the stored row, written at the last successful save, so
 * it is the only evidence available that the document is unreadable rather than
 * empty. Saying it out loud is the difference between "nothing is granted" and
 * "something is granted and clawboo cannot see it".
 */
function unreadableMessage(known: number): string {
  const held = known > 0 ? `, which last held ${known} ${known === 1 ? 'rule' : 'rules'}` : ''
  return `clawboo could not read this computer's permission list${held}. Nothing here is safe to trust until it can be read again.`
}
const DEAD = new Set<ExecAllowlistRow['classification']>(['inert-allow-always', 'inert'])

/** A mint is a pair, so the revocable unit is a group rather than a row. */
interface GrantGroup {
  keys: string[]
  primary: ExecAllowlistRow
  companions: ExecAllowlistRow[]
}

function groupGrants(rows: ExecAllowlistRow[]): GrantGroup[] {
  const markers = rows.filter((r) => r.classification === 'node-marker')
  const rest = rows.filter((r) => r.classification !== 'node-marker')
  const groups: GrantGroup[] = rest.map((primary) => ({
    keys: [primary.key],
    primary,
    companions: [],
  }))

  // ONE companion, attached to the one bound grant, and only when that is
  // unambiguous. The marker hashes the command text while the grant hashes the
  // argv and directory, so the two cannot be matched to each other from the list
  // alone. With exactly one of each the pairing is certain; with more than one it
  // is a guess, and a wrong pairing would revoke someone else's grant.
  const bound = groups.filter((g) => g.primary.classification === 'bound-grant')
  if (bound.length === 1 && markers.length === 1 && bound[0] && markers[0]) {
    bound[0].companions = [markers[0]]
    bound[0].keys = [bound[0].primary.key, markers[0].key]
    return groups
  }
  return [...groups, ...markers.map((m) => ({ keys: [m.key], primary: m, companions: [] }))]
}

function GrantRow({
  group,
  duplicated,
  busy,
  onRevoke,
}: {
  group: GrantGroup
  duplicated: boolean
  busy: boolean
  onRevoke: (g: GrantGroup) => void
}) {
  const { primary, companions } = group
  const dead = DEAD.has(primary.classification)
  const name = primary.lastResolvedPath ?? primary.pattern
  /** A companion row that could not be attached to the grant it belongs to. */
  const orphanMarker = primary.classification === 'node-marker'

  return (
    <li className="flex items-start justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-data truncate text-[12px] text-foreground">{name}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{CLASS_LABEL[primary.classification]}</span>
          {dead && <StatusPill tone="idle" label="Not in effect" />}
          {LOUD.has(primary.classification) && <StatusPill tone="warning" label="Broad" />}
          {companions.length > 0 && <span>and its companion rule</span>}
        </span>
        {primary.classification === 'bound-grant' && (
          // The honest sentence. OpenClaw stores a hash of the argv and the
          // directory, never the text, so no amount of work here recovers it.
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            clawboo cannot show which command: OpenClaw keeps only a fingerprint of it and the
            folder it ran in. The same command typed differently, or run elsewhere, asks again.
          </span>
        )}
        {duplicated && (
          <span className="text-[11px] text-amber">
            Also granted to every Boo. Removing it here would not stop it.
          </span>
        )}
      </div>
      {/* AN UNPAIRED MARKER IS NOT REVOCABLE. It is half of some grant, and
          which one cannot be determined from the list: the marker hashes the
          command text while the grant hashes the argv and the folder. Removing
          it would break a grant still shown as working elsewhere on this screen,
          so the row is diagnostic only. */}
      {orphanMarker ? (
        <span className="shrink-0 text-[10.5px] text-muted-foreground">Not removable here</span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-destructive"
          disabled={busy || duplicated}
          onClick={() => onRevoke(group)}
          aria-label={`Revoke ${name}`}
        >
          <Trash2 size={13} aria-hidden="true" />
        </Button>
      )}
    </li>
  )
}

export function ExecAllowlist({ agentId }: { agentId: string }) {
  const [state, setState] = useState<ExecAllowlistState | null>(null)
  const [busy, setBusy] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  const load = useCallback(async () => {
    setState(await fetchExecAllowlist(agentId))
  }, [agentId])

  useEffect(() => {
    setState(null)
    void load()
  }, [load])

  const groups = useMemo(
    () => (state?.state === 'ok' ? groupGrants(state.snapshot.entries) : []),
    [state],
  )

  const onRevoke = useCallback(
    async (group: GrantGroup) => {
      const name = group.primary.lastResolvedPath ?? group.primary.pattern
      const pair = group.companions.length > 0
      const ok = await confirm({
        title: 'Revoke this standing permission?',
        message: [
          `${name} will need your approval again the next time this Boo runs it.`,
          pair ? 'Both rules this approval created are removed together.' : '',
          'A command already approved and waiting to run may fail, because OpenClaw checks the whole rule set again before it starts.',
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: 'Revoke',
        tone: 'danger',
      })
      if (!ok) return

      setBusy(true)
      const res = await revokeExecGrants(agentId, group.keys)
      setBusy(false)
      // NOTHING IS REMOVED OPTIMISTICALLY. The row stays exactly where it was
      // until a re-read shows it gone, because the one thing this panel must not
      // do is show a permission as revoked while the Gateway still honours it.
      await load()
      if (res.ok) addToast({ message: 'Standing permission revoked', type: 'success' })
      else addToast({ message: res.error ?? 'Could not revoke that permission', type: 'error' })
    },
    [agentId, addToast, load],
  )

  if (state?.state === 'not-applicable') return null

  return (
    <div className="mt-4" data-testid="exec-allowlist">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-foreground">
          Commands this Boo can run without asking
        </span>
        <Button variant="ghost" size="sm" onClick={() => void load()} aria-label="Refresh">
          <RefreshCw size={12} aria-hidden="true" />
        </Button>
      </div>

      <div
        className="rounded-2xl border border-border bg-surface p-4"
        style={{ boxShadow: 'var(--shadow-raised)' }}
      >
        {state === null && <Skeleton className="h-12 w-full" />}

        {state?.state === 'unreadable' && (
          // NOT an empty state. The grants are still on disk and still enforced.
          <FormattedAlert tone="error">
            <span>{unreadableMessage(state.knownAllowlistCount)}</span>
            <span className="mt-1 block opacity-80">{state.error}</span>
          </FormattedAlert>
        )}

        {state?.state === 'absent' && (
          <EmptyState
            icon={ShieldCheck}
            title="No standing permissions"
            helper="Nothing on this computer has been granted a standing exec permission yet."
          />
        )}

        {state?.state === 'ok' && groups.length === 0 && (
          <EmptyState
            icon={ShieldCheck}
            title="No standing permissions"
            helper="When you answer Always to a command prompt, what you allowed appears here."
          />
        )}

        {state?.state === 'ok' && groups.length > 0 && (
          <ul className="flex flex-col">
            {groups.map((g) => (
              <GrantRow
                key={g.primary.key}
                group={g}
                duplicated={state.snapshot.duplicatedInWildcard.includes(g.primary.key)}
                busy={busy}
                onRevoke={(grp) => void onRevoke(grp)}
              />
            ))}
          </ul>
        )}

        {state?.state === 'ok' && state.snapshot.wildcard.length > 0 && (
          <p className="mt-3 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
            {state.snapshot.wildcard.length}{' '}
            {state.snapshot.wildcard.length === 1 ? 'permission applies' : 'permissions apply'} to
            every Boo on this computer. Those are set outside clawboo and cannot be changed here.
          </p>
        )}
      </div>
    </div>
  )
}
