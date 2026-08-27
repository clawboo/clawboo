// The connectors tab body, kept out of MarketplacePanel because that file is
// already 695 lines across three tabs.
//
// PART directory, PART installer, and the copy now says exactly which is which.
// clawboo can run a curated, credential-free stdio server itself; everything
// else it can only describe, so those tiles offer a config block to paste into a
// runtime you already use and say plainly why they cannot be connected here.
//
// Which half a tile falls into is decided by `connectRefusal` in
// @clawboo/connector-catalog -- the SAME predicate the REST handler enforces.
// A tile therefore cannot offer a button the server would refuse, which is the
// affordance-shaped lie this file exists to avoid.
//
// No fetch, no loading state: the catalog is committed data.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Copy, Info, KeyRound, Plus, SearchX } from 'lucide-react'
import {
  COST_COPY,
  CONNECT_REFUSAL_COPY,
  connectorBySlug,
  connectorCounts,
  cleanPastedSecret,
  isImmediate,
  needsArgumentOnly,
  needsCredentialOnly,
  needsSignInOnly,
  connectorSnippet,
  connectRefusal,
  searchConnectors,
  SNIPPET_DIALECTS,
  type ConnectRefusal,
  type ConnectorCategory,
  type ConnectorCost,
  type ConnectorDefinition,
  type SnippetDialect,
} from '@clawboo/connector-catalog'
import { Button } from '@/features/shared/Button'
import { useConnectorShelf } from './useConnectorShelf'
import { searchCommunity, useCommunityConnectors } from './useCommunityConnectors'
import { EmptyState } from '@/features/shared/EmptyState'
import { SearchInput } from '@/features/shared/SearchInput'
import { ConnectorMark, hasBrandMark } from '@/features/connectors/ConnectorMark'
import { CollapsiblePillRow, type PillOption } from './CollapsiblePillRow'
import { wantsCommunityBand } from './communityBand'
import { useToastStore } from '@/stores/toast'
import { useMarketplaceStore } from '@/stores/marketplace'
import {
  connectConnector,
  fetchPathSuggestions,
  createCustomConnector,
  deleteCustomConnector,
  disconnectConnector,
  fetchConnectorConfig,
  listCustomConnectors,
  listLiveConnectors,
  saveConnectorConfig,
  signInConnector,
  signOutConnector,
  type ConnectorConfigState,
  type PathSuggestion,
  type CredentialStatus,
  type LiveConnectorRow,
} from './connectConnector'

// ─── Category pills ─────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  dev: 'Dev',
  issues: 'Issues',
  chat: 'Chat',
  docs: 'Docs',
  data: 'Data',
  observability: 'Observability',
  browser: 'Browser',
  search: 'Search',
  productivity: 'Productivity',
  finance: 'Finance',
  other: 'Uncategorised',
}

/**
 * The heading above a refusal.
 *
 * `Not connectable yet` is a CATEGORY, and it made every refusal read the same
 * whether the answer was one field away or impossible. `CONNECT_REFUSAL_COPY`
 * already names the actual obstacle below it; the heading now does too, so the
 * first three words tell the reader what is missing.
 */
/**
 * How many community entries a page shows.
 *
 * A PAGE, not a ceiling. This was a hard cap with no way past it, which made
 * the registry band a permanent window onto the same sixty entries: the file is
 * ordered by the publisher's reverse-DNS name, so the visible sixty were every
 * publisher that sorts before `io.github`, and the three hundred and twenty
 * seven entries published under it could not be reached by scrolling at all.
 * The count beside the heading now reads "shown of found", and the button under
 * the last card asks for the next page.
 */
const COMMUNITY_PAGE_SIZE = 60

/**
 * One titled run of connector rows.
 *
 * `offset` keeps the entrance stagger continuous across bands, so the list
 * animates in as one column rather than restarting at each heading.
 */
function ShelfBand({
  title,
  defs,
  offset,
  shelf,
  onOpen,
}: {
  title: string
  defs: readonly ConnectorDefinition[]
  offset: number
  shelf: ReturnType<typeof useConnectorShelf>
  onOpen: (def: ConnectorDefinition) => void
}) {
  if (defs.length === 0) return null
  return (
    <section className="mt-1">
      <div className="flex items-baseline gap-2 px-3 pb-0.5 pt-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          {title}
        </h3>
        <span className="text-[11px] tabular-nums text-muted-foreground/70">{defs.length}</span>
      </div>
      <div className="flex flex-col">
        {defs.map((def, i) => (
          <ConnectorCard
            key={def.slug}
            def={def}
            index={offset + i}
            cost={shelf.costOf(def)}
            busy={shelf.busy(def.slug)}
            onOpen={onOpen}
            onAct={(d, c) => void shelf.act(d, c)}
            onConfigured={shelf.refresh}
          />
        ))}
      </div>
    </section>
  )
}

const CONNECT_REFUSAL_HEADING: Readonly<Record<ConnectRefusal, string>> = Object.freeze({
  'community-unsandboxed': 'Nobody has read this one',
  'remote-needs-registered-app': 'clawboo cannot sign in here',
  'remote-needs-oauth': 'Needs you to sign in',
  'needs-credential': 'Needs a key',
  'needs-user-supplied-argument': 'Needs a folder to work in',
})

// ─── Card ───────────────────────────────────────────────────────────────────

/**
 * One connector, priced.
 *
 * THE CARD DOES THE WORK NOW. Every state has its action here, so nothing needs
 * the detail view to get started, and the pill names what the entry will COST
 * rather than reporting a status the reader has to interpret. The `3/3 risk`
 * chip is gone from this surface: it counted trifecta legs, which describe what
 * a connector can reach rather than whether it is safe, and a bare fraction next
 * to a name reads as a score. That belongs in the detail pane where there is
 * room to name the three legs.
 *
 * A DIV, NOT A BUTTON. The whole card opens the detail view and it also carries
 * its own action, and a button inside a button is invalid and unclickable. The
 * open affordance is an absolutely-positioned button behind the content; the
 * action sits above it.
 */
