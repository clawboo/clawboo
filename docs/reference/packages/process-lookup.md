---
title: '@clawboo/process-lookup'
description: 'Resolve a TCP port to the PID listening on it, cross-platform: the shared lsof/netstat lookup behind clawboo stop and the managed-Gateway control.'
---

- **Version** 0.1.0 · **Purity** server-only (shells out via `node:child_process`)
- **Purpose** Answer "which process is listening on this port?" on POSIX and Windows, safely enough that the answer can be handed to `process.kill`.
- **Workspace deps** none
- **External deps** none (Node built-ins only)

<Note>
Server-only, and deliberately so: it spawns `lsof` (POSIX) or `netstat` (Windows). It exists because two callers that cannot import each other need the same answer — the `clawboo` CLI's [`stop` / `restart`](/reference/cli#clawboo-stop) and the dashboard server's managed-Gateway control (`stopGateway`, [`POST /api/system/gateway`](/reference/rest-api/system)). Each carried its own copy until the copies started to matter.
</Note>

<Warning>
Both callers feed the result to `process.kill`, so a wrong answer force-kills an innocent process. Treat the three hardening details below as load-bearing, not incidental, and keep the parsers' test coverage if you change them.
</Warning>

## Public API

All exports come from the single `.` barrel (`src/index.ts`). No subpath exports.

### Functions

| Export            | Signature                                          | Contract                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findListenerPid` | `(port: number) => number \| null`                 | The PID **listening** on `port`, or `null` when it cannot be determined: nothing is listening, the tool is absent (`lsof` is missing from Alpine and some hardened images), or the socket belongs to another user and is invisible. Never throws. |
| `parseLsofPids`   | `(stdout: string) => number[]`                     | Pure. Parse `lsof -t` output (one PID per line) into deduped PIDs in output order. A dual-stack listener (`0.0.0.0` + `::`) reports the same PID twice, so the dedupe makes the result a list of processes rather than of sockets.                |
| `parseNetstatPid` | `(stdout: string, port: number) => number \| null` | Pure. Parse `netstat -ano` for the PID listening on `port`. Reads the **local** address column specifically, prefers an explicit `LISTENING` row, and falls back to the locale-independent listener signature described below.                    |

### The three details that matter

1. **`-sTCP:LISTEN` on POSIX.** The command is `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`. Plain `lsof -i :PORT` also matches _connected_ sockets, so a browser tab open on the dashboard appears in that output and taking the first line can return the browser's PID. `-n` / `-P` additionally skip DNS and `/etc/services` lookups, because a stalled resolver would block this synchronous call.
2. **A raised `maxBuffer` for `netstat -ano`.** Node's 1 MB default throws `ENOBUFS` on a host with thousands of connections, and the surrounding catch would silently turn that into "no process found".
3. **A locale-independent listener fallback.** `netstat.exe` translates its state column (`ABHÖREN` on German Windows, `À L'ÉCOUTE` on French), so an English-only `LISTENING` match finds nothing there. When no `LISTENING` row matches, a row whose local address is the port **and** whose foreign address is the all-zero placeholder (`0.0.0.0:0` / `[::]:0`) is accepted — the structural signature of a listening socket, which no locale translates. The PID is read as the last column, which survives a localized state string containing a space.

## Why a package rather than a copy in each app

`apps/cli` and `apps/web/server` are separate build targets and neither may import the other, so shared logic belongs in a `@clawboo/*` package. That matters more here than for most shared code: a fix applied to one copy and not the other is a bug that only manifests on one surface, and the failure mode is force-killing the wrong process.

## Testing

`src/__tests__/processLookup.test.ts` covers the parsers against realistic `netstat -ano` and `lsof -t` fixtures — including a localized (`ABHÖREN`) row, a space-bearing French state string, IPv6 local addresses, CRLF output, UDP rows on the same port, prefix collisions (`:187890` must not match `:18789`), and a synthetic `LISTENING` row whose _foreign_ address is the target port, which is the only shape that isolates the local-address column check. `findListenerPid` itself is not unit-tested; it spawns real tools, and its behavior is covered by the CLI's end-to-end `stop` / `restart` scenarios.

## See also

- [CLI reference](/reference/cli#clawboo-stop), `clawboo stop` and `clawboo restart`
- [System API](/reference/rest-api/system), `POST /api/system/gateway` (the managed-Gateway lifecycle)
- [Packages overview](/reference/packages/index), the full dependency graph and build order
