// Shown in a signed-in Codex row when its CLI is too old for the ChatGPT plan's
// current models (`RuntimeStatus.updateRequired`): such a CLI falls back to the
// models it shipped with, the backend refuses them, and every run fails. Updating
// is reinstalling, so the action is the runtime's own install stream.

import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'

import { fetchCodexModels, installRuntime } from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'

export function CodexUpdateNotice({
  cliVersion,
  onChanged,
}: {
  cliVersion?: string | null
  onChanged: () => void | Promise<void>
}) {
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  function handleUpdate(): void {
    setError(null)
    setUpdating(true)
    controllerRef.current?.abort()
    controllerRef.current = installRuntime('codex', {
      onError: (e) => {
        setError(typeof e.message === 'string' ? e.message : 'The update failed')
        setUpdating(false)
      },
      onComplete: () => {
        // Hold the busy state until the refetch lands: the row then reads the
        // updated CLI and this notice goes away. The install dropped the server's
        // model probe, and the runtime list only starts a new one without waiting,
        // so wait for the probe first: otherwise the row reads Connected for a
        // moment even when the new CLI still needs updating.
        void (async () => {
          await fetchCodexModels()
          await onChanged()
          setUpdating(false)
        })()
      },
    })
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="runtime-codex-update-required">
      <FormattedAlert tone="warning">
        This Codex CLI{cliVersion ? ` (${cliVersion})` : ''} is too old for your ChatGPT plan's
        current models, so its runs fail. Update it to fix that.
      </FormattedAlert>
      {error && <FormattedAlert tone="error">{error}</FormattedAlert>}
      <div>
        <Button
          variant="primary"
          size="sm"
          loading={updating}
          onClick={handleUpdate}
          data-testid="runtime-codex-update"
        >
          {!updating && <Download size={13} />}
          {updating ? 'Updating Codex…' : 'Update Codex'}
        </Button>
      </div>
    </div>
  )
}
