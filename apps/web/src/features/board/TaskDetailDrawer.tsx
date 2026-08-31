import { useEffect, useId, useState, useCallback } from 'react'
import {
  X,
  GitBranch,
  FileQuestion,
  FileText,
  ListChecks,
  MessagesSquare,
  Workflow,
  Terminal,
} from 'lucide-react'

import {
  boardClient,
  getTaskExecutions,
  getWorkspaceDetail,
  type BoardExecution,
  type TaskDetail,
  type WorkspaceDetail,
} from '@/lib/boardClient'
import { useFleetStore } from '@/stores/fleet'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { IconButton } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { Skeleton } from '@/features/shared/Skeleton'
import { ActivityTerminal } from '@/features/obs/ActivityTerminal'
import { Modal } from '@/features/shared/Modal'

import { StatusSelect } from './StatusSelect'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`
const SECTION_LABEL =
  'font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground'

const VERDICT_TONE: Record<'pass' | 'fail' | 'completed_with_debt', StatusTone> = {
  pass: 'success',
  fail: 'error',
  completed_with_debt: 'warning',
}

interface Verdict {
  status?: 'pass' | 'fail' | 'completed_with_debt'
  attempts?: {
    critic?: {
      findings?: { severity?: string; title?: string }[]
      reviewerRuntime?: string | null
      reviewerModel?: string | null
    }
  }[]
  debtNotes?: string[]
}

function parseVerification(v: unknown): Verdict | null {
  if (!v) return null
  try {
    return typeof v === 'string' ? (JSON.parse(v) as Verdict) : (v as Verdict)
  } catch {
    return null
  }
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-5">
      <div className="mb-2.5 flex items-center gap-1.5">
        <span className="flex text-foreground/40">{icon}</span>
        <span className={SECTION_LABEL}>{title}</span>
      </div>
      {children}
    </div>
  )
}

const codeBox: React.CSSProperties = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: 'var(--code-block-bg, rgb(var(--foreground-rgb) / 0.05))',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '10px 12px',
  color: muted(0.75),
  maxHeight: 260,
  overflowY: 'auto',
}

function kv(label: string, value: string) {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 12.5, marginBottom: 6 }}>
      <span style={{ color: 'var(--muted-foreground)', minWidth: 82 }}>{label}</span>
      <span
        className="font-data"
        style={{
          color: 'var(--foreground)',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </span>
    </div>
  )
}

// Same label rhythm as `kv`, but the value is an interactive control (e.g. the
// status editor) rather than plain text — so no font-data/word-break, and the
// row is vertically centered on the control.
function kvControl(label: string, control: React.ReactNode) {
  return (
    <div
      style={{ display: 'flex', gap: 12, fontSize: 12.5, marginBottom: 6, alignItems: 'center' }}
    >
      <span style={{ color: 'var(--muted-foreground)', minWidth: 82 }}>{label}</span>
      {control}
    </div>
  )
}

export function TaskDetailDrawer({
  taskId,
  onClose,
  onStatusCommitted,
}: {
  taskId: string
  onClose: () => void
  /** Fires after a status change commits (success only), so the parent board can move
   *  the card to its new column immediately instead of waiting for the next ~5s
   *  reconciliation poll (#98). Mirrors the drawer's own optimistic `setDetail`. */
  onStatusCommitted?: (taskId: string, newStatus: string) => void
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [executions, setExecutions] = useState<BoardExecution[]>([])
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [d, ex, ws] = await Promise.all([
      boardClient.getTask(taskId),
      getTaskExecutions(taskId),
      getWorkspaceDetail(taskId),
    ])
    setDetail(d)
    setExecutions(ex)
    setWorkspace(ws)
    setLoading(false)
  }, [taskId])

  useEffect(() => {
    void load()
  }, [load])

  // Dialog semantics, focus trap, Escape and focus-return all come from Modal.
  const headingId = useId()

  const task = detail?.task
  const verdict = parseVerification(task?.['verification'])
  const cost = typeof task?.['costUsd'] === 'number' ? (task['costUsd'] as number) : null
  const comments = (detail?.comments ?? []) as {
    body?: string
    authorType?: string
    authorAgentId?: string | null
    createdAt?: number
  }[]
  // The delegated agent's deliverable is its report-up comment(s) — surface them as
  // a prominent, readable section so clicking the task shows what the agent
  // produced, formatting preserved. The Comments section below keeps the full log.
  //
  // This is also the ONLY place a board reply lands: a boo's task work stays on the
  // task rather than arriving unprompted in the person's 1:1 chat (see the native
  // driver). Naming the boo is what makes that read as a teammate reporting back
  // instead of an anonymous block of output.
  const agentOutputs = comments.filter(
    (c) => c.authorType === 'agent' && typeof c.body === 'string' && c.body.trim().length > 0,
  )
  const assigneeId = (task?.['assigneeAgentId'] as string | null | undefined) ?? null
  const reporterId = agentOutputs.find((c) => c.authorAgentId)?.authorAgentId ?? assigneeId
  const reporterName = useFleetStore(
    (st) => st.agents.find((a) => a.id === reporterId)?.name ?? null,
  )
  const outputTitle = reporterName ? `${reporterName}'s report` : 'Report'

  return (
    <Modal
      open
      variant="drawer"
      layer={60}
      labelledBy={headingId}
      onClose={onClose}
      data-testid="task-detail-drawer"
      panelClassName="surface-overlay-tier flex flex-col overflow-hidden"
      panelStyle={{
        width: 'min(560px, 92vw)',
        borderTopLeftRadius: 16,
        borderBottomLeftRadius: 16,
      }}
    >
      <div
        style={{
          height: 56,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '0 12px 0 20px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <h2
          id={headingId}
          className="truncate font-display font-bold text-foreground"
          style={{
            fontSize: 16,
            letterSpacing: '-0.02em',
            margin: 0,
          }}
        >
          {task?.title ?? 'Task'}
        </h2>
        <IconButton variant="ghost" size="sm" label="Close" onClick={onClose}>
          <X size={16} strokeWidth={2} />
        </IconButton>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 36px' }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {[0, 1, 2].map((s) => (
              <div key={s} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Skeleton width={120} height={11} />
                <Skeleton height={14} />
                <Skeleton width="70%" height={14} />
              </div>
            ))}
          </div>
        ) : !task ? (
          <EmptyState
            icon={FileQuestion}
            title="Task not found"
            helper="This task may have been dropped or is no longer on the board."
          />
        ) : (
          <>
            {agentOutputs.length > 0 && (
              <Section icon={<FileText size={13} />} title={outputTitle}>
                <div className="flex flex-col gap-2">
                  {agentOutputs.map((c, i) => (
                    <div
                      key={i}
                      className="whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-3 text-[13px] leading-relaxed text-foreground/85"
                      style={{ fontFamily: 'var(--font-body)' }}
                    >
                      {c.body}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section icon={<ListChecks size={13} />} title="Overview">
              {kvControl(
                'Status',
                <StatusSelect
                  taskId={task.id}
                  status={task.status}
                  assigneeAgentId={task.assigneeAgentId}
                  onChange={(next) => {
                    setDetail((d) =>
                      d
                        ? {
                            ...d,
                            // Mirror the server: a →todo release clears the assignee,
                            // runtime, and verification verdict (repository.ts, the
                            // cross-runtime rebind boundary). Without this the Assignee
                            // row reads stale, a prior verdict lingers, and the release
                            // confirm would re-fire on the next move.
                            task: {
                              ...d.task,
                              status: next,
                              ...(next === 'todo'
                                ? {
                                    assigneeAgentId: null,
                                    assigneeRuntime: null,
                                    verification: null,
                                  }
                                : {}),
                            },
                          }
                        : d,
                    )
                    // Reflect the move on the board at once (#98). onChange fires only
                    // on a committed change, so this never moves a card for a failed one.
                    onStatusCommitted?.(taskId, next)
                  }}
                />,
              )}
              {kv('Assignee', String(task['assigneeAgentId'] ?? '—'))}
              {kv('Runtime', String(task['assigneeRuntime'] ?? 'openclaw'))}
              {kv('Cost', cost != null ? `$${cost.toFixed(4)}` : '—')}
              {task['parentTaskId']
                ? kv('Parent', String(task['parentTaskId']).slice(0, 12))
                : null}
            </Section>

            <Section icon={<ListChecks size={13} />} title="Verification">
              {verdict ? (
                <div style={{ fontSize: 12 }}>
                  <StatusPill
                    tone={verdict.status ? VERDICT_TONE[verdict.status] : 'idle'}
                    label={verdict.status ?? 'unknown'}
                  />
                  {(() => {
                    // Surface who reviewed — a same-model review's independence is
                    // context-level only (fresh session, detached worktree), so the
                    // reviewer model/runtime is shown for the bias caveat.
                    const critic = verdict.attempts?.[verdict.attempts.length - 1]?.critic
                    const runtime = critic?.reviewerRuntime
                    const model = critic?.reviewerModel
                    return runtime || model ? (
                      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted-foreground)' }}>
                        Reviewed by {runtime ?? 'unknown'}
                        {model ? ` · ${model}` : ''}
                      </div>
                    ) : null
                  })()}
                  {(verdict.debtNotes ?? []).length > 0 && (
                    <ul
                      style={{
                        margin: '8px 0 0',
                        paddingLeft: 16,
                        color: 'var(--amber)',
                        fontSize: 11,
                      }}
                    >
                      {verdict.debtNotes!.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  )}
                  {(verdict.attempts?.[0]?.critic?.findings ?? []).map((fnd, i) => (
                    <div key={i} className="mt-1.5 text-[11px] text-foreground/70">
                      <strong className="font-semibold text-foreground/85">{fnd.severity}</strong> —{' '}
                      {fnd.title}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                  No verification verdict yet.
                </div>
              )}
            </Section>

            <Section icon={<GitBranch size={13} />} title="Workspace">
              {workspace?.ok && workspace.workspace ? (
                <>
                  {kv('Branch', workspace.workspace.branch ?? '—')}
                  {kv('Worktree', workspace.workspace.worktreePath ?? '—')}
                  {workspace.diffStat &&
                    kv(
                      'Diff',
                      `${workspace.diffStat.filesChanged} files, +${workspace.diffStat.insertions} −${workspace.diffStat.deletions}`,
                    )}
                  {Object.entries(workspace.sorFiles ?? {}).length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div
                        style={{ fontSize: 11, color: 'var(--muted-foreground)', marginBottom: 4 }}
                      >
                        System-of-record files
                      </div>
                      {Object.entries(workspace.sorFiles ?? {}).map(([name, content]) => (
                        <details key={name} style={{ marginBottom: 4 }}>
                          <summary
                            style={{
                              fontSize: 11,
                              color: muted(0.6),
                              cursor: 'pointer',
                              fontFamily: 'var(--font-mono)',
                            }}
                          >
                            <FileText size={10} style={{ display: 'inline', marginRight: 4 }} />
                            {name}
                          </summary>
                          <div style={codeBox}>{content}</div>
                        </details>
                      ))}
                    </div>
                  )}
                  {workspace.diff ? (
                    <div style={{ marginTop: 8 }}>
                      <div
                        style={{ fontSize: 11, color: 'var(--muted-foreground)', marginBottom: 4 }}
                      >
                        Diff
                      </div>
                      <div style={codeBox}>{workspace.diff}</div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                  No worktree provisioned for this task.
                </div>
              )}
            </Section>

            <Section
              icon={<Workflow size={13} />}
              title={`Execution ledger (${executions.length})`}
            >
              {executions.length === 0 ? (
                <div className="text-[11px] text-muted-foreground">No runs recorded.</div>
              ) : (
                executions.map((ex) => (
                  <div key={ex.id} className="border-t border-border py-2 text-[11px]">
                    <span className="font-semibold text-foreground">
                      {ex.executorType ?? 'runtime'}
                    </span>{' '}
                    <span className="text-foreground/50">{ex.status}</span>
                    {typeof ex.costUsd === 'number' && (
                      <span className="font-data text-foreground/50">
                        {' '}
                        · ${ex.costUsd.toFixed(4)}
                      </span>
                    )}
                    {(ex.inputTokens != null || ex.outputTokens != null) && (
                      <span className="font-data text-foreground/40">
                        {' '}
                        · {ex.inputTokens ?? 0}↓ {ex.outputTokens ?? 0}↑ tok
                      </span>
                    )}
                    {ex.error && (
                      <div className="font-data mt-1 whitespace-pre-wrap break-words text-[10.5px] text-destructive">
                        {ex.error}
                      </div>
                    )}
                  </div>
                ))
              )}
            </Section>

            <Section icon={<Terminal size={13} />} title="Activity">
              <ActivityTerminal scope={{ taskId }} maxHeight={260} hideHeader />
            </Section>

            <Section icon={<MessagesSquare size={13} />} title={`Comments (${comments.length})`}>
              {comments.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>No comments.</div>
              ) : (
                comments.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 11.5,
                      padding: '8px 0',
                      borderTop: '1px solid var(--border)',
                    }}
                  >
                    <span style={{ color: 'var(--muted-foreground)' }}>
                      {c.authorType ?? 'system'}:{' '}
                    </span>
                    <span
                      style={{
                        color: muted(0.75),
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {c.body}
                    </span>
                  </div>
                ))
              )}
            </Section>

            <Section icon={<Workflow size={13} />} title="Lineage / deps">
              {(detail?.ancestors ?? []).length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                  Top-level task (no ancestors).
                </div>
              ) : (
                <div
                  className="font-data"
                  style={{
                    fontSize: 11,
                    color: muted(0.6),
                  }}
                >
                  {(detail?.ancestors ?? []).map((a) => a.id.slice(0, 8)).join(' → ')}
                </div>
              )}
            </Section>
          </>
        )}
      </div>
    </Modal>
  )
}
