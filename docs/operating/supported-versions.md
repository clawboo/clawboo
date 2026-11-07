---
title: 'Supported versions'
description: 'Which Clawboo versions work together: a server serves clients of its current and previous minor release. How a client checks, and what each surface offers.'
keywords:
  [
    'versions',
    'compatibility',
    'support window',
    'api revision',
    'capabilities',
    'feature flags',
    'desktop app',
    'phone',
  ]
---

More than the dashboard talks to a Clawboo server: the `clawboo` command, a desktop app that bundles the server, a reverse proxy in front of it, and apps on other devices. Use this page to know which versions work together and what each surface offers.

## The support window

A Clawboo server supports clients of its **current minor release and the previous one**. A 0.6.x server keeps every route, response field and stream event that a client built for 0.5.x or 0.6.x uses. A client built for 0.4.x is outside the window and should ask you to update one side.

- A patch release never removes or renames anything a client uses.
- When a route, field or event has to go, it goes in a minor release, and the server's API revision goes up by one. Adding a route, field, event or flag never changes the revision.
- A major release starts a new window: a 1.0 server serves 1.0 clients.

Security fixes ship only in the latest release (see [SECURITY.md](https://github.com/clawboo/clawboo/blob/main/SECURITY.md)), so update the server first when you can.

## How a client checks

1. Call `GET /api/system/capabilities` (see the [System API](/reference/rest-api/system)).
2. A `401` means the server has an access token: sign in first.
3. An answer that is not the capabilities JSON (a `404`, or the dashboard's HTML page) means the server is older than the route and reports no flags. Use only what that older release had, or ask the person to update the server.
4. Compare versions. The server promises to serve the client when the client's own `major.minor` is at least the answer's `supportFloor` and no newer than its `version`. Below the floor, ask the person to update the client. A client newer than the server gets no promise, and works only through the flags in the next step.
5. Before using an optional feature, check its flag in `features`. A flag that is missing counts as off: the server is older than the feature.

`apiRevision` adds one more check for a client that records the revision it was built against: when the server reports that same revision, nothing the client relies on has been removed or renamed, whatever the two versions are.

## What each surface offers

Every surface talks to the same server, so a feature the server has can reach every surface. The table tracks where each one can be used today.

- **npm install**: `npx clawboo` or `npm install -g clawboo`, with the dashboard in a browser on the same computer, or reached from another one as in [Reach Clawboo from another machine](/guides/self-host-securely).
- **Desktop app**: an app that runs this same server, unchanged, with its own Node.js. It is not available to download yet.
- **Phone web app**: the dashboard, installed to a phone's home screen. It does not exist yet. A phone browser can already open the dashboard through a reverse proxy, but the layout is made for a computer screen.

**Supported** means released on that surface. **Beta** means released, with behavior that may still change. **Planned** means not released on that surface yet.

| Feature                                             | Flag                                                                               | npm install                    | Desktop app | Phone web app |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------ | ----------- | ------------- |
| Clawboo Native agents                               | `runtime.clawboo-native`                                                           | Supported                      | Planned     | Planned       |
| Claude Code, Codex and Hermes agents                | `runtime.claude-code`, `runtime.codex`, `runtime.hermes`                           | Supported                      | Planned     | Planned       |
| OpenClaw agents                                     | `runtime.openclaw`                                                                 | Supported                      | Planned     | Planned       |
| Team chat and chat rooms                            | `chat.rooms`                                                                       | Supported                      | Planned     | Planned       |
| 1:1 chats                                           | `chat.direct`                                                                      | Supported                      | Planned     | Planned       |
| Board, with checks on finished work                 | `board.verification`, `board.checkHold`, `board.reportResult`, `board.parentWaits` | Supported                      | Planned     | Planned       |
| A person's inbox, with read state on the server     | `board.inbox`                                                                      | Supported                      | Planned     | Planned       |
| A person's request as one main task                 | `board.mainTasks`                                                                  | Supported                      | Planned     | Planned       |
| Comments that reach a running task                  | `board.steering`                                                                   | Supported                      | Planned     | Planned       |
| Readable task ids                                   | `board.readableIds`                                                                |
| Team labels on tasks                                | `board.labels`                                                                     |
| Agents that wake on what happens to their task      | `board.wakes`                                                                      | Supported                      | Planned     | Planned       |
| Agents waking each other, once you allow it         | `board.agentWakes`                                                                 | Supported                      |
| A job waits for a person at its limit of runs       | `board.jobLimit`                                                                   | Supported                      |
| Plans, and asking before one starts                 | `board.planDocuments`, `board.planApproval`                                        | Supported                      |
| Reopen, tasks for a person, questions to a person   | `board.reopen`, `board.personAssignees`, `board.questions`                         | Supported                      | Planned     | Planned       |
| The person check on person writes                   | `board.personCheck`                                                                | Supported                      | Planned     | Planned       |
| Workspace view and page preview                     | `workspace.view`, `workspace.preview`                                              | Supported                      | Planned     | Planned       |
| Agent browser screenshots                           | `agent.screenshots`                                                                | Supported                      | Planned     | Planned       |
| Shell commands for Clawboo Native agents            | `agent.nativeShell`                                                                | Supported                      | Planned     | Planned       |
| Routines                                            | `routines`                                                                         | Supported                      | Planned     | Planned       |
| Shared memory and similarity search                 | `memory`, `memory.embeddings`                                                      | Supported                      | Planned     | Planned       |
| Connectors, custom connectors and brokered apps     | `connectors`, `connectors.custom`, `connectors.broker`                             | Supported                      | Planned     | Planned       |
| Live streams that resume after a dropped connection | `stream.teamChat.resume`, `stream.agentChat.resume`, `stream.events.resume`        | Supported                      | Planned     | Planned       |
| Update from inside the app                          | `system.selfUpdate`                                                                | Supported for a global install | Planned     | Planned       |
| Names from a sign-in proxy's identity tokens        | `auth.proxyIdentity`                                                               | Supported, off by default      | Planned     | Planned       |

A flag being on means the server has the feature. It does not mean the surface you use shows it yet.

## Related

- [System API](/reference/rest-api/system): the `GET /api/system/capabilities` answer and every flag.
- [Deployment](/operating/deployment): running the server as a service, and updating it.
- [CLI reference](/reference/cli): the `clawboo` command, which checks the running server's version when it attaches.
