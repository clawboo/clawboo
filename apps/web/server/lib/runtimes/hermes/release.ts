// The Hermes release Clawboo installs, pinned. Pure data and pure helpers.
//
// Hermes is installed from its GitHub release tag, not from PyPI (PyPI's
// `hermes-agent` lags the releases by several versions). The tag's source
// tarball is checked against the hash below before anything in it is read.
//
// Its toolchain comes from the release itself: `pm/lock.json` inside the
// tarball pins the uv build and the CPython build (python-build-standalone) that
// release runs on, each with a sha256 per platform. Clawboo installs exactly
// those into its own folder, so no system Python is needed and a system Python
// upgrade cannot break the install. v0.23.1 runs only on Python 3.14: its
// pyproject gates every core dependency on `python_version >= '3.14'`.
//
// Bumping Hermes: change the tag, the version and the tarball hash together,
// after reading the new release's pyproject.toml and pm/lock.json, and check the
// gateway's API routes the driver uses still answer as before.

export interface HermesRelease {
  /** The git tag, e.g. `v0.23.1`. */
  tag: string
  /** The version Hermes reports for this tag. */
  version: string
  /** The commit the tag points at. Written into the install stamp, which is how a
   *  tree with no git history reports its version. */
  commit: string
  /** The tag's source tarball on GitHub. */
  tarballUrl: string
  /** sha256 of that tarball, hex. */
  tarballSha256: string
  /** The folder the tarball unpacks to. */
  tarballRoot: string
  /** The extras installed with Hermes (pyproject `[project.optional-dependencies]`). */
  extras: readonly string[]
}

export const HERMES_RELEASE: HermesRelease = {
  tag: 'v0.23.1',
  version: '0.23.1',
  commit: '3b421578588243f920886e6fe79a6faa87ea026e',
  tarballUrl: 'https://github.com/NousResearch/hermes-agent/archive/refs/tags/v0.23.1.tar.gz',
  tarballSha256: '52a8eb321f368576034f40595491abf9646b60c3861eee0cf45f610e5faa9bb6',
  tarballRoot: 'hermes-agent-0.23.1',
  // `anthropic` lets a run use an Anthropic key; `mcp` is the MCP client that
  // reaches Clawboo's Tasks, Memory, Tools and TeamChat servers. The API server
  // runs on aiohttp, which no core dependency brings: `sms` is the extra that
  // holds aiohttp and nothing else (it turns no SMS channel on).
  extras: ['anthropic', 'mcp', 'sms'],
}

/** A downloadable artifact from the release's `pm/lock.json`. */
export interface PinnedArtifact {
  url: string
  sha256: string
}

/** The `pm/lock.json` platform key for this machine, or null when the release
 *  ships no build for it. Musl Linux is told apart from glibc by the caller. */
export function pmPlatformKey(
  platform: NodeJS.Platform,
  arch: string,
  opts: { musl?: boolean } = {},
): string | null {
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  if (!cpu) return null
  if (platform === 'darwin') return `darwin-${cpu}`
  if (platform === 'win32') return `win32-${cpu}`
  if (platform === 'linux') return `linux-${cpu}${opts.musl ? '-musl' : ''}`
  return null
}

const SHA256_RE = /^[0-9a-f]{64}$/

/**
 * The uv and Python artifacts `pm/lock.json` pins for one platform. Throws when
 * the file does not have them, so a tarball whose lock changed shape fails the
 * install with a reason rather than downloading something unpinned. Only https
 * URLs from GitHub are taken: the lock is inside a tarball whose hash is pinned,
 * but the rule costs nothing and keeps a mirror or a `.deb` out.
 */
export function pinnedToolchain(
  lock: unknown,
  platformKey: string,
): { uv: PinnedArtifact & { version: string }; python: PinnedArtifact & { version: string } } {
  const packages = (lock as { packages?: Record<string, unknown> } | null)?.packages
  const pick = (name: 'uv' | 'python'): PinnedArtifact & { version: string } => {
    const entry = packages?.[name] as
      { version?: unknown; artifacts?: Record<string, unknown> } | undefined
    const art = entry?.artifacts?.[platformKey] as { url?: unknown; sha256?: unknown } | undefined
    const url = typeof art?.url === 'string' ? art.url : ''
    const sha256 = typeof art?.sha256 === 'string' ? art.sha256.toLowerCase() : ''
    const version = typeof entry?.version === 'string' ? entry.version : ''
    if (!url || !SHA256_RE.test(sha256) || !version) {
      throw new Error(`Hermes ${HERMES_RELEASE.tag} pins no ${name} build for ${platformKey}`)
    }
    if (!url.startsWith('https://github.com/')) {
      throw new Error(`Hermes ${HERMES_RELEASE.tag} pins ${name} from outside GitHub: ${url}`)
    }
    return { url, sha256, version }
  }
  return { uv: pick('uv'), python: pick('python') }
}
