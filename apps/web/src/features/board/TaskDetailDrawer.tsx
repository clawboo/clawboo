import { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
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
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { EmptyState } from '@/features/shared/EmptyState'
import { Skeleton } from '@/features/shared/Skeleton'
import { ActivityTerminal } from '@/features/obs/ActivityTerminal'
import { ENTER_SPRING } from '@/lib/motion'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

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
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 9 }}>
        <span style={{ color: muted(0.4), display: 'flex' }}>{icon}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: muted(0.45),
          }}
        >
          {title}
        </span>
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
  borderRadius: 8,
  padding: '8px 10px',
  color: muted(0.75),
  maxHeight: 260,
  overflowY: 'auto',
}

function kv(label: string, value: string) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12, marginBottom: 4 }}>
      <span style={{ color: muted(0.4), minWidth: 78 }}>{label}</span>
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

export function TaskDetailDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const task = detail?.task
  const verdict = parseVerification(task?.['verification'])
  const cost = typeof task?.['costUsd'] === 'number' ? (task['costUsd'] as number) : null
  const comments = (detail?.comments ?? []) as {
    body?: string
    authorType?: string
    createdAt?: number
  }[]

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--overlay-scrim, rgb(0 0 0 / 0.5))',
          zIndex: 60,
        }}
      />
      <motion.div
        data-testid="task-detail-drawer"
        className="surface-overlay-tier"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={ENTER_SPRING}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(560px, 92vw)',
          borderRadius: 0,
          zIndex: 61,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            height: 48,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 14px',
            borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.08)',
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {task?.title ?? 'Task'}
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              width: 28,
              height: 28,
              borderRadius: 7,
              border: 'none',
              background: 'transparent',
              color: muted(0.5),
              cursor: 'pointer',
              transition: 'background var(--motion-fast), color var(--motion-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgb(var(--foreground-rgb) / 0.06)'
              e.currentTarget.style.color = 'var(--foreground)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = muted(0.5)
            }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 32px' }}>
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
              <Section icon={<ListChecks size={13} />} title="Overview">
                {kv('Status', task.status)}
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
                        <div style={{ marginTop: 6, fontSize: 11, color: muted(0.5) }}>
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
                      <div key={i} style={{ marginTop: 6, fontSize: 11, color: muted(0.7) }}>
                        <strong style={{ color: 'var(--primary)' }}>{fnd.severity}</strong> —{' '}
                        {fnd.title}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: muted(0.4) }}>
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
                        <div style={{ fontSize: 11, color: muted(0.45), marginBottom: 4 }}>
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
                        <div style={{ fontSize: 11, color: muted(0.45), marginBottom: 4 }}>
                          Diff
                        </div>
                        <div style={codeBox}>{workspace.diff}</div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: muted(0.4) }}>
                    No worktree provisioned for this task.
                  </div>
                )}
              </Section>

              <Section
                icon={<Workflow size={13} />}
                title={`Execution ledger (${executions.length})`}
              >
                {executions.length === 0 ? (
                  <div style={{ fontSize: 11, color: muted(0.4) }}>No runs recorded.</div>
                ) : (
                  executions.map((ex) => (
                    <div
                      key={ex.id}
                      style={{
                        fontSize: 11,
                        padding: '6px 0',
                        borderTop: '1px solid rgb(var(--foreground-rgb) / 0.05)',
                      }}
                    >
                      <span style={{ color: 'var(--foreground)', fontWeight: 600 }}>
                        {ex.executorType ?? 'runtime'}
                      </span>{' '}
                      <span style={{ color: muted(0.5) }}>{ex.status}</span>
                      {typeof ex.costUsd === 'number' && (
                        <span style={{ color: muted(0.5) }}> · ${ex.costUsd.toFixed(4)}</span>
                      )}
                      {(ex.inputTokens != null || ex.outputTokens != null) && (
                        <span style={{ color: muted(0.4) }}>
                          {' '}
                          · {ex.inputTokens ?? 0}↓ {ex.outputTokens ?? 0}↑ tok
                        </span>
                      )}
                      {ex.error && (
                        <div
                          className="font-data"
                          style={{
                            marginTop: 3,
                            fontSize: 10.5,
                            color: 'var(--primary)',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}
                        >
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
                  <div style={{ fontSize: 11, color: muted(0.4) }}>No comments.</div>
                ) : (
                  comments.map((c, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: 11.5,
                        padding: '6px 0',
                        borderTop: '1px solid rgb(var(--foreground-rgb) / 0.05)',
                      }}
                    >
                      <span style={{ color: muted(0.4) }}>{c.authorType ?? 'system'}: </span>
                      <span style={{ color: muted(0.75) }}>{c.body}</span>
                    </div>
                  ))
                )}
              </Section>

              <Section icon={<Workflow size={13} />} title="Lineage / deps">
                {(detail?.ancestors ?? []).length === 0 ? (
                  <div style={{ fontSize: 11, color: muted(0.4) }}>
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
      </motion.div>
    </>
  )
}
