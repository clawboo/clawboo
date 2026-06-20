import type { RuntimeEvent } from './runtime-event'

/** Known runtime ids (open set — any string is valid; these are autocomplete hints). */
export type RuntimeId = 'openclaw' | 'claude-code' | 'codex' | 'hermes' | (string & {})

/**
 * Who executes the work behind an adapter. Almost always an automated agent
 * runtime today; `'human'` is a reserved seam so a person can later be a
 * first-class task assignee / delegation target / approver behind the SAME
 * interface. Nothing branches on this in the current code — it exists so the
 * trait, the board's assignee model, and the lifecycle stream never bake in
 * "executor == automated agent".
 */
export type ParticipantKind = 'agent' | 'human'

/**
 * How a runtime composes with the host: a per-run spawned one-shot worker, a
 * long-lived connected substrate the host drives over its live connection
 * (e.g. the OpenClaw Gateway), or a host-native participant. Omitted ⇒
 * 'wrapped-oneshot' (the conservative spawn path).
 */
export type RuntimeClass = 'wrapped-oneshot' | 'connected-substrate' | 'native'

/**
 * A runtime's CLAIM about the home dir it accrues state in. The HOST decides
 * where that home actually lives — adapters stay pure and never compute paths.
 */
export interface NativeHomeClaim {
  /** Keyed by runtime-side identity (one stable home per agent) or per run. */
  scope: 'per-identity' | 'per-run'
  /** Whether the home must outlive the run (skills/memory compound across runs). */
  persist: boolean
}

export interface Capabilities {
  /** Emits incremental text deltas (vs. a single whole-message at turn end). */
  streaming: boolean
  /** Can discover / call MCP tool servers. */
  mcp: boolean
  /** Runs work in isolated git worktrees. */
  worktrees: boolean
  /** Can resume a prior session from a serialized handle. */
  resume: boolean
  /** Surfaces tool-approval gates the host must resolve. */
  toolApproval: boolean
  /** Model identifiers this runtime can use (may be empty when unknown). */
  models: string[]
  /**
   * The runtime's context window in tokens, when known. Drives the proactive
   * session-rotation watermark (rotate before the window fills). Omitted/0 ⇒ the
   * watermark is inert and rotation fires only on an explicit `max_turns` signal.
   */
  contextWindowTokens?: number

  // ── Native-preservation seam ──────────────────────────────────────────────
  // Declares which native powers a runtime carries so the host routes it to the
  // right integration depth BY CONSTRUCTION (`resolveRuntimeIntegration`), never
  // by branching on runtime ids. All optional: a third-party adapter that omits
  // the seam compiles unchanged and resolves to the conservative one-shot
  // defaults — absence of a claim never preserves AND never strips anything
  // beyond what the plain one-shot path already does.

  /** Integration depth. Omitted ⇒ 'wrapped-oneshot'. */
  runtimeClass?: RuntimeClass
  /** Home-dir claim — the host materializes the actual path. */
  nativeHome?: NativeHomeClaim
  /** Native on-disk skills survive across runs ('preserve') or not ('none'). */
  nativeSkills?: 'preserve' | 'none'
  /** Native on-disk memory survives across runs ('preserve') or not ('none'). */
  nativeMemory?: 'preserve' | 'none'
  /** The runtime's own delivery channels ('gateway' = its live connection). */
  nativeChannels?: 'gateway' | 'none'
  /**
   * Runtime ships its own scheduler / cron / heartbeat. INFORMATIONAL ONLY —
   * the host's scheduler always owns when-to-run for teammate dispatch;
   * `resolveRuntimeIntegration` never lets a native scheduler co-run.
   */
  nativeScheduler?: boolean
}

export interface HealthResult {
  ok: boolean
  message?: string
}

/**
 * The unit of work a run executes. `taskId` / `teamId` reference the durable
 * board when board-backed; both optional so an adapter can also run ad-hoc.
 */
export interface TaskHandle {
  taskId?: string | null
  teamId?: string | null
}

export interface StartOpts {
  /** The runtime-side actor this run targets (e.g. an OpenClaw agentId). */
  agentId: string
  /** The session this run belongs to (e.g. an OpenClaw sessionKey). */
  sessionKey: string
  /** The instruction/message that starts the run. */
  message: string
  /** Optional model override for this run. */
  model?: string | null
  /** Optional context block(s) delivered alongside the message. */
  context?: string | null
  /**
   * Tools a child run must NOT use (e.g. no recursive delegation). Advisory for
   * runtimes that can't restrict tools per-run; the host ALSO enforces the real
   * guarantee out-of-band (e.g. a board spawn-depth ceiling).
   */
  childToolBlocklist?: string[]
}

/**
 * Handle to a live run. `runId` is late-bound: a runtime often does not return
 * its run id synchronously from `start()` — it arrives on the first lifecycle
 * frame — so callers begin with `runId: null` and read it once events flow.
 */
export interface RunHandle {
  readonly adapterId: string
  readonly sessionKey: string
  runId: string | null
}

/** Optional serialize/restore of a run's session for resume. */
export interface SessionCodec {
  serialize(run: RunHandle): Promise<string>
  restore(blob: string): Promise<RunHandle>
}

/**
 * One interface over every runtime. Adapters wrap a black-box runtime and
 * normalize its native signals into the `RuntimeEvent` stream — clawboo's hot
 * path is supervision + relay + UI, so we wrap runtimes, we do not reimplement
 * their loops.
 */
export interface RuntimeAdapter {
  readonly id: RuntimeId
  readonly participantKind: ParticipantKind
  capabilities(): Capabilities
  health(): Promise<HealthResult>
  start(task: TaskHandle, opts: StartOpts): Promise<RunHandle>
  /**
   * Normalized lifecycle stream for `run.sessionKey`. Implementations yield
   * RuntimeEvents and re-bind `run.runId` from the first frame of each run.
   *
   * For long-lived sessions (e.g. a Gateway team session that hosts many runs)
   * this is a CONTINUOUS observer: it keeps yielding across successive runs;
   * `done` / `error` are yielded as events but do not necessarily end the
   * stream. The consumer terminates observation explicitly (`break` /
   * `iterator.return()`), which releases the underlying subscription. For
   * one-shot runtimes (a single CLI process) the stream naturally ends when the
   * process exits. Either way the consumer drives termination.
   */
  events(run: RunHandle): AsyncIterable<RuntimeEvent>
  abort(run: RunHandle): Promise<void>
  setModel(run: RunHandle, model: string): Promise<void>
  writeContext(run: RunHandle, key: string, value: string): Promise<void>
  readonly sessionCodec?: SessionCodec
  dispose?(): Promise<void>
}
