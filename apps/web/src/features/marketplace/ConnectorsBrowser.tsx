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
import {
  Check,
  Copy,
  Globe,
  Info,
  KeyRound,
  Plug,
  Plus,
  SearchX,
  ShieldAlert,
  Terminal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  CONNECT_REFUSAL_COPY,
  connectorCounts,
  isReachable,
  needsArgumentOnly,
  needsCredentialOnly,
  needsSignInOnly,
  connectorSnippet,
  connectRefusal,
  isConnectable,
  searchConnectors,
  SNIPPET_DIALECTS,
  type ConnectorCategory,
  type ConnectorDefinition,
  type SnippetDialect,
} from '@clawboo/connector-catalog'
import { Button } from '@/features/shared/Button'
import { Chip } from '@/features/shared/Chip'
import { EmptyState } from '@/features/shared/EmptyState'
import { SearchInput } from '@/features/shared/SearchInput'
import { CollapsiblePillRow, type PillOption } from './CollapsiblePillRow'
import { useToastStore } from '@/stores/toast'
import { useMarketplaceStore } from '@/stores/marketplace'
import {
  connectConnector,
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
  type CredentialStatus,
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
}

/**
 * The status word a user reads.
 *
 * A CONNECTABLE entry now reports its connection STATE. It used to say "Active"
 * on the grounds that a no-auth server is ready the moment it is attached, and
 * that was true while this tab was a directory and nothing more. It is exactly
 * the set that now offers a Connect button, so leaving it would put "Active"
 * next to "Connect" on the same tile and claim a state the backend does not
 * have.
 */
function authLabel(
  def: ConnectorDefinition,
  connected: boolean,
): { label: string; icon?: LucideIcon; active: boolean } {
  // `connected` is the live truth from the server, so it is checked FIRST and
  // for every entry. Gating it on `isConnectable(def)` meant a connector that
  // needed a key, a path or a sign-in never showed "Connected" even while its
  // process was running, which is 14 of the 19.
  if (connected) return { label: 'Connected', icon: Plug, active: true }
  if (isConnectable(def)) return { label: 'Not connected', active: false }
  if (def.auth.kind === 'oauth') return { label: 'Sign in', icon: KeyRound, active: false }
  // "Add …" rather than "Needs …": both are now something the user can do here,
  // not a statement about why they cannot.
  if (needsArgumentOnly(def)) return { label: 'Add a path', icon: KeyRound, active: false }
  if (needsCredentialOnly(def)) return { label: 'Add a key', icon: KeyRound, active: false }
  if (def.auth.kind === 'none') return { label: 'Copy config', active: false }
  return { label: 'Needs a key', icon: KeyRound, active: false }
}

/** How many trifecta legs this connector can arm, at its most permissive. */
function legCount(def: ConnectorDefinition): number {
  const t = def.trifecta
  return (t.readsPrivateData ? 1 : 0) + (t.ingestsUntrustedContent ? 1 : 0) + (t.canEgress ? 1 : 0)
}

// ─── Card ───────────────────────────────────────────────────────────────────

