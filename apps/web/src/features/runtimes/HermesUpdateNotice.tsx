// Shown in a connected Hermes row when Hermes was installed without its ACP mode
// (`RuntimeStatus.acpMissing`): its runs still work, but report only when they
// finish, and a comment sent mid-run stops the run and resumes it. Updating is
// reinstalling with the extra, so the action is the runtime's own install stream.
// The server asks Hermes again before the stream completes, so the refetch after
// it already reads the new answer.

import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'

import { installRuntime } from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'

export function HermesUpdateNotice({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  // Unmounting only closes the stream: the server runs an update to the end.
  useEffect(() => () => controllerRef.current?.abort(), [])

  function handleUpdate(): void {
    setError(null)
    setUpdating(true)
    controllerRef.current?.abort()
    controllerRef.current = installRuntime('hermes', {
      onError: (e) => {
        setError(typeof e.message === 'string' ? e.message : 'The update failed')
        setUpdating(false)
      },
      onComplete: () => {
        // Hold the busy state until the refetch lands: the row then reads the
        // updated Hermes and this notice goes away.
        void (async () => {
          await onChanged()
          setUpdating(false)
        })()
      },
    })
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="runtime-hermes-update-required">
      <FormattedAlert tone="warning">
        This Hermes was installed without its live mode, so a run shows its work only when it
        finishes, and a comment sent mid-run pauses the run to read it. Update Hermes to watch runs
        as they work and steer them without a pause.
      </FormattedAlert>
      {error && <FormattedAlert tone="error">{error}</FormattedAlert>}
      <div>
        <Button
          variant="primary"
          size="sm"
          loading={updating}
          onClick={handleUpdate}
          data-testid="runtime-hermes-update"
        >
          {!updating && <Download size={13} />}
          {updating ? 'Updating Hermes…' : 'Update Hermes'}
        </Button>
      </div>
    </div>
  )
}
