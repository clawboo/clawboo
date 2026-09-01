// What a person actually pastes, turned into a key or a reason it is not one.
//
// THE DASHBOARD HANDS OUT A LINE, NOT A VALUE. Composio shows the key as
// `COMPOSIO_API_KEY=ak_...`, so pasting the whole line is the ordinary thing to
// do rather than a mistake. Storing it verbatim produced a saved key that every
// later call rejected with a 401, and the only place that said so was a toast on
// the Connect button several screens later. Accepting the shapes people really
// paste costs a few lines here and removes that entire failure.
//
// THE SHAPE IS CHECKED, because two different keys are called an API key and
// only one of them works. `composio login` writes a user key (`uak_`) that is
// for the CLI and returns 401 against the API, so a person who copies it has no
// way to tell it apart from the one they needed. Naming it is the difference
// between a dead end and a next step.

/** A project key: what the SDK accepts. */
const PROJECT_KEY = /^ak_[A-Za-z0-9_-]{10,}$/

/** An env-style assignment, with or without `export`. */
const ASSIGNMENT = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/s

/** A value wrapped in matching quotes. */
const QUOTED = /^(["'])(.*)\1$/s

export type KeyProblem = 'empty' | 'user-key' | 'unrecognised'

export interface KeyReading {
  /** The key, when the paste yielded one. */
  key: string | null
  problem?: KeyProblem
}

/**
 * Strip the wrapping a copied key arrives in.
 *
 * Order matters: the quotes come off last, because a `.env` line quotes the
 * value rather than the whole assignment.
 */
function unwrap(raw: string): string {
  let value = raw.trim()

  // Only a plausible variable name is stripped, so a key that somehow contains
  // an equals sign is left alone.
  const assignment = value.match(ASSIGNMENT)
  if (assignment?.[1] !== undefined) value = assignment[1].trim()

  const quoted = value.match(QUOTED)
  if (quoted?.[2] !== undefined) value = quoted[2].trim()

  return value
}

/** A person's paste, read as a key or as the reason it is not one. */
export function readComposioKey(raw: string): KeyReading {
  const value = unwrap(raw)
  if (value === '') return { key: null, problem: 'empty' }
  if (PROJECT_KEY.test(value)) return { key: value }
  if (/^uak_/.test(value)) return { key: null, problem: 'user-key' }
  return { key: null, problem: 'unrecognised' }
}

/** What to tell the person, in their words rather than the API's. */
export function explainKeyProblem(problem: KeyProblem): string {
  switch (problem) {
    case 'empty':
      return 'Paste your Composio key.'
    case 'user-key':
      // The distinction is invisible on the page they copied it from, so the
      // message has to name where the right one lives.
      return 'That is a Composio login key. The one needed here starts with ak_ and is on your project settings page.'
    case 'unrecognised':
      return 'That does not look like a Composio key. It starts with ak_.'
  }
}
