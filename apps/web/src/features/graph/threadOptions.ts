// What a thread pulled off a given node is allowed to end in.
//
// ONE PLACE, because the picker and the refusal predicate must agree. The
// canvas already has `connectionRefusal`, which answers "may these two node
// types connect" for a drop ON a node; this answers the same question for a
// drop on EMPTY canvas, where the target does not exist yet and the honest
// framing is "what could I create here".
//
// A ROW THAT CANNOT BE COMPLETED ON THE CANVAS IS NOT OFFERED. A connector
// needing a key or a folder is listed but inert, carrying the reason: the
// operator asked to see the whole shelf, and hiding half of it would make the
// product look smaller than it is. Anything needing a multi-field form (a
// custom server, a team) is absent entirely rather than linked away.

import {
  byCost,
  connectorCost,
  COST_COPY,
  isImmediate,
  searchConnectors,
  type ConnectorCost,
  type ConnectorDefinition,
} from '@clawboo/connector-catalog'

import { SKILL_CATALOG } from '@/features/marketplace/catalog'
import type { ThreadOption } from './threadPickerRows'

export interface ThreadOptionsInput {
  /** The node the thread came from. Only a Boo can spawn today. */
  fromNodeType: string | null
  /** Skills this agent already has, so the list never offers a duplicate. */
  ownedSkillNames: ReadonlySet<string>
  /** Connector slugs already live, likewise. */
  liveConnectorSlugs: ReadonlySet<string>
  /** Prices a connector against live + configured state. */
  costOf: (def: ConnectorDefinition) => ConnectorCost
}

/**
 * The rows to show for a thread released on empty canvas.
 *
 * Empty when the source cannot spawn anything, which is the signal to skip the
 * picker entirely rather than open one with nothing in it.
 */
export function threadOptionsFor(input: ThreadOptionsInput): ThreadOption[] {
  // ONLY FROM A BOO. A skill or connector tile dragged to empty canvas has no
  // meaningful thing to create: its own existence is owned by the agent it
  // orbits, and "create a second copy of this skill, attached to nothing" is
  // not a state the model has.
  if (input.fromNodeType !== 'boo') return []

  const options: ThreadOption[] = []

  // CONNECTORS FIRST, and ordered by what they cost. The list used to open with
  // thirty-two skills, so the first connector sat past a full screen of
  // scrolling; and within connectors the first one visible was `github`, which
  // is inert here because it needs a key. Leading with what can be finished in
  // one click is the same ordering the shelf already uses.
  for (const def of byCost(searchConnectors(''), input.costOf)) {
    if (input.liveConnectorSlugs.has(def.slug)) continue
    const cost = input.costOf(def)
    const copy = COST_COPY[cost]
    options.push({
      id: `connector:${def.slug}`,
      kind: 'connector',
      label: def.displayName,
      hint: def.description,
      slug: def.slug,
      action: copy?.action,
      // Listed but inert. The reason is the same sentence the shelf uses, so a
      // reader who has seen one surface recognises the other.
      ...(isImmediate(cost)
        ? {}
        : { disabledReason: `${copy?.action ?? 'Set up'} in the Connectors tab first` }),
    })
  }

  for (const skill of SKILL_CATALOG) {
    if (input.ownedSkillNames.has(skill.name)) continue
    options.push({
      id: `skill:${skill.id}`,
      kind: 'skill',
      label: skill.name,
      hint: skill.description,
      action: 'Add',
    })
  }

  return options
}

/** Re-exported so callers price connectors the same way the shelf does. */
export { connectorCost }
