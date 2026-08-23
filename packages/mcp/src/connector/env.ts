// The environment a CONNECTOR child process inherits.
//
// A SEPARATE FUNCTION, NOT A WRAPPER AROUND buildChildEnv, and that is the whole
// design. `buildChildEnv` is a ~52-name DENYLIST written for semi-trusted
// first-party runtime CLIs, and it deliberately PRESERVES ambient provider auth
// because Codex reads OPENAI_API_KEY and Hermes reads its provider's key. Adding
// names on top of it removes nothing: a connector would inherit
// ANTHROPIC_API_KEY, OPENROUTER_API_KEY, KUBECONFIG and every other variable
// nobody thought to enumerate. A denylist is the wrong shape for a process whose
// code we did not write.
//
// So this starts from {} and adds back only what a child process needs in order
// to START. Everything else is a deliberate decision, made once, here.
//
// ONE CAVEAT, because the guarantee is narrower than it first reads: the SDK's
// stdio transport merges `getDefaultEnvironment()` UNDERNEATH whatever env it is
// given. On POSIX that adds HOME, LOGNAME, PATH, SHELL, TERM and USER; on Windows
// APPDATA, HOMEDRIVE, HOMEPATH, LOCALAPPDATA, PATH, PROCESSOR_ARCHITECTURE,
// SYSTEMDRIVE, SYSTEMROOT, TEMP, USERNAME, USERPROFILE and PROGRAMFILES. That set
// is fixed and contains no credential, so the security property holds; the exact
// key set the child sees is simply the union, not this list alone. Those names
// are enumerated below so the documented set matches the real one.
//
// WHAT THIS IS NOT. It is not a sandbox. The child still runs as the user and
// can read ~/.ssh, ~/.aws, the clawboo database and the vault files on disk. It
// closes the env vector only. Saying otherwise would be the kind of claim this
// codebase refuses to make elsewhere, and it should not start here.

/**
 * Variables a process needs to run at all, on any platform.
 *
 * PATH is load-bearing: without it `npx` cannot find node. HOME likewise, or npm
 * writes its cache to `/`. Locale and TZ are here because their absence changes
 * a connector's OUTPUT rather than its ability to start, and a date formatted in
 * an unexpected locale is a bug nobody will trace back to this file.
 */
const POSIX_PASSTHROUGH = [
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  // The SDK adds these regardless. Listed so CONNECTOR_ENV_ALLOWLIST is the
  // truth about what the child receives rather than a subset of it.
  'LOGNAME',
  'TERM',
  'USER',
]

/**
 * Windows equivalents. SystemRoot is not optional: omit it and process creation
 * itself fails with a cryptic error, because the loader resolves system DLLs
 * relative to it. APPDATA / LOCALAPPDATA are where npm keeps its cache and
 * prefix, so a cold `npx` cannot install without them.
 */
const WINDOWS_PASSTHROUGH = [
  'SystemRoot',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'windir',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  // Also added by the SDK on Windows.
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'PROGRAMFILES',
]

/**
 * Proxy configuration.
 *
 * Included with eyes open. A proxy URL CAN carry credentials
 * (`http://user:pass@proxy`), so this hands a connector one secret it would not
 * otherwise see. The alternative is that every connector is simply broken behind
 * a corporate proxy, with no diagnostic that would ever lead someone here. The
 * operator's own proxy credential is also a far smaller prize than the provider
 * keys the denylist approach would have leaked.
 */
const PROXY_PASSTHROUGH = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]

/** Every name that may pass through, in one frozen set for the test to assert against. */
export const CONNECTOR_ENV_ALLOWLIST: ReadonlySet<string> = Object.freeze(
  new Set([...POSIX_PASSTHROUGH, ...WINDOWS_PASSTHROUGH, ...PROXY_PASSTHROUGH]),
) as ReadonlySet<string>

export interface ConnectorEnvOptions {
  /** The ambient environment to draw from. Defaults to the current process. */
  source?: NodeJS.ProcessEnv
  /**
   * Credentials the connector DECLARED and the operator supplied, by exact name.
   *
   * Merged last and never filtered: these are the keys a human explicitly
   * granted to this connector. Anything not declared cannot arrive this way,
   * which is what makes the declaration meaningful rather than decorative.
   */
  declared?: Record<string, string>
}

/**
 * Build the environment for a connector child.
 *
 * Deterministic and pure given `source`, so the test can assert the exact key
 * set rather than whatever the developer's shell happens to hold.
 */
export function connectorChildEnv(opts: ConnectorEnvOptions = {}): Record<string, string> {
  const source = opts.source ?? process.env
  const env: Record<string, string> = {}

  for (const name of CONNECTOR_ENV_ALLOWLIST) {
    const value = source[name]
    if (typeof value === 'string' && value.length > 0) env[name] = value
  }

  // Declared credentials last. An empty value is dropped rather than passed as
  // an empty string, because a connector that reads `""` as "configured" fails
  // in a much more confusing way than one that reports the variable as missing.
  for (const [name, value] of Object.entries(opts.declared ?? {})) {
    if (typeof value === 'string' && value.length > 0) env[name] = value
  }

  return env
}
