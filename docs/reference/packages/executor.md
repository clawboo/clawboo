---
title: 'Write a runtime adapter'
sidebarTitle: 'Write an adapter'
description: 'Build a runtime adapter on @clawboo/executor: declare honest capabilities, map native frames to RuntimeEvent, and pass the shared contract suite.'
keywords:
  [
    '@clawboo/executor',
    'executor',
    'RuntimeAdapter',
    'RuntimeEvent',
    'runAdapterContract',
    'contract suite',
    'tiers',
    'add a runtime',
  ]
---

`@clawboo/executor` is the package every runtime adapter builds on. An adapter starts a run on one runtime (a
coding CLI, an SDK, a long-lived connection) and turns that runtime's own output into the shared `RuntimeEvent`
stream that the task runner, the team engine and the dashboard read.

Use this page when you write the adapter package for a new runtime or change an existing one. The interface is
explained member by member in [The RuntimeAdapter trait](/internals/runtime-adapter). Wiring a finished adapter
into the server is the [Add a runtime](/internals/runtime-adapter#add-a-runtime) checklist.

## What you import

| Entry point                  | What an adapter author uses from it                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@clawboo/executor`          | `RuntimeAdapter`, `Capabilities` and the run types; the `RuntimeEvent` union; `createAsyncQueue`; `steerThroughDriver`; `withIdleTimeout`; the session-rotation helpers; `resolveRuntimeIntegration` |
| `@clawboo/executor/contract` | `runAdapterContract` and the `AdapterTestHarness` type. It imports vitest, so use it from tests only.                                                                                                |
| `@clawboo/executor/tiers`    | `assembleTiers`, `sortToolDefs` and `dateStamp`, which keep a prompt in cache-friendly order                                                                                                         |

The package has no dependencies and imports nothing from `node:*`. Keep your adapter the same way: it never spawns
a process or opens a socket. A driver on the server does that, and the adapter receives it as an injected factory,
or as a connected client in OpenClaw's case.

## Before you begin

- Know how the runtime runs without a person at the keyboard (an SDK call, a CLI with machine-readable output, a
  long-lived connection) and what it reports: text deltas, tool calls, token usage, cost.
- Read [Runtime adapters](/reference/packages/adapters) to see how the six existing adapters differ, and pick the
  closest one to copy. For a CLI or an SDK that runs once per task, that is Claude Code, Codex or Hermes.

## Write the adapter

<Steps>

<Step title="Create the package">

Make `packages/adapters/<id>/` with `@clawboo/executor` as its only workspace dependency and vitest as a dev
dependency (the [Packages](/reference/packages/index) page has the full recipe). Export the adapter class, a type
for the runtime's native frames, and a pure function that maps one native frame to `RuntimeEvent[]`.

The per-run pattern keeps the adapter small. The constructor takes `(driverFactory, healthCheck?)`. `start()` calls
the factory once per run, the driver exposes `start()`, `onEvent(handler)` (returning an unsubscribe function),
`abort()`, `setModel()`, `writeContext()` and an optional `steer()`, and the adapter delegates to it.

</Step>

<Step title="Declare only true capabilities">

`capabilities()` tells the host what the runtime can do: `streaming`, `mcp`, `worktrees`, `resume`, `toolApproval`,
`models`, and optionally `steering`, `contextWindowTokens` and the integration fields (`runtimeClass`,
`nativeHome`, `nativeSkills`, `nativeMemory`, `nativeChannels`, `nativeScheduler`). The host routes on these through
`resolveRuntimeIntegration` and never on the runtime id. A missing claim is read conservatively: no `steering`
means `none`, and no `runtimeClass` means a one-shot run.

<Warning>

`toolApproval: true` says the runtime can ask before it uses a tool. It does not mean Clawboo's runs are gated:
Clawboo drives Claude Code, Codex and Hermes with their own approval prompts and sandboxes turned off. See
[What agents can do](/concepts/permissions) before you describe a runtime's safety anywhere.

</Warning>

</Step>

<Step title="Map native frames to RuntimeEvent">

There are seven event kinds: `text-delta` (with `channel` set to `assistant` or `reasoning`), `tool-call`,
`tool-result`, `status`, `cost`, `done` (reason `success`, `max_turns`, `aborted` or `error`) and `error` (with a
`fatal` flag). Every event carries `runId`, `sessionId`, `ts` and a strictly increasing `seq`. Follow these rules:

- `start()` returns `runId: null`. Bind the run id from the first native frame that carries one, and fall back to
  the session key.
- A runtime with no incremental text emits one `text-delta` that carries the whole message.
- Put provider USD in `costUsd` only when the runtime reports it. If it reports tokens but no price, send
  `costUsd: null`, `estimated: true` and the usage. If it reports neither, emit no `cost` event.
- Drop frames you do not recognise instead of throwing.
- End every run with `done`, or with an `error` whose `fatal` is `true`.

`createAsyncQueue` turns the driver's callback into the async iterable `events()` returns. It drops the oldest
event when full, and closing the iterator closes the queue, which is how `events()` releases its subscription.

</Step>

<Step title="Implement the control members">

- `abort()` cancels the run. The stream must still end with `done` (reason `aborted`); the contract suite checks
  it, and the host treats that event as the end of the run.
- `setModel()` and `writeContext()` reach the driver. A runtime that fixes its model at launch may treat
  `setModel()` as a no-op, as the Claude Code, Codex and Hermes drivers do.
- If you declare `steering`, implement `steer()` with `steerThroughDriver(driver, text, mode, opts)`. It returns
  `no-run` with no driver, `unsupported` when the driver has no `steer` or a passive message meets an
  `interrupt-resume` runtime, `run-ended` when the driver answers `false`, and `rejected` when it throws.
- If the runtime can resume a session, expose a `sessionCodec` that serializes the session id.

</Step>

<Step title="Pass the contract suite">

In the adapter's tests, build an `AdapterTestHarness` over a fake driver and call `runAdapterContract`. The harness
says how to make the adapter, start a run, emit a native frame, and list the side effects the adapter issued.

```ts
import { runAdapterContract, type AdapterTestHarness } from '@clawboo/executor/contract'

function makeHarness(): AdapterTestHarness {
  let driver = new FakeDriver()
  return {
    label: 'my-runtime',
    makeAdapter: () => {
      driver = new FakeDriver()
      return new MyRuntimeAdapter(() => driver)
    },
    start: (adapter) =>
      adapter.start({}, { agentId: 'a1', sessionKey: 'agent:a1:main', message: 'hi' }),
    emit: (frame) => driver.emit(frame as MyNativeFrame),
    frames: {
      delta: (text) => ({ type: 'text', text }),
      toolCall: (name, input) => ({ type: 'tool-call', id: 'tc-1', name, input }),
      final: (summary) => ({ type: 'result', ok: true, summary }),
      aborted: () => ({ type: 'result', ok: false, aborted: true, summary: '' }),
      error: (message) => ({ type: 'result', ok: false, errorMessage: message, summary: '' }),
    },
    recordedCalls: () => driver.calls,
  }
}

runAdapterContract(makeHarness())
```

The suite checks a stable id, a well-formed `capabilities()`, a `health()` that answers within two seconds, a
late-bound `runId`, increasing `seq`, a run that ends in `done: success` or `done: aborted`, and that `abort`,
`setModel` and `writeContext` reach the driver. Run it with `pnpm --filter @clawboo/adapter-<id> test`; you should
see a `RuntimeAdapter contract` block pass. Put runtime-specific tests in the same file.

</Step>

<Step title="Wire it into the server">

Follow the [Add a runtime](/internals/runtime-adapter#add-a-runtime) checklist. In short: a driver under
`apps/web/server/lib/runtimes/`, a descriptor entry, a case in `adapterFactoryFor()` with a health check, a
capability source, an agent source, an `AGENT_FILE_RUNTIME_SUPPORT` row, and the dashboard's runtime catalog.

</Step>

<Step title="Check it end to end">

Run `pnpm build` and `pnpm test`, start the dev server, and connect the runtime from the Runtimes panel. Create a
board task, then run it with `POST /api/runtimes/<id>/run` and a body of `taskId` plus `"kind": "research"`. A
`code` task (the default kind) also needs a `repoPath` for its worktree, or the run is refused with
`workspace_unavailable`. The request stays open until the run ends (see [Runtimes API](/reference/rest-api/runtimes)).
You should get a `200` response with `"ok": true` and a `doneReason`.

</Step>

</Steps>

## How the host treats your adapter

- **A fresh adapter per run.** The server builds one through `adapterFactoryFor(id)` for each run, so keep no
  cross-run state in the adapter. `RuntimeRegistry` is exported but the server does not use it.
- **Silence ends a run.** The task runner and the team engine wrap your stream in `withIdleTimeout`. Past the
  silence ceiling (`CLAWBOO_RUN_SILENT_TIMEOUT_MS`) the host calls `abort()` and waits a short grace period for
  your terminal event, then ends the stream itself.
- **Rotation needs a window.** With `contextWindowTokens` set, the task runner starts a successor session before
  the window fills. A `done` with reason `max_turns` triggers rotation too.
- **Missing cost is estimated.** A `cost` event with `costUsd: null` and usage is priced from the tokens and
  marked as an estimate. A run that reports no usage at all is estimated from the characters it was sent and
  produced, on task-runner runs and in team chat alike. A `cost` event with `local: true` marks a model the user's
  own Ollama served, and the host records it at $0. See [Budgets and spend](/using/budgets-and-spend) for what
  users see.
- **Some claims change the path.** A runtime that declares `runtimeClass: 'connected-substrate'` is refused by the
  task runner, and one that declares `worktrees: false` gets no task worktree.
- **Prompt order.** The task runner builds every prompt with `assembleTiers`, frozen content first. No Clawboo
  code reads the `cacheBreakpoints` it returns.

## Troubleshooting

<AccordionGroup>

<Accordion title="The contract block does not appear in the test output">

The suite registers its tests on the vitest the adapter package resolves, because the package keeps vitest
external. Add `vitest` to the adapter's `devDependencies`, run `pnpm install`, and call `runAdapterContract` from a
file that vitest collects (`src/__tests__/*.test.ts`).

</Accordion>

<Accordion title="A stopped run takes a long time to end">

After `abort()`, the stream must still yield `done` with reason `aborted`. Without it, the run ends only when the
silence ceiling closes the stream. If the driver drops its listeners on abort, synthesize that event in the
adapter.

</Accordion>

<Accordion title="Spend shows nothing for the new runtime">

The mapper emitted no `cost` event. Emit one with the token usage, even when the runtime reports no price.

</Accordion>

</AccordionGroup>

## Related

- [The RuntimeAdapter trait](/internals/runtime-adapter): every member and event kind explained.
- [Runtime adapters](/reference/packages/adapters): how the six existing adapters differ.
- [The executor runner](/internals/executor-runner): how a task run claims, isolates, drives and verifies.
- [What agents can do](/concepts/permissions): the safety posture of each runtime.
- [Choose a runtime](/runtimes/index): the runtimes as users see them.
