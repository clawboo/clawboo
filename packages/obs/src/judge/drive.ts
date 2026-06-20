// The structured-output JUDGE drive — the pure half of "drive an LLM to emit a
// typed verdict and parse it with a way-out". Extracted so BOTH the read-only
// critic (apps/web/server/lib/verification/critic.ts) and the eval model-grader
// (packages/evals) share ONE implementation. It is adapter-agnostic by design: the
// CALLER owns the runtime (it passes a `runText` thunk that starts + drains its own
// adapter), so this package never imports `RuntimeAdapter` — keeping the
// "packages never import apps" invariant intact.

import type { TypeOf, ZodTypeAny } from 'zod'

/** Extract the first balanced top-level `{…}` JSON object from model text. */
export function extractJsonBlock(text: string): unknown | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export type JudgeStatus = 'parsed' | 'empty' | 'unparseable'

export interface JudgeResult<T> {
  /** The raw (trimmed) model text. */
  raw: string
  /** The validated verdict, or null when not parseable. */
  value: T | null
  /** `parsed` (valid JSON matching the schema), `empty` (no JSON at all — a valid
   *  "nothing to report"), or `unparseable` (text present but not valid/typed). */
  status: JudgeStatus
}

export interface DriveStructuredJudgeInput<S extends ZodTypeAny> {
  /** Start the runtime, drain its events to a single text blob, return it. */
  runText: () => Promise<string>
  /** The Zod schema the verdict must satisfy. */
  schema: S
}

/**
 * Run a judge and parse its output into a typed verdict with a way-out:
 * empty output ⇒ `empty` (a valid "no findings"); valid JSON ⇒ `parsed`;
 * anything else ⇒ `unparseable` (the caller decides whether that's a soft warn).
 * Never throws on bad model output. The value is the schema's OUTPUT type.
 */
export async function driveStructuredJudge<S extends ZodTypeAny>(
  input: DriveStructuredJudgeInput<S>,
): Promise<JudgeResult<TypeOf<S>>> {
  const raw = (await input.runText()).trim()
  const block = extractJsonBlock(raw)
  if (block === null) return { raw, value: null, status: raw ? 'unparseable' : 'empty' }
  const parsed = input.schema.safeParse(block)
  if (parsed.success) return { raw, value: parsed.data as TypeOf<S>, status: 'parsed' }
  return { raw, value: null, status: 'unparseable' }
}

export interface JudgePromptOptions {
  /** What the judge is evaluating (the task / the artifact under review). */
  task: string
  /** A literal JSON shape string the model must emit (e.g. '{"score":0,"reason":"..."}'). */
  shape: string
  /** Optional per-dimension rubric text (kept isolated — one judge per dimension). */
  rubric?: string
  /** Extra constraints appended verbatim. */
  notes?: string[]
}

/**
 * Build a structured-output judge prompt: "output ONLY JSON of <shape>, empty/
 * neutral is valid, and you may answer 'Unknown' rather than hallucinate". Used by
 * the eval model-grader; the critic keeps its own verbatim prompt (T8 is
 * behavior-preserving) and only reuses `extractJsonBlock` + `driveStructuredJudge`.
 */
export function buildJudgePrompt(opts: JudgePromptOptions): string {
  const lines = [
    'You are an INDEPENDENT evaluator (builder ≠ judge). Judge ONLY what is presented; do not assume hidden context.',
    opts.rubric ? `Rubric:\n${opts.rubric}` : '',
    `Task under evaluation:\n${opts.task}`,
    `Output ONLY a single JSON object, no prose, of the form:\n${opts.shape}`,
    'If you cannot determine a dimension from the evidence, use "Unknown" rather than guessing.',
    ...(opts.notes ?? []),
  ].filter(Boolean)
  return lines.join('\n\n')
}
