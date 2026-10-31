---
title: '@clawboo/governance'
sidebarTitle: 'governance'
description: 'The pure decision rules behind verification, budgets, delegation caps, circuit breakers and connector grants, and where each one is enforced.'
keywords:
  [
    '@clawboo/governance',
    'governance',
    'decideGrant',
    'grants',
    'connector grants',
    'budget math',
    'warn',
    'hard cap',
    'circuit breaker',
    'BREAKER_DEFAULTS',
    'verification verdict',
    'isVerdictPromotable',
    'lethal trifecta',
    'caps',
  ]
---

`@clawboo/governance` holds Clawboo's decision rules as pure functions and zod schemas, with no database, network
or `node:*` access. The board, the server and the SPA all import the same rules, so a badge on screen and the check
that enforces it cannot disagree. The state the rules decide over lives in [@clawboo/db](/reference/packages/db),
and the server applies the decisions.

Use this page when you change how Clawboo decides whether work passed verification, spend is over a budget, a
delegation goes too deep, a run is looping, or an agent may call a connector tool.

## What it decides

| Group (`src/`) | Decides                                                                | Main entry points                                                                                                                                     | Applied by                                                         |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `verify/`      | whether a task's work passed, judged by someone other than its builder | `verificationStatusFor`, `classifySeverity`, `nextCycleDecision`, `isVerdictPromotable`, `shouldRunCritic`, `parseVerifyCommand`, the verdict schemas | the server's verification gate and `updateStatus` in `@clawboo/db` |
| `budget/`      | a budget's status after spend                                          | `statusForSpend`, `budgetStatusAfter`, `softThresholdCents`, the cent conversions                                                                     | `recordSpend` in `@clawboo/db`                                     |
| `caps/`        | how deep and wide delegation may go, and a per-run cost ceiling        | `checkDepthCap`, `checkFanoutCap`, `checkCostCap`                                                                                                     | the board's capped create path, the team engine, the task runner   |
| `breaker/`     | when a run is looping or burning tokens                                | `createBreakerState`, `stepBreaker`, `toolSignature`, `breakerConfigSchema`                                                                           | the task runner                                                    |
| `grants/`      | whether an agent may call a connector tool                             | `decideGrant`, `requiredMode`, `isLethalTrifecta`, `isToolInScope`, `canonicalizeSpec`                                                                | the tool broker's grant gate in `@clawboo/db`                      |

## Budgets: warn is the default

The budget functions compute a status from a limit and the spend so far: `active`, `soft_capped` at the soft
threshold (`SOFT_CAP_PERCENT` of the limit), and `paused` at the limit. They do not decide whether `paused` stops
anything. That depends on the budget's mode, stored by `@clawboo/db`:

- **`warn`, the default.** Spend is tracked and warnings fire at the soft threshold and at 100%. A warn budget is
  stored as `soft_capped` even past its limit, so it never reads `paused` and never stops work.
- **`cap`, opt-in.** The budget pauses at 100%, and the task runner, team chat and one-to-one chat refuse to start
  work for a paused scope (`budget_paused`).

Spend is kept in micro-cents (`MICRO_CENTS_PER_CENT`), so sub-cent turns still add up. Which run paths a hard cap
can actually stop, and when, is explained in [Budgets and guardrails](/concepts/governance); the user's view is
[Budgets and spend](/using/budgets-and-spend).

## Caps

| Rule             | Default                                                                         | Where it applies                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `checkDepthCap`  | `DEFAULT_MAX_DEPTH` = 2                                                         | refuses a delegation once the ancestor depth reaches the limit; the board, the team engine and the task runner share this one constant |
| `checkFanoutCap` | `DEFAULT_MAX_CHILDREN` = 24                                                     | live children of one parent on the board's capped create path; the team engine applies it per turn with its own, smaller limit         |
| root-task rate   | `DEFAULT_MAX_ROOT_CREATES` = 30 per `DEFAULT_ROOT_CREATE_WINDOW_MS` (5 minutes) | new tasks with no parent, so a looping agent trips quickly and the limit clears itself                                                 |
| `checkCostCap`   | none                                                                            | a per-run cent ceiling the task runner applies only when the run input sets `maxNodeCents`                                             |

The caps are enforced in code below the model, whatever the prompt asks for. The full list of numbers is on
[Limits and defaults](/reference/limits-and-defaults).

## Circuit breakers

`createBreakerState(config)` makes a run-local accumulator, and `stepBreaker(state, signal)` feeds it one signal
taken from a typed `RuntimeEvent` (a tool call, a tool result, a cost, a policy denial) and returns the first trip
it sees. A trip names its reason: `iteration-cap`, `repeat-failure`, `no-progress`, `token-velocity` or
`repeat-policy-denied`. `toolSignature(name, input)` identifies a repeated call from its name and a hash of its
input, never from prose.

