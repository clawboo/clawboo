// A KPI opened from its tile: the value now and where it came from, the values
// stored before it (who reported or typed each, the run and task an agent's came
// from, and a source link), a form to type a new value when a person is its
// source, and Edit and Archive.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Archive, ExternalLink, Pencil } from 'lucide-react'

import {
  addKpiValue,
  archiveKpi,
  listKpiValues,
  type KpiTile,
  type KpiValue,
  type TeamKpi,
} from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { Skeleton } from '@/features/shared/Skeleton'
import { confirm } from '@/stores/confirm'

import {
  actorName,
  computedFrom,
  formatDate,
  formatKpiValue,
  kpiWindow,
  METRIC_LABEL,
  provenanceWords,
  readingText,
  relativeTime,
  SOURCE_LABEL,
  staleWords,
  targetWords,
} from './homeFormat'
import { DIALOG_PANEL, FIELD_LABEL, INPUT_CLASS } from './homeForm'
import { SECTION_LABEL } from '@/features/shared/sectionLabel'
import type { HomeNames } from './useHomeNames'
import { homeWrite } from './homeWrite'

export function KpiDetailDialog({
  tile,
  onClose,
  teamId,
  now,
  names,
  onEdit,
  onChanged,
  onOpenTask,
}: {
  /** Null: closed. */
  tile: KpiTile | null
  onClose: () => void
  teamId: string
  now: number
  names: HomeNames
  onEdit: (kpi: TeamKpi) => void
  /** A value was added or the KPI archived: Home reads again. */
  onChanged: () => void
  /** Opens the task an agent's value was reported from. */
  onOpenTask: (taskId: string) => void
}) {
  return (
    <Modal
      open={tile !== null}
      onClose={onClose}
      label={tile ? `KPI: ${tile.kpi.name}` : 'KPI'}
      data-testid="kpi-detail"
      panelClassName={DIALOG_PANEL}
    >
      {tile ? (
        <KpiDetailBody
          key={tile.kpi.id}
          tile={tile}
          onClose={onClose}
          teamId={teamId}
          now={now}
          names={names}
          onEdit={onEdit}
          onChanged={onChanged}
          onOpenTask={onOpenTask}
        />
      ) : null}
    </Modal>
  )
}

