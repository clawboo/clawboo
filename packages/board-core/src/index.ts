// ─── @clawboo/board-core ────────────────────────────────────────────────────
// The pure task state machine, extracted so the durable board (@clawboo/db), the
// orchestration engine (@clawboo/team-orchestration), and the browser board UI
// all read ONE declaration of the 7 statuses and the legal-transition table
// instead of hand-maintained copies that can silently drift.
//
// Zero dependencies, no `node:*`, no I/O — safe to bundle into the Vite SPA.

export * from './state-machine'
