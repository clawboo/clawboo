#!/usr/bin/env node
// Dev-only live acceptance driver (NOT shipped — scripts/ is excluded from the CLI
// tarball). Drives the EXECUTOR leg of an all-flags-on acceptance run: creates a
// durable board task and executes it on the REAL Claude Code runtime, then reads
// back the cross-subsystem evidence (board status + report-up comment, worktree +
// AGENT_HANDOFF.json, verification verdict, governance budget ledger, the
// observability trace). The MCP attach is auto-wired by the server from the
// request host, so the runtime can read the board/memory over MCP.
//
// Prereq: a clawboo server running with the all-on flags + CLAWBOO_RUNTIME_CLAUDE_CODE=1,
// and a logged-in `claude` CLI (or ANTHROPIC_API_KEY). It uses a LABEL teamId
// string (no real team row) so it leaves no team behind; residual throwaway
// task/execution/obs rows + the worktree are reported for cleanup.
//
//   BASE=http://localhost:18790 LIVE_MODEL=haiku node scripts/live-acceptance.mjs

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.BASE || 'http://localhost:18790'
const MODEL = process.env.LIVE_MODEL || 'haiku'
const TEAM_LABEL = 'live-acceptance'
const evidence = { base: BASE, model: MODEL, steps: {} }

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json }
}

function log(label, obj) {
  console.log(`\n=== ${label} ===`)
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
}

async function main() {
  // 0. Sanity: the server is up + reports the all-on features.
  const settings = await api('GET', '/api/settings')
  evidence.steps.features = settings.json?.features ?? settings.json
  log('server features', evidence.steps.features)
  const runtimes = await api('GET', '/api/runtimes')
  evidence.steps.runtimes = runtimes.json
  log('enabled runtimes + health', runtimes.json)

  // 1. Snapshot existing teams (verify intact at the end — we never touch them).
  const teamsBefore = await api('GET', '/api/teams')
  const teamsBeforeArr = teamsBefore.json?.teams ?? teamsBefore.json
  const beforeNames = Array.isArray(teamsBeforeArr)
    ? teamsBeforeArr.map((t) => t.name).sort()
    : teamsBeforeArr
  evidence.steps.teamsBefore = beforeNames
  log('existing teams BEFORE', beforeNames)

  // 2. A throwaway git repo for the worktree to branch from.
  const repo = mkdtempSync(path.join(os.tmpdir(), 'live-acceptance-repo-'))
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'live-acceptance'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'live-acceptance@example.com'], { cwd: repo })
  writeFileSync(path.join(repo, 'README.md'), '# live acceptance\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '--no-verify', '-m', 'init'], { cwd: repo })
  evidence.steps.repo = repo
  log('throwaway repo', repo)

  // 3. Create a durable board task (label teamId — no real team row).
  const task = await api('POST', '/api/board', {
    title: 'Create greeting.txt and a passing verify command',
    description:
      'In the current working directory, create a file named greeting.txt containing a single short greeting line. ' +
      "Then edit init.sh so the line reads exactly: VERIFY_CMD='test -f greeting.txt'. " +
      'Keep the change minimal. Reply with a one-line summary when done.',
    teamId: TEAM_LABEL,
  })
  const taskId = task.json?.id ?? task.json?.task?.id
  evidence.steps.taskCreated = { status: task.status, taskId, body: task.json }
  log('board task created', { status: task.status, taskId })
  if (!taskId) throw new Error(`task create failed: ${JSON.stringify(task.json)}`)

  // 3.5 Optional: pre-set an agent budget limit so the governance LEDGER records
  //     this run's real spend (uncapped → no row; capped → spend accrues).
  if (process.env.BUDGET_CENTS) {
    const limitUsdCents = Number(process.env.BUDGET_CENTS)
    const bud = await api('POST', '/api/governance/budgets', {
      scope: 'agent',
      scopeId: 'la-claude',
      limitUsdCents,
    })
    evidence.steps.budgetSet = { limitUsdCents, status: bud.status, body: bud.json }
    log('budget limit set (agent/la-claude)', evidence.steps.budgetSet)
  }

  // 4. Execute the task on the REAL Claude Code runtime (worktree + MCP + verify +
  //    governance + obs all active). The server derives mcpBaseUrl from the host.
  log('running on claude-code …', { model: MODEL })
  const t0 = Date.now()
  const run = await api('POST', '/api/runtimes/claude-code/run', {
    taskId,
    assigneeAgentId: 'la-claude',
    repoPath: repo,
    kind: 'code',
    model: MODEL,
  })
  evidence.steps.run = { status: run.status, elapsedMs: Date.now() - t0, result: run.json }
  log(`run result (HTTP ${run.status}, ${Date.now() - t0} ms)`, run.json)

  // 5. Read back the cross-subsystem evidence.
  const board = await api('GET', `/api/board/${taskId}`)
  evidence.steps.board = board.json
  log('board task + comments + ancestors', board.json)

  const ws = await api('GET', `/api/board/${taskId}/workspace`)
  evidence.steps.workspace = ws.json
  log('workspace + reconstructed state + AGENT_HANDOFF.json', ws.json)

  const budgets = await api('GET', '/api/governance/budgets')
  evidence.steps.budgets = budgets.json
  log('governance budgets', budgets.json)

  const obs = await api('GET', `/api/obs/events?taskId=${taskId}`)
  const events = Array.isArray(obs.json?.events) ? obs.json.events : []
  const kinds = events.map((e) => e.kind)
  const traceId = events.find((e) => e.traceId)?.traceId ?? null
  evidence.steps.obs = { count: events.length, kinds, traceId }
  log('obs events', { count: events.length, kinds, traceId })
  if (traceId) {
    const trace = await api('GET', `/api/obs/traces/${traceId}`)
    evidence.steps.trace = trace.json
    log('obs trace', trace.json)
  }

  // 6. Verify the user's teams are untouched + report residuals for cleanup.
  const teamsAfter = await api('GET', '/api/teams')
  const teamsAfterArr = teamsAfter.json?.teams ?? teamsAfter.json
  const afterNames = Array.isArray(teamsAfterArr)
    ? teamsAfterArr.map((t) => t.name).sort()
    : teamsAfterArr
  evidence.steps.teamsAfter = afterNames
  const intact = JSON.stringify(beforeNames) === JSON.stringify(afterNames)
  log('existing teams AFTER (must equal BEFORE)', { intact, afterNames })

  const wtRoot = path.join(os.homedir(), '.openclaw', 'clawboo', 'worktrees')
  evidence.steps.worktreeRootExists = existsSync(wtRoot)
  evidence.cleanup = {
    note: 'Label teamId only — no team row created. Residual throwaway task/execution/obs rows remain in the dev DB.',
    throwawayTaskId: taskId,
    worktreeRoot: wtRoot,
    repo,
  }

  const outPath = path.join(os.tmpdir(), 'live-acceptance-evidence.json')
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  log('evidence written', outPath)
  console.log(
    `\nSUMMARY: run HTTP ${evidence.steps.run.status}, task status ${board.json?.task?.status}, teams intact ${intact}`,
  )
}

main().catch((err) => {
  console.error('live-acceptance failed:', err)
  process.exit(1)
})
