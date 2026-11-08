// ─── Questions to a person ──────────────────────────────────────────────────
// What an agent may ask (`ask_person`) and what counts as an answer. The rows live
// in `task_questions` (@clawboo/db); these rules are import-free so the board's
// answer controls and the server read one definition.

export type QuestionKind =
  /** A question, with options, free text, or both. */
  | 'question'
  /** A yes or no. */
  | 'confirm'
  /** A proposed breakdown the person accepts, edits or turns down. */
  | 'suggest_tasks'

export type QuestionStatus = 'pending' | 'answered' | 'expired' | 'cancelled'

export interface SuggestedTask {
  title: string
  description?: string
  /** For a plan's step: the agent it goes to, and that agent's name when it was asked. */
  agentId?: string
  agentName?: string
}

/**
 * Why a plan is put to a person whatever its team's switch says:
 *  • `unnamed_team`: Boo Zero's one-to-one chat chose a team the person's message did
 *    not name, so its hand-offs to that team wait for the person's yes.
 */
export type PlanAskReason = 'unnamed_team'

/** What makes a `suggest_tasks` question a plan: accepting it creates the steps. */
export interface PlanRef {
  /** The revision of the task's plan document this asks about. */
  revision: number
  /** Where the steps go. Null: at the top of the board. */
  parentTaskId: string | null
  /** The task holds nothing but this plan, because the turn that wrote it had no task. */
  holder: boolean
  /** A batch of hand-offs, not an ordered plan: its steps all start at once. */
  parallel?: boolean
  /** Asked whatever the team's switch says. Such a card is its own request: no other
   *  plan takes its place, and the switch going off does not close it. */
  ask?: PlanAskReason
}

export interface QuestionPayload {
  prompt: string
  /** For `question`: the choices offered. None means free text only. */
  options?: string[]
  /** For `question`: free text is accepted as well as the options. */
  allowOther?: boolean
  /** For `suggest_tasks`: the proposed tasks. */
  tasks?: SuggestedTask[]
  /** For `suggest_tasks` on a team that asks before a plan starts. */
  plan?: PlanRef
}

export type QuestionAnswer =
  | { kind: 'question'; choice?: string; text?: string }
  | { kind: 'confirm'; confirmed: boolean; note?: string }
  | { kind: 'suggest_tasks'; accepted: boolean; tasks: SuggestedTask[]; note?: string }

/** Longest free-text answer or note kept. */
export const QUESTION_ANSWER_MAX_CHARS = 4_000

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.length <= QUESTION_ANSWER_MAX_CHARS ? t : null
}

function suggestedTasks(v: unknown): SuggestedTask[] | null {
  if (!Array.isArray(v)) return null
  const out: SuggestedTask[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return null
    const title = text((raw as Record<string, unknown>)['title'])
    if (!title) return null
    const description = text((raw as Record<string, unknown>)['description'])
    const agentId = text((raw as Record<string, unknown>)['agentId'])
    const agentName = text((raw as Record<string, unknown>)['agentName'])
    out.push({
      title,
      ...(description ? { description } : {}),
      ...(agentId ? { agentId } : {}),
      ...(agentName ? { agentName } : {}),
    })
  }
  return out
}

function planRef(v: unknown): PlanRef | null {
  if (!v || typeof v !== 'object') return null
  const p = v as Record<string, unknown>
  if (typeof p['revision'] !== 'number' || !Number.isInteger(p['revision'])) return null
  return {
    revision: p['revision'],
    parentTaskId: typeof p['parentTaskId'] === 'string' ? p['parentTaskId'] : null,
    holder: p['holder'] === true,
    ...(p['parallel'] === true ? { parallel: true } : {}),
    ...(p['ask'] === 'unnamed_team' ? { ask: 'unnamed_team' as const } : {}),
  }
}

