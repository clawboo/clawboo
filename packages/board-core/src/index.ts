// ─── @clawboo/board-core ────────────────────────────────────────────────────
// The pure task rules, extracted so the durable board (@clawboo/db), the
// orchestration engine (@clawboo/team-orchestration), and the browser board UI
// all read ONE declaration instead of hand-maintained copies that can silently
// drift: the 7 statuses and the legal-transition table, the dispatch rules that
// decide whether a `todo` task will ever run on its own, the needs-you
// classification built on them, and how a task's run costs add up.
//
// Zero dependencies, no `node:*`, no I/O — safe to bundle into the Vite SPA.

export * from './state-machine'
export * from './dispatch'
export * from './attention'
export * from './runCost'
