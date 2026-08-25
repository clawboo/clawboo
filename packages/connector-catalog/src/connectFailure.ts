// Turning a spawn or handshake failure into a sentence the operator can act on.
//
// WHAT THIS REPLACES. A connect that fails returns whatever the child or the
// transport threw: `Error: spawn npx ENOENT`, an npm E404 block, a JSON-RPC
// code, a 401 with no body. Every one of those is true and none of them tells
// the person who just pasted a token what to do next. The worst case is the
// key path: a token rejected for missing permissions produced a bare `502`,
// which reads as "clawboo is broken" rather than "that token cannot do this".
//
// THE RAW TEXT IS NEVER DISCARDED, only demoted. A developer debugging a real
// spawn problem needs the original, so it rides along as `detail` and the UI
// shows it under the sentence rather than instead of it.
//
// MATCHED ON SUBSTRINGS, deliberately, not on structured error types: the text
// arrives from four different layers (Node's spawn, npm, the MCP SDK, the
// vendor's HTTP response) and none of them share a shape. A missed match falls
// through to a generic sentence that is still better than a stack trace.

export interface ConnectFailure {
  /** One sentence naming the obstacle. Safe to show on its own. */
  message: string
  /** The original text, for somebody who needs it. May be empty. */
  detail: string
}

/** Case-insensitive substring test, tolerant of the many wrappers around these. */
function has(haystack: string, ...needles: string[]): boolean {
  const h = haystack.toLowerCase()
  return needles.some((n) => h.includes(n.toLowerCase()))
}

/**
 * Explain why a connector did not come up.
 *
 * `raw` must already be redacted: this runs on text that may have carried a
 * token through a child's stderr, and nothing here re-reads the vault.
 */
export function explainConnectFailure(raw: string, displayName: string): ConnectFailure {
  const detail = raw.trim()
  const name = displayName

  // The runtime is missing entirely. Distinguished from a missing PACKAGE
  // because the remedy is completely different: install Node, not check a name.
  if (has(detail, 'spawn npx enoent', 'spawn uvx enoent', 'command not found')) {
    const tool = has(detail, 'uvx') ? 'uvx' : 'npx'
    return {
      message:
        tool === 'uvx'
          ? `${name} needs uvx, which is not on this machine. Install uv, then try again.`
          : `${name} needs npx, which comes with Node.js. Install Node 18 or newer, then try again.`,
      detail,
    }
  }

  if (has(detail, 'unsupported engine', 'engine "node"', 'requires node')) {
    return { message: `${name} did not start. It needs a newer version of Node.js.`, detail }
  }

  // The package itself is gone or misspelled. Common for a community entry
  // whose publisher unpublished it after the snapshot was taken.
  if (has(detail, 'e404', '404 not found', 'notarget', 'no matching version')) {
    return {
      message: `${name} did not start: that package or version is no longer published. It may have been removed since clawboo recorded it.`,
      detail,
    }
  }

  // The credential was reached and refused. THE MOST IMPORTANT CASE, because it
  // is the one where the operator did everything right and the old copy blamed
  // the product.
  if (has(detail, '401', 'unauthorized', 'invalid_token', 'invalid api key', 'authentication')) {
    return {
      message: `${name} did not accept that key. Check you copied all of it, and that it has not expired.`,
      detail,
    }
  }

  if (has(detail, '403', 'forbidden', 'insufficient', 'missing scope', 'permission')) {
    return {
      message: `${name} accepted the key but refused the request. It is probably missing a permission: check the scopes on the token you created.`,
      detail,
    }
  }

  if (has(detail, 'etimedout', 'timeout', 'timed out')) {
    return {
      message: `${name} did not respond in time. It may be slow to start, or offline.`,
      detail,
    }
  }

  if (has(detail, 'enotfound', 'econnrefused', 'eai_again', 'getaddrinfo')) {
    return { message: `clawboo could not reach ${name}. Check your network connection.`, detail }
  }

  if (has(detail, 'enoent', 'no such file')) {
    return {
      message: `${name} could not find a file it needs. If you gave it a folder or a database file, check the path still exists.`,
      detail,
    }
  }

  // Fell through. Still a sentence, still names the connector, and the original
  // is one line below rather than being the whole message.
  return { message: `${name} did not start.`, detail }
}
