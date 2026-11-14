// Which requests count as a person acting, for presence (see presence.ts).
//
// A request is a person acting only when it is something a person does: never a
// read, and never something a client sends by itself. A request a sign-in proxy
// or an app link vouched for does not count just for that: a proxy vouches for
// every request it forwards, a background tab's polling included, so an install
// behind one would never look idle. So, after the request is routed:
//
//   - GET, HEAD and OPTIONS never count, vouched or not.
//   - A route on PERSON_ACTION_ROUTES counts, whoever sent it (the dashboard, the
//     API, a linked device): answering an approval or a question, sending a chat
//     message or a comment, creating, moving, retrying, stopping or pausing work.
//   - Any other write counts when the identity lane names a person on it, unless
//     it is on AUTOMATIC_WRITE_ROUTES: the presence beat itself, the hold, and the
//     writes the dashboard sends without anyone doing anything.
//   - A spawned runtime's own calls (the MCP routes it reaches with its attach
//     token) never count.
//
// A write that cannot be told apart from an automatic one is left out: a missed
// action only shortens the idle window, while a false one keeps the machine up.

import type { NextFunction, Request, RequestHandler, Response } from 'express'

import { presence, type Presence } from './presence'

/** Writes that are a person acting, by `METHOD /registered/path`. */
export const PERSON_ACTION_ROUTES: ReadonlySet<string> = new Set([
  // Answering an approval or an agent's question (plan approvals included), or a
  // job's request to go on.
  'POST /api/approvals',
  'POST /api/tools/approvals/:id/resolve',
  'POST /api/board/questions/:questionId/answer',
  'POST /api/board/agent-wakes/:jobTaskId',
  'POST /api/board/job-limit/:jobTaskId',
  // Sending a chat message or a comment, or clearing a chat.
  'POST /api/teams/:id/chat',
  'POST /api/teams/:id/chat/clear',
  'POST /api/agents/:agentId/chat',
  'POST /api/board/:taskId/comments',
  // Creating, moving, retrying, reopening or handing over work (each can start a
  // run), stopping or pausing it, or running a routine now.
  'POST /api/board',
  'PATCH /api/board/:taskId',
  'POST /api/board/:taskId/retry',
  'POST /api/board/:taskId/reopen',
  'POST /api/board/:taskId/assign',
  'POST /api/board/:taskId/assign-person',
  'POST /api/teams/:id/chat/stop',
  'POST /api/agents/:agentId/chat/stop',
  'POST /api/runtimes/:id/run',
  'POST /api/schedules/:id/run',
  'PATCH /api/schedules/:id',
  'POST /api/pauses',
  'DELETE /api/pauses/:kind/:id',
])

/**
 * Writes that never count, even when the identity lane names a person on them:
 * the presence beat (it reports a person its own way), the hold (a stop script's),
 * and every write the dashboard can send without anyone doing anything (on load, on
 * a Gateway connect, on a timer, as a view opens or closes). Several of these are
 * also sent when a person does something (saving a file, creating a team), but a
 * write that cannot be told apart from an automatic one is left out.
 */
export const AUTOMATIC_WRITE_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/system/presence',
  'POST /api/system/hold',
  'DELETE /api/system/hold/:owner',
  // Read marks, as a view opens or comes back into sight.
  'POST /api/board/inbox/read',
  'POST /api/board/:taskId/read',
  // The graph's saved layout, after every automatic layout (page load included).
  'POST /api/graph-layout',
  // A Gateway connect: the agent sync, Boo Zero's name, and moving teamless agents
  // into a team.
  'POST /api/agents/sync',
  'PUT /api/boo-zero/display-name/:agentId',
  'PUT /api/agents/:agentId/files/:name',
  'POST /api/teams',
  'POST /api/teams/:id/agents',
  'DELETE /api/teams/:id/agents/:agentId',
  'PATCH /api/teams/:id',
  // The first-run nudge, a browser frame when the browser card opens, and records
  // kept from the Gateway's events.
  'POST /api/settings',
  'POST /api/agents/:agentId/screenshot/capture',
  'POST /api/cost-records',
  'POST /api/chat-history',
  // Sent as a dialog or a setup panel opens, or a personality edit is left.
  'POST /api/access/launch-code',
  'POST /api/system/auto-configure-openclaw',
  'POST /api/system/install-openclaw',
  'POST /api/system/gateway',
  'POST /api/personality',
  // Read-style POSTs: a sign-in's long wait, and a model list.
  'POST /api/connectors/:slug/authorize/await',
  'POST /api/providers/:id/models',
])

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The route a request was served by, as `METHOD /registered/path`, or null. */
function routeKey(req: Request): string | null {
  const path = (req.route as { path?: unknown } | undefined)?.path
  return typeof path === 'string' ? `${req.method} ${path}` : null
}

/** Whether this routed request is a person acting (see the rules above). */
export function isPersonAction(req: Request): boolean {
  if (READS.has(req.method)) return false
  const key = routeKey(req)
  if (key === null) return false
  // What a spawned runtime sends over its MCP attach is an agent's, not a person's.
  if (key.startsWith(`${req.method} /api/mcp/`)) return false
  if (AUTOMATIC_WRITE_ROUTES.has(key)) return false
  if (PERSON_ACTION_ROUTES.has(key)) return true
  return req.person != null
}

/**
 * Middleware, mounted before the API router: once a response is sent, a request
 * that was a person acting counts as one in the presence record.
 */
export function recordPersonActions(record: () => Presence = presence): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!READS.has(req.method)) {
      res.once('finish', () => {
        try {
          if (isPersonAction(req)) record().acted()
        } catch {
          // Presence is a hint; it never fails a request.
        }
      })
    }
    next()
  }
}
