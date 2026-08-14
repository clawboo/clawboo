/**
 * scripts/lib/bundle-externals.mjs
 *
 * Static "what does the shipped bundle still need from node_modules?" analysis.
 *
 * The CLI publishes ONE artifact (`dist/`), assembled from tsup bundles that
 * inline almost everything. Whatever is left un-inlined becomes a bare
 * `require(...)` / `import(...)` in the emitted JS, and MUST be resolvable from
 * the user's install — i.e. declared in `apps/cli` `dependencies`, a Node
 * builtin, or a knowingly-optional module the code degrades without. A module
 * that resolves only because the repo's workspace `node_modules` happens to sit
 * above the bundle is a latent "works on my machine" bug that only shows up on
 * a stranger's `npx clawboo`.
 *
 * This module is the extractor + the policy. It is pure (no fs, no process) so
 * the same code runs against the repo build AND against an installed tarball.
 *
 * ── Why a hand-rolled scanner instead of a regex ────────────────────────────
 * A naive /require\(["']([^"']+)["']\)/g over the bundle produces FALSE
 * POSITIVES: the inlined `ajv` source contains the literal string
 * `'require("ajv/dist/runtime/equal").default'` (ajv's standalone-codegen
 * template), and esbuild writes module paths into `// comments`. Both look
 * exactly like a require to a regex. The scanner below walks the source with
 * just enough JS lexing (strings, template literals with `${}` nesting, line +
 * block comments, regex literals) to only ever match a call in CODE position.
 *
 * A parser would be exact, but the clean-install gate deliberately runs with
 * zero non-builtin imports on three OSes right after a frozen install; adding a
 * parser dependency to it is a worse trade than ~150 lines of lexing that is
 * fixture-tested (see `selfCheckExtractor`) and validated against esbuild's own
 * metafile output.
 *
 * The scanner's failure direction is safe: a mis-lex makes it MISS a specifier
 * (the smoke test that actually boots the install is the backstop), it does not
 * invent one.
 */

import { builtinModules } from 'node:module'

// ─── Policy ──────────────────────────────────────────────────────────────────

/** Node builtins, with and without the `node:` prefix. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  // Not in `builtinModules` on every line, but always resolvable.
  'node:test',
  'node:sea',
])

/**
 * Modules that are deliberately NOT in the CLI's `dependencies` even though the
 * bundle references them. Every entry is lazy-imported behind a try/catch and
 * the product degrades — never crashes — when it is absent, and every entry is
 * documented in the page named here. Adding to this list is a product decision,
 * not a build detail: it means "a clean install cannot do X until the user
 * installs this themselves".
 */
export const OPTIONAL_EXTERNALS = [
  {
    label: '@opentelemetry/*',
    match: (spec) => spec.startsWith('@opentelemetry/'),
    reason:
      'OTel SDK — lazy-imported by the obs layer only when an OTLP endpoint is configured; ' +
      'absent it degrades to event-log-only. Bundling it would bloat every install for a ' +
      'feature almost nobody turns on.',
    docs: 'docs/concepts/observability.md',
  },
  {
    label: '@anthropic-ai/claude-agent-sdk',
    match: (spec) => spec === '@anthropic-ai/claude-agent-sdk',
    reason:
      'Claude Agent SDK — lazy-imported inside a Claude Code run only. Declaring it would add ' +
      '~200 MB to EVERY install (its per-platform optional dependency is a ~210 MB `claude` ' +
      'binary, and npm installs optional deps by default), so the lean-install posture wins and ' +
      'the Claude Code runtime asks the user to install it alongside clawboo instead.',
    docs: 'docs/runtimes/claude-code.md',
  },
]

// ─── Specifier helpers ───────────────────────────────────────────────────────

export function isNodeBuiltin(specifier) {
  return NODE_BUILTINS.has(specifier)
}

export function isRelativeSpecifier(specifier) {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(specifier)
  )
}

