// Settings an administrator can pin for everyone on this install, shown with
// where each value comes from. A pinned one reads "Set by your administrator"
// and offers no control: the server refuses a change to it, and a control that
// looked editable would only fail.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { apiFetch } from '@clawboo/control-client'

import { Switch } from '@/features/shared/Switch'
import { useToastStore } from '@/stores/toast'

import { SectionCard } from './SectionCard'

type SettingKey =
  'disableSelfUpdate' | 'disableBrowserAutostart' | 'catalogIndexUrl' | 'proxyIdentity'

export interface EffectiveSetting {
  key: SettingKey
  value: boolean | string | number | null
  source: 'environment' | 'file' | 'user' | 'default'
  pinned: boolean
  userEditable: boolean
  env: string
}

const ENDPOINT = '/api/system/operator-settings'

function PinnedNote({ setting }: { setting: EffectiveSetting }) {
  return (
    <span
      data-testid={`pinned-${setting.key}`}
      className="flex items-center gap-1 text-[11px] text-muted-foreground"
      title={
        setting.source === 'environment'
          ? `Pinned with ${setting.env}`
          : 'Pinned in the operator settings file'
      }
    >
      <Lock size={11} strokeWidth={2} aria-hidden />
      Set by your administrator
    </span>
  )
}

function Row({
  title,
  description,
  setting,
  children,
}: {
  title: string
  description: string
  setting: EffectiveSetting
  children: ReactNode
}) {
  return (
    <div
      className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
      data-testid={`deployment-${setting.key}`}
    >
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[12.5px] font-medium text-foreground">{title}</span>
        <span className="text-[11.5px] leading-relaxed text-muted-foreground">{description}</span>
        {setting.pinned && <PinnedNote setting={setting} />}
      </span>
      <span className="max-w-[45%] shrink-0 pt-0.5 text-right">{children}</span>
    </div>
  )
}

function Value({ children }: { children: ReactNode }) {
  return <span className="font-data break-all text-[12px] text-foreground/80">{children}</span>
}

export function DeploymentSettings() {
  const [settings, setSettings] = useState<EffectiveSetting[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  useEffect(() => {
    let cancelled = false
    apiFetch(ENDPOINT)
      .then(async (r) => {
        // A server that predates this route answers 404: show nothing rather
        // than guess. Any other failure is said, not hidden.
        if (r.status === 404) return
        const body = r.ok ? ((await r.json()) as { settings?: unknown }) : null
        if (cancelled) return
        if (Array.isArray(body?.settings)) setSettings(body.settings as EffectiveSetting[])
        else setLoadFailed(true)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const replace = useCallback((next: EffectiveSetting) => {
    setSettings((prev) => prev?.map((s) => (s.key === next.key ? next : s)) ?? prev)
  }, [])

  const save = useCallback(
    async (key: SettingKey, value: boolean) => {
      setBusy(true)
      try {
        const res = await apiFetch(`${ENDPOINT}/${key}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        })
        const body = (await res.json().catch(() => null)) as {
          setting?: EffectiveSetting
          error?: string
        } | null
        // The value in force, from the server, whether the save took or not.
        if (body?.setting) replace(body.setting)
        if (!res.ok) {
          addToast({ message: body?.error ?? 'Could not change that setting', type: 'error' })
          return
        }
        addToast({ message: 'Saved', type: 'success' })
      } catch {
        addToast({ message: 'clawboo could not be reached', type: 'error' })
      } finally {
        setBusy(false)
      }
    },
    [addToast, replace],
  )

  if (!settings) {
    if (!loadFailed) return null
    return (
      <SectionCard label="Deployment" data-testid="deployment-settings">
        <p className="text-[12px] text-muted-foreground" role="status">
          These settings could not be loaded. Reopen this panel to try again.
        </p>
      </SectionCard>
    )
  }
  const byKey = new Map(settings.map((s) => [s.key, s]))
  const updates = byKey.get('disableSelfUpdate')
  const browsers = byKey.get('disableBrowserAutostart')
  const catalog = byKey.get('catalogIndexUrl')
  const proxyIdentity = byKey.get('proxyIdentity')

  return (
    <SectionCard label="Deployment" data-testid="deployment-settings">
      <div className="flex flex-col divide-y divide-border">
        {browsers && (
          <Row
            title="Start the browsers on a new install"
            description="Starts Playwright and Chrome DevTools when Clawboo starts, if neither has been connected yet, so agents can browse. Each keeps a process running."
            setting={browsers}
          >
            <Switch
              checked={browsers.value !== true}
              disabled={busy || browsers.pinned || !browsers.userEditable}
              onChange={(next) => void save('disableBrowserAutostart', !next)}
              label="Start the browsers on a new install"
            />
          </Row>
        )}
        {updates && (
          <Row
            title="Updates from the dashboard"
            description="The update notice and its one-click update."
            setting={updates}
          >
            <Value>{updates.value === true ? 'Off' : 'On'}</Value>
          </Row>
        )}
        {catalog && (
          <Row
            title="Marketplace catalog"
            description="Where the Marketplace's teams and agents come from."
            setting={catalog}
          >
            <Value>{typeof catalog.value === 'string' ? catalog.value : 'Default'}</Value>
          </Row>
        )}
        {proxyIdentity && (
          <Row
            title="Sign-in proxy"
            description="Checks the signed identity token a sign-in proxy sends with each request, and records who approved, wrote or moved what."
            setting={proxyIdentity}
          >
            <Value>
              {proxyIdentity.value === 'required'
                ? 'Required'
                : proxyIdentity.value === 'on'
                  ? 'On'
                  : 'Off'}
            </Value>
          </Row>
        )}
      </div>
    </SectionCard>
  )
}
