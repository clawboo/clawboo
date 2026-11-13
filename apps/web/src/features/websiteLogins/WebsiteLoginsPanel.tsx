// Settings > Website logins. A person saves the logins their agents may sign in
// with, and can connect 1Password as a second source.
//
// A VALUE IS NEVER READ BACK. The list shows where a login fills (its origin), its
// label and two markers, nothing else, because the server answers nothing else.
// The edit form starts with empty username, password and one-time code fields and
// sends only what the person typed. Passwords, one-time code keys and the
// 1Password token leave component state the moment their request is over, success
// or failure, and every failure is shown through the fixed map in the client.

import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Globe, KeyRound, LogIn, Plus } from 'lucide-react'

import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { Skeleton } from '@/features/shared/Skeleton'
import { StatusPill } from '@/features/shared/StatusPill'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { confirm } from '@/stores/confirm'
import { useToastStore } from '@/stores/toast'

import {
  connectOnePassword,
  installOnePasswordSupport,
  createWebsiteLogin,
  deleteWebsiteLogin,
  disconnectOnePassword,
  fetchWebsiteLogins,
  loginErrorMessage,
  updateWebsiteLogin,
  type LoginChange,
  type NewLogin,
  type OnePasswordStatus,
  type Outcome,
  type WebsiteLogin,
  type WebsiteLoginsSnapshot,
} from './websiteLoginsClient'

// The server's own limits, so a value that would be refused as too long can't be typed.
const LIMITS = { username: 512, password: 1_024, oneTimeCode: 256, label: 120 } as const

const INPUT =
  'w-full rounded-xl border border-border bg-surface px-3.5 py-2 text-[13px] text-foreground ' +
  'outline-none transition placeholder:text-foreground/35 focus:border-primary ' +
  'focus:ring-4 focus:ring-primary/15 disabled:opacity-50'

const CARD = 'rounded-2xl border border-border bg-surface p-4'
const RAISED = { boxShadow: 'var(--shadow-raised)' }

/** The origin as a person reads it: https:// dropped, any other scheme kept. */
function siteName(origin: string): string {
  return origin.replace(/^https:\/\//, '')
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] font-medium text-foreground/80">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-[11.5px] text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground/75">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer accent-[var(--primary)]"
      />
      {children}
    </label>
  )
}

function Marker({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground/65">
      {children}
    </span>
  )
}

// ─── The add / edit form ─────────────────────────────────────────────────────