/** `@scope/pkg/sub/path` → `@scope/pkg`; `pkg/sub` → `pkg`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier)
}

// ─── The scanner ─────────────────────────────────────────────────────────────

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$]/
const DIGIT = /[0-9]/

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

/**
 * Can a `/` at this position open a regex literal? `prev` is the previous
 * significant token: `''` at start, `'operand'` for a literal, an identifier /
 * keyword, or a single punctuator character.
 *
 * The two genuinely ambiguous predecessors — `)` and `}` — resolve to DIVISION,
 * which is overwhelmingly the common case in generated code. Getting one of
 * those wrong can only cause a miss, never a fabricated specifier.
 */
function regexCanFollow(prev) {
  if (prev === '') return true
  if (prev === 'operand') return false
  if (IDENT_START.test(prev)) return REGEX_AFTER_KEYWORD.has(prev)
  if (prev === ')' || prev === ']' || prev === '}') return false
  return true
}

/**
 * Every literal module specifier passed to `require(...)` / `import(...)` in
 * code position, in source order (deduplicated).
 *
 * @param {string} source
 * @param {{ label?: string }} [opts]
 * @returns {string[]}
 */
export function extractModuleSpecifiers(source, opts = {}) {
  const label = opts.label ?? '<source>'
  const found = new Set()
  const n = source.length
  // Frame stack: the base code frame, plus one frame per nested template
  // literal / `${}` substitution. `depth` counts `{` nesting inside a code
  // frame so a substitution knows which `}` closes it.
  const frames = [{ kind: 'code', substitution: false, depth: 0 }]
  const top = () => frames[frames.length - 1]
  let prev = ''
  let i = 0

  /** Whitespace + comments from `p`; returns the next code index. */
  const skipTrivia = (p) => {
    for (;;) {
      while (p < n && /\s/.test(source[p])) p++
      if (source[p] === '/' && source[p + 1] === '/') {
        const nl = source.indexOf('\n', p)
        p = nl === -1 ? n : nl + 1
        continue
      }
      if (source[p] === '/' && source[p + 1] === '*') {
        const end = source.indexOf('*/', p + 2)
        p = end === -1 ? n : end + 2
        continue
      }
      return p
    }
  }

  /** Read the quoted literal at `p`; null when it isn't a usable specifier. */
  const readQuoted = (p) => {
    const quote = source[p]
    if (quote !== '"' && quote !== "'" && quote !== '`') return null
    let value = ''
    let k = p + 1
    while (k < n) {
      const c = source[k]
      if (c === '\\') {
        // A specifier never needs escapes; bail rather than mis-decode one.
        return null
      }
      if (c === quote) return { value, next: k + 1 }
      // An interpolated / multi-line specifier isn't statically knowable.
      if (c === '\n' || (quote === '`' && c === '$' && source[k + 1] === '{')) return null
      value += c
      k++
    }
    return null
  }

  /** Consume a regex literal at `p`; -1 when it isn't one after all. */
  const skipRegex = (p) => {
    let k = p + 1
    let inClass = false
    while (k < n) {
      const c = source[k]
      if (c === '\\') {
        k += 2
        continue
      }
      if (c === '\n') return -1
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        k++
        while (k < n && IDENT_PART.test(source[k])) k++
        return k
      }
      k++
    }
    return -1
  }

  while (i < n) {
    const frame = top()

    // ── Template-literal text ────────────────────────────────────────────
    if (frame.kind === 'template') {
      const c = source[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '`') {
        frames.pop()
        prev = 'operand'
        i++
        continue
      }
      if (c === '$' && source[i + 1] === '{') {
        frames.push({ kind: 'code', substitution: true, depth: 0 })
        prev = ''
        i += 2
        continue
      }
      i++
      continue
    }

    // ── Code ─────────────────────────────────────────────────────────────
    const c = source[i]

    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (c === '"' || c === "'") {
      // Consume the string wholesale (readQuoted bails on escapes, so walk it
      // here with full escape handling).
      let k = i + 1
      while (k < n) {
        if (source[k] === '\\') {
          k += 2
          continue
        }
        if (source[k] === c) {
          k++
          break
        }
        if (source[k] === '\n') break // unterminated — treat the newline as the end
        k++
      }
      i = k
      prev = 'operand'
      continue
    }
    if (c === '`') {
      frames.push({ kind: 'template', substitution: false, depth: 0 })
      i++
      continue
    }
    if (c === '/' && regexCanFollow(prev)) {
      const end = skipRegex(i)
      if (end !== -1) {
        i = end
        prev = 'operand'
        continue
      }
      prev = '/'
      i++
      continue
    }
    if (c === '{') {
      frame.depth++
      prev = '{'
      i++
      continue
    }
    if (c === '}') {
      if (frame.substitution && frame.depth === 0) {
        frames.pop() // back to the enclosing template's text
        i++
        continue
      }
      if (frame.depth > 0) frame.depth--
      prev = '}'
      i++
      continue
    }
    if (IDENT_START.test(c)) {
      let k = i + 1
      while (k < n && IDENT_PART.test(source[k])) k++
      const word = source.slice(i, k)
      // `foo.require(...)` is a method call on some object, not module loading.
      if ((word === 'require' || word === 'import') && prev !== '.') {
        let p = skipTrivia(k)
        if (source[p] === '(') {
          p = skipTrivia(p + 1)
          const lit = readQuoted(p)
          if (lit) {
            const after = skipTrivia(lit.next)
            // `require("x")` and esbuild's `__toESM(require("x"), 1)` both end
            // the specifier with `)` or `,`.
            if (source[after] === ')' || source[after] === ',') found.add(lit.value)
          }
        }
      }
      prev = word
      i = k
      continue
    }
    if (DIGIT.test(c)) {
      let k = i + 1
      while (k < n && /[0-9a-zA-Z_.]/.test(source[k])) k++
      prev = 'operand'
      i = k
      continue
    }

    prev = c
    i++
  }

  // A clean scan ends back in the base code frame. Anything else means the
  // lexer lost the thread (an unterminated template, a mis-classified regex),
  // and its output can no longer be trusted — fail loudly instead of quietly
  // under-reporting.
  if (frames.length !== 1 || frames[0].kind !== 'code') {
    throw new Error(
      `bundle scan of ${label} ended mid-literal (${frames.length} open frames) — ` +
        'the extractor needs fixing before its result can be trusted',
    )
  }

  return [...found]
}

