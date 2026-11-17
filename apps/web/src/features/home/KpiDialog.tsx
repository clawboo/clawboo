// Define a KPI, edit one, or accept an agent's suggestion with a person's edits.
//
// A person defines every KPI: its name, unit, which way is good, a target, the
// window it reads, and its source. A computed KPI picks from the closed list of
// metrics Clawboo works out from the board, its runs and its budget; an agent KPI
// says which agent may report it (or any agent on the team); a person KPI takes
// values typed on Home. Agent and person KPIs can say when a value goes stale.

import { useId, useMemo, useState } from 'react'

import {
  acceptKpiSuggestion,
  createKpi,
  HOME_COMPUTED_METRIC_UNITS,
  HOME_COMPUTED_METRICS,
  KPI_PERIODS,
  updateKpi,
  type CreateKpiInput,
  type GoalSummary,
  type HomeComputedMetric,
  type KpiDirection,
  type KpiPeriod,
  type KpiSource,
  type KpiTile,
  type TeamKpi,
} from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { SegmentedControl } from '@/features/shared/SegmentedControl'
import { Select } from '@/features/shared/Select'
import { useFleetStore } from '@/stores/fleet'

import { isPointInTime, METRIC_HINT, METRIC_LABEL, PERIOD_LABEL } from './homeFormat'
import {
  DIALOG_PANEL,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT_CLASS,
  FULL_WIDTH,
  goalOptions,
} from './homeForm'
import { homeWrite } from './homeWrite'

export type KpiDialogMode =
  | { kind: 'new'; goalId?: string | null }
  | { kind: 'edit'; kpi: TeamKpi }
  | { kind: 'accept'; kpi: TeamKpi }

const ANY_AGENT = ''
const NO_GOAL = ''

export function KpiDialog({
  mode,
  onClose,
  teamId,
  goals,
  onSaved,
  onDismissSuggestion,
}: {
  /** Null: closed. */
  mode: KpiDialogMode | null
  onClose: () => void
  teamId: string
  goals: GoalSummary[]
  onSaved: (tile: KpiTile) => void
  /** Accept mode's other answer. */
  onDismissSuggestion?: (kpi: TeamKpi) => void
}) {
  const title =
    mode?.kind === 'edit' ? 'Edit KPI' : mode?.kind === 'accept' ? 'Suggested KPI' : 'New KPI'
  return (
    <Modal
      open={mode !== null}
      onClose={onClose}
      label={title}
      data-testid="kpi-dialog"
      panelClassName={DIALOG_PANEL}
    >
      {mode ? (
        <KpiForm
          key={mode.kind === 'new' ? 'new' : `${mode.kind}:${mode.kpi.id}`}
          mode={mode}
          title={title}
          onClose={onClose}
          teamId={teamId}
          goals={goals}
          onSaved={onSaved}
          onDismissSuggestion={onDismissSuggestion}
        />
      ) : null}
    </Modal>
  )
}

