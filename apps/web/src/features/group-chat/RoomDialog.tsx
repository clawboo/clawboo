// RoomDialog: create a chat room inside a team, or edit one (name, members, delete).
//
// A room is a subset of the team's members with its own conversation. Boo Zero
// is not offered as a member: it presides over every room on its own, exactly as
// it does over the team's group chat. Deleting a room archives it (the
// conversation is kept), and stops whatever the room was working on.

import { useEffect, useId, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { Button } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { archiveRoom, createRoom, updateRoom, type Room } from '@/lib/roomsClient'
import { useBooZeroStore } from '@/stores/booZero'
import { confirm } from '@/stores/confirm'
import { useFleetStore } from '@/stores/fleet'
import { useRoomStore } from '@/stores/rooms'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

const FIELD_LABEL =
  'mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground'
const INPUT_CLASS =
  'h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] text-foreground ' +
  'outline-none transition placeholder:text-muted-foreground ' +
  'focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50'

export interface RoomDialogProps {
  open: boolean
  onClose: () => void
  teamId: string
  /** The room to edit; absent = create a new one. */
  room?: Room | null
}

export function RoomDialog({ open, onClose, teamId, room = null }: RoomDialogProps) {
  const headingId = useId()
  const nameId = useId()
  const editing = room !== null
  const agents = useFleetStore((s) => s.agents)
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  // The team's members, Boo Zero aside (it is in every room already).
  const candidates = useMemo(
    () => agents.filter((a) => a.teamId === teamId && a.id !== booZeroAgentId),
    [agents, teamId, booZeroAgentId],
  )

  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seed the form each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setName(room?.name ?? '')
    setSelected(new Set(room?.memberIds ?? []))
    setError(null)
    setBusy(false)
  }, [open, room])

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const trimmed = name.trim()
  const memberIds = candidates.filter((a) => selected.has(a.id)).map((a) => a.id)
  const canSave = trimmed.length > 0 && memberIds.length > 0 && !busy

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    const result = room
      ? await updateRoom(teamId, room.id, { name: trimmed, memberIds })
      : await createRoom(teamId, { name: trimmed, memberIds })
    if (!result.ok) {
      setBusy(false)
      setError(result.error)
      return
    }
    useRoomStore.getState().upsert(result.room)
    onClose()
    if (!editing) useViewStore.getState().openGroupChat(teamId, result.room.id)
  }

  const remove = async (): Promise<void> => {
    if (!room) return
    const ok = await confirm({
      title: `Delete ${room.name}?`,
      message:
        'The conversation is kept, but the room leaves the sidebar and anything it is working on stops. Its tasks stay on the board.',
      confirmLabel: 'Delete room',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const archived = await archiveRoom(teamId, room.id)
    setBusy(false)
    if (!archived) {
      setError('Could not delete the room. Try again?')
      return
    }
    useRoomStore.getState().remove(teamId, room.id)
    onClose()
    useViewStore.getState().openGroupChat(teamId)
    useToastStore.getState().addToast({ message: `${room.name} deleted.`, type: 'success' })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      labelledBy={headingId}
      data-testid="room-dialog"
      panelClassName="surface-overlay-tier flex max-h-[88vh] w-[440px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl"
    >
      <div className="px-5 pb-2 pt-5">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {editing ? 'Edit room' : 'New room'}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          A separate conversation with some of the team. Boo Zero leads every room and hands work
          only to the members you pick. Team rules, brief and memory are shared.
        </p>
      </div>

      <form
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div>
          <label htmlFor={nameId} className={FIELD_LABEL}>
            Name
          </label>
          <input
            id={nameId}
            data-testid="room-name"
            className={INPUT_CLASS}
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="Launch prep"
            autoComplete="off"
          />
        </div>

        <fieldset>
          <legend className={FIELD_LABEL}>Members</legend>
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">This team has no members yet.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {candidates.map((a) => {
                const checked = selected.has(a.id)
                return (
                  <label
                    key={a.id}
                    data-testid="room-member-option"
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border px-2.5 py-2 transition-colors ${
                      checked
                        ? 'border-border-strong bg-surface-raised'
                        : 'border-transparent hover:bg-foreground/[0.04]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(a.id)}
                      disabled={busy}
                      aria-label={a.name}
                      className="accent-primary"
                    />
                    <AgentBooAvatar agentId={a.id} size={22} />
                    <span className="truncate text-[13px] text-foreground">{a.name}</span>
                  </label>
                )
              })}
            </div>
          )}
        </fieldset>

        {error && (
          <p role="alert" className="text-[12px] text-destructive">
            {error}
          </p>
        )}
        {/* Enter submits from the name field. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>

      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        {editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void remove()}
            disabled={busy}
            data-testid="room-delete"
          >
            <Trash2 size={14} />
            Delete room
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={!canSave}
          loading={busy}
          data-testid="room-save"
        >
          {editing ? 'Save' : 'Create room'}
        </Button>
      </div>
    </Modal>
  )
}