function LoginForm({
  login,
  onSaved,
  onCancel,
}: {
  /** The login being changed. Absent when adding a new one. */
  login?: WebsiteLogin
  onSaved: () => void
  onCancel: () => void
}) {
  const editing = login !== undefined
  const uid = useId()
  const ids = {
    site: `${uid}-site`,
    label: `${uid}-label`,
    username: `${uid}-username`,
    password: `${uid}-password`,
    oneTimeCode: `${uid}-otp`,
  }
  // The site and label are shown in the list anyway, so they may start filled.
  const [site, setSite] = useState(login?.origin ?? '')
  const [label, setLabel] = useState(login?.label ?? '')
  // Never pre-filled: nothing can fill them, because nothing is read back.
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [oneTimeCode, setOneTimeCode] = useState('')
  const [clearUsername, setClearUsername] = useState(false)
  const [removeOneTimeCode, setRemoveOneTimeCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const addToast = useToastStore((s) => s.addToast)

  const canSave = editing ? site.trim() !== '' : site.trim() !== '' && password !== ''

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !canSave) return
    setError(null)

    let result: Outcome
    if (!editing) {
      const body: NewLogin = { site: site.trim(), password }
      if (username.trim()) body.username = username
      if (oneTimeCode.trim()) body.oneTimeCodeSecret = oneTimeCode.trim()
      if (label.trim()) body.label = label.trim()
      setBusy(true)
      result = await createWebsiteLogin(body)
    } else {
      // Only what changed or was typed. An empty field keeps what is saved.
      const change: LoginChange = {}
      if (site.trim() !== login.origin) change.site = site.trim()
      if (label.trim() !== (login.label ?? '')) change.label = label.trim()
      if (clearUsername) change.username = ''
      else if (username.trim()) change.username = username
      if (password) change.password = password
      if (removeOneTimeCode) change.oneTimeCodeSecret = null
      else if (oneTimeCode.trim()) change.oneTimeCodeSecret = oneTimeCode.trim()
      if (Object.keys(change).length === 0) {
        setPassword('')
        setOneTimeCode('')
        onCancel()
        return
      }
      setBusy(true)
      result = await updateWebsiteLogin(login.id, change)
    }

    // The secrets leave state as soon as the request is over, whatever it answered.
    setPassword('')
    setOneTimeCode('')
    setBusy(false)
    if (result.ok) {
      setUsername('')
      addToast({ message: editing ? 'Login updated' : 'Login saved', type: 'success' })
      onSaved()
    } else {
      setError(result.error)
    }
  }

  const keepHint = 'Leave empty to keep'

  return (
    <form
      onSubmit={(e) => void submit(e)}
      autoComplete="off"
      className="flex flex-col gap-3"
      aria-label={editing ? `Change the login for ${siteName(login.origin)}` : 'Add a login'}
    >
      {editing ? (
        <p className="text-[12px] text-muted-foreground">
          Saved values are never shown. Leave a field empty to keep what is saved.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          id={ids.site}
          label="Site address"
          hint="Like example.com. Any link on the site works too."
        >
          <input
            id={ids.site}
            type="text"
            inputMode="url"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="example.com"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${ids.site}-hint`}
            className={INPUT}
          />
        </Field>
        <Field id={ids.label} label="Label (optional)">
          <input
            id={ids.label}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Work account"
            maxLength={LIMITS.label}
            autoComplete="off"
            className={INPUT}
          />
        </Field>
        <Field id={ids.username} label="Username">
          <input
            id={ids.username}
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={editing && login.hasUsername ? keepHint : 'Optional'}
            maxLength={LIMITS.username}
            autoComplete="off"
            spellCheck={false}
            disabled={clearUsername}
            className={INPUT}
          />
        </Field>
        <Field id={ids.password} label="Password">
          <input
            id={ids.password}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={editing ? keepHint : undefined}
            maxLength={LIMITS.password}
            autoComplete="new-password"
            spellCheck={false}
            className={INPUT}
          />
        </Field>
      </div>
      <Field
        id={ids.oneTimeCode}
        label="One-time code key (optional)"
        hint="The setup key a site shows when you turn on an authenticator app."
      >
        <input
          id={ids.oneTimeCode}
          type="password"
          value={oneTimeCode}
          onChange={(e) => setOneTimeCode(e.target.value)}
          placeholder={editing && login.hasOneTimeCode ? keepHint : undefined}
          maxLength={LIMITS.oneTimeCode}
          autoComplete="new-password"
          spellCheck={false}
          disabled={removeOneTimeCode}
          aria-describedby={`${ids.oneTimeCode}-hint`}
          className={INPUT}
        />
      </Field>
      {editing && (login.hasUsername || login.hasOneTimeCode) ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {login.hasUsername ? (
            <Check checked={clearUsername} onChange={setClearUsername}>
              Clear the saved username
            </Check>
          ) : null}
          {login.hasOneTimeCode ? (
            <Check checked={removeOneTimeCode} onChange={setRemoveOneTimeCode}>
              Remove the one-time code
            </Check>
          ) : null}
        </div>
      ) : null}
      {error ? <FormattedAlert tone="error">{loginErrorMessage(error)}</FormattedAlert> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={!canSave} loading={busy}>
          {editing ? 'Save changes' : 'Save login'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setPassword('')
            setOneTimeCode('')
            setUsername('')
            onCancel()
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

// ─── One saved login ─────────────────────────────────────────────────────────

function LoginRow({
  login,
  editing,
  removing,
  onEdit,
  onCancelEdit,
  onSaved,
  onRemove,
}: {
  login: WebsiteLogin
  editing: boolean
  removing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onSaved: () => void
  onRemove: () => void
}) {
  const name = siteName(login.origin)
  return (
    <li className={CARD} style={RAISED} data-testid={`website-login-${login.id}`}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-foreground/70"
          style={{ background: 'rgb(var(--foreground-rgb) / 0.05)' }}
        >
          <Globe size={17} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[13.5px] font-semibold text-foreground"
            title={login.origin}
          >
            {name}
          </div>
          {login.label ? (
            <div className="truncate text-[12px] text-muted-foreground">{login.label}</div>
          ) : null}
          {login.hasUsername || login.hasOneTimeCode ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {login.hasUsername ? <Marker>username set</Marker> : null}
              {login.hasOneTimeCode ? <Marker>one-time code</Marker> : null}
            </div>
          ) : null}
        </div>
        {editing ? null : (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={onEdit}
              aria-label={`Edit the login for ${name}`}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemove}
              loading={removing}
              aria-label={`Remove the login for ${name}`}
            >
              Remove
            </Button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="mt-3 border-t border-border pt-3">
          <LoginForm login={login} onSaved={onSaved} onCancel={onCancelEdit} />
        </div>
      ) : null}
    </li>
  )
}

// ─── 1Password ───────────────────────────────────────────────────────────────

function OnePasswordCard({
  status,
  onChanged,
}: {
  status: OnePasswordStatus
  onChanged: () => void
}) {
  const uid = useId()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState(status.sdkInstalling)
  const [error, setError] = useState<string | null>(null)
  const addToast = useToastStore((s) => s.addToast)

  const connect = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !token.trim()) return
    setError(null)
    setBusy(true)
    // 1Password support is downloaded the first time anyone connects, once.
    if (!status.sdkInstalled) {
      setInstalling(true)
      const installed = await installOnePasswordSupport()
      setInstalling(false)
      if (!installed.ok) {
        setToken('')
        setBusy(false)
        setError(installed.error)
        return
      }
    }
    const result = await connectOnePassword(token.trim())
    // The token leaves state as soon as the request is over, whatever it answered.
    setToken('')
    setBusy(false)
    if (result.ok) {
      const vaults = result.value
      addToast({
        message:
          vaults === null
            ? '1Password connected'
            : `1Password connected. It can read ${vaults} ${vaults === 1 ? 'vault' : 'vaults'}.`,
        type: 'success',
      })
      onChanged()
    } else {
      setError(result.error)
    }
  }

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect 1Password?',
      message:
        'Clawboo forgets the token. Agents stop signing in with logins kept in 1Password until you connect it again.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    })
    if (!ok) return
    setError(null)
    setBusy(true)
    const result = await disconnectOnePassword()
    setBusy(false)
    if (result.ok) {
      addToast({ message: '1Password disconnected', type: 'success' })
      onChanged()
    } else {
      setError(result.error)
    }
  }

  return (
    <section
      aria-labelledby={`${uid}-title`}
      className={CARD}
      style={RAISED}
      data-testid="website-logins-1password"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-foreground/70"
          style={{ background: 'rgb(var(--foreground-rgb) / 0.05)' }}
        >
          <KeyRound size={17} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 id={`${uid}-title`} className="text-[13.5px] font-semibold text-foreground">
              {status.connected ? '1Password' : 'Connect 1Password'}
            </h2>
            {status.connected ? <StatusPill tone="success" label="Connected" /> : null}
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {status.connected
              ? status.connectedAt !== null
                ? `Since ${formatDate(status.connectedAt)}. Agents can sign in with logins kept there.`
                : 'Agents can sign in with logins kept there.'
              : 'Let agents sign in with logins kept in 1Password, using a service account token.'}
          </p>
        </div>
        {status.connected ? (
          <Button variant="ghost" size="sm" loading={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        ) : null}
      </div>

      {status.connected ? null : (
        <form
          onSubmit={(e) => void connect(e)}
          autoComplete="off"
          className="mt-3 flex flex-col gap-1 pl-12"
        >
          <label htmlFor={`${uid}-token`} className="text-[12px] font-medium text-foreground/80">
            Service account token
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`${uid}-token`}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              className={`${INPUT} font-mono`}
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!token.trim()}
              loading={busy}
            >
              Connect
            </Button>
          </div>
          {installing ? (
            <p
              role="status"
              className="text-[12px] text-muted-foreground"
              data-testid="website-logins-1password-installing"
            >
              Installing 1Password support. This happens once and can take a minute.
            </p>
          ) : null}
        </form>
      )}

      <p className={`mt-2 text-[11.5px] text-muted-foreground ${status.connected ? '' : 'pl-12'}`}>
        The token lives in Clawboo&apos;s encrypted vault and only your own runs use it.
      </p>
      {error ? (
        <FormattedAlert tone="error" className="mt-2">
          {loginErrorMessage(error)}
        </FormattedAlert>
      ) : null}
    </section>
  )
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function WebsiteLoginsPanel() {
  const [snapshot, setSnapshot] = useState<WebsiteLoginsSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const addToast = useToastStore((s) => s.addToast)
  const listTitleId = useId()

  const refresh = useCallback(async () => {
    const result = await fetchWebsiteLogins()
    if (result.ok) {
      setSnapshot(result.value)
      setLoadError(null)
    } else {
      setLoadError(result.error)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const remove = async (login: WebsiteLogin) => {
    const name = siteName(login.origin)
    const ok = await confirm({
      title: `Remove the login for ${name}?`,
      message: "Agents can't sign in to this site with it any more. This can't be undone.",
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    setRemovingId(login.id)
    const result = await deleteWebsiteLogin(login.id)
    setRemovingId(null)
    if (result.ok) {
      addToast({ message: 'Login removed', type: 'success' })
      if (editingId === login.id) setEditingId(null)
      await refresh()
    } else {
      addToast({ message: loginErrorMessage(result.error), type: 'error' })
    }
  }

  const logins = snapshot?.logins ?? []

  return (
    <div className="flex h-full flex-col bg-background">
      <PanelHeader
        title="Website logins"
        subtitle="Logins your agents can sign in with."
        icon={LogIn}
        border
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Refresh
            </Button>
            <GitHubStarButton />
          </>
        }
      />
      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="flex max-w-[760px] flex-col gap-5">
          <div className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-foreground/75">
            <p>
              Saved logins are filled straight into the agent&apos;s own browser, so the agent is
              never handed them. A login is filled only on a page at exactly its address (https
              only, except localhost).
            </p>
            <p>A CAPTCHA, passkey or card check still needs you.</p>
            {snapshot && !snapshot.fillAvailable ? (
              <p
                className="text-[12px] text-muted-foreground"
                data-testid="website-logins-fill-unavailable"
              >
                No browser connector is connected, so agents can&apos;t sign in with these yet.
                Connect Playwright or Chrome DevTools under Connectors.
              </p>
            ) : null}
          </div>

          {loadError ? (
            <div className="flex items-center gap-2">
              <FormattedAlert tone="error" className="flex-1">
                Couldn&apos;t load your website logins. {loginErrorMessage(loadError)}
              </FormattedAlert>
              <Button variant="secondary" size="sm" onClick={() => void refresh()}>
                Try again
              </Button>
            </div>
          ) : null}

          <section aria-labelledby={listTitleId} className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id={listTitleId} className="text-[13px] font-semibold text-foreground">
                Saved logins
              </h2>
              {adding || snapshot === null ? null : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setEditingId(null)
                    setAdding(true)
                  }}
                >
                  <Plus size={14} strokeWidth={2.25} aria-hidden />
                  Add login
                </Button>
              )}
            </div>

            {adding ? (
              <div className={CARD} style={RAISED}>
                <LoginForm
                  onSaved={() => {
                    setAdding(false)
                    void refresh()
                  }}
                  onCancel={() => setAdding(false)}
                />
              </div>
            ) : null}

            {snapshot === null ? (
              loadError ? null : (
                [0, 1].map((i) => <Skeleton key={i} height={68} radius={16} />)
              )
            ) : logins.length === 0 ? (
              adding ? null : (
                <EmptyState
                  icon={LogIn}
                  title="No website logins yet"
                  helper="Add a login for a site your agents need to sign in to."
                  paddingTop={20}
                />
              )
            ) : (
              <ul className="flex flex-col gap-3" aria-labelledby={listTitleId}>
                {logins.map((login) => (
                  <LoginRow
                    key={login.id}
                    login={login}
                    editing={editingId === login.id}
                    removing={removingId === login.id}
                    onEdit={() => {
                      setAdding(false)
                      setEditingId(login.id)
                    }}
                    onCancelEdit={() => setEditingId(null)}
                    onSaved={() => {
                      setEditingId(null)
                      void refresh()
                    }}
                    onRemove={() => void remove(login)}
                  />
                ))}
              </ul>
            )}
          </section>

          {snapshot ? <OnePasswordCard status={snapshot.onePassword} onChanged={refresh} /> : null}
        </div>
      </div>
    </div>
  )
}