// ─── The policy check ────────────────────────────────────────────────────────

/**
 * @typedef {object} BundleFile
 * @property {string} label     display path, e.g. `dist/server.js`
 * @property {string} source    the file's contents
 */

/**
 * Classify every external specifier in `files` against the declared deps.
 *
 * @param {{ files: BundleFile[], dependencies: Iterable<string> }} input
 * @returns {{
 *   violations: Array<{ file: string, specifier: string, package: string }>,
 *   optional: Array<{ file: string, specifier: string, entry: object }>,
 *   declared: Array<{ file: string, specifier: string }>,
 *   builtins: Array<{ file: string, specifier: string }>,
 *   relative: Array<{ file: string, specifier: string }>,
 * }}
 */
export function analyzeBundleExternals({ files, dependencies }) {
  const deps = new Set(dependencies)
  const violations = []
  const optional = []
  const declared = []
  const builtins = []
  const relative = []

  for (const file of files) {
    for (const specifier of extractModuleSpecifiers(file.source, { label: file.label }).sort()) {
      const at = { file: file.label, specifier }
      if (isRelativeSpecifier(specifier)) {
        relative.push(at)
        continue
      }
      if (isNodeBuiltin(specifier)) {
        builtins.push(at)
        continue
      }
      const pkg = packageNameOf(specifier)
      if (deps.has(pkg)) {
        declared.push(at)
        continue
      }
      const entry = OPTIONAL_EXTERNALS.find((o) => o.match(specifier))
      if (entry) {
        optional.push({ ...at, entry })
        continue
      }
      violations.push({ ...at, package: pkg })
    }
  }

  return { violations, optional, declared, builtins, relative }
}

