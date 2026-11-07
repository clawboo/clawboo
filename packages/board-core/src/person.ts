// ─── The built-in local person ──────────────────────────────────────────────
// Behind a sign-in proxy a person is the one its verified token names (the
// server's `personOf(req)`). A local install has no proxy, so it has one built-in
// person, "You", with a fixed id: whoever is at the dashboard. Writes record it
// when nothing vouched for anyone else, and a task assigned to it is everyone's
// on that install. It proves nothing about who sent a request: see the server's
// `actsAsPerson` for the check that stands in for that locally.
//
// The same shape as @clawboo/protocol's PersonRef. Import-free.

export interface LocalPersonRef {
  id: string
  name: string | null
  role: string | null
}

/** The built-in person's fixed id. */
export const LOCAL_PERSON_ID = 'local'

/** The built-in person a local install acts as. */
export const LOCAL_PERSON: Readonly<LocalPersonRef> = Object.freeze({
  id: LOCAL_PERSON_ID,
  name: 'You',
  role: null,
})

export function isLocalPerson(id: string | null | undefined): boolean {
  return id === LOCAL_PERSON_ID
}