/** A question's stored payload, or null for anything it cannot read. */
export function parseQuestionPayload(raw: unknown): QuestionPayload | null {
  let doc: unknown = raw
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!doc || typeof doc !== 'object') return null
  const d = doc as Record<string, unknown>
  const prompt = typeof d['prompt'] === 'string' ? d['prompt'] : null
  if (!prompt) return null
  const options = Array.isArray(d['options'])
    ? d['options'].filter((o): o is string => typeof o === 'string' && o !== '')
    : null
  const tasks = suggestedTasks(d['tasks'])
  const plan = planRef(d['plan'])
  return {
    prompt,
    ...(options && options.length > 0 ? { options } : {}),
    ...(d['allowOther'] === true ? { allowOther: true } : {}),
    ...(tasks ? { tasks } : {}),
    ...(plan ? { plan } : {}),
  }
}

/**
 * What a person sent, as an answer this question allows, or null when it allows
 * no such thing. Free text counts for a `question` that offers no options or says
 * it takes other answers; a choice must be one of the options.
 */
export function normalizeAnswer(
  kind: string,
  payload: QuestionPayload,
  raw: unknown,
): QuestionAnswer | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const note = text(a['note'])
  if (kind === 'confirm') {
    if (typeof a['confirmed'] !== 'boolean') return null
    return { kind: 'confirm', confirmed: a['confirmed'], ...(note ? { note } : {}) }
  }
  if (kind === 'suggest_tasks') {
    if (typeof a['accepted'] !== 'boolean') return null
    const tasks = a['tasks'] === undefined ? (payload.tasks ?? []) : suggestedTasks(a['tasks'])
    if (!tasks) return null
    return { kind: 'suggest_tasks', accepted: a['accepted'], tasks, ...(note ? { note } : {}) }
  }
  if (kind !== 'question') return null
  const options = payload.options ?? []
  if (a['choice'] !== undefined) {
    return typeof a['choice'] === 'string' && options.includes(a['choice'])
      ? { kind: 'question', choice: a['choice'] }
      : null
  }
  const free = text(a['text'])
  if (!free) return null
  return options.length === 0 || payload.allowOther === true
    ? { kind: 'question', text: free }
    : null
}

/** Text an agent wrote, on one line, so a line break in it cannot make it read as
 *  something else where a person or a later run reads it. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** What a person said, for the task's thread under their name. The question is not in
 *  it: that is the agent's text, and on this line it would read as the person's. An
 *  option or a suggested task is the agent's wording too, but it is what they chose. */
export function answerWords(answer: QuestionAnswer, opts?: { planCreated?: boolean }): string {
  const noted = 'note' in answer && answer.note ? `\nNote: ${answer.note}` : ''
  if (answer.kind === 'confirm') return `${answer.confirmed ? 'Yes' : 'No'}.${noted}`
  if (answer.kind === 'question')
    return answer.choice ? oneLine(answer.choice) : (answer.text ?? '')
  if (!answer.accepted) return `Turned these tasks down.${noted}`
  // The person's note comes first: a reader cuts from the end, and the list can be long.
  // An accepted plan's tasks exist by now and hold their own words, so it names them, and
  // the agent must not read this as an ask.
  if (opts?.planCreated) {
    const titles = answer.tasks.map((t) => `- ${oneLine(t.title)}`)
    return `Accepted the plan.${noted}\nIts tasks are on the board:\n${titles.join('\n')}`
  }
  const list = answer.tasks.map(
    (t) => `- ${oneLine(t.title)}${t.description ? `: ${oneLine(t.description)}` : ''}`,
  )
  return `Accepted.${noted ? `${noted}\n` : ' '}Create these tasks:\n${list.join('\n')}`
}

/** The question on the task's thread, under the agent that wrote it. */
export function askedWords(prompt: string): string {
  return `Asked a person: ${oneLine(prompt)}`
}

/** What the agent reads when an answer wakes it. The answer comes first, because a
 *  mailbox note is cut from the end and a question can be long. */
export function answerForAgent(
  prompt: string,
  answer: QuestionAnswer,
  opts?: { planCreated?: boolean },
): string {
  return `${answerWords(answer, opts)}\n\n(Your question, as you wrote it: ${oneLine(prompt)})`
}