function ConnectorCard({
  def,
  index,
  cost,
  busy,
  onOpen,
  onAct,
  onConfigured,
}: {
  def: ConnectorDefinition
  index: number
  cost: ConnectorCost
  busy: boolean
  onOpen: (def: ConnectorDefinition) => void
  onAct: (def: ConnectorDefinition, cost: ConnectorCost) => void
  /** The card finished a save or a connect and the shelf should re-price. */
  onConfigured: () => void
}) {
  const copy = COST_COPY[cost]
  // ONE VERB ON THE SHELF. The catalogue distinguishes "Turn on" from "Connect"
  // from "Add key" from "Add it", and on a card read on its own that precision
  // is worth something. In a single scrolling list it reads as four different
  // kinds of thing, and the reader starts wondering which one is the real one.
  // Whatever a connector needs still appears the moment the button is pressed,
  // which is where a field is an answer rather than a warning.
  //
  // The other surfaces keep the specific verbs: the chat card offers one
  // connector at a time, where naming the cost up front is a promise about what
  // the next tap does rather than a taxonomy to decode.
  const action = cost === 'on' ? copy.action : cost === 'blocked' ? copy.action : 'Connect'
  // IN PLACE, NOT A NAVIGATION. A key and a folder are one field each, and
  // sending the reader to a full-pane detail view to type one field was the
  // single biggest source of felt resistance on this surface: half the
  // catalogue was two clicks and a lost scroll position from its own action.
  const inlineable = cost === 'needs-key' || cost === 'needs-folder'
  const [expanded, setExpanded] = useState(false)
  const [config, setConfig] = useState<ConnectorConfigState | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (!expanded || config) return
    let alive = true
    void fetchConnectorConfig(def.slug).then((next) => {
      if (!alive) return
      if (next) setConfig(next)
      else setLoadFailed(true)
    })
    return () => {
      alive = false
    }
  }, [expanded, config, def.slug])

  // Something else satisfied this connector while the form was open (the detail
  // pane, another tab, an agent's card). Close rather than keep asking for what
  // it already has.
  useEffect(() => {
    if (expanded && !inlineable) setExpanded(false)
  }, [expanded, inlineable])

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, delay: Math.min(index * 0.012, 0.25) }}
      className="group relative rounded-xl px-3 py-2.5 transition-colors duration-150 hover:bg-foreground/[0.03] focus-within:bg-foreground/[0.03]"
      data-testid={`connector-row-${def.slug}`}
    >
      {/* Behind the content, so the whole row opens the detail view without
          swallowing the action button in front of it. */}
      <button
        type="button"
        onClick={() => onOpen(def)}
        className="absolute inset-0 cursor-pointer rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        aria-label={`${def.displayName}: ${copy.label}. Open details`}
      />

      <div className="relative flex items-center gap-3">
        <ConnectorMark slug={def.slug} displayName={def.displayName} size={30} />

        <div className="pointer-events-none min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium leading-tight text-foreground">
            {def.displayName}
          </div>
          <div className="truncate text-[12px] leading-snug text-muted-foreground">
            {def.description}
          </div>
        </div>

        {/* `pointer-events-none` on the group, `auto` on the control alone: the
            dead space between them would otherwise swallow the click meant for
            the row behind it. */}
        <div className="pointer-events-none flex shrink-0 items-center gap-2">
          {cost === 'on' ? (
            // A TICK, NOT A SENTENCE. The row already names the connector;
            // repeating "Connected and running" beside every one of them is
            // noise to scan past on the way to the ones still asking for
            // something. Turn off appears on hover and on keyboard focus.
            <>
              <Check
                size={15}
                strokeWidth={2.6}
                className="text-mint"
                aria-label="Connected"
                role="img"
              />
              <Button
                size="sm"
                variant="ghost"
                className="pointer-events-auto opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100"
                disabled={busy}
                aria-label={`Turn off ${def.displayName}`}
                onClick={() => onAct(def, cost)}
              >
                {busy ? 'Working…' : 'Turn off'}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              className="pointer-events-auto"
              // NEUTRAL, all of them. Filled buttons on the free connectors put
              // a column of eight red rectangles down the page, which shouts
              // where the reference surfaces stay quiet and makes the one row
              // that IS connected harder to spot. The verb already carries the
              // cost: "Turn on" and "Add key" are different promises without
              // needing different weights, and the tick is the only colour the
              // list needs.
              variant="secondary"
              disabled={busy}
              // NAMED, because nineteen buttons reading "Turn on" are nineteen
              // identical announcements to a screen reader.
              aria-label={`${action} ${def.displayName}`}
              aria-expanded={inlineable ? expanded : undefined}
              onClick={() => {
                if (inlineable) setExpanded((v) => !v)
                else onAct(def, cost)
              }}
            >
              {busy ? 'Working…' : expanded ? 'Cancel' : action}
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        // `relative` + `pointer-events-auto`: the row's open-details button is
        // absolutely positioned behind everything, and without both of these it
        // swallows every click meant for this form.
        <div className="pointer-events-auto relative mt-3 border-t border-border pt-3">
          {config ? (
            <ConfigForm
              def={def}
              state={config}
              connectAfterSave
              compact
              onSaved={(next) => {
                setConfig(next)
                onConfigured()
                // Satisfied means the form has nothing left to ask. Leaving it
                // open would show an empty box under a row that now says On.
                if (next.satisfied) setExpanded(false)
              }}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {loadFailed
                ? 'Could not read what this connector needs. Check the clawboo server is running.'
                : 'Checking what this needs…'}
            </p>
          )}
        </div>
      )}
    </motion.div>
  )
}

/**
 * Adding a server clawboo has not read.
 *
 * REPLACES A REFUSAL, and the refusal was the interesting failure. It read "add
 * it as a custom connector if you trust it", which names the exact remedy and
 * then makes the user retype the command by hand into a different form. Four
 * hundred entries behaving like that is a bigger directory, not a better product.
 *
 * Three things stay true at once here, which is the whole trick: clawboo vouches
 * for nothing, the user sees the exact argv before anything runs, and the gap
 * between finding it and running it is two clicks rather than a retyped command
 * line. On confirm it becomes the operator's OWN entry, so it lands on the
 * ordinary key flow and `catalogId` records where it came from.
 */
function CommunityConsent({
  def,
  onCancel,
  onAdded,
}: {
  def: ConnectorDefinition
  onCancel: () => void
  onAdded: () => void
}) {
  const [busy, setBusy] = useState(false)
  // STDIO ONLY, asserted rather than branched. The ingest filters remote entries
  // out and `verify:connectors` fails the build if one appears, so a remote
  // branch here could not run; what it COULD do is hand a URL to
  // `createCustomConnector`, whose body treats its `command` as a program to
  // spawn. That is a URL executed as a local process.
  if (def.launch.transport !== 'stdio') return null
  const launch = def.launch
  const argv = `${launch.command} ${launch.args.join(' ')}`

  return (
    <section className="rounded-xl border border-border bg-surface-subtle p-4">
      <h3 className="text-sm font-semibold text-foreground">Add {def.displayName}?</h3>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        clawboo has not checked this one. It will run on your machine, as you, with the same access
        to your files and network that you have.
      </p>
      <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-surface p-2.5 text-[11px]">
        <code>{argv}</code>
      </pre>
      <p className="mt-2 text-[11px] text-muted-foreground">
        From <code>{def.catalogId ?? def.slug}</code>, version {launch.pinnedVersion}.
        {def.auth.inputs.length > 0 && (
          <> It will ask for {def.auth.inputs.map((i) => i.key).join(', ')}.</>
        )}
      </p>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              const ok = await createCustomConnector({
                slug: def.slug,
                displayName: def.displayName,
                description: def.description,
                command: launch.command,
                args: [...launch.args],
                // CARRIED, both of them. Without the inputs the panel above
                // promises a key will be asked for and nothing ever asks;
                // without the catalogId the entry the operator accepted becomes
                // anonymous, and the registry identity that would let anyone
                // check what they installed is gone.
                authInputs: def.auth.inputs.map((i) => ({
                  key: i.key,
                  description: i.description,
                  required: i.required,
                })),
                ...(def.catalogId ? { catalogId: def.catalogId } : {}),
                ...(launch.pinnedVersion ? { pinnedVersion: launch.pinnedVersion } : {}),
              })
              if (ok) onAdded()
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Adding…' : 'I trust it, add it'}
        </Button>
      </div>
    </section>
  )
}

// ─── Detail: the copy-paste snippet ─────────────────────────────────────────

/**
 * Connect / Disconnect, or an honest statement of why neither is offered.
 *
 * The refusal copy comes from the catalog package, which is the same predicate
 * the REST handler enforces. A tile therefore cannot offer a button the server
 * would refuse, and cannot withhold one the server would accept.
 */
