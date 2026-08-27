// Asking a broker to connect one of its upstream apps.
//
// READ THE SCHEMA, DO NOT MEMORISE IT. The broker's connection tool takes
// arguments this repo has no way to pin down: its shape is documented in prose,
// it is versioned by the broker rather than by us, and nothing here can be
// tested against the live service. Hardcoding a guess produces the worst
// available failure, a call that is accepted and does the wrong thing.
//
// So the arguments are built from the tool's OWN JSON Schema, which MCP carries
// verbatim through `listTools()`. If the schema says the app goes in a field
// called `toolkit`, that is where it goes. If it says `app`, likewise. If the
// schema has required fields this code cannot fill, it refuses and names them
// rather than sending a call it does not understand.

/** Field names a broker might use for "which upstream app". Most specific first. */
const APP_KEYS = ['toolkit', 'toolkit_slug', 'toolkitSlug', 'app', 'app_name', 'appName', 'slug']

/** Field names a broker might use for "what to do with it". */
const ACTION_KEYS = ['action', 'operation', 'mode', 'command']

/** Enum members that mean "start a new connection". Most specific first. */
const CREATE_VALUES = ['create', 'initiate', 'connect', 'add', 'new', 'authorize', 'link']

export interface LinkArgsRefusal {
  /** Why no call was made, in a sentence a person can act on. */
  reason: string
}

export type LinkArgs = Record<string, unknown>

function properties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const props = schema['properties']
  if (!props || typeof props !== 'object') return {}
  return props as Record<string, Record<string, unknown>>
}

function required(schema: Record<string, unknown>): string[] {
  const req = schema['required']
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === 'string') : []
}

function enumOf(prop: Record<string, unknown> | undefined): string[] {
  const e = prop?.['enum']
  return Array.isArray(e) ? e.filter((v): v is string => typeof v === 'string') : []
}

/** The first key present in `props`, searching `candidates` in order. */
function pickKey(props: Record<string, unknown>, candidates: readonly string[]): string | null {
  for (const c of candidates) if (c in props) return c
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]))
  for (const c of candidates) {
    const hit = lower.get(c.toLowerCase())
    if (hit) return hit
  }
  return null
}

/**
 * Arguments for a "connect this app" call, or a refusal naming what is missing.
 *
 * REFUSES RATHER THAN IMPROVISES. A required field this code cannot fill is the
 * signal that the broker's tool is not the shape this was written against, and
 * the honest response is to say so on screen. The alternative, sending the call
 * anyway and hoping, is how an operator ends up with a connection to something
 * they did not choose.
 */
export function buildLinkArgs(
  schema: Record<string, unknown>,
  toolkit: string,
): LinkArgs | LinkArgsRefusal {
  const props = properties(schema)
  if (Object.keys(props).length === 0) {
    return { reason: 'The connection tool published no arguments, so clawboo cannot call it.' }
  }

  const appKey = pickKey(props, APP_KEYS)
  if (!appKey) {
    return {
      reason: `The connection tool takes ${Object.keys(props).join(', ')}, and none of those names an app to connect.`,
    }
  }

  const args: LinkArgs = { [appKey]: toolkit }

  const actionKey = pickKey(props, ACTION_KEYS)
  if (actionKey) {
    const choices = enumOf(props[actionKey])
    if (choices.length > 0) {
      const create = CREATE_VALUES.map((want) =>
        choices.find((c) => c.toLowerCase() === want || c.toLowerCase().includes(want)),
      ).find(Boolean)
      if (!create) {
        return {
          reason: `The connection tool's ${actionKey} accepts ${choices.join(', ')}, and none of those starts a connection.`,
        }
      }
      args[actionKey] = create
    } else {
      args[actionKey] = CREATE_VALUES[0]!
    }
  }

  // Anything else the broker insists on is something this code does not know a
  // value for. Naming them is more useful than a generic failure, because the
  // names are what a maintainer needs to widen the tables above.
  const unmet = required(schema).filter((r) => !(r in args))
  if (unmet.length > 0) {
    return {
      reason: `The connection tool also requires ${unmet.join(', ')}, which clawboo has no value for.`,
    }
  }

  return args
}

/** Whether `buildLinkArgs` refused. */
export function isRefusal(v: LinkArgs | LinkArgsRefusal): v is LinkArgsRefusal {
  return typeof (v as LinkArgsRefusal).reason === 'string'
}

/** The first http(s) URL in a tool's text result, or null. */
export function approvalUrlFrom(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s"'<>)\]]+/)
  if (!match) return null
  try {
    const url = new URL(match[0])
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}
