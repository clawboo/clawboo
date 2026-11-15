// The arguments `clawboo agent-user` forwards to the server bundle
// (`node server.js --agent-user <action> ...`).

export interface AgentUserOpts {
  user?: string
  pool?: string
  teams?: string
  firstUid?: string
  firstTeamGid?: string
}

/** `--user`, or for a user per agent `--pool` with `--teams`, `--first-uid`
 *  and `--first-team-gid`, as the server's own command reads them. */
export function agentUserArgs(opts: AgentUserOpts): string[] {
  const out: string[] = []
  if (opts.user) out.push('--user', opts.user)
  if (opts.pool !== undefined) out.push('--pool', opts.pool)
  if (opts.teams !== undefined) out.push('--teams', opts.teams)
  if (opts.firstUid !== undefined) out.push('--first-uid', opts.firstUid)
  if (opts.firstTeamGid !== undefined) out.push('--first-team-gid', opts.firstTeamGid)
  return out
}
