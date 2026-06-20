// ─── Tasks MCP server ────────────────────────────────────────────────────────
// A thin protocol façade over the durable board repository (@clawboo/db). Lets
// ANY runtime coordinate on the same board. Atomic claim surfaces a conflict as
// a tool-error the model must NOT retry (the "never retry a 409" rule).

import {
  addComment,
  blockTask,
  claimTask,
  createSubtask,
  createTask,
  getAncestors,
  getComments,
  getReadyTasks,
  getTask,
  linkDep,
  listTasks,
  releaseTask,
  unblockTask,
  updateStatus,
  type ClawbooDb,
  type TaskStatus,
} from '@clawboo/db'
import { z } from 'zod'

import { buildServer, jsonResult, textResult, type Server, type ToolDef } from '../shared'

const STATUS = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
])

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function createTasksServer(db: ClawbooDb): Server {
  const claimHandler = (args: Record<string, unknown>) => {
    const result = claimTask(
      db,
      str(args['taskId']),
      str(args['assigneeAgentId']),
      optStr(args['assigneeRuntime']),
    )
    if (!result.ok) return textResult(`claim failed: ${result.reason}`, true) // conflict → DO NOT retry
    return jsonResult(result.task)
  }
  const claimSchema = z.object({
    taskId: z.string(),
    assigneeAgentId: z.string(),
    assigneeRuntime: z.string().optional(),
  })

  const tools: ToolDef[] = [
    {
      name: 'list_tasks',
      description: 'List board tasks. Pass ready=true for only claimable (deps satisfied) work.',
      inputSchema: z.object({
        teamId: z.string().optional(),
        status: STATUS.optional(),
        ready: z.boolean().optional(),
      }),
      handler: (args) => {
        const teamId = optStr(args['teamId'])
        const tasks =
          args['ready'] === true
            ? getReadyTasks(db, { teamId })
            : listTasks(db, { teamId, status: optStr(args['status']) as TaskStatus | undefined })
        return jsonResult(tasks)
      },
    },
    {
      name: 'get_task',
      description: 'Get a task with its comments and ancestor chain.',
      inputSchema: z.object({ taskId: z.string() }),
      handler: (args) => {
        const id = str(args['taskId'])
        const task = getTask(db, id)
        if (!task) return textResult(`not found: ${id}`, true)
        return jsonResult({ task, comments: getComments(db, id), ancestors: getAncestors(db, id) })
      },
    },
    {
      name: 'create_task',
      description: 'Create a board task.',
      inputSchema: z.object({
        title: z.string(),
        description: z.string().optional(),
        status: STATUS.optional(),
        priority: z.number().int().optional(),
        teamId: z.string().optional(),
        parentTaskId: z.string().optional(),
        assigneeRuntime: z.string().optional(),
      }),
      handler: (args) =>
        jsonResult(
          createTask(db, {
            title: str(args['title']),
            description: optStr(args['description']),
            status: optStr(args['status']) as TaskStatus | undefined,
            priority: typeof args['priority'] === 'number' ? args['priority'] : undefined,
            teamId: optStr(args['teamId']),
            parentTaskId: optStr(args['parentTaskId']),
            assigneeRuntime: optStr(args['assigneeRuntime']),
          }),
        ),
    },
    {
      name: 'create_subtask',
      description: 'Create a subtask under a parent (inherits the parent team).',
      inputSchema: z.object({
        parentTaskId: z.string(),
        title: z.string(),
        description: z.string().optional(),
      }),
      handler: (args) =>
        jsonResult(
          createSubtask(db, str(args['parentTaskId']), {
            title: str(args['title']),
            description: optStr(args['description']),
          }),
        ),
    },
    {
      name: 'claim_task',
      description:
        'Atomically claim a todo task. A "conflict" error means another agent won — do not retry.',
      inputSchema: claimSchema,
      handler: claimHandler,
    },
    {
      name: 'assign_task',
      description:
        'Assign a todo task to an agent (same atomic claim; conflict means already assigned).',
      inputSchema: claimSchema,
      handler: claimHandler,
    },
    {
      name: 'release_task',
      description: 'Release an in-progress task back to todo.',
      inputSchema: z.object({ taskId: z.string() }),
      handler: (args) => {
        releaseTask(db, str(args['taskId']))
        return textResult(`released: ${str(args['taskId'])}`)
      },
    },
    {
      name: 'update_task_status',
      description: 'Transition a task status (state-machine enforced; illegal transitions error).',
      inputSchema: z.object({ taskId: z.string(), status: STATUS }),
      handler: (args) => {
        const r = updateStatus(db, str(args['taskId']), str(args['status']) as TaskStatus)
        return r.ok ? jsonResult(r.task) : textResult(`status change failed: ${r.reason}`, true)
      },
    },
    {
      name: 'block_task',
      description: 'Mark a task blocked.',
      inputSchema: z.object({ taskId: z.string() }),
      handler: (args) => {
        const r = blockTask(db, str(args['taskId']))
        return r.ok ? jsonResult(r.task) : textResult(`block failed: ${r.reason}`, true)
      },
    },
    {
      name: 'unblock_task',
      description: 'Unblock a task (back to todo).',
      inputSchema: z.object({ taskId: z.string() }),
      handler: (args) => {
        const r = unblockTask(db, str(args['taskId']))
        return r.ok ? jsonResult(r.task) : textResult(`unblock failed: ${r.reason}`, true)
      },
    },
    {
      name: 'add_comment',
      description: 'Add a comment to a task (report-up summaries, system notes).',
      inputSchema: z.object({
        taskId: z.string(),
        body: z.string(),
        authorAgentId: z.string().optional(),
        authorType: z.enum(['agent', 'user', 'system']).optional(),
      }),
      handler: (args) =>
        jsonResult(
          addComment(
            db,
            str(args['taskId']),
            str(args['body']),
            (optStr(args['authorType']) as 'agent' | 'user' | 'system' | undefined) ?? 'agent',
            optStr(args['authorAgentId']),
          ),
        ),
    },
    {
      name: 'link_task',
      description:
        'Make taskId depend on dependsOnTaskId (it stays unready until the dependency is done).',
      inputSchema: z.object({ taskId: z.string(), dependsOnTaskId: z.string() }),
      handler: (args) => {
        linkDep(db, str(args['taskId']), str(args['dependsOnTaskId']))
        return textResult(
          `linked: ${str(args['taskId'])} depends on ${str(args['dependsOnTaskId'])}`,
        )
      },
    },
  ]

  return buildServer('clawboo-tasks', tools)
}
