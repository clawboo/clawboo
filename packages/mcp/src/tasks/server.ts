// ─── Tasks MCP server ────────────────────────────────────────────────────────
// A thin protocol façade over the durable board repository (@clawboo/db). Lets
// ANY runtime coordinate on the same board. Atomic claim surfaces a conflict as
// a tool-error the model must NOT retry (the "never retry a 409" rule).

import {
  addComment,
  blockTask,
  claimTask,
  createCappedSubtask,
  createTask,
  getAncestors,
  getComments,
  getReadyTasks,
  getTask,
  linkDep,
  listTasks,
  releaseTask,
  TaskDependencyCycleError,
  taskStatusSchema,
  unblockTask,
  updateStatus,
  type ClawbooDb,
  type CreateSubtaskResult,
  type CreateTaskInput,
  type TaskStatus,
} from '@clawboo/db'
import { z } from 'zod'

import {
  buildServer,
  jsonResult,
  textResult,
  type McpToolResult,
  type Server,
  type ToolDef,
} from '../shared'

// The tool schemas advertise exactly the statuses the board accepts. Derived from
// the shared state machine (@clawboo/board-core, re-exported by @clawboo/db) rather
// than hand-listed, so a status added server-side reaches MCP clients automatically.
const STATUS = taskStatusSchema

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Turn a capped-create denial into the tool error the model sees. The cap
 * messages name the recovery so the model can act instead of retrying — the same
 * spirit as the "never retry a 409" claim conflict.
 *
 * The caps bound what an ATTACHED RUNTIME can create through these tools. The
 * durable repository stays uncapped: the REST board and the in-process team-chat
 * orchestrator carry their own per-turn fan-out and dispatch-depth limits. Rows
 * they create still COUNT here, so an agent cannot launder rows in through
 * another surface to raise its own ceiling.
 */
function subtaskDenial(parentTaskId: string, result: CreateSubtaskResult): McpToolResult {
  if (result.reason === 'child_cap') {
    return textResult(
      `subtask rejected: parent ${parentTaskId} already has ${result.childCount} children (max ${result.max}); drop one or attach the new task elsewhere`,
      true,
    )
  }
  if (result.reason === 'depth_cap') {
    return textResult(
      `subtask rejected: parent ${parentTaskId} is at the maximum nesting depth (${result.max}); attach the new task higher in the tree`,
      true,
    )
  }
  return textResult(`parent not found: ${parentTaskId}`, true)
}

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
      description:
        'Create a board task. With parentTaskId set it is a subtask: the per-parent child-count and nesting-depth caps apply.',
      inputSchema: z.object({
        title: z.string(),
        description: z.string().optional(),
        status: STATUS.optional(),
        priority: z.number().int().optional(),
        teamId: z.string().optional(),
        // .min(1) so '' is an "invalid args" tool error rather than an empty-string
        // parent that reaches the FK and throws out of the handler. Wire-invisible:
        // the zod→JSON-Schema converter emits { type: 'string' } either way.
        parentTaskId: z.string().min(1).optional(),
        assigneeRuntime: z.string().optional(),
      }),
      handler: (args) => {
        const input: Omit<CreateTaskInput, 'parentTaskId'> = {
          title: str(args['title']),
          description: optStr(args['description']),
          status: optStr(args['status']) as TaskStatus | undefined,
          priority: typeof args['priority'] === 'number' ? args['priority'] : undefined,
          teamId: optStr(args['teamId']),
          assigneeRuntime: optStr(args['assigneeRuntime']),
        }
        // No parent ⇒ a root task: unchanged hot path, no transaction, no caps.
        const parentTaskId = optStr(args['parentTaskId'])
        if (!parentTaskId) return jsonResult(createTask(db, input))
        const result = createCappedSubtask(db, parentTaskId, input)
        return result.ok ? jsonResult(result.task) : subtaskDenial(parentTaskId, result)
      },
    },
    {
      name: 'create_subtask',
      description:
        'Create a subtask under a parent (inherits the parent team). Capped per parent (child count) and by nesting depth.',
      inputSchema: z.object({
        parentTaskId: z.string().min(1),
        title: z.string(),
        description: z.string().optional(),
      }),
      handler: (args) => {
        const parentTaskId = str(args['parentTaskId'])
        const result = createCappedSubtask(db, parentTaskId, {
          title: str(args['title']),
          description: optStr(args['description']),
        })
        return result.ok ? jsonResult(result.task) : subtaskDenial(parentTaskId, result)
      },
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
        try {
          linkDep(db, str(args['taskId']), str(args['dependsOnTaskId']))
        } catch (error) {
          if (error instanceof TaskDependencyCycleError) {
            return textResult(error.message, true)
          }
          throw error
        }
        return textResult(
          `linked: ${str(args['taskId'])} depends on ${str(args['dependsOnTaskId'])}`,
        )
      },
    },
  ]

  return buildServer('clawboo-tasks', tools)
}
