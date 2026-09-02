// Turn a pending tool call into something a person can actually decide about.
//
// THE PROBLEM. The card used to show the raw name, `mcp__composio__COMPOSIO_
// MULTI_EXECUTE_TOOL`, a sentence repeating that name, and a clipped JSON blob.
// Every word of that is addressed to whoever wrote the tool, and none of it to
// the person being asked to approve it. Someone reading it cannot tell whether
// they are about to let an agent read their inbox or email their whole address
// book, which is the one question a consent surface exists to answer.
//
// THREE RULES SHAPE THIS, and each one is a correction of an earlier draft.
//
// 1. THE REQUEST MAY DESCRIBE, ONLY THE SERVER MAY REASSURE. What a call claims
//    to do comes from arguments a model wrote. That is good enough to make a
//    sentence more specific and never good enough to make a card calmer, so a
//    request's own verb may RAISE how serious this looks and may never lower it.
//    Concretely: nothing here ever prints "reads only" for a brokered call. The
//    approval exists because the server judged the call to have external side
//    effects, and a slug beginning FETCH does not overrule that.
//
// 2. CLAWBOO SPEAKS IN THE HEADLINE; THE AGENT SPEAKS IN QUOTATION MARKS. The
//    broker's arguments carry a `current_step` field the model fills with a
//    plain-English description of its own intent. It is the most readable string
//    available and it is exactly what a prompt injection would target, so it is
//    never the headline. It appears once, quoted and attributed, below the fold.
//
// 3. A FIELD IS DECISIVE WHEN CHANGING ITS VALUE ALONE WOULD CHANGE WHO IS
//    AFFECTED, WHAT LEAVES THE MACHINE, OR WHAT IS DESTROYED. Decisive fields are
//    always visible without expanding anything. Hiding a recipient behind a
//    disclosure triangle is not tidiness, it is consent to something unseen.
//
// When any of this cannot be read, `confident` goes false and the caller shows
// the unvarnished truth instead. A confident-sounding guess is the one output
// this must never produce.

import { appForToolkit, BROKERED_TOOLKITS } from '@clawboo/connector-catalog'

/** How much damage this call could do, as clawboo is able to judge it. */
export type ActionClass = 'reads' | 'changes' | 'sends' | 'destroys' | 'unknown'

export interface Field {
  label: string
  value: string
}

export interface HumanizedApproval {
  /** One sentence, in the second person, naming the actor and the effect. */
  headline: string
  /** A short factual chip. Never reassuring, never a safety claim. */
  chip: string
  actionClass: ActionClass
  /** Rendered inline, always. See rule 3. */
  decisive: Field[]
  /** Rendered behind one disclosure. */
  remainder: Field[]
  /** The model's own words, to be shown quoted and attributed. */
  agentNote: string | null
  /** False when the request could not be read and raw detail must be shown. */
  confident: boolean
}

// VERBS ONLY, and matched as whole tokens.
//
// Both halves of that are load-bearing, and getting either wrong is not a
// cosmetic slip. `EMAIL` was briefly in the send list, which is a NOUN, and the
// match was a substring test, so `GMAIL_FETCH_EMAILS` read as a send: the card
// told an operator that an agent wanted to SEND something when it wanted to read
// their inbox, and offered them a red button labelled "Send it". A consent
// surface that misdescribes the action is worse than no consent surface, because
// the person now believes something false and has approved on that basis.
const DESTROY = new Set(['DELETE', 'REMOVE', 'TRASH', 'PURGE', 'DROP', 'REVOKE', 'ARCHIVE'])
const SEND = new Set(['SEND', 'POST', 'PUBLISH', 'REPLY', 'FORWARD', 'INVITE', 'SHARE', 'EMAIL'])
const CHANGE = new Set(['CREATE', 'UPDATE', 'PATCH', 'WRITE', 'ADD', 'SET', 'MOVE', 'RENAME'])
const READ = new Set([
  'FETCH',
  'GET',
  'LIST',
  'SEARCH',
  'READ',
  'FIND',
  'QUERY',
  'COUNT',
  'CHECK',
  'LOOKUP',
])