function KpiDetailBody({
  tile: initial,
  onClose,
  teamId,
  now,
  names,
  onEdit,
  onChanged,
  onOpenTask,
}: {
  tile: KpiTile
  onClose: () => void
  teamId: string
  now: number
  names: HomeNames
  onEdit: (kpi: TeamKpi) => void
  onChanged: () => void
  onOpenTask: (taskId: string) => void
}) {
  const [tile, setTile] = useState(initial)
  const { kpi, reading } = tile
  const [values, setValues] = useState<KpiValue[] | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const stored = kpi.source !== 'computed'

  // Only the newest read lands: the first read can answer after the one a new value
  // started, and must not put back the history without that value.
  const historyRead = useRef(0)
  const read = useCallback(async () => {
    if (!stored) return
    const id = ++historyRead.current
    try {
      const got = await listKpiValues(teamId, kpi.id, { limit: 50 })
      if (id !== historyRead.current) return
      setValues(got)
      setReadFailed(false)
    } catch {
      if (id === historyRead.current) setReadFailed(true)
    }
  }, [stored, teamId, kpi.id])

  useEffect(() => {
    void read()
  }, [read])

  async function archive() {
    const ok = await confirm({
      title: `Archive ${kpi.name}?`,
      message: 'It leaves Home. Its values are kept.',
      confirmLabel: 'Archive',
      tone: 'danger',
    })
    if (!ok) return
    const done = await homeWrite('archive the KPI', () => archiveKpi(teamId, kpi.id), {
      success: 'KPI archived.',
    })
    if (done) {
      onChanged()
      onClose()
    }
  }

  const stale = staleWords(tile, now)
  const target = targetWords(kpi)

  return (
    <>
      <div className="px-5 pb-3 pt-5">
        <h2 className="text-base font-semibold text-foreground">{kpi.name}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {SOURCE_LABEL[kpi.source]}
          {kpi.source === 'computed' && kpi.metric ? `: ${METRIC_LABEL[kpi.metric]}` : ''}
          {' · '}
          {kpiWindow(kpi)}
          {target ? ` · ${target}` : ''}
        </p>
        <div className="mt-3 flex items-baseline gap-2">
          <span
            className={[
              'text-page font-semibold tabular-nums tracking-tight',
              reading.value === null ? 'text-muted-foreground' : 'text-foreground',
            ].join(' ')}
            data-testid="kpi-detail-value"
          >
            {readingText(reading, kpi.unit)}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="kpi-detail-provenance">
          {/* A reading uses only its current source's values, so after the source
              changes it has none while the history still lists the earlier ones. */}
          {reading.freshness === 'missing' && stored && values && values.length > 0
            ? 'No value from its current source yet. The history keeps the values from before.'
            : provenanceWords(tile, now, names)}
        </p>
        {stale ? <p className="board-reason mt-1 text-xs font-medium">{stale}</p> : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t border-border px-5 py-4">
        {kpi.source === 'person' ? (
          <AddValueForm
            teamId={teamId}
            kpi={kpi}
            onAdded={(next) => {
              setTile(next)
              void read()
              onChanged()
            }}
          />
        ) : null}

        {kpi.source === 'computed' ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Worked out each time Home is read, {computedFrom(kpi.metric)}, so there is no stored
            history. No agent or person types this number.
          </p>
        ) : (
          <div>
            <h3 className={`${SECTION_LABEL} mb-2`}>History</h3>
            {readFailed ? (
              <p className="text-xs text-muted-foreground">The history could not be read.</p>
            ) : values === null ? (
              <div className="flex flex-col gap-2">
                <Skeleton height={14} />
                <Skeleton width="70%" height={14} />
              </div>
            ) : values.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {kpi.source === 'agent'
                  ? 'No agent has reported a value yet.'
                  : 'No value typed yet.'}
              </p>
            ) : (
              <ol className="m-0 flex list-none flex-col p-0" data-testid="kpi-history">
                {values.map((v) => (
                  <li
                    key={v.id}
                    className="flex flex-col gap-0.5 border-b border-border py-2 last:border-b-0"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="text-sm font-medium tabular-nums text-foreground">
                        {formatKpiValue(v.value, kpi.unit)}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatDate(v.asOf, now)} · {relativeTime(v.asOf, now)}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>
                        {v.reportedBy?.kind === 'agent' ? 'Reported by ' : 'Typed by '}
                        {actorName(v.reportedBy, names)}
                      </span>
                      {v.taskId ? (
                        <button
                          type="button"
                          onClick={() => onOpenTask(v.taskId!)}
                          className="cursor-pointer text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                        >
                          {v.executionId ? 'Open its run' : 'Open its task'}
                        </button>
                      ) : null}
                      {v.sourceUrl ? (
                        <a
                          href={v.sourceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-0.5 text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                        >
                          Source
                          <ExternalLink size={11} strokeWidth={2} aria-hidden />
                        </a>
                      ) : null}
                    </span>
                    {v.note ? <span className="text-xs text-foreground">{v.note}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Button variant="ghost" size="sm" onClick={() => void archive()} data-testid="kpi-archive">
          <Archive size={14} aria-hidden />
          Archive
        </Button>
        <span className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => onEdit(kpi)} data-testid="kpi-edit">
          <Pencil size={14} aria-hidden />
          Edit
        </Button>
        <Button variant="primary" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </>
  )
}

/** A person types a value: the number, an optional note and source link. */
function AddValueForm({
  teamId,
  kpi,
  onAdded,
}: {
  teamId: string
  kpi: TeamKpi
  onAdded: (tile: KpiTile) => void
}) {
  const ids = { value: useId(), note: useId(), url: useId() }
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const n = value.trim() === '' ? NaN : Number(value)
  const urlOk = url.trim() === '' || /^https?:\/\//i.test(url.trim())
  const canAdd = Number.isFinite(n) && urlOk && !busy

  async function add() {
    if (!canAdd) return
    setBusy(true)
    const result = await homeWrite(
      'add the value',
      () =>
        addKpiValue(teamId, kpi.id, {
          value: n,
          note: note.trim() || null,
          sourceUrl: url.trim() || null,
        }),
      { success: 'Value added.' },
    )
    setBusy(false)
    if (result) {
      setValue('')
      setNote('')
      setUrl('')
      onAdded(result.kpi)
    }
  }

  return (
    <form
      data-testid="kpi-add-value"
      className="flex flex-col gap-3 rounded-xl border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void add()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
        <div>
          <label htmlFor={ids.value} className={FIELD_LABEL}>
            New value{kpi.unit ? ` (${kpi.unit})` : ''}
          </label>
          <input
            id={ids.value}
            data-testid="kpi-value-input"
            className={INPUT_CLASS}
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            autoComplete="off"
          />
        </div>
        <div>
          <label htmlFor={ids.note} className={FIELD_LABEL}>
            Note
          </label>
          <input
            id={ids.note}
            className={INPUT_CLASS}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            placeholder="Optional"
            autoComplete="off"
          />
        </div>
      </div>
      <div>
        <label htmlFor={ids.url} className={FIELD_LABEL}>
          Source link
        </label>
        <input
          id={ids.url}
          className={INPUT_CLASS}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          placeholder="https://… (optional)"
          aria-invalid={!urlOk}
          autoComplete="off"
        />
      </div>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={!canAdd}
          loading={busy}
          data-testid="kpi-add-value-save"
        >
          Add value
        </Button>
      </div>
    </form>
  )
}
