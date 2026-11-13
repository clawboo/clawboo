// Shown in a connected Hermes row when Clawboo's own install of the pinned
// Hermes release is missing or older (`RuntimeStatus.updateRequired`), as on a
// Hermes installed with pip or pipx before Clawboo installed its own. Clawboo
// runs every Hermes agent through its own install's gateway, so its runs need
// it. The action is the runtime's own install stream.

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
        Clawboo now installs its own copy of Hermes, the current release, and runs your Hermes
        agents through it. Install it to keep using them: their memory and skills carry over.
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