/** Argument names that decide WHO is reached. */
const RECIPIENT_KEYS = [
  'recipient_email',
  'recipient',
  'to',
  'to_email',
  'channel',
  'channel_id',
  'user_id',
  'email',
  'phone',
]
/** Argument names that decide WHAT is said or changed. */
const CONTENT_KEYS = ['subject', 'body', 'message', 'text', 'content', 'title', 'comment']
/** Argument names that decide WHAT is destroyed or written. */
const TARGET_KEYS = ['path', 'file', 'id', 'message_id', 'thread_id', 'issue_key', 'spreadsheet_id']
/**
 * Argument names that decide HOW MUCH is read.
 *
 * A read's decisive question is scope, not identity: `user_id: "me"` tells an
 * operator nothing, while "everything after 2026/08/30, up to 15 messages" tells
 * them exactly what is about to be handed to a model.
 */
const SCOPE_KEYS = [
  'query',
  'q',
  'label',
  'label_ids',
  'folder',
  'max_results',
  'limit',
  'count',
  'page_size',
  'include_payload',
  'verbose',
]

/** A short, readable rendering of one argument value. */
function show(value: unknown, max = 140): string {
  if (value === null || value === undefined) return ''
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

/** Title Case from a snake_case argument name. */
function labelFor(key: string): string {
  const word = key.replace(/_/g, ' ').trim()
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** The toolkit a Composio slug belongs to, longest match wins. */
function toolkitOf(slug: string): string | null {
  const upper = slug.toUpperCase()
  let best: string | null = null
  for (const toolkit of BROKERED_TOOLKITS) {
    const prefix = toolkit.toUpperCase()
    if (!upper.startsWith(prefix)) continue
    // A prefix has to end at a boundary or `github` would claim `githubactions`.
    const next = upper.charAt(prefix.length)
    if (next !== '' && next !== '_') continue
    if (best === null || prefix.length > best.length) best = toolkit
  }
  return best
}

/**
 * The class a slug's leading verb implies.
 *
 * THE VERB IS THE FIRST TOKEN. `FETCH_EMAILS` is a fetch of emails, not an email;
 * `SEND_EMAIL` is a send. Reading the leading token is what distinguishes them,
 * and scanning the whole slug for a keyword is what confused them.
 *
 * An unrecognised verb returns `changes`, which is the server's floor: the
 * approval exists because the server saw external side effects, so "no idea" must
 * never resolve downward to `reads`.
 */
function classOf(operation: string): ActionClass {
  const verb = operation.toUpperCase().split('_')[0] ?? ''
  if (DESTROY.has(verb)) return 'destroys'
  if (SEND.has(verb)) return 'sends'
  if (READ.has(verb)) return 'reads'
  if (CHANGE.has(verb)) return 'changes'
  return 'changes'
}

/** The bare tool name, with any MCP namespace prefix removed. */
function bareName(name: string): string {
  return (name.split('__').pop() ?? name).trim()
}

/** Split arguments into the decisive ones and the rest, by class. */
function splitFields(args: Record<string, unknown>, cls: ActionClass): [Field[], Field[]] {
  // Priority is PER CLASS, not global. On a sends-class call the recipient and
  // the content are both decisive, and a global ordering would push the message
  // body behind the fold on exactly the card where it matters most.
  const priority =
    cls === 'sends'
      ? [...RECIPIENT_KEYS, ...CONTENT_KEYS]
      : cls === 'destroys'
        ? [...TARGET_KEYS, ...RECIPIENT_KEYS]
        : cls === 'reads'
          ? [...SCOPE_KEYS, ...TARGET_KEYS]
          : [...TARGET_KEYS, ...CONTENT_KEYS, ...RECIPIENT_KEYS]

  const decisive: Field[] = []
  const seen = new Set<string>()
  for (const key of priority) {
    if (decisive.length >= 3) break
    const value = show(args[key])
    if (!value || seen.has(key)) continue
    seen.add(key)
    decisive.push({ label: labelFor(key), value })
  }
  const remainder: Field[] = []
  for (const [key, value] of Object.entries(args)) {
    if (seen.has(key)) continue
    const text = show(value)
    if (text) remainder.push({ label: labelFor(key), value: text })
  }
  return [decisive, remainder]
}

/** Parse the scrubbed args summary. It can fail: it is truncated for storage. */
function parseArgs(argsSummary: string | null): Record<string, unknown> | null {
  if (!argsSummary) return null
  try {
    const parsed: unknown = JSON.parse(argsSummary)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export interface HumanizeInput {
  toolName: string
  argsSummary: string | null
  /** The requesting agent's display name, when clawboo knows it. */
  agentName: string | null
  /**
   * The SERVER's reading of the tool, from the registry. This is the FLOOR.
   *
   * A tool name is written by whoever built the tool and the arguments by a
   * model, so neither may talk the card into looking calmer than this. They may
   * only make it look more serious, or make the same seriousness more specific.
   */
  toolClass?: 'read' | 'write' | 'destructive' | null
  /** The tool's own one-line description, for when nothing can name the verb. */
  toolSummary?: string | null
}

/** Rank, so a request can raise the server's floor but never lower it. */
const SEVERITY: Record<ActionClass, number> = {
  reads: 0,
  unknown: 1,
  changes: 1,
  sends: 2,
  destroys: 3,
}

/**
 * The server's class on the same scale, or null when the server said nothing.
 *
 * NULL IS NOT A FLOOR. Treating an absent classification as `changes` would let
 * a missing field quietly override a request that read itself correctly, which
 * is how a plain fetch started reporting as a change.
 */
function floorFor(toolClass: HumanizeInput['toolClass']): ActionClass | null {
  if (!toolClass) return null
  return toolClass === 'destructive' ? 'destroys' : toolClass === 'read' ? 'reads' : 'changes'
}

/** Take the more serious of the server's floor and the request's own reading. */
function atLeast(floor: ActionClass | null, claimed: ActionClass): ActionClass {
  if (floor === null) return claimed
  return SEVERITY[claimed] >= SEVERITY[floor] ? claimed : floor
}

/**
 * Describe a pending call in the second person.
 *
 * The actor is named when known. When it is not, the caller says so in its own
 * line rather than inventing an actor, because "an agent" reads as though
 * clawboo knows which one.
 */
export function humanizeApproval(input: HumanizeInput): HumanizedApproval {
  const who = input.agentName ?? 'An agent'
  const args = parseArgs(input.argsSummary)
  const bare = bareName(input.toolName)

  // ── The broker: the app and the operation live in the arguments ──
  const batch = args?.['tools']
  if (Array.isArray(batch) && batch.length > 0) {
    const slugs = batch
      .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>)['tool_slug'] : null))
      .filter((s): s is string => typeof s === 'string')
    const placed = slugs.map(toolkitOf)
    const toolkits = [...new Set(placed.filter((t): t is string => t !== null))]

    // EVERY slug must be placeable, not merely most of them. Comparing the deduped
    // toolkit count against the slug count would fail a perfectly readable batch
    // of three Gmail calls, and would pass a batch where one slug in five landed
    // nowhere. Guessing an app prints a brand name over a call reaching somewhere
    // else entirely, so the test is that nothing is unplaced.
    if (slugs.length > 0 && placed.every((t) => t !== null)) {
      const appNames = toolkits.map((t) => appForToolkit(t)?.name ?? t)
      const appLabel = appNames.join(' and ')
      const first = slugs[0] ?? ''
      const operation = first.slice((toolkitOf(first) ?? '').length + 1)
      // NO SERVER FLOOR ON A BROKER META-TOOL, deliberately.
      //
      // The floor works because a descriptor's class describes what that tool
      // does. A broker meta-tool is different in kind: it is a transport, and its
      // class describes the most any call through it could do, not what THIS one
      // does. Applying it here collapsed every Composio call to "change something
      // in your Gmail", which threw away the one thing that makes these cards
      // useful, namely that the slug says exactly which operation was asked for.
      //
      // Nothing is over-claimed by dropping it: the chip on a brokered call never
      // says the call is safe, only which app it reaches.
      const cls = slugs.length === 1 ? classOf(operation) : 'changes'
      const step = args?.['current_step']

      // ACCURACY IS NOT REASSURANCE. An earlier draft refused to say "read" on a
      // brokered call, reasoning that a request must never make a card calmer.
      // That conflated two different things and produced a card that told an
      // operator an agent wanted to SEND from their Gmail when it wanted to read
      // the inbox. The rule that survives is narrower and correct: the request
      // decides the DESCRIPTION, the server decides the REASSURANCE. So the verb
      // below is accurate, and the chip still refuses to claim the call is safe.
      const verb =
        cls === 'destroys'
          ? `delete something in your ${appLabel}`
          : cls === 'sends'
            ? `send something from your ${appLabel}`
            : cls === 'reads'
              ? `read your ${appLabel}`
              : `change something in your ${appLabel}`

      const [decisive, remainder] = splitFields(
        (batch[0] as Record<string, unknown>)?.['arguments'] as Record<string, unknown>,
        cls,
      )
      // A batch says how many steps, because approving one is not approving five.
      const scale = slugs.length > 1 ? ` It wants to run ${slugs.length} actions.` : ''
      return {
        headline: `${who} wants to ${verb}.${scale}`,
        chip: `Acts on your ${appLabel}`,
        actionClass: cls,
        decisive,
        remainder: [{ label: 'Operation', value: operation || first }, ...remainder],
        agentNote: typeof step === 'string' && step.trim() ? step.trim() : null,
        confident: true,
      }
    }

    // Slugs present but unreadable: say exactly that, and show everything.
    return {
      headline: `${who} wants to run an action through a connected app, and clawboo could not read which one.`,
      chip: 'Unrecognised request',
      actionClass: 'unknown',
      decisive: [],
      remainder: Object.entries(args ?? {}).map(([k, v]) => ({
        label: labelFor(k),
        value: show(v, 400),
      })),
      agentNote: null,
      confident: false,
    }
  }

  // ── clawboo's own tools, named for what they do ──
  const BUILTIN: Record<string, { verb: string; chip: string; cls: ActionClass }> = {
    delete_path: {
      verb: 'delete a file on this computer',
      chip: 'Deletes your data',
      cls: 'destroys',
    },
    read_file: { verb: 'read a file on this computer', chip: 'Reads only', cls: 'reads' },
    write_file: {
      verb: 'write a file on this computer',
      chip: 'Changes your data',
      cls: 'changes',
    },
    echo: { verb: 'repeat a message back', chip: 'Reads only', cls: 'reads' },
    note: { verb: 'write a note', chip: 'Changes your data', cls: 'changes' },
  }
  const known = BUILTIN[bare]
  if (known && args) {
    const [decisive, remainder] = splitFields(args, known.cls)
    return {
      headline: `${who} wants to ${known.verb}.`,
      chip: known.chip,
      actionClass: known.cls,
      decisive,
      remainder,
      agentNote: null,
      confident: true,
    }
  }

  // ── ANY OTHER TOOL, which on a general platform is most of them ──
  //
  // An install can carry any number of connectors nobody wrote a phrasebook for.
  // On the machine this was built against there were 90 registered tools across
  // seven connectors, and hard-coded knowledge covered twelve of them. So the
  // general path has to produce something a person can act on from what is
  // always available: the server's classification, the tool's own description,
  // and the verb in its name.
  const cls = atLeast(floorFor(input.toolClass), verbInName(bare))
  const [decisive, remainder] = args ? splitFields(args, cls) : [[], []]
  const summary = input.toolSummary?.trim()
  return {
    headline: `${who} wants to run "${prettyToolName(bare)}".`,
    // THE SERVER MAY REASSURE, and here it is the server talking: this class
    // came off the registry entry, not off the tool's name or the model's
    // arguments, so a read really is a read.
    chip: chipForClass(input.toolClass),
    actionClass: cls,
    // The tool's own sentence, first, because on an unfamiliar tool it is the
    // only thing that says what the call actually does.
    decisive: summary ? [{ label: 'What it does', value: summary }, ...decisive] : decisive,
    remainder,
    agentNote: null,
    // Confident only when the server told us something. Without that the card
    // keeps showing the raw request rather than a reassuring summary of it.
    confident: Boolean(input.toolClass),
  }
}

/** A readable name from a namespaced tool id: `browser_navigate` -> `Browser navigate`. */
function prettyToolName(bare: string): string {
  const words = bare.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The first known verb anywhere in a tool's name.
 *
 * Scanned across tokens rather than taken from the front, because naming
 * conventions differ per server: `read_file` leads with its verb, and
 * `browser_navigate` puts the subject first. Token matching is what keeps this
 * safe: substring matching is how `FETCH_EMAILS` was once read as a send.
 */
function verbInName(bare: string): ActionClass {
  for (const token of bare
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean)) {
    if (DESTROY.has(token)) return 'destroys'
    if (SEND.has(token)) return 'sends'
    if (READ.has(token)) return 'reads'
    if (CHANGE.has(token)) return 'changes'
  }
  return 'unknown'
}

/** The chip, stated by the server. Only the server gets to say a call is safe. */
function chipForClass(toolClass: HumanizeInput['toolClass']): string {
  return toolClass === 'destructive'
    ? 'Deletes your data'
    : toolClass === 'read'
      ? 'Reads only'
      : toolClass === 'write'
        ? 'Changes your data'
        : 'clawboo cannot tell what this does'
}