`BREAKER_DEFAULTS` holds the thresholds, and `POST /api/runtimes/<id>/run` accepts a partial `breakerConfig` that
`breakerConfigSchema` validates. Breakers run only on the task runner path, not in team chat.

## Verification

These rules judge one attempt at a task and decide what happens next. Which runs are verified at all (only
task-runner runs in a git worktree with changes to check) is explained in [How work is checked](/concepts/verification).

- **One attempt.** `verificationStatusFor(deterministic, critic)` returns `fail` when the verify command failed,
  `fail` when it passed but the critic found a blocking problem, and `pass` otherwise.
- **Blocking findings.** `classifySeverity` blocks on `security`, `crash`, `data_loss`, `wrong_algorithm` and
  `missing_ac`; every other finding is recorded as debt.
- **Retries.** `nextCycleDecision` retries a failed attempt until the attempts run out, then marks the work as
  completed with debt, which sends the task to a person. The server's attempt budget is `CLAWBOO_MAX_FIX_CYCLES`
  plus one (two attempts by default); the package's `DEFAULT_MAX_FIX_CYCLES` is not used by the server.
- **Moving to done.** `isVerdictPromotable` is the rule `updateStatus` applies to a stored verdict on the way to
  `done`: `pass` may move, and `completed_with_debt` may move only when the latest verify command passed. Any other
  verdict is refused unless a person overrides it. A task with no stored verdict was never checked, and it moves to
  `done` normally.
- **The critic.** `shouldRunCritic` runs the read-only reviewer for delegated work, a risk flag (no caller sets one),
  or a diff over the size threshold (`DEFAULT_CRITIC_THRESHOLD`).
- **The verify command.** `parseVerifyCommand` reads `VERIFY_CMD` from a task's `init.sh` and returns `null` for a
  missing value or the placeholder Clawboo writes.

## Connector grants

A grant says that an agent (or a team) may use one connector, in a mode, under an approval policy. It is both the
permission the broker checks and the edge the Org chart draws: the graph asks `decideGrant` the same question
through `previewGrant`, so the picture and the gate cannot disagree.

| Term            | Values                                                                            |
| --------------- | --------------------------------------------------------------------------------- |
| Grant state     | `proposed`, `active`, `suspended`, `revoked`, `expired`; only `active` authorizes |
| Mode            | `read`, `write`, `admin`, ranked in that order                                    |
| Approval policy | `never`, `risk`, `writes`, `always`                                               |
| Tool risk       | `safe`, `external`, `destructive`                                                 |
| Decision        | `allow`, `require_approval` or `deny`, each with a reason                         |

`decideGrant` checks a call in a fixed order, and the order matters:

<Steps>

<Step title="Find the grant and check its state">

No matching grant denies with `no-grant`. A revoked, suspended, proposed or expired grant denies, and expiry is
checked against the clock as well as the stored state.

</Step>

<Step title="Check for drift">

If the connector's spec or tool list changed since the grant pinned them, the call is denied (`spec-drift`).
This runs before the scope check, so a renamed or redefined tool is caught as drift.

</Step>

<Step title="Check scope, mode and rate">

The tool must match the grant's allow and deny patterns, the tool's required mode must not exceed the grant's
mode, and the grant's hourly call ceiling must not be reached.

</Step>

<Step title="Check the run's risk">

If the run's combined reach reads private data, ingests untrusted content and can send data out (the lethal
trifecta), or the run is tainted and can send data out, the call needs a person's approval. These approvals are
never remembered, and they run before the approval policy, so a policy of `never` cannot switch them off.

</Step>

<Step title="Apply standing rules and the policy">

A standing deny rule denies. A never-remember tool always asks, whatever the policy. A policy of `always` asks
next, even for a tool a standing allow rule covers, and marks the request never-remember. Otherwise a standing
allow rule allows, and then the policy decides: `writes` asks for a mutating tool, `never` allows, and `risk` asks
for a destructive tool or a mutating tool with external effects.

</Step>

</Steps>

The broker's grant gate in `@clawboo/db` calls `decideGrant` for every call to a connector tool, and charges the
hourly window in the same synchronous step as the decision. Clawboo's built-in tools are never grant-governed. Every
decision is recorded as a `grant_decision` event. How users attach a connector to an agent is on
[Connect tools to your agents](/using/connectors).

## Test it

Run `pnpm --filter @clawboo/governance test`. Each group has its own suite, and `grants/` tests the decision order
case by case. A change to `decideGrant` usually needs a matching case in the grant gate tests in `@clawboo/db`.

## Related

- [Budgets and guardrails](/concepts/governance): budgets, caps and breakers as a model, and which run paths have them.
- [How work is checked](/concepts/verification): when work is checked and what a verdict means.
- [@clawboo/db](/reference/packages/db): where budgets, grants and verdicts are stored.
- [Connect tools to your agents](/using/connectors): connecting a connector and granting it to agents.
- [Budgets and spend](/using/budgets-and-spend): warn only and hard cap as users set them.
