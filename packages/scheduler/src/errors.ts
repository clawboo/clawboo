// Typed errors for the scheduling surface. Every error carries a readonly
// `code` so REST handlers and callers can branch structurally (never on
// message prose). Refusals that originate as DATA inside @clawboo/db (the
// board's "0-row claim is data" idiom) are minted into these at the server
// layer.

import type { ScheduleManageability } from './records'

/** A cron spec that parses as neither a croner expression nor `once@<iso>`. */
export class InvalidCronSpecError extends Error {
  readonly code = 'invalid_cron_spec' as const
  constructor(
    readonly spec: string,
    detail?: string,
  ) {
    super(`Invalid cron spec "${spec}"${detail ? `: ${detail}` : ''}`)
    this.name = 'InvalidCronSpecError'
  }
}

/** Reachable-but-unimplemented branches (the human-participant Routine). */
export class NotImplementedError extends Error {
  readonly code = 'not_implemented' as const
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

/** write() on a source whose manageability tier forbids the action. */
export class UnsupportedScheduleWriteError extends Error {
  readonly code = 'unsupported_schedule_write' as const
  constructor(
    readonly sourceId: string,
    readonly action: string,
    readonly manageability: ScheduleManageability,
  ) {
    super(`Schedule source "${sourceId}" (${manageability}) does not support "${action}"`)
    this.name = 'UnsupportedScheduleWriteError'
  }
}

/**
 * Creating a domain:'team-task' schedule via a runtime-own-life source (e.g.
 * the OpenClaw Gateway cron). clawboo never registers a team task into a
 * runtime's own scheduler — team-task cadence is the Routines ledger's.
 */
export class TeamTaskDomainViolationError extends Error {
  readonly code = 'team_task_domain_violation' as const
  constructor(readonly sourceId: string) {
    super(
      `A team-task schedule cannot be registered into "${sourceId}" — team-task cadence belongs to the Routines ledger`,
    )
    this.name = 'TeamTaskDomainViolationError'
  }
}

/** A WRITE against a source whose backing connection is down (REST → 503). */
export class ScheduleSourceUnavailableError extends Error {
  readonly code = 'schedule_source_unavailable' as const
  constructor(
    readonly sourceId: string,
    readonly reason: string,
  ) {
    super(`Schedule source "${sourceId}" is unavailable: ${reason}`)
    this.name = 'ScheduleSourceUnavailableError'
  }
}

/** A user-driven transition the routine state machine forbids (REST → 409). */
export class IllegalScheduleTransitionError extends Error {
  readonly code = 'illegal_schedule_transition' as const
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal schedule transition ${from} → ${to}`)
    this.name = 'IllegalScheduleTransitionError'
  }
}

/** Unknown composite id / unknown source (REST → 404). */
export class UnknownScheduleError extends Error {
  readonly code = 'unknown_schedule' as const
  constructor(readonly id: string) {
    super(`Unknown schedule "${id}"`)
    this.name = 'UnknownScheduleError'
  }
}

/** The registration-time de-dup refusal surfaced through the write path. */
export class DuplicateFiringOwnerError extends Error {
  readonly code = 'duplicate_firing_owner' as const
  constructor(
    readonly existingOwner: string,
    detail?: string,
  ) {
    super(
      `Already scheduled by "${existingOwner}"${detail ? ` (${detail})` : ''} — never retry this refusal`,
    )
    this.name = 'DuplicateFiringOwnerError'
  }
}

/**
 * Binding a RECURRING routine to a pre-existing team task. A bound task is
 * dispatched as-is and is claimable only once (todo → done); a recurring cron
 * would fire once then park in error forever. Bound routines must be one-shot
 * (`once@<iso>`). REST → 400. Never retried.
 */
export class BoundRecurringScheduleError extends Error {
  readonly code = 'bound_recurring_schedule' as const
  constructor(
    readonly teamTaskId: string,
    readonly cronSpec: string,
  ) {
    super(
      `A recurring schedule ("${cronSpec}") cannot bind to existing team task ${teamTaskId} — a bound task is claimable once, so use a one-shot (once@<iso>) spec`,
    )
    this.name = 'BoundRecurringScheduleError'
  }
}