// ─── Extractor self-check ────────────────────────────────────────────────────

const FIXTURES = [
  { name: 'plain require', src: 'const a = require("pkg-a")', want: ['pkg-a'] },
  { name: 'single quotes', src: "require('pkg-b')", want: ['pkg-b'] },
  { name: 'scoped subpath', src: 'require("@scope/pkg/sub")', want: ['@scope/pkg/sub'] },
  { name: 'dynamic import', src: 'const m = await import("pkg-c")', want: ['pkg-c'] },
  { name: 'esbuild __toESM', src: 'var x = __toESM(require("pkg-d"), 1);', want: ['pkg-d'] },
  { name: 'whitespace + newlines', src: 'require(\n  "pkg-e"\n)', want: ['pkg-e'] },
  { name: 'comment between', src: 'require(/* why */ "pkg-f")', want: ['pkg-f'] },
  // The false positives a regex-based extractor produces.
  {
    name: 'require inside a string (ajv standalone codegen)',
    src: 'equal.code = \'require("ajv/dist/runtime/equal").default\';',
    want: [],
  },
  { name: 'require inside a line comment', src: '// require("nope")\nvar x = 1', want: [] },
  { name: 'require inside a block comment', src: '/* require("nope") */ var x = 1', want: [] },
  {
    name: 'require inside a template literal',
    src: 'var t = `prefix require("nope") suffix`',
    want: [],
  },
  {
    name: 'template substitution is code',
    src: 'var t = `a${require("pkg-g")}b`',
    want: ['pkg-g'],
  },
  {
    name: 'nested template inside a substitution',
    src: 'var t = `a${ `inner ${ require("pkg-h") }` }b require("nope")`',
    want: ['pkg-h'],
  },
  {
    name: 'regex literal containing quotes and slashes',
    src: 'var re = /["\'\\/]+/g; require("pkg-i")',
    want: ['pkg-i'],
  },
  {
    name: 'regex character class containing a slash',
    src: 'var re = /[/"]/; require("pkg-j")',
    want: ['pkg-j'],
  },
  {
    name: 'division is not a regex',
    src: 'var x = (a + b) / 2; require("pkg-k")',
    want: ['pkg-k'],
  },
  { name: 'escaped quote inside a string', src: 'var s = "a\\"require(\\"nope\\")"', want: [] },
  {
    name: 'member call named require',
    src: 'mod.require("nope"); require("pkg-l")',
    want: ['pkg-l'],
  },
  { name: 'non-literal specifier is skipped', src: 'require(name)', want: [] },
  { name: 'interpolated specifier is skipped', src: 'require(`pkg-${x}`)', want: [] },
  {
    name: 'the esbuild module-path comment header',
    src: '// ../../node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/equal.js\nrequire("pkg-m")',
    want: ['pkg-m'],
  },
]

/**
 * Run the extractor over its fixtures. `scripts/` has no CI-wired Vitest
 * project (the root config globs `packages/*` only, and `pnpm test` fans out
 * per package), so the fixtures run as part of the gate itself — cheap,
 * deterministic, and it keeps the "no false positives" property honest.
 *
 * @returns {string[]} failure descriptions; empty when the extractor is sound
 */
export function selfCheckExtractor() {
  const failures = []
  for (const fixture of FIXTURES) {
    let got
    try {
      got = extractModuleSpecifiers(fixture.src, { label: fixture.name }).sort()
    } catch (err) {
      failures.push(`${fixture.name}: threw ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const want = [...fixture.want].sort()
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${fixture.name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
    }
  }
  return failures
}
