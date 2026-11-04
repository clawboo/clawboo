// A person a sign-in proxy vouched for, as the rows that record what they did
// store it: a JSON `{ id, name, role }` in a nullable TEXT column. The same shape
// as @clawboo/protocol's PersonRef. Only the server's proxy identity lane makes
// one, from a token it verified; nothing a request body says ever becomes one.

export interface PersonRecord {
  id: string
  name: string | null
  role: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** The column value for a person, or null for none. */
export function personJson(person: PersonRecord | null | undefined): string | null {
  if (!person || typeof person.id !== 'string' || person.id === '') return null
  return JSON.stringify({ id: person.id, name: person.name ?? null, role: person.role ?? null })
}

/** The person a column holds, or null for none or for anything it cannot read. */
export function parsePersonJson(raw: string | null | undefined): PersonRecord | null {
  if (!raw) return null
  try {
    const doc = JSON.parse(raw) as Record<string, unknown> | null
    const id = str(doc?.['id'])
    return id ? { id, name: str(doc?.['name']), role: str(doc?.['role']) } : null
  } catch {
    return null
  }
}
