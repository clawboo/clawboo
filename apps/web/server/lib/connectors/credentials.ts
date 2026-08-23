// Credentials a connector DECLARED, resolved for its child process.
//
// VAULT ONLY, deliberately. `resolveRuntimeKey` reads `process.env` first and
// then falls back to OpenClaw's `.env` -- an auto-connect chain that is right for
// a first-party runtime and wrong here. The connector env is an ALLOWLIST
// precisely so a child cannot pick up an ambient secret nobody granted it, and
// resolving through the ambient chain would hand that back: a user with
// NOTION_TOKEN exported would silently give it to any connector that named the
// same variable.
//
// So a connector credential has to be entered once, explicitly, and lands in the
// vault. That is a little more friction and a much clearer story about who gave
// what to whom.
//
// A VALUE NEVER LEAVES THIS MODULE except into a spawned child's env. Nothing
// here returns one to a caller, and the status shape below is booleans only.

import { getSetting, setSetting, type ClawbooDb } from '@clawboo/db'

import { deleteRuntimeSecret, getRuntimeSecret, setRuntimeSecret } from '../secretsVault'

/** One credential a connector declared, and whether it is satisfied. */
export interface CredentialStatus {
  key: string
  description: string
  required: boolean
  secret: boolean
  /** Whether a value is stored. NEVER the value. */
  present: boolean
  docsUrl?: string
}

export interface DeclaredInput {
  key: string
  description: string
  required: boolean
  secret: boolean
  docsUrl?: string
}

/**
 * Namespace the vault slot by connector.
 *
 * Two connectors can legitimately want different values for the same variable
 * name -- a work and a personal Notion token both want `NOTION_TOKEN` -- and a
 * bare name would make the second silently overwrite the first. It also keeps a
 * connector's credential away from the runtime provider keys that share the
 * vault, so deleting one can never disturb the other.
 */
export function connectorSecretSlot(slug: string, key: string): string {
  return `connector:${slug}:${key}`
}

/** Which of a connector's declared credentials are stored. Booleans only. */
export function credentialStatus(
  slug: string,
  inputs: readonly DeclaredInput[],
): CredentialStatus[] {
  return inputs.map((input) => ({
    key: input.key,
    description: input.description,
    required: input.required,
    secret: input.secret,
    ...(input.docsUrl ? { docsUrl: input.docsUrl } : {}),
    present: getRuntimeSecret(connectorSecretSlot(slug, input.key)) !== null,
  }))
}

/** Whether every REQUIRED credential is stored. Optional ones never block. */
export function credentialsSatisfied(slug: string, inputs: readonly DeclaredInput[]): boolean {
  return credentialStatus(slug, inputs).every((c) => !c.required || c.present)
}

/** Store one credential. The value goes straight to the vault and nowhere else. */
export function setConnectorCredential(slug: string, key: string, value: string): void {
  setRuntimeSecret(connectorSecretSlot(slug, key), value)
}

/** Remove one credential. */
export function clearConnectorCredential(slug: string, key: string): void {
  deleteRuntimeSecret(connectorSecretSlot(slug, key))
}

/**
 * The declared credentials, resolved, for the child's environment.
 *
 * Returns only what is actually stored: a missing OPTIONAL credential is simply
 * absent rather than an empty string, because a connector that reads `""` as
 * "configured" fails far more confusingly than one that reports it as missing.
 */
export function resolveConnectorCredentials(
  slug: string,
  inputs: readonly DeclaredInput[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const input of inputs) {
    const value = getRuntimeSecret(connectorSecretSlot(slug, input.key))
    if (value) out[input.key] = value
  }
  return out
}

// ─── The non-secret half: a launch argument the operator supplies ────────────
// Deliberately NOT in the vault. A folder path or a database file is not a
// credential, and putting it there would mean it could never be shown back to
// the operator -- which is exactly what you want them to be able to check
// before they connect something to their filesystem.

function argumentKey(slug: string): string {
  return `connector:${slug}:argument`
}

/** The stored launch argument for a connector, or null. */
export function getConnectorArgument(db: ClawbooDb, slug: string): string | null {
  const value = getSetting(db, argumentKey(slug))
  return value && value.length > 0 ? value : null
}

/** Store or clear the launch argument. An empty value clears it. */
export function setConnectorArgument(db: ClawbooDb, slug: string, value: string): void {
  setSetting(db, argumentKey(slug), value.trim())
}