function ConnectorCard({
  def,
  index,
  connected,
  onOpen,
}: {
  def: ConnectorDefinition
  index: number
  connected: boolean
  onOpen: (def: ConnectorDefinition) => void
}) {
  const auth = authLabel(def, connected)
  const legs = legCount(def)
  const remote = def.launch.transport === 'streamable-http'

  return (
    <motion.button
      type="button"
      onClick={() => onOpen(def)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.4) }}
      className="group flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 text-left transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      style={{ boxShadow: 'var(--shadow-raised)' }}
      aria-label={`${def.displayName} connector: ${auth.label}, ${legs} of 3 risk signals`}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'color-mix(in srgb, var(--category-other) 14%, transparent)' }}
        >
          <Plug size={18} style={{ color: 'var(--category-other)' }} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{def.displayName}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {remote ? <Globe size={11} aria-hidden /> : <Terminal size={11} aria-hidden />}
            <span>{remote ? 'Remote' : 'Local process'}</span>
            <span aria-hidden>·</span>
            <span>{CATEGORY_LABELS[def.category]}</span>
          </div>
        </div>
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {def.description}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <Chip size="sm" icon={auth.icon} active={auth.active}>
          {auth.label}
        </Chip>
        {legs >= 2 && (
          <Chip size="sm" icon={ShieldAlert} accent="var(--amber)">
            {legs}/3 risk
          </Chip>
        )}
        {def.provenance === 'community' && <Chip size="sm">Community</Chip>}
      </div>
    </motion.button>
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
}: {
  def: ConnectorDefinition
  state: ConnectorConfigState
  onSaved: (next: ConnectorConfigState) => void
  /** Collapsed once everything is supplied: present but out of the way. */
  collapsedByDefault?: boolean
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [argument, setArgument] = useState(state.argument ?? '')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(!collapsedByDefault)

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
        onSaved(next)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface-subtle p-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <KeyRound size={13} aria-hidden />
        Before it can run
      </div>
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
              <code>{cred.key}</code>
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
              onChange={(e) => setDraft((d) => ({ ...d, [cred.key]: e.target.value }))}
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
                Where to get this
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
          {busy ? 'Saving…' : 'Save'}
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
            Opens {def.displayName} in a new tab. clawboo registers itself with them for this
            install and keeps the resulting token on this machine, encrypted.
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

function ConnectAction({
  def,
  connected,
  onChanged,
}: {
  def: ConnectorDefinition
  connected: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [config, setConfig] = useState<ConnectorConfigState | null>(null)

  // Fetched for ANY connector with something to configure, not only an
  // unsatisfied one. A credential or folder that can never be seen or changed
  // again is worse than one that was never asked for: checking which folder a
  // connector was handed is the entire reason for asking.
  const hasConfig =
    def.auth.inputs.length > 0 || def.userArgument !== undefined || needsSignInOnly(def)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!hasConfig) return
    void fetchConnectorConfig(def.slug).then((next) => {
      if (next) setConfig(next)
      else setFailed(true)
    })
  }, [hasConfig, def.slug])

  const configGated = needsCredentialOnly(def) || needsArgumentOnly(def) || needsSignInOnly(def)
  const satisfied = config?.satisfied ?? false
  // The FOURTH argument is not optional in practice: without it every remote
  // connector reads as never-signed-in, so the panel refuses an action the
  // server would have accepted and Connect is unreachable forever.
  const refusal = connectRefusal(def, satisfied, satisfied, config?.authorized ?? false)

  if (configGated && !satisfied) {
    if (config && needsSignInOnly(def) && !config.authorized) {
      return (
        <SignInPanel
          def={def}
          onChanged={() => void fetchConnectorConfig(def.slug).then(setConfig)}
        />
      )
    }
    if (config) return <ConfigForm def={def} state={config} onSaved={setConfig} />
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
          Not connectable yet
        </div>
        {/* Verbatim from the shared predicate: the actual obstacle, not a status. */}
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {CONNECT_REFUSAL_COPY[refusal]}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          You can still copy the config below into a runtime you already use.
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
      {/* Still editable after it is satisfied. A credential can expire and a
          folder can be the wrong one, and neither is fixable from a panel that
          disappeared the moment it was filled in. */}
      {config && hasConfig && (
        <ConfigForm def={def} state={config} onSaved={setConfig} collapsedByDefault />
      )}
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
      {/* The way OUT, which nothing else offers. A stored token cannot be
          inspected, so the only thing an operator can do with one is replace it
          or forget it; without this the tokens are unreachable from the product
          and a provider-side revocation has no local counterpart. */}
      {remote && config?.authorized && (
        <RevokeRow
          title={`Signed in to ${def.displayName}`}
          detail="Signing out deletes the stored tokens and stops the connection."
          action="Sign out"
          busyLabel="Signing out…"
          onConfirm={async () => {
            if (await signOutConnector(def.slug, def.displayName)) {
              const next = await fetchConnectorConfig(def.slug)
              if (next) setConfig(next)
              onChanged()
            }
          }}
        />
      )}
      {/* Only a custom entry can be removed: a curated one is part of the
          catalog, and deleting it would be deleting a row of the product. */}
      {def.provenance === 'custom' && (
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
      <ConnectAction def={def} connected={connected} onChanged={onConnected} />

      {/* What it is allowed to reach. Shown before the snippet on purpose: the
          decision a user is making is "should this run at all", not "where do I
          paste it". */}
      <section className="rounded-xl border border-border bg-surface-subtle p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What it can reach
        </h3>
        <ul className="mt-2 space-y-1 text-xs text-foreground">
          <li>
            {def.launch.transport === 'stdio'
              ? `Runs locally: ${def.launch.command} ${def.launch.args.join(' ')}`
              : `Talks to ${def.launch.url}`}
          </li>
          <li>
            Network:{' '}
            {def.egressAllow.length === 0
              ? 'none, local only'
              : def.egressAllow.includes('*')
                ? 'any host (a browser can go anywhere)'
                : def.egressAllow.join(', ')}
          </li>
          {def.auth.inputs.length > 0 && (
            <li>
              Needs: {def.auth.inputs.map((i) => i.key).join(', ')}{' '}
              <span className="text-muted-foreground">
                (stored in clawboo&rsquo;s vault, never in a config file)
              </span>
            </li>
          )}
          {def.auth.scopesRationale && <li>Scopes: {def.auth.scopesRationale}</li>}
        </ul>
      </section>

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

      {/* The snippet. Framed as "paste this into your own runtime" because that is
          literally what it does: clawboo writes nothing. */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Add it to your runtime
          </h3>
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
            You will also need to set {snippet.requiredEnv.join(', ')} in your environment. The
            block references them by name so it stays safe to commit.
          </p>
        )}
      </section>

      {def.homepage && (
        <a
          href={def.homepage}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent underline"
        >
          Connector source and documentation
        </a>
      )}
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

  const counts = connectorCounts()
  // Stated rather than implied. The header used to read "a directory, not an
  // installer", which was true when nothing here could run and is now false for
  // exactly the connectable set.
  // Everything an operator could get running once they have filled in whatever
  // it asks for. `isReachable` exists precisely so this is one predicate rather
  // than a hand-assembled union that forgets a case -- which it did, by two.
  const connectableCount = useMemo(() => searchConnectors('').filter(isReachable).length, [])

  // The operator's own entries, merged with the committed catalog. Fetched
  // rather than bundled: they live in the database, so the browser cannot know
  // them statically the way it knows the catalog.
  const [custom, setCustom] = useState<ConnectorDefinition[]>([])
  const refreshCustom = useCallback(() => {
    void listCustomConnectors().then(setCustom)
  }, [])
  useEffect(refreshCustom, [refreshCustom])

  const results = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const mine = q
      ? custom.filter(
          (c) =>
            c.displayName.toLowerCase().includes(q) ||
            c.slug.includes(q) ||
            c.description.toLowerCase().includes(q),
        )
      : custom
    const matched = [...mine, ...searchConnectors(searchQuery)]
    return categoryFilter === 'all' ? matched : matched.filter((c) => c.category === categoryFilter)
  }, [searchQuery, categoryFilter, custom])

  const categoryOptions: PillOption[] = useMemo(() => {
    const present = new Set(searchConnectors('').map((c) => c.category))
    return [
      { key: 'all', label: 'All' },
      ...[...present].sort().map((c) => ({ key: c, label: CATEGORY_LABELS[c] })),
    ]
  }, [])

  // Which connectors are live, by slug. Fetched rather than assumed: a connector
  // survives a page reload because the PROCESS is owned by the server, so a
  // client-side guess would be wrong on every refresh.
  const [liveSlugs, setLiveSlugs] = useState<ReadonlySet<string>>(new Set())
  const refreshLive = useCallback(() => {
    void listLiveConnectors().then((rows) => setLiveSlugs(new Set(rows.map((r) => r.slug))))
  }, [])
  useEffect(refreshLive, [refreshLive])

  if (selected) {
    return (
      <ConnectorDetail
        def={selected}
        connected={liveSlugs.has(selected.slug)}
        onConnected={refreshLive}
        onClose={() => setSelected(null)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-border px-6 py-3.5">
        <SearchInput
          size="sm"
          placeholder="Search connectors…"
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

      {/* The count is always a SPLIT, never one total. "1000+" is the claim the
          reference implementations make and cannot support. */}
      <div className="shrink-0 px-6 pt-3 text-[11px] text-muted-foreground">
        {counts.curated} curated
        {counts.community > 0 && <> · {counts.community} community</>} · {connectableCount}{' '}
        {connectableCount === 1 ? 'runs' : 'run'} here; the rest are a directory, so copy their
        config into a runtime you already use
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {results.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No connectors match"
            helper="Try a different search or clear the category filter."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((def, i) => (
              <ConnectorCard
                key={def.slug}
                def={def}
                index={i}
                connected={liveSlugs.has(def.slug)}
                onOpen={setSelected}
              />
            ))}
          </div>
        )}
        <AddCustomConnector onAdded={refreshCustom} />
      </div>
    </div>
  )
}
