// @clawboo/governance — the pure, browser-safe decision layer for verification
// (builder ≠ judge) and governance (budgets, caps). All exports are pure
// functions or zod schemas with no DB / node:* / network dependency, so the
// board, the server libs, and the SPA all consume the SAME typed vocabulary.
// DB-bound concerns (tables, atomic SQL, audit inserts) live in @clawboo/db;
// runtime I/O (spawning the verify command, the review worktree) lives server-side.

export * from './verify'
export * from './budget'
export * from './caps'
export * from './breaker'
