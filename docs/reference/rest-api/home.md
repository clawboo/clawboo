---
title: 'Home API'
description: "REST reference for Home: one read for a team's Home or for all teams, and the routes for goals, goal updates, KPIs and their values, pages and their revisions, Home settings and weekly updates."
keywords:
  [
    'home',
    'goals',
    'kpi',
    'metrics',
    'status update',
    'pages',
    'revisions',
    'status line',
    'weekly updates',
  ]
---

From 0.9.0. Home is one page for each team, plus one for all teams. It joins what Clawboo already knows about a team (its requests in flight, what needs you, its spend) with what a person sets for it: goals, KPIs and pages. The capability flag `home.goals` (see [System](/reference/rest-api/system#get-%2Fapi%2Fsystem%2Fcapabilities)) says the engine has these routes. The typed client is `home.ts` in `@clawboo/control-client`.

Every write here is a person's. A request that may not act as the person (see [the person check](/operating/security#the-person-check)) gets `403` with `"error": "person_only"`. Agents reach Home only through the [Tasks MCP tools](/reference/mcp-tools#home-tools), and only to report a KPI value, suggest a KPI, write a page or draft a goal update. No route or tool lets an agent define a KPI, change a target, set a goal's health or publish an update.

Every route is on the general [rate limit](/reference/rest-api/index#rate-limits), and the two settings writes also on the sensitive one. Request bodies are JSON. Add the access cookie to each `curl` example (see [Authentication](/reference/rest-api/index#authentication)). Times are epoch milliseconds.

## Where each number comes from

| Number                          | Source                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal progress                   | The goal's linked tasks: done over all, leaving out cancelled and removed tasks and each request's own card. A parent goal counts its child goals' tasks too.                 |
| Checked                         | Done tasks whose stored check verdict passed.                                                                                                                                 |
| Added in the last 7 days        | Linked tasks created in the last 7 days: how the scope changed.                                                                                                               |
| Goal cost                       | The sum of the linked tasks' run costs. `includesEstimates` is true when any run priced itself by an estimate rather than a cost its runtime reported.                        |
| Spend (team, last 7 or 30 days) | The cost records of the team's agents (the same records the Cost dashboard reads). `includesEstimates` is true when a run of the team's tasks in that window was an estimate. |
| Budget                          | The team's budget, when it has one.                                                                                                                                           |
| Needs you                       | The Board's Needs you reasons for the team's tasks, tool approvals waiting for the team's agents, drafts waiting on its goals, and KPIs agents suggested.                     |
| A computed KPI                  | Worked out on read from the board, its costs and its budget (see [Computed metrics](#computed-metrics)).                                                                      |
| An agent KPI                    | The value an agent reported, with the run and task it came from and an optional source link.                                                                                  |
| A person KPI                    | The value a person typed.                                                                                                                                                     |

## Routes

| Method | Path                                                        | Summary                                                |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------ |
| GET    | `/api/home`                                                 | One team's Home (`?teamId=`), or all teams without one |
| GET    | `/api/home/teams/:teamId/goals`                             | The team's goals with progress and cost                |
| POST   | `/api/home/teams/:teamId/goals`                             | Create a goal                                          |
| POST   | `/api/home/teams/:teamId/goals/reorder`                     | Put goals in a new order                               |
| GET    | `/api/home/teams/:teamId/goals/:goalId`                     | A goal's own page                                      |
| PATCH  | `/api/home/teams/:teamId/goals/:goalId`                     | Change a goal                                          |
| DELETE | `/api/home/teams/:teamId/goals/:goalId`                     | Archive a goal                                         |
| POST   | `/api/home/teams/:teamId/goals/:goalId/health`              | Set a goal's health, or clear it                       |
| GET    | `/api/home/teams/:teamId/goals/:goalId/updates`             | A goal's updates, newest first                         |
| POST   | `/api/home/teams/:teamId/goals/:goalId/updates`             | A person writes an update, published at once           |
| POST   | `/api/home/teams/:teamId/updates/:updateId/publish`         | Publish a draft, edited first if the body says so      |
| POST   | `/api/home/teams/:teamId/updates/:updateId/discard`         | Discard a draft                                        |
| GET    | `/api/home/teams/:teamId/kpis`                              | Active and suggested KPIs with their readings          |
| POST   | `/api/home/teams/:teamId/kpis`                              | Define a KPI                                           |
| PATCH  | `/api/home/teams/:teamId/kpis/:kpiId`                       | Change a KPI                                           |
| DELETE | `/api/home/teams/:teamId/kpis/:kpiId`                       | Archive a KPI                                          |
| POST   | `/api/home/teams/:teamId/kpis/:kpiId/accept`                | Accept an agent's suggestion, with edits               |
| POST   | `/api/home/teams/:teamId/kpis/:kpiId/dismiss`               | Dismiss an agent's suggestion                          |
| GET    | `/api/home/teams/:teamId/kpis/:kpiId/values`                | A KPI's stored values, newest first                    |
| POST   | `/api/home/teams/:teamId/kpis/:kpiId/values`                | A person types a value (person-source KPIs only)       |
| GET    | `/api/home/teams/:teamId/pages`                             | The team's pages                                       |
| POST   | `/api/home/teams/:teamId/pages`                             | Create a page                                          |
| GET    | `/api/home/teams/:teamId/pages/:pageId`                     | A page with its newest words                           |
| PATCH  | `/api/home/teams/:teamId/pages/:pageId`                     | A new revision, or a new goal link                     |
| DELETE | `/api/home/teams/:teamId/pages/:pageId`                     | Archive a page                                         |
| GET    | `/api/home/teams/:teamId/pages/:pageId/revisions`           | Revisions newest first, without their words, paged     |
| GET    | `/api/home/teams/:teamId/pages/:pageId/revisions/:revision` | One revision with its words                            |
| POST   | `/api/home/teams/:teamId/pages/:pageId/revert`              | A new revision that copies an old one                  |
| POST   | `/api/home/teams/:teamId/pages/:pageId/pin`                 | Pin or unpin a page on Home                            |
| GET    | `/api/home/teams/:teamId/settings`                          | The team's Home settings                               |
| PUT    | `/api/home/teams/:teamId/settings`                          | Turn the lead-written status line on or off            |
| POST   | `/api/home/teams/:teamId/weekly-updates`                    | Turn on weekly updates (makes a team routine)          |

A goal, update, KPI or page of another team answers `404`, the same as one that does not exist. A team that does not exist answers `404` with `"error": "team_not_found"`. With [roles](/guides/sso-proxy) enforced, reads need `see`, writes need `work`, the settings write needs an owner or operator, and turning on weekly updates needs `setup`. A guest reaches only the teams their token lists, and the all-teams read shows only those.

## Errors

A refused write answers `{ "ok": false, "error": "<code>" }`:

| Status | Codes                                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid` (a body field, or a query or path number that is not a whole number in range), `empty`, `too_long`, `invalid_parent`, `parent_has_parent`, `goal_has_children`, `goal_other_team`, `wrong_source` |
| 403    | `person_only`                                                                                                                                                                                               |
| 404    | `team_not_found`, `goal_not_found`, `update_not_found`, `kpi_not_found`, `page_not_found`, `revision_not_found`                                                                                             |
| 409    | `goal_archived`, `not_draft`, `not_suggested`, `not_active`, `archived`, `too_many`, `lead_cannot_write`                                                                                                    |

`too_many` is a limit: 100 goals and 60 KPIs a team (not counting archived ones), 10 suggestions waiting at once, 5 drafts waiting on one goal (each agent holds at most one, rewritten in place), and 100 values a KPI takes in a rolling day. Pages limit agents only, so a person is never stopped from editing or reverting one: an agent may not start a page once the team has 300 (not counting archived ones), nor more than 10 new pages a day, nor add a revision to a page that has 200, nor more than 6 revisions to one page in an hour. `lead_cannot_write`: see [Settings and weekly updates](#settings-and-weekly-updates).

---

## GET /api/home

One team's Home with `?teamId=<id>`, or all teams with no team (or `teamId=all`).

```bash
curl "http://127.0.0.1:18790/api/home?teamId=TEAM_ID"
```

The answer is `{ "scope": "team", "home": TeamHome }` or `{ "scope": "all", "home": AllTeamsHome }`:

```ts
TeamHome {
  team: { id, name, icon, color, leaderAgentId }
  asOf: number
  status: StatusLine        // see "The status line"
  settings: { leadWritesStatus: boolean, leadCanWriteStatus: boolean,
              leadCannotWriteReason: string | null,
              weeklyUpdatesRoutineId: string | null }
  needsYou: {
    total: number           // tasks + approvals + drafts + suggestions
    tasks: Array<{ taskId, identifier, title, teamId, reason }>   // the Board's reasons
    approvals: number
    questions: number       // already among `tasks`, as reason 'question'
    draftUpdates: Array<{ updateId, goalId, goalTitle, teamId, author, createdAt }>
    suggestedKpis: Array<{ kpiId, name, teamId, goalId, suggestedBy, note, createdAt }>
  }
  goals: GoalSummary[]      // active goals, by position
  kpis: KpiTile[]           // active KPIs, by position
  inFlight: Array<{ taskId, identifier, title, status, goalId, leadAgentId,
                    subtaskCount, subtasksDone, createdAt, updatedAt }>   // open requests
  spend: { last7DaysUsd, last30DaysUsd, includesEstimates,
           budget: { limitUsd, spentUsd, mode, status } | null }
  routines: Array<{ id, name, target, agentId, nextRunAt, status }>       // the next 5
  pinnedPages: TeamPage[]
  recentFiles: Array<{ taskId, taskIdentifier, taskTitle, path, sizeBytes, modifiedAt }>
}

AllTeamsHome {
  asOf: number
  teams: Array<{ team, status, goals: GoalSummary[], kpis: KpiTile[],   // the first 3 KPIs
                 needsYouCount: number, spend }>
  totals: { requestsInFlight, needsYou, doneLast7Days, spentLast7DaysUsd,
            goalsActive, goalsAtRisk, goalsOffTrack }
  needsYou: NeedsYou        // across every team
}
```

`recentFiles` lists up to 8 files from the top of the folders of the team's 8 most recently changed tasks (`<team folder>/tasks/<task id>`), the most recently modified first. Each folder's first 40 entries in name order (folders first) are read, so a folder with more entries can hold a newer file than the ones listed. Open one with `GET /api/board/:taskId/folder/file?path=`. A folder that is gone or unreadable is skipped. Worktree checkouts are not listed.

### The status line

```ts
StatusLine {
  text: string
  source: 'computed' | 'lead'
  asOf: number
  author: { kind, id, name } | null   // the lead, for a written line
  executionId: string | null
  model: string | null                // what the lead's registry row says it runs
  facts: { requestsInFlight, needsYou, doneLast7Days, spentLast7DaysUsd,
           budgetLimitUsd, budgetSpentUsd }
}
```

By default the line is computed from `facts`, for example "2 requests in flight, 1 needs you, 3 done this week, $12 of $60 spent." A team can turn on a line its lead writes ([settings](#settings-and-weekly-updates)). Each ask is a model call, so it is off until a person turns it on, and the asks keep to limits that waste none. Every 15 minutes Clawboo looks at the teams that turned it on and asks the lead for a line in the team chat (it shows as "Routine · Home status line") only when the team's board moved past every point already seen: where it stood when the line was turned on, at the last ask, and at the last line. An untouched board is never asked about. Asks and lines share one clock: at most one every 6 hours, counting both, and at most 4 asks in a rolling day. The lead answers with the `write_home_summary` tool, and a line that answers the ask always lands. A line the lead writes unasked keeps to the same board and clock rules. A lead that cannot hold the tool (see `leadCannotWriteReason` in [settings](#settings-and-weekly-updates)) is never asked, even if the lead changed after the line was turned on. An ask that fails to post (a pause covers the team, or the engine is down) is taken back, so the next pass asks again instead of waiting out the clock. A written line older than a day gives way to the computed one.

## Goals

```ts
TeamGoal {
  id, teamId
  parentGoalId: string | null      // one level only; same team
  title: string                    // 1 to 200 characters
  description: string              // markdown, up to 20,000 characters
  owner: { kind: 'person' | 'agent', id, name } | null
  targetDate: number | null
  status: 'active' | 'done' | 'dropped'
  health: 'on_track' | 'at_risk' | 'off_track' | null
  healthSetBy, healthSetAt
  updateCadenceDays: number        // 1 to 365, default 7
  position: number
  createdBy, createdAt, updatedAt
  archivedAt: number | null
}

GoalSummary {
  goal: TeamGoal
  progress: { total, done, doneChecked, addedLast7Days, doneLast7Days }
  cost: { usd, includesEstimates }
  lastUpdateAt: number | null      // the newest published update
  updateMissing: boolean           // active, and none published within updateCadenceDays
  draftCount: number
  childCount: number
}
```

A task's goal is its own `goalId`, else the nearest goal up its parent chain, which is its request's when nothing between names another. Every create copies the parent's goal down when the task is made, and work filed before its request had a goal is read as its request's. A task only serves a goal of its own team: a goal of another team counts as none.

- `GET .../goals` lists the team's goals that are not archived, whatever their status (active, done and dropped), as `{ "goals": GoalSummary[] }`; `?includeArchived=true` adds archived ones. The team's Home (`GET /api/home`) shows only the active ones.
- `POST .../goals` takes `{ title, description?, parentGoalId?, owner?, targetDate?, updateCadenceDays? }` and answers `{ "goal": TeamGoal }`.
- `PATCH .../goals/:goalId` takes any of those fields and `status`. A parent must be a goal of the same team that is not archived and has no parent itself; a goal with child goals cannot take a parent.
- `DELETE .../goals/:goalId` archives the goal. Its tasks keep their link; its child goals lose their parent; its open drafts are discarded, so they leave Needs you.
- `POST .../goals/:goalId/health` takes `{ "health": "on_track" | "at_risk" | "off_track" | null }`. Each change is recorded.
- `POST .../goals/reorder` takes `{ "goalIds": string[] }`: those first, in that order; the rest keep their order after them.

`GET .../goals/:goalId` answers `{ "goal": GoalDetail }`:

```ts
GoalDetail {
  summary: GoalSummary
  parent: { id, title } | null
  children: GoalSummary[]
  healthHistory: Array<{ health, setBy, setAt, updateId }>   // newest first
  tasks: Array<{ taskId, identifier, title, status, isMainTask, assigneeAgentId, costUsd,
                 checked: boolean | null, linkedVia: 'own' | 'request' | 'parent',
                 dropped, createdAt, completedAt }>
  kpis: KpiTile[]          // the goal's own KPIs
  updates: GoalUpdate[]    // drafts, published and discarded, newest first
  pages: TeamPage[]        // pages linked to the goal
}
```

### Linking tasks to goals

`POST /api/board` and `PATCH /api/board/:taskId` take `goalId`: a goal of the task's own team, or `null` for none. Another team's goal answers `400` with `"error": "goal_other_team"`. Changing a task's goal is a person's write (on `POST`, a `goalId` from a caller that is not a person is ignored and the task takes its parent's goal). `null` takes the task off every goal, its request's included, and the work under it with it. When a task's goal changes, the work under it that still carried the old goal moves to the new one; work a person put on another goal stays there. A person's team chat message (`POST /api/teams/:id/chat`) can carry `goalId` too: the request's main task, and the work filed under it, serve that goal. Board task rows (`GET /api/board`, `GET /api/board/:taskId`, and the task a create or patch returns) and board change frames carry the stored `goalId` and the goal the task counts toward: `effectiveGoalId`, with `goalLinkedVia` `own`, `request` or `parent` (the goal page's `linkedVia`). A subtask or hand-off made under a request that has a goal stores that goal as its `goalId`. Work filed before its request had a goal keeps a null `goalId` and has `effectiveGoalId` set through the request, so a goal chip and a "No goal" filter read `effectiveGoalId`.

## Goal updates

```ts
GoalUpdate {
  id, goalId, teamId
  body: string                     // markdown, up to 20,000 characters
  health: 'on_track' | 'at_risk' | 'off_track' | null
  author: { kind, id, name } | null
  executionId: string | null       // the run that drafted it
  state: 'draft' | 'published' | 'discarded'
  publishedBy, publishedAt, createdAt
}
```

Agents draft updates with `draft_goal_update`. Each agent holds at most one open draft on a goal: drafting again rewrites it in place (its words, health, run and time), so the table does not grow with each draft. Publishing an update that names a health sets the goal's health, recorded as set by the person who published it.

- `POST .../goals/:goalId/updates` takes `{ body, health? }`: a person's own update, published at once. Answers `{ update, goal }`; an archived goal answers `409 goal_archived`.
- `POST .../updates/:updateId/publish` takes `{ body?, health? }` to edit before publishing. Answers `{ update, goal }`; a draft that is not a draft any more answers `409 not_draft`, and a draft on an archived goal `409 goal_archived`.
- `POST .../updates/:updateId/discard` answers `{ update }`.

## KPIs

```ts
TeamKpi {
  id, teamId, goalId: string | null
  name: string
  unit: string                    // free text: '', '$', '%', 'signups'
  direction: 'up' | 'down'        // which way is better
  target: number | null
  period: 'week' | 'month' | 'quarter' | 'all'   // the last 7, 30 or 90 days, or all time
  source: 'computed' | 'agent' | 'person'
  metric: string | null           // computed only; see below
  reporterAgentId: string | null  // agent only: who may report; null means any agent on the team
  staleAfterHours: number | null  // agent and person only
  status: 'active' | 'suggested' | 'archived'
  suggestedBy, suggestionNote     // for a KPI an agent suggested
  createdBy, position, createdAt, updatedAt
}

KpiTile {
  kpi: TeamKpi
  reading: {
    value: number | null
    asOf: number | null
    source: 'computed' | 'agent' | 'person'
    periodStart: number | null    // computed only
    latest: KpiValue | null       // the stored value behind an agent or person reading
    freshness: 'ok' | 'stale' | 'missing'
  }
}

KpiValue { id, kpiId, value, asOf, reportedBy, executionId, taskId, sourceUrl, note, createdAt }
```

A reading is `stale` when its value is older than `staleAfterHours`, and `missing` when there is no value yet. A computed reading is always `ok`, with `asOf` the time of the read. An agent or person reading uses only values from the KPI's current source, by who reported them: a person's values for a `person` KPI, an agent's for an `agent` one. So after its source changes, a KPI reads `missing` until the new source reports. Its value history keeps every value.

- `GET .../kpis` answers `{ "kpis": KpiTile[] }`: active and suggested (`?includeArchived=true` adds archived).
- `POST .../kpis` takes `{ name, source, unit?, direction?, target?, period?, metric?, goalId?, reporterAgentId?, staleAfterHours? }`. A computed KPI needs a `metric`; a reporter must be an agent on the team. Answers `{ "kpi": KpiTile }`.
- `PATCH .../kpis/:kpiId` takes the same fields. `DELETE` archives it.
- `POST .../kpis/:kpiId/accept` takes the same fields as edits and makes a suggestion active; `dismiss` archives it.
- `POST .../kpis/:kpiId/values` takes `{ value, asOf?, note?, sourceUrl? }`, only for an active KPI whose source is `person`. A source link must start with `http://` or `https://`. Answers `{ value, kpi }`.
- `GET .../kpis/:kpiId/values?limit=` answers `{ "values": KpiValue[] }`, newest first. `limit` is a whole number from 1 to 1,000 (default 100); anything else answers `400 invalid`.

### Computed metrics

Worked out on read, for the KPI's team and period. Three read the state now and ignore the period.

| Metric                 | What it counts                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| `tasks_done`           | Tasks moved to Done in the period, not counting requests' own cards            |
| `tasks_checked_done`   | Of those, the ones whose check passed                                          |
| `requests_done`        | People's requests (main tasks) finished in the period                          |
| `spend_usd`            | The team's agents' recorded run costs in the period                            |
| `budget_used_pct`      | The team budget's spend over its limit, as a percent, now; null with no budget |
| `run_success_rate`     | Finished runs of the team's tasks that succeeded, as a percent; null with none |
| `needs_you_count`      | The team's tasks waiting on a person now                                       |
| `median_hours_to_done` | Median hours from created to Done, for tasks done in the period                |
| `open_requests`        | People's requests still open now                                               |

## Pages

```ts
TeamPage {
  id, teamId, goalId: string | null
  title: string
  pinned: boolean
  archivedAt: number | null
  createdAt, updatedAt
  revision: number                 // the newest
  updatedBy: { kind, id, name } | null
}

TeamPageRevisionMeta { id, pageId, revision, title, bodyChars, author, executionId,
                       revertedFrom: number | null, createdAt }
TeamPageRevision = TeamPageRevisionMeta & { body: string }
```

Every edit is a new revision; nothing is overwritten, and the same words again make none. A body a person writes holds up to 200,000 characters; one an agent writes, 50,000. An agent writes pages with `write_page`, inside the agent limits under [Errors](#errors), and a person can always revert its revision: no limit applies to a person's edits or reverts.

- `GET .../pages` answers `{ "pages": TeamPage[] }` (`?goalId=` for one goal's, `?includeArchived=true`).
- `POST .../pages` takes `{ title, body?, goalId?, pinned? }` and answers `{ "page": TeamPage & { body } }`.
- `GET .../pages/:pageId` answers `{ "page": TeamPage & { body } }`.
- `PATCH .../pages/:pageId` takes `{ title?, body?, goalId? }`. A new title or body makes a new revision; a goal change alone makes none. An archived page answers `409 archived`.
- `GET .../pages/:pageId/revisions?before=&limit=` answers `{ revisions: TeamPageRevisionMeta[], nextBefore: number | null }`: revisions newest first without their words, up to `limit` (default 50, at most 200) numbered below `before`. Pass `nextBefore` as `before` for the next page; it is null on the last one.
- `GET .../pages/:pageId/revisions/:revision` answers `{ "revision": TeamPageRevision }` with its words, or `404 revision_not_found`.
- `POST .../pages/:pageId/revert` takes `{ "revision": number }` and makes a new revision with that one's title and body.
- `POST .../pages/:pageId/pin` takes `{ "pinned": boolean }`. `DELETE` archives the page and unpins it.

## Settings and weekly updates

### GET /api/home/teams/:teamId/settings

Answers `{ "settings": { leadWritesStatus: boolean, leadCanWriteStatus: boolean, leadCannotWriteReason: string | null, weeklyUpdatesRoutineId: string | null } }`. `leadCanWriteStatus` is false when the team's lead cannot write the line, because it is never offered `write_home_summary`, and `leadCannotWriteReason` says why (null when it can):

| Reason            | The team's lead                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `no_lead`         | There is none.                                                                                                             |
| `openclaw_lead`   | An OpenClaw agent. Its Tasks tools carry no identity, so they never include Home's writes.                                 |
| `tasks_read_only` | A Clawboo Native agent whose Tasks access is read (the default for Clawboo Native). A read-only session serves reads only. |
| `tasks_off`       | A Clawboo Native agent with Tasks access off.                                                                              |

Codex, Claude Code and Hermes leads get a signed Tasks session bound to them on every team run, so they can write it.

### PUT /api/home/teams/:teamId/settings

Takes `{ "leadWritesStatus": boolean }`. Turns the lead-written [status line](#the-status-line) on or off for the team; each change is in the [audit log](/reference/rest-api/governance). Turning it on for a team whose lead cannot write it answers `409` with `"error": "lead_cannot_write"`. Turning it on records where the board stands, and the first ask waits for the board to move past it.

### POST /api/home/teams/:teamId/weekly-updates

Makes a normal team [routine](/reference/rest-api/schedules), "Weekly goal updates", on Mondays at 09:00 in the routines' time zone. It asks the team's lead to call `draft_goal_update` for each active goal. The drafts wait on Home and count in Needs you. Answers `{ routineId, settings, created }`; calling it again returns the routine it made (`created: false`) while that routine exists. Pause, change or delete it from Routines like any other.

## Related

- [MCP tools: Home tools](/reference/mcp-tools#home-tools)
- [Board API](/reference/rest-api/board)
- [Schedules API](/reference/rest-api/schedules)
- [Events and errors](/reference/events-and-errors)