function KpiForm({
  mode,
  title,
  onClose,
  teamId,
  goals,
  onSaved,
  onDismissSuggestion,
}: {
  mode: KpiDialogMode
  title: string
  onClose: () => void
  teamId: string
  goals: GoalSummary[]
  onSaved: (tile: KpiTile) => void
  onDismissSuggestion?: (kpi: TeamKpi) => void
}) {
  const ids = { name: useId(), unit: useId(), target: useId(), stale: useId() }
  const base = mode.kind === 'new' ? null : mode.kpi
  const agents = useFleetStore((s) => s.agents)
  const teamAgents = useMemo(
    () => agents.filter((a) => a.teamId === teamId).sort((a, b) => a.name.localeCompare(b.name)),
    [agents, teamId],
  )

  const [name, setName] = useState(base?.name ?? '')
  const [source, setSource] = useState<KpiSource>(
    base?.source ?? (mode.kind === 'new' ? 'computed' : 'person'),
  )
  const [metric, setMetric] = useState<HomeComputedMetric>(base?.metric ?? 'tasks_done')
  const [unit, setUnit] = useState(base?.unit ?? '')
  const [direction, setDirection] = useState<KpiDirection>(base?.direction ?? 'up')
  const [target, setTarget] = useState(base?.target != null ? String(base.target) : '')
  const [period, setPeriod] = useState<KpiPeriod>(base?.period ?? 'week')
  const [reporter, setReporter] = useState(base?.reporterAgentId ?? ANY_AGENT)
  const [staleAfter, setStaleAfter] = useState(
    base?.staleAfterHours != null ? String(base.staleAfterHours) : '',
  )
  const [goalId, setGoalId] = useState(
    base?.goalId ?? (mode.kind === 'new' ? (mode.goalId ?? NO_GOAL) : NO_GOAL),
  )
  const [busy, setBusy] = useState(false)

  const computed = source === 'computed'
  const pointInTime = computed && isPointInTime(metric)
  const shownUnit = computed ? HOME_COMPUTED_METRIC_UNITS[metric] : unit

  const targetNumber = target.trim() === '' ? null : Number(target)
  const targetOk = targetNumber === null || Number.isFinite(targetNumber)
  const staleNumber = staleAfter.trim() === '' ? null : Number(staleAfter)
  const staleOk =
    computed || staleNumber === null || (Number.isInteger(staleNumber) && staleNumber > 0)
  const canSave = name.trim().length > 0 && targetOk && staleOk && !busy

  async function save() {
    if (!canSave) return
    setBusy(true)
    const input: CreateKpiInput = {
      name: name.trim(),
      unit: shownUnit,
      direction,
      target: targetNumber,
      period,
      source,
      metric: computed ? metric : null,
      goalId: goalId || null,
      reporterAgentId: source === 'agent' ? reporter || null : null,
      staleAfterHours: computed ? null : staleNumber,
    }
    const what =
      mode.kind === 'accept'
        ? 'accept the KPI'
        : mode.kind === 'edit'
          ? 'save the KPI'
          : 'add the KPI'
    const saved = await homeWrite(what, () =>
      mode.kind === 'accept'
        ? acceptKpiSuggestion(teamId, mode.kpi.id, input)
        : mode.kind === 'edit'
          ? updateKpi(teamId, mode.kpi.id, input)
          : createKpi(teamId, input),
    )
    setBusy(false)
    if (saved) {
      onSaved(saved)
      onClose()
    }
  }

  return (
    <>
      <div className="px-5 pb-2 pt-5">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {mode.kind === 'accept' ? (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {mode.kpi.suggestedBy?.name ?? 'An agent'} suggested this KPI
            {mode.kpi.suggestionNote ? `: “${mode.kpi.suggestionNote}”` : '.'} Change what you like,
            then accept it, or dismiss it.
          </p>
        ) : (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A number the team tracks. Pick where its values come from: worked out from the board,
            reported by an agent, or typed by a person.
          </p>
        )}
      </div>
      <form
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div>
          <label htmlFor={ids.name} className={FIELD_LABEL}>
            Name
          </label>
          <input
            id={ids.name}
            data-testid="kpi-name"
            className={INPUT_CLASS}
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="Signups"
            autoComplete="off"
          />
        </div>

        <div>
          <span className={FIELD_LABEL}>Values come from</span>
          <SegmentedControl<KpiSource>
            size="sm"
            aria-label="Values come from"
            value={source}
            onChange={setSource}
            className="flex w-full [&>*]:flex-1"
            options={[
              { id: 'computed', label: 'Computed' },
              { id: 'agent', label: 'An agent' },
              { id: 'person', label: 'A person' },
            ]}
          />
        </div>

        {computed ? (
          <div>
            <span className={FIELD_LABEL}>Metric</span>
            <Select
              style={FULL_WIDTH}
              aria-label="Metric"
              data-testid="kpi-metric"
              value={metric}
              onChange={(v) => setMetric(v as HomeComputedMetric)}
              disabled={busy}
              options={HOME_COMPUTED_METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] }))}
            />
            <p className={FIELD_HINT}>
              {METRIC_HINT[metric]} Clawboo works it out each time Home is read, in{' '}
              {HOME_COMPUTED_METRIC_UNITS[metric]}.
            </p>
          </div>
        ) : null}

        {source === 'agent' ? (
          <div>
            <span className={FIELD_LABEL}>Who reports it</span>
            <Select
              style={FULL_WIDTH}
              aria-label="Who reports it"
              value={reporter}
              onChange={setReporter}
              disabled={busy}
              options={[
                { value: ANY_AGENT, label: 'Any agent on the team' },
                ...teamAgents.map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
            <p className={FIELD_HINT}>
              The agent reports it with its report_kpi tool. Home shows who reported each value and
              from which run.
            </p>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {!computed ? (
            <div>
              <label htmlFor={ids.unit} className={FIELD_LABEL}>
                Unit
              </label>
              <input
                id={ids.unit}
                data-testid="kpi-unit"
                className={INPUT_CLASS}
                maxLength={20}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                disabled={busy}
                placeholder="$, %, signups"
                autoComplete="off"
              />
            </div>
          ) : null}
          <div>
            <label htmlFor={ids.target} className={FIELD_LABEL}>
              Target
            </label>
            <input
              id={ids.target}
              data-testid="kpi-target"
              className={INPUT_CLASS}
              inputMode="decimal"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy}
              placeholder="Optional"
              aria-invalid={!targetOk}
            />
          </div>
          <div>
            <span className={FIELD_LABEL}>Better when</span>
            <Select
              style={FULL_WIDTH}
              aria-label="Better when"
              value={direction}
              onChange={(v) => setDirection(v as KpiDirection)}
              disabled={busy}
              options={[
                { value: 'up', label: 'Higher' },
                { value: 'down', label: 'Lower' },
              ]}
            />
          </div>
          <div>
            <span className={FIELD_LABEL}>Window</span>
            <Select
              style={FULL_WIDTH}
              aria-label="Window"
              value={pointInTime ? 'all' : period}
              onChange={(v) => setPeriod(v as KpiPeriod)}
              disabled={busy || pointInTime}
              options={KPI_PERIODS.map((p) => ({
                value: p,
                label: pointInTime ? 'Now' : PERIOD_LABEL[p],
              }))}
            />
          </div>
          {!computed ? (
            <div>
              <label htmlFor={ids.stale} className={FIELD_LABEL}>
                Stale after (hours)
              </label>
              <input
                id={ids.stale}
                data-testid="kpi-stale-after"
                className={INPUT_CLASS}
                inputMode="numeric"
                value={staleAfter}
                onChange={(e) => setStaleAfter(e.target.value)}
                disabled={busy}
                placeholder="Never"
                aria-invalid={!staleOk}
              />
            </div>
          ) : null}
          {goals.length > 0 || base?.goalId ? (
            <div>
              <span className={FIELD_LABEL}>Goal</span>
              <Select
                style={FULL_WIDTH}
                aria-label="Goal"
                value={goalId}
                onChange={setGoalId}
                disabled={busy}
                options={goalOptions(goals, base?.goalId ?? null)}
              />
            </div>
          ) : null}
        </div>
        {pointInTime ? (
          <p className={FIELD_HINT}>This metric reads the state now, so it has no window.</p>
        ) : null}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        {mode.kind === 'accept' && onDismissSuggestion ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            data-testid="kpi-dismiss"
            onClick={() => onDismissSuggestion(mode.kpi)}
          >
            Dismiss
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={!canSave}
          loading={busy}
          data-testid="kpi-save"
        >
          {mode.kind === 'accept' ? 'Accept' : mode.kind === 'edit' ? 'Save' : 'Add KPI'}
        </Button>
      </div>
    </>
  )
}