/**
 * Enter the credentials a connector declared.
 *
 * The values are write-only from the browser's point of view: the server stores
 * them in the vault and every response reports presence alone, so a stored
 * credential can never be read back out through this form. An already-stored
 * value therefore renders as a placeholder rather than a value, and leaving the
 * field untouched leaves the stored one alone.
 */
function ConfigForm({
  def,
  state,
  onSaved,
  collapsedByDefault = false,
  connectAfterSave = false,
  compact = false,
}: {
  def: ConnectorDefinition
  state: ConnectorConfigState
  onSaved: (next: ConnectorConfigState) => void
  /** Collapsed once everything is supplied: present but out of the way. */
  collapsedByDefault?: boolean
  /**
   * Rendered inside a card that already names the connector.
   *
   * Drops the panel chrome and the heading, because a bordered box with its own
   * title nested inside a bordered card reads as two things rather than one
   * card that opened.
   */
  compact?: boolean
  /**
   * Saving also connects, and the button says so.
   *
   * Only for the not-yet-connected flow. There is no reason a user should have
   * to know that storing a key and starting the process are different
   * operations: they typed the one thing that was missing, and "Save" that
   * leaves the card still saying "Turn on" is a second click for our
   * architecture's benefit, not theirs.
   */
  connectAfterSave?: boolean
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [argument, setArgument] = useState(state.argument ?? '')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(!collapsedByDefault)
  // Real paths the server checked exist. One click instead of typing an
  // absolute path from memory, which is the most error-prone input this whole
  // surface asks for. Empty means the field stands alone, exactly as before.
  const [pathChips, setPathChips] = useState<PathSuggestion[]>([])
  useEffect(() => {
    if (state.argumentSpec && open) {
      void fetchPathSuggestions(def.slug).then(setPathChips)
    }
  }, [def.slug, state.argumentSpec, open])

  if (!open) {
    return (
      <section className="rounded-xl border border-border bg-surface-subtle px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-xs text-muted-foreground">
            {/* The stored ARGUMENT is shown in full, which is the entire reason
                for asking which folder a connector gets. Credentials are counted,
                never shown. */}
            {state.argument ? (
              <>
                Configured: <code className="text-foreground">{state.argument}</code>
              </>
            ) : (
              `${state.credentials.filter((c) => c.present).length} credential${
                state.credentials.filter((c) => c.present).length === 1 ? '' : 's'
              } saved`
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Change
          </Button>
        </div>
      </section>
    )
  }

  const argumentChanged = argument.trim() !== (state.argument ?? '')
  const hasCredentialInput = Object.values(draft).some((v) => v.length > 0)

  async function save() {
    setBusy(true)
    try {
      // Only fields the user actually typed into. Sending the untouched ones as
      // empty strings would CLEAR credentials they never meant to remove.
      const values = Object.fromEntries(Object.entries(draft).filter(([, v]) => v.length > 0))
      const next = await saveConnectorConfig(def.slug, def.displayName, {
        ...(Object.keys(values).length > 0 ? { values } : {}),
        ...(argumentChanged ? { argument: argument.trim() } : {}),
      })
      if (next) {
        setDraft({})
        // Connect only when the save made it POSSIBLE. A partially filled form
        // saves fine and stays a form; connecting on an unsatisfied config
        // would surface the server's refusal as a failure of the field the
        // user just filled correctly.
        if (connectAfterSave && next.satisfied) {
          await connectConnector(def.slug, def.displayName)
        }
        onSaved(next)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={compact ? 'pt-1' : 'rounded-xl border border-border bg-surface-subtle p-4'}>
      {!compact && (
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <KeyRound size={13} aria-hidden />
          Before it can run
        </div>
      )}
      {state.credentials.length > 0 && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Credentials are stored encrypted on this machine and passed only to this connector&rsquo;s
          process. clawboo never sends them anywhere else, and never shows them again once saved.
        </p>
      )}

      {state.argumentSpec && (
        <label className="mt-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-foreground">
            {state.argumentSpec.label}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {state.argumentSpec.description}
          </span>
          {pathChips.length > 0 && (
            <span className="flex flex-wrap gap-1.5 py-0.5">
              {pathChips.map((chip) => (
                <button
                  key={chip.path}
                  type="button"
                  onClick={() => setArgument(chip.path)}
                  title={chip.path}
                  className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                    argument === chip.path
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-muted-foreground hover:border-accent/50 hover:text-foreground'
                  }`}
                >
                  {chip.label}
                </button>
              ))}
            </span>
          )}
          <input
            type="text"
            spellCheck={false}
            value={argument}
            onChange={(e) => setArgument(e.target.value)}
            placeholder={state.argumentSpec.example}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          />
        </label>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {state.credentials.map((cred: CredentialStatus) => (
          <label key={cred.key} className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
              {/* WHAT THE VENDOR CALLS IT. An operator who just made a token on
                  GitHub knows they made a "GitHub token", not a GITHUB_TOKEN;
                  the env var name is what the child process needs and lives
                  under Technical details, where somebody wiring this into
                  another runtime goes looking for it. */}
              {cred.label ?? <code>{cred.key}</code>}
              {cred.required ? null : <span className="text-muted-foreground">(optional)</span>}
              {cred.present && (
                <span className="text-[10px] text-mint" aria-label="already stored">
                  saved
                </span>
              )}
            </span>
            <span className="text-[11px] text-muted-foreground">{cred.description}</span>
            <input
              type={cred.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              value={draft[cred.key] ?? ''}
              // CLEANED IN THE HANDLER, so the operator sees the value that will
              // actually be stored. `Bearer ghp_x` and `"secret_x"` both look
              // correct in a password field and both fail at the vendor with an
              // error naming none of this.
              onChange={(e) =>
                setDraft((d) => ({ ...d, [cred.key]: cleanPastedSecret(e.target.value) }))
              }
              placeholder={cred.present ? 'saved, type to replace' : 'not set'}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            />
            {cred.docsUrl && (
              <a
                href={cred.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-accent underline"
              >
                {def.auth.setupGuide
                  ? `Make one on ${def.auth.setupGuide.console}`
                  : 'Where to get this'}
              </a>
            )}
          </label>
        ))}
      </div>

      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={busy || (!hasCredentialInput && !argumentChanged)}
        >
          {busy
            ? connectAfterSave
              ? 'Connecting…'
              : 'Saving…'
            : connectAfterSave
              ? 'Save and connect'
              : 'Save'}
        </Button>
      </div>
    </section>
  )
}

/**
 * Point clawboo at a server of your own.
 *
 * The honest framing, and the copy says it: this is the same thing as writing a
 * server into a runtime's own config file, which is what the snippet below every
 * catalog entry already asks you to do. clawboo vouches for nothing here, which
 * is why the form asks for a command rather than offering a list.
 */
function AddCustomConnector({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')

  // Derived rather than a fourth field: a slug is an implementation detail (it
  // becomes a tool-name segment and a grant identity), and asking for one would
  // be asking the operator to care about that.
  // Split-and-join rather than replace-then-trim. The trim was `/^-+|-+$/g`,
  // whose second alternative is a greedy `+` with no start anchor, so a global
  // replace retries it from every position and costs O(n squared) on a long run
  // of separators. Same output, and the shape a scanner flags is simply not
  // there. (The same pattern predates this work in six other files, on inputs
  // that are not typed into a form; those are left alone.)
  const slug = displayName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .slice(0, 48)

  const valid = slug.length > 0 && command.trim().length > 0

  async function submit() {
    setBusy(true)
    try {
      const ok = await createCustomConnector({
        slug,
        displayName: displayName.trim(),
        command: command.trim(),
        // Split on whitespace, which is the shape a user copies from a README.
        // Never joined back into a string: argv stays an array all the way to
        // the spawn, so a value containing a shell metacharacter is inert.
        args: argsText.trim().length > 0 ? argsText.trim().split(/\s+/) : [],
      })
      if (ok) {
        setDisplayName('')
        setCommand('')
        setArgsText('')
        setOpen(false)
        onAdded()
      }
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="mt-3 flex justify-center">
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          <Plus size={13} aria-hidden />
          Add your own MCP server
        </Button>
      </div>
    )
  }

  return (
    <section className="mt-3 rounded-2xl border border-border bg-surface-subtle p-4">
      <h3 className="text-xs font-semibold text-foreground">Add your own MCP server</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Anything that speaks MCP over stdio. clawboo runs it as a local process under your account
        and does not vouch for it, so add servers you would be willing to put in a runtime&rsquo;s
        config file yourself.
      </p>

      <div className="mt-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-foreground">Name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="My Notes Server"
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-foreground">Command</span>
          <span className="text-[11px] text-muted-foreground">
            The program to run. An absolute path is used as-is; a bare name is looked up on PATH.
          </span>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            spellCheck={false}
            placeholder="npx"
            className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-foreground">Arguments</span>
          <span className="text-[11px] text-muted-foreground">
            Separated by spaces. Passed to the program directly, never through a shell.
          </span>
          <input
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            spellCheck={false}
            placeholder="-y @scope/my-mcp-server@1.0.0"
            className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={busy || !valid}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </section>
  )
}

/**
 * Sign in to a remote provider.
 *
 * The copy names what actually happens, because it is a browser tab going to
 * somebody else's site: clawboo registers itself with that provider for this
 * install and stores the resulting token locally.
 */
function SignInPanel({ def, onChanged }: { def: ConnectorDefinition; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <section className="rounded-xl border border-border bg-surface-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <KeyRound size={13} aria-hidden />
            Sign in to {def.displayName}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {def.brokeredBy
              ? // A BROKERED APP SIGNS IN SOMEWHERE ELSE. The direct sentence
                // below claims clawboo registers itself and keeps the token,
                // and for these forty-one entries neither half is true: the
                // broker registers, and the broker keeps it. Saying it here
                // costs one line and stops the detail view from describing a
                // flow that is not the one about to run.
                `Opens ${def.displayName} in a new tab. Sign-in is handled by Composio, which keeps the resulting token; clawboo holds only a token for Composio.`
              : `Opens ${def.displayName} in a new tab. clawboo registers itself with them for this install and keeps the resulting token on this machine, encrypted.`}
          </p>
        </div>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              if (await signInConnector(def.slug, def.displayName)) onChanged()
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Waiting…' : 'Sign in'}
        </Button>
      </div>
    </section>
  )
}

/**
 * One connector's stored configuration, owned by the pane rather than a section.
 *
 * SHARED, because two sections need it and they must not disagree: the action
 * decides whether Connect is offered, and "What you gave it" shows what is in
 * there. Two fetches would be two answers, and the moment they differ the pane
 * is arguing with itself in front of the reader.
 */
function useConnectorConfig(def: ConnectorDefinition, onChanged: () => void) {
  const [config, setConfig] = useState<ConnectorConfigState | null>(null)
  const [failed, setFailed] = useState(false)

  // Fetched for ANY connector with something to configure, not only an
  // unsatisfied one. A credential or folder that can never be seen or changed
  // again is worse than one that was never asked for: checking which folder a
  // connector was handed is the entire reason for asking.
  const hasConfig =
    def.auth.inputs.length > 0 || def.userArgument !== undefined || needsSignInOnly(def)

  useEffect(() => {
    if (!hasConfig) return
    // THIS PANE IS REUSED across connectors: moving from one to another re-runs
    // the effect without remounting, so a slow response for the connector just
    // left can land after the new one's and write ITS credentials, argument and
    // authorized flag under the new connector's name. Everything downstream
    // (`satisfied`, the refusal, the stored path on screen) then describes the
    // wrong connector. Cleared first so the pane never shows the previous
    // connector's values while the new request is in flight.
    let alive = true
    setConfig(null)
    setFailed(false)
    void fetchConnectorConfig(def.slug).then((next) => {
      if (!alive) return
      if (next) setConfig(next)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [hasConfig, def.slug])

  /**
   * Record new configuration in BOTH places.
   *
   * The pane holds its own copy for the form, and the shelf holds a set of which
   * connectors are satisfied. Updating only the pane left the card behind it
   * reading "Needs a key" for a key that had just been entered, which is the
   * stale half of the same lie the price tag exists to stop.
   */
  const saveConfig = useCallback(
    (next: ConnectorConfigState) => {
      setConfig(next)
      onChanged()
    },
    [onChanged],
  )

  const reload = useCallback(async () => {
    const next = await fetchConnectorConfig(def.slug)
    if (next) saveConfig(next)
    else onChanged()
  }, [def.slug, saveConfig, onChanged])

  return { config, setConfig, saveConfig, reload, failed, hasConfig }
}

type ConnectorConfigHandle = ReturnType<typeof useConnectorConfig>

function ConnectAction({
  def,
  connected,
  onChanged,
  cfg,
}: {
  def: ConnectorDefinition
  connected: boolean
  onChanged: () => void
  cfg: ConnectorConfigHandle
}) {
  const [busy, setBusy] = useState(false)
  const { config, setConfig, saveConfig, reload, failed } = cfg

  const configGated = needsCredentialOnly(def) || needsArgumentOnly(def) || needsSignInOnly(def)
  const satisfied = config?.satisfied ?? false
  // The FOURTH argument is not optional in practice: without it every remote
  // connector reads as never-signed-in, so the panel refuses an action the
  // server would have accepted and Connect is unreachable forever.
  const refusal = connectRefusal(def, satisfied, satisfied, config?.authorized ?? false)

  if (configGated && !satisfied) {
    if (config && needsSignInOnly(def) && !config.authorized) {
      return <SignInPanel def={def} onChanged={() => void reload()} />
    }
    if (config) return <ConfigForm def={def} state={config} onSaved={saveConfig} connectAfterSave />
    // A failed fetch must not leave the tile spinning forever with no way out.
    return (
      <section className="rounded-xl border border-border bg-surface-subtle p-4 text-xs text-muted-foreground">
        {failed
          ? 'Could not read this connector’s settings. Check that the clawboo server is running, then reopen this connector.'
          : 'Checking what this connector needs…'}
      </section>
    )
  }

  if (refusal) {
    return (
      <section className="rounded-xl border border-border bg-surface-subtle p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Info size={13} aria-hidden />
          {CONNECT_REFUSAL_HEADING[refusal]}
        </div>
        {/* Verbatim from the shared predicate: the actual obstacle, not a status. */}
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {CONNECT_REFUSAL_COPY[refusal]}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {/* NAMES THE DISCLOSURE, because the block moved behind one. "the
              config below" described a visible thing until the demotion, and a
              sentence pointing at something not on screen is worse than no
              sentence: the reader looks for it and concludes it is missing. */}
          You can still run it somewhere else: open <strong>Technical details</strong> below and
          copy the config into a runtime you already use.
        </p>
      </section>
    )
  }

  const remote = def.launch.transport !== 'stdio'

  async function run() {
    setBusy(true)
    try {
      if (connected) await disconnectConnector(def.slug, def.displayName, remote)
      else {
        // The callback matters for a token the provider has revoked: the local
        // record still reads as authorized, so without re-reading the config the
        // panel would keep offering a Connect button that always fails.
        await connectConnector(def.slug, def.displayName, () => {
          void fetchConnectorConfig(def.slug).then((next) => {
            if (next) setConfig(next)
          })
        })
      }
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="rounded-xl border border-border bg-surface-subtle p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground">
              {connected ? 'Connected' : remote ? 'Connect to this provider' : 'Run this connector'}
            </div>
            {/* BRANCHED ON THE TRANSPORT, because the two are not the same act.
                A local connector is a child process on this machine and a
                package download; a remote one is an authenticated HTTP session
                to somebody else's server, where nothing is spawned and nothing
                is downloaded. One sentence covering both was wrong for whichever
                half the reader was looking at. */}
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {connected
                ? remote
                  ? 'Its tools are available to your agents. Disconnecting closes the connection; your sign-in is kept until you sign out.'
                  : 'Its tools are available to your agents. Disconnecting stops the process.'
                : remote
                  ? `clawboo opens an authenticated connection to ${def.launch.transport === 'streamable-http' ? def.launch.url : ''} and lists its tools. Nothing runs on your machine.`
                  : 'clawboo starts this server as a local process and lists its tools. The first run downloads the pinned package.'}
            </p>
          </div>
          <Button
            size="sm"
            variant={connected ? 'secondary' : 'primary'}
            onClick={run}
            disabled={busy}
          >
            {busy ? 'Working…' : connected ? 'Disconnect' : 'Connect'}
          </Button>
        </div>
      </section>
    </>
  )
}

/**
 * A destructive control that asks first.
 *
 * Two clicks rather than a confirm dialog: both actions here delete something
 * that cannot be recovered from the product, and both sit next to a button the
 * operator uses routinely.
 */
function RevokeRow({
  title,
  detail,
  action,
  busyLabel,
  onConfirm,
}: {
  title: string
  detail: string
  action: string
  busyLabel: string
  onConfirm: () => Promise<void>
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <section className="rounded-xl border border-border bg-surface-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground">{title}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {armed ? `${detail} This cannot be undone.` : detail}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {armed && (
            <Button size="sm" variant="secondary" onClick={() => setArmed(false)} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              if (!armed) {
                setArmed(true)
                return
              }
              setBusy(true)
              try {
                await onConfirm()
              } finally {
                setBusy(false)
                setArmed(false)
              }
            }}
          >
            {busy ? busyLabel : armed ? `Yes, ${action.toLowerCase()}` : action}
          </Button>
        </div>
      </div>
    </section>
  )
}

/**
 * What the operator handed this connector, and how to take it back.
 *
 * A LABELLED GROUP, and BELOW the consequences. These three controls used to
 * sit above "What it can do", so the reader met "Remove this connector" and
 * "Sign out" before the sentences explaining what the thing does. Destructive
 * controls belong after the explanation, and the stored folder belongs next to
 * them because it is the same question: what did I give this.
 *
 * Renders nothing when the answer is nothing, rather than an empty box.
 */
function WhatYouGaveIt({
  def,
  cfg,
  onChanged,
}: {
  def: ConnectorDefinition
  cfg: ConnectorConfigHandle
  onChanged: () => void
}) {
  const { config, saveConfig, reload, hasConfig } = cfg
  const remote = def.launch.transport !== 'stdio'
  const showConfig = Boolean(config && hasConfig)
  const showSignOut = remote && Boolean(config?.authorized)
  const showRemove = def.provenance === 'custom'
  if (!showConfig && !showSignOut && !showRemove) return null

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        What you gave it
      </h3>
      {/* Still editable after it is satisfied. A credential can expire and a
          folder can be the wrong one, and neither is fixable from a panel that
          disappeared the moment it was filled in. */}
      {showConfig && config && (
        <ConfigForm def={def} state={config} onSaved={saveConfig} collapsedByDefault />
      )}
      {/* The way OUT, which nothing else offers. A stored token cannot be
          inspected, so the only thing an operator can do with one is replace it
          or forget it; without this the tokens are unreachable from the product
          and a provider-side revocation has no local counterpart. */}
      {showSignOut && (
        <RevokeRow
          title={`Signed in to ${def.displayName}`}
          detail="Signing out deletes the stored tokens and stops the connection."
          action="Sign out"
          busyLabel="Signing out…"
          onConfirm={async () => {
            if (await signOutConnector(def.slug, def.displayName)) await reload()
          }}
        />
      )}
      {/* Only a custom entry can be removed: a curated one is part of the
          catalog, and deleting it would be deleting a row of the product. */}
      {showRemove && (
        <RevokeRow
          title="Remove this connector"
          detail="Deletes the definition you added. Its process is stopped first."
          action="Remove"
          busyLabel="Removing…"
          onConfirm={async () => {
            if (await deleteCustomConnector(def.slug, def.displayName)) onChanged()
          }}
        />
      )}
    </section>
  )
}

/**
 * What this connector actually gave the fleet.
 *
 * The strongest replacement for a config block, because it is PROOF rather than
 * instructions: these are the exact names the model will see. It is also the
 * only place a dropped tool is visible, and a tool dropped for a duplicate name
 * is otherwise silent.
 */
function ConnectedTools({ def, connected }: { def: ConnectorDefinition; connected: boolean }) {
  const [rows, setRows] = useState<LiveConnectorRow[]>([])
  useEffect(() => {
    if (!connected) {
      setRows([])
      return
    }
    void listLiveConnectors().then(setRows)
  }, [connected, def.slug])

  const row = rows.find((r) => r.slug === def.slug)
  if (!connected || !row) return null

  return (
    <section className="rounded-xl border border-border bg-surface-subtle p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {row.toolCount} {row.toolCount === 1 ? 'tool' : 'tools'} your agents can call
      </h3>
      <p className="mt-2 break-words text-xs leading-relaxed text-foreground">
        {row.tools.map((name) => name.replace(/^mcp__[^_]+__/, '')).join(', ')}
      </p>
      {row.skipped.length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {row.skipped.length} dropped:{' '}
          {row.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}
        </p>
      )}
    </section>
  )
}

function ConnectorDetail({
  def,
  connected,
  onConnected,
  onClose,
}: {
  def: ConnectorDefinition
  connected: boolean
  onConnected: () => void
  onClose: () => void
}) {
  // OWNED HERE so the action and "What you gave it" read one answer.
  const cfg = useConnectorConfig(def, onConnected)
  const [dialect, setDialect] = useState<SnippetDialect>('claude-code')
  const [copied, setCopied] = useState(false)
  const addToast = useToastStore((s) => s.addToast)
  const snippet = useMemo(() => connectorSnippet(def, dialect), [def, dialect])

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet.body)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard is permission-gated and fails silently in some contexts. Say so
      // rather than leaving the button looking like it worked.
      addToast({
        type: 'error',
        message: 'Could not copy. Select the block and copy manually.',
      })
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-6 py-5">
      <div className="flex items-start gap-3">
        {/* The same mark that was on the card. Dropping it here left the pane
            visually unanchored to the thing the reader just clicked. */}
        <ConnectorMark slug={def.slug} displayName={def.displayName} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">{def.displayName}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{def.description}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Back
        </Button>
      </div>

      {/* The connect action, or the reason there isn't one. Above the snippet
          because running it here is now the primary verb; pasting a config into
          your own runtime is the fallback for everything clawboo cannot run. */}
      <ConnectAction def={def} connected={connected} onChanged={onConnected} cfg={cfg} />

      {/* WHAT IT CAN DO, in sentences. This replaces the `3/3 risk` chip, and
          prose beats a chip here for one reason: the fact being communicated is
          a CONSEQUENCE, and a fraction cannot carry a consequence. Same three
          booleans, same data, still feeding `decideGrant`. Only the badge died. */}
      <section className="rounded-xl border border-border bg-surface-subtle p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What it can do
        </h3>
        <ul className="mt-2 space-y-1 text-xs text-foreground">
          <li>
            {def.launch.transport === 'stdio'
              ? 'Runs on this machine, as you.'
              : `Talks to ${def.launch.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}.`}
          </li>
          {def.trifecta.readsPrivateData && (
            <li>Reads private data from your {def.displayName}.</li>
          )}
          {def.trifecta.ingestsUntrustedContent && (
            <li>Reads things other people wrote, so treat what it hands back as untrusted.</li>
          )}
          {def.trifecta.canEgress && (
            <li>
              Can send data out to{' '}
              {def.egressAllow.includes('*') ? 'any host it likes' : def.egressAllow.join(', ')}.
            </li>
          )}
          {!def.trifecta.canEgress && <li>Cannot reach the network.</li>}
        </ul>
      </section>

      {/* BETWEEN the consequences and the proof. What the reader handed over
          sits after the explanation of what this thing does with it, and before
          the list of what it gave back. */}
      <WhatYouGaveIt def={def} cfg={cfg} onChanged={onConnected} />

      {/* The tools themselves, once it is running. The strongest possible
          replacement for a config block: proof the thing works, in the words the
          agent will actually see. */}
      <ConnectedTools def={def} connected={connected} />

      {def.auth.setupGuide && (
        <section className="rounded-xl border border-border p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Setup: {def.auth.setupGuide.console}
          </h3>
          <ol className="mt-2 list-inside list-decimal space-y-1 text-xs text-foreground">
            {def.auth.setupGuide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <a
            href={def.auth.setupGuide.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs text-accent underline"
          >
            Open {def.auth.setupGuide.console}
          </a>
        </section>
      )}

      {/* EVERYTHING BELOW IS FOR OPERATORS, and it is collapsed because it stopped
          being the path. The exact argv, the pinned version and the paste-into-
          another-runtime block were primary content when this tab was a directory
          and clawboo could run nothing. For 18 of 19 entries they are now the
          fallback, and leaving them on top is what made the pane read as
          documentation rather than as a product. Nothing is hidden: one click
          away is not the same as gone. */}
      <details className="rounded-xl border border-border">
        <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-muted-foreground hover:text-foreground">
          Technical details
        </summary>
        <div className="flex flex-col gap-3 border-t border-border p-4">
          <ul className="space-y-1 text-[11px] text-foreground">
            <li>
              <span className="text-muted-foreground">Runs: </span>
              <code>
                {def.launch.transport === 'stdio'
                  ? `${def.launch.command} ${def.launch.args.join(' ')}`
                  : def.launch.url}
              </code>
            </li>
            <li>
              <span className="text-muted-foreground">Network: </span>
              {def.egressAllow.length === 0 ? 'none, local only' : def.egressAllow.join(', ')}
            </li>
            {def.auth.inputs.length > 0 && (
              <li>
                <span className="text-muted-foreground">Reads: </span>
                {def.auth.inputs.map((i) => i.key).join(', ')}{' '}
                <span className="text-muted-foreground">
                  (from clawboo&rsquo;s vault, never from a config file)
                </span>
              </li>
            )}
            {def.auth.scopesRationale && (
              <li>
                <span className="text-muted-foreground">Scopes: </span>
                {def.auth.scopesRationale}
              </li>
            )}
          </ul>

          {/* NOTHING TO EXPORT FOR A BROKERED APP. This section emits a config
            block to paste into another runtime, and a brokered entry's launch
            is the broker's endpoint: pasting it elsewhere would point that
            runtime at Composio's whole surface rather than at this one app,
            which is both wrong and more access than the reader asked for. */}
          {!def.brokeredBy && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Use it somewhere else
                </h4>
                {/* A pressed-state group, NOT role="tablist". The ARIA tab pattern
                  obliges arrow-key roving, a roving tabindex and an aria-controls
                  tabpanel; announcing a widget that does not behave the way it was
                  announced is worse for a screen reader than plain buttons. */}
                <div className="flex gap-1" role="group" aria-label="Config dialect">
                  {SNIPPET_DIALECTS.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      aria-pressed={dialect === d.id}
                      onClick={() => setDialect(d.id)}
                      className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                        dialect === d.id
                          ? 'bg-surface-strong text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <code>{snippet.file}</code>
                <Button size="sm" variant="secondary" onClick={copy}>
                  {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>

              <pre className="max-h-72 overflow-auto rounded-xl border border-border bg-surface-subtle p-3 text-[11px] leading-relaxed">
                <code>{snippet.body}</code>
              </pre>

              {snippet.requiredEnv.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  You will also need to set {snippet.requiredEnv.join(', ')} in your environment.
                  The block references them by name so it stays safe to commit.
                </p>
              )}
            </div>
          )}
        </div>
        {/* INSIDE the disclosure. A bare source-and-documentation link dangling
            below it was the one piece of developer material still on the
            surface after everything else was tucked away. */}
        {def.homepage && (
          <a
            href={def.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-xs text-accent underline"
          >
            Connector source and documentation
          </a>
        )}
      </details>
    </div>
  )
}

// ─── Browser ────────────────────────────────────────────────────────────────

export function ConnectorsBrowser() {
  const searchQuery = useMarketplaceStore((s) => s.connectorSearchQuery)
  const setSearchQuery = useMarketplaceStore((s) => s.setConnectorSearchQuery)
  const categoryFilter = useMarketplaceStore((s) => s.connectorCategoryFilter)
  const setCategoryFilter = useMarketplaceStore((s) => s.setConnectorCategoryFilter)
  const [selected, setSelected] = useState<ConnectorDefinition | null>(null)

  // Stated rather than implied. The header used to read "a directory, not an
  // installer", which was true when nothing here could run and is now false for
  // exactly the connectable set. The number it shows is what the shelf can turn
  // on WITHOUT the reader first going somewhere else for a key, because a header
  // promising nineteen next to eight cards asking for a token is the same broken
  // promise `connectorCost` exists to stop a button from making.

  // The operator's own entries, merged with the committed catalog. Fetched
  // rather than bundled: they live in the database, so the browser cannot know
  // them statically the way it knows the catalog.
  const [custom, setCustom] = useState<ConnectorDefinition[]>([])
  const refreshCustom = useCallback(() => {
    void listCustomConnectors().then(setCustom)
  }, [])
  useEffect(refreshCustom, [refreshCustom])

  // A deep link from anywhere else, by slug: the graph's Configure button, and
  // the in-chat connect card. Consumed once and cleared, so returning to the tab
  // later lands on the shelf rather than re-opening whatever was last linked.
  const openSlug = useMarketplaceStore((s) => s.openConnectorSlug)
  const setOpenSlug = useMarketplaceStore((s) => s.setOpenConnectorSlug)
  useEffect(() => {
    if (!openSlug) return
    const def = connectorBySlug(openSlug) ?? custom.find((c) => c.slug === openSlug) ?? null
    if (def) setSelected(def)
    setOpenSlug(null)
  }, [openSlug, custom, setOpenSlug])

  const matched = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const mine = q
      ? custom.filter(
          (c) =>
            c.displayName.toLowerCase().includes(q) ||
            c.slug.includes(q) ||
            c.description.toLowerCase().includes(q),
        )
      : custom
    const all = [...mine, ...searchConnectors(searchQuery)]
    if (categoryFilter === 'all') return all
    // `community` is a BAND, not a category: selecting it shows the long tail
    // below the divider and hides the curated grid rather than filtering it to
    // an empty state that reads as "there is nothing here".
    if (categoryFilter === 'community') return []
    // The two COST-AXIS filters cannot narrow here: what a connector costs is
    // known only after the shelf has read live and configured state, and the
    // shelf takes this list as its input. They are applied to the priced result
    // instead, below.
    if (
      categoryFilter === 'connected' ||
      categoryFilter === 'not-connected' ||
      categoryFilter === 'yours'
    )
      return all
    return all.filter((c) => c.category === categoryFilter)
  }, [searchQuery, categoryFilter, custom])

  // One owner for live state, stored configuration, per-card busy and the card
  // actions. See useConnectorShelf: nineteen copies of that state drift.
  const shelf = useConnectorShelf(matched, setSelected)

  // Counted over the WHOLE curated directory, never the filtered view. Counting
  // the filtered set put "19 connectors, 0 you can turn on right now" on screen
  // under a filter that shows none of them: two numbers describing two different
  // populations, which reads as a bug in the product rather than in the sentence.
  //
  // SPLIT, because a connector that is already running cannot also be one you
  // can turn on. Folding both into one number meant the count never moved as the
  // operator connected things, which is the one moment they would look at it.
  const tally = useMemo(() => {
    let on = 0
    let ready = 0
    for (const d of searchConnectors('')) {
      const cost = shelf.costOf(d)
      if (cost === 'on') on += 1
      else if (isImmediate(cost)) ready += 1
    }
    return { on, ready }
  }, [shelf])
  // Applied AFTER pricing, for the reason above. THREE STATES, not five: the
  // two questions a reader actually arrives with are "what have I got" and
  // "what can I add", and a row of six competing filters answered neither
  // faster than scrolling did. "Yours" survives because an operator's own entry
  // is otherwise findable only by remembering its name.
  const results = useMemo(() => {
    if (categoryFilter === 'connected') return shelf.ordered.filter((d) => shelf.costOf(d) === 'on')
    if (categoryFilter === 'not-connected')
      return shelf.ordered.filter((d) => shelf.costOf(d) !== 'on')
    if (categoryFilter === 'yours')
      return shelf.ordered.filter((d) => d.provenance === 'custom' || shelf.isConfigured(d.slug))
    return shelf.ordered
  }, [categoryFilter, shelf])

  // Constant for the life of the build, so it is read once rather than memoised.
  const counts = connectorCounts()

  // THREE BANDS, READ TOP TO BOTTOM. Names people arrive already knowing, then
  // the rest of what clawboo has run, then the open registry. The reader never
  // has to learn what "curated" or "unchecked" mean to use the page: the order
  // is the claim, and it descends from most recognised to least.
  const [popularResults, moreResults] = useMemo(() => {
    const popular: ConnectorDefinition[] = []
    const more: ConnectorDefinition[] = []
    for (const def of results) (def.popular ? popular : more).push(def)
    return [popular, more]
  }, [results])

  // Reset on every change to the question being asked, so a narrowed search
  // never inherits a deep page from the previous one.
  const [communityPage, setCommunityPage] = useState(1)
  useEffect(() => setCommunityPage(1), [searchQuery, categoryFilter])

  const communityQuery = searchQuery.trim()
  // THE LONG TAIL, and it stays behind a divider with its own count forever.
  // Never on first paint: it is roughly 220 KB and worth nothing until the
  // operator asks a question it could answer.
  //
  // A CURATED HIT USED TO SUPPRESS IT ENTIRELY. The condition was `results
  // .length === 0`, so one vouched-for match hid every registry match behind
  // it: searching "search" matches Exa on a tag and buried sixty-seven registry
  // entries, "file" buried twenty. Search is the only way into this band, and
  // it failed silently on exactly the generic words someone browsing types.
  //
  // The single-character path is kept deliberately. Nine one-character queries
  // return no curated match at all, and each of them opens the band today; a
  // flat two-character minimum would have replaced those nine working searches
  // with an empty state while the registry held matches.
  const wantsCommunity = wantsCommunityBand({
    categoryFilter,
    query: communityQuery,
    curatedHits: results.length,
  })
  const community = useCommunityConnectors(wantsCommunity)
  // The FULL match set, before the render cap. Kept so the divider can say how
  // many were found rather than how many fitted: "60 from the MCP registry" next
  // to a snapshot of 230 understates the directory to exactly the person who
  // opened this band to find out how big it is.
  const communityMatches = useMemo(() => {
    if (!wantsCommunity) return []
    const found = searchCommunity(community.entries, communityQuery)
    // THE ONES SOMEONE RECOGNISES, FIRST. The snapshot is written in publisher
    // order, which is meaningless to a reader and put all thirty-three entries
    // carrying a real logo behind the first page bar five. Sorting on "do we
    // have a mark for this" is a proxy for "is this a service you have heard
    // of", and it is the only signal available: the registry publishes no
    // popularity data of any kind. Sort is stable, so publisher order still
    // decides within each group.
    return [...found].sort((a, b) => Number(hasBrandMark(b.slug)) - Number(hasBrandMark(a.slug)))
  }, [wantsCommunity, community.entries, communityQuery])
  const communityResults = useMemo(
    () => communityMatches.slice(0, COMMUNITY_PAGE_SIZE * communityPage),
    [communityMatches, communityPage],
  )

  const categoryOptions: PillOption[] = useMemo(() => {
    const present = new Set(searchConnectors('').map((c) => c.category))
    // NO 'all' ENTRY: CollapsiblePillRow renders its own All pill, and passing one
    // too put two identical pills side by side.
    return [
      // THE TWO-WORD ANSWER to the only question a browsing operator is really
      // asking. It leads because the ordering already puts these first, and a
      // filter that agrees with the sort is one the reader can trust.
      // ONE STATE FILTER. There were three, and two of them answered the same
      // question: "Connected" and "Yours" returned nearly the same rows for
      // anyone who had not hand-added a server, and "Not connected" was the
      // inverse of a filter that was already there. A reader deciding between
      // three overlapping pills is doing the product's sorting for it.
      //
      // NO PROVENANCE PILL either. "Unchecked" named a distinction that matters
      // to whoever maintains the catalogue and to nobody choosing a connector;
      // the third band is reached by reading down the list instead.
      { key: 'connected', label: 'Connected' },
      ...[...present].sort().map((c) => ({ key: c, label: CATEGORY_LABELS[c] })),
    ]
  }, [])

  if (selected && selected.provenance === 'community') {
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto px-6 py-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{selected.displayName}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {selected.description}
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setSelected(null)}>
            Back
          </Button>
        </div>
        <CommunityConsent
          def={selected}
          onCancel={() => setSelected(null)}
          onAdded={() => {
            // It is the operator's own entry now, so it leaves the community band
            // and lands on the ordinary key flow with its provenance recorded.
            setSelected(null)
            refreshCustom()
            shelf.refresh()
          }}
        />
      </div>
    )
  }

  if (selected) {
    return (
      <ConnectorDetail
        def={selected}
        connected={shelf.costOf(selected) === 'on'}
        onConnected={shelf.refresh}
        onClose={() => setSelected(null)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Its own surface now, so it gets its own title. As a Marketplace tab it
          inherited that panel's header and opened straight onto a filter bar,
          which read as a sub-screen of a shop rather than a place of its own. */}
      <div className="shrink-0 px-6 pt-5">
        <h2 className="text-[15px] font-semibold leading-none text-foreground">Connectors</h2>
        {/* SCOPED, because four of the nineteen are remote and nothing runs
            locally for them. "Everything runs on this machine" is the local-first
            claim worth making and it was simply false for GitHub, Linear, Sentry
            and Stripe. The detail pane already branches on the transport for
            exactly this reason; the header was the one place still saying it
            flat. */}
        <p className="mt-1.5 text-[12.5px] text-muted-foreground">Tools your agents can use.</p>
      </div>
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-border px-6 py-3.5">
        <SearchInput
          size="sm"
          placeholder="Search connectors"
          value={searchQuery}
          onChange={setSearchQuery}
        />
        <CollapsiblePillRow
          aria-label="Filter connectors by category"
          options={categoryOptions}
          activeKey={categoryFilter}
          onSelect={(key) => setCategoryFilter(key as ConnectorCategory | 'all')}
        />
      </div>

      {/* WHAT IS ON, and nothing else. The line this replaces reported three
          numbers at once and made the reader do arithmetic before they could
          look for Notion: "19 connectors, 1 on, 7 more you can turn on right
          now, plus 400 clawboo has not checked". The section headings below
          carry the counts now, each one describing the list beneath it. The
          split is still real and still never becomes a single total. */}
      {tally.on > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 px-6 pt-2 text-[12px] text-muted-foreground">
          <Check size={13} strokeWidth={2.6} className="text-mint" aria-hidden />
          <span className="tabular-nums">{tally.on} connected</span>
        </div>
      )}

      {/* A MEASURE, not the full pane width. On a wide display the action sat
          more than a thousand pixels from the name it belonged to, which reads
          as two unrelated columns rather than as one row. */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto w-full max-w-3xl">
          {results.length === 0 && !wantsCommunity ? (
            <EmptyState
              icon={SearchX}
              title="No connectors match"
              helper="Try a different search or clear the category filter."
            />
          ) : results.length === 0 && searchQuery.trim() !== '' ? (
            // A MISS IN BOTH SETS. The community fallthrough suppresses the empty
            // state, so without this the screen answered a search for something
            // nobody has written a server for with a divider reading "0 from the
            // MCP registry" and nothing else: an inventory statement where the
            // reader expected an answer.
            <p className="pt-6 text-center text-xs text-muted-foreground">
              Nothing set up for <span className="text-foreground">{searchQuery.trim()}</span> yet.
              {community.loading
                ? ' Looking in the MCP registry…'
                : communityMatches.length > 0
                  ? ''
                  : ' The MCP registry has no match either.'}
            </p>
          ) : results.length > 0 ? (
            // EACH BAND GUARDED ON ITS OWN CONTENTS. A heading with nothing
            // under it is a section the reader goes looking for and cannot
            // find, and every filter here can empty one band while leaving the
            // other full.
            <>
              <ShelfBand
                title="Popular"
                defs={popularResults}
                offset={0}
                shelf={shelf}
                onOpen={setSelected}
              />
              <ShelfBand
                title="More connectors"
                defs={moreResults}
                offset={popularResults.length}
                shelf={shelf}
                onOpen={setSelected}
              />
            </>
          ) : null}
          {/* Nothing to divide off when the band is empty and not loading: a divider
            announcing "0 from the MCP registry" is an inventory statement, and the
            miss has already been reported above. An error still shows, because
            "could not load" is a fact the reader needs. */}
          {wantsCommunity &&
            (communityResults.length > 0 || community.loading || community.error) && (
              <section className="mt-6">
                {/* A SECTION, not a warning band. The counts still never merge
                into one total ("419 connectors" is the claim every reference
                implementation makes and none can support), but the heading now
                says what the list IS rather than what clawboo has not done to
                it. The one-line note below carries the provenance, once. */}
                <div className="flex items-baseline gap-2 px-3 pb-0.5 pt-1">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                    From the community
                  </h3>
                  <span className="text-[11px] tabular-nums text-muted-foreground/70">
                    {community.loading
                      ? '…'
                      : community.error
                        ? // No count when there is nothing to count. A dash beside
                          // the heading reads as a value; the line below already
                          // says the list could not be read.
                          ''
                        : communityMatches.length > communityResults.length
                          ? `${communityResults.length} of ${communityMatches.length}`
                          : communityResults.length}
                  </span>
                </div>
                {/* NO PROVENANCE PARAGRAPH. It used to read "clawboo has not
                  checked these", which is true, and which nobody choosing a
                  connector needs before they have chosen one. The warning did
                  not go away: it moved to the consent step, where it is about
                  to matter and cannot be scrolled past. An error still shows,
                  because a list that failed to load is a fact about the screen
                  in front of the reader. */}
                {community.error && (
                  <p className="px-3 pb-2 text-[11.5px] text-muted-foreground">
                    Could not load this list. The ones above are unaffected.
                  </p>
                )}
                {communityResults.length > 0 && (
                  <div className="flex flex-col">
                    {communityResults.map((def, i) => (
                      <ConnectorCard
                        key={def.slug}
                        def={def}
                        index={i}
                        cost="not-reviewed"
                        busy={false}
                        onOpen={setSelected}
                        onAct={setSelected}
                        // A community card never expands in place: `not-reviewed`
                        // is not an inlineable cost, and its action is the consent
                        // step rather than a field.
                        onConfigured={shelf.refresh}
                      />
                    ))}
                  </div>
                )}
                {/* THE WAY PAST SIXTY. Everything here is already in memory, so
                  this costs no request and no import; it exists because a list
                  that stops without saying so reads as the whole directory. */}
                {communityMatches.length > communityResults.length && (
                  <div className="mt-3 flex justify-center">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setCommunityPage((n) => n + 1)}
                    >
                      {communityMatches.length - communityResults.length > COMMUNITY_PAGE_SIZE
                        ? `Show ${COMMUNITY_PAGE_SIZE} more`
                        : `Show the last ${communityMatches.length - communityResults.length}`}
                    </Button>
                  </div>
                )}
              </section>
            )}
          {/* THE SECOND POPULATION, NAMED WHERE IT IS MISSED. On the default
            view the registry band does not render at all, which is correct (it
            is a lazy 220 KB) but left the shelf looking like the whole of
            clawboo's connector support. This costs nothing: the count is a
            constant on the static path, and the button is what loads the band.
            The two numbers stay adjacent and separate rather than summed, which
            is the rule the provenance split turns on. */}
          {categoryFilter === 'all' && communityQuery === '' && (
            <div className="mt-6 flex flex-col items-center gap-1.5 border-t border-border pt-5">
              <Button size="sm" variant="secondary" onClick={() => setCategoryFilter('community')}>
                Show {counts.community} more
              </Button>
            </div>
          )}
          <AddCustomConnector onAdded={refreshCustom} />
        </div>
      </div>
    </div>
  )
}
