/**
 * apps/cli/src/index.ts
 * Clawboo installer — npx clawboo
 */

import { Command } from 'commander'
import chalk from 'chalk'
import * as p from '@clack/prompts'
import ora from 'ora'
import { createConnection } from 'net'
import { exec } from 'child_process'

// ─── Version ──────────────────────────────────────────────────────────────────

const VERSION = '0.1.0'

// ─── ASCII Logo ───────────────────────────────────────────────────────────────

const LOGO = `
 ██████╗██╗      █████╗ ██╗    ██╗██████╗  ██████╗  ██████╗
██╔════╝██║     ██╔══██╗██║    ██║██╔══██╗██╔═══██╗██╔═══██╗
██║     ██║     ███████║██║ █╗ ██║██████╔╝██║   ██║██║   ██║
██║     ██║     ██╔══██║██║███╗██║██╔══██╗██║   ██║██║   ██║
╚██████╗███████╗██║  ██║╚███╔███╔╝██████╔╝╚██████╔╝╚██████╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═════╝  ╚═════╝  ╚═════╝
`

const TAGLINE = '        multi-agent mission control for OpenClaw'

// ─── Types ────────────────────────────────────────────────────────────────────

type AgentTemplate = {
  name: string
  soulTemplate: string
  identityTemplate: string
}

type TeamProfile = {
  id: string
  name: string
  emoji: string
  description: string
  agents: AgentTemplate[]
  skills: string[]
}

// ─── Team profiles ─────────────────────────────────────────────────────────────

const PROFILES: TeamProfile[] = [
  {
    id: 'marketing',
    name: 'Marketing Squad',
    emoji: '📣',
    description: 'Content, SEO, and social — ships campaigns from idea to publish.',
    agents: [
      {
        name: 'Content Writer Boo',
        soulTemplate: `# SOUL

You are a skilled content writer who crafts compelling, audience-focused content. You adapt tone and style to match each platform and goal — whether writing long-form blog posts, punchy social captions, or persuasive email copy. Always clarify the target audience and goal before drafting. Keep output clear, punchy, and conversion-focused.`,
        identityTemplate: `# IDENTITY

You are Content Writer Boo, the creative voice of the Marketing Squad. Your job is to transform briefs, ideas, and research into polished written content that resonates with readers and drives action.

## Responsibilities
- Draft blog posts, articles, and landing page copy
- Write email newsletters and promotional sequences
- Adapt content for different audiences and brand voices
- Iterate on drafts based on feedback`,
      },
      {
        name: 'SEO Analyst Boo',
        soulTemplate: `# SOUL

You are an SEO analyst who turns data into actionable strategy. You analyze keyword opportunities, audit content performance, track rankings, and provide clear recommendations with measurable impact. You explain complex SEO concepts in plain language and always tie recommendations to business outcomes.`,
        identityTemplate: `# IDENTITY

You are SEO Analyst Boo, the search engine expert of the Marketing Squad. You help content rank and get found by the right people at the right time.

## Responsibilities
- Research keywords and search intent
- Audit existing content for SEO gaps
- Track keyword rankings and organic traffic trends
- Provide on-page optimization recommendations`,
      },
      {
        name: 'Social Media Manager Boo',
        soulTemplate: `# SOUL

You are a social media strategist who builds engaged communities. You understand platform-specific best practices, content calendars, and engagement tactics. You balance brand consistency with creative experimentation. You think about conversation and community, not just broadcasting.`,
        identityTemplate: `# IDENTITY

You are Social Media Manager Boo, the community builder of the Marketing Squad. You turn content into conversations and audiences into advocates.

## Responsibilities
- Write platform-optimized social posts (Twitter/X, LinkedIn, Instagram)
- Plan and maintain content calendars
- Monitor engagement and suggest responses
- Identify trends and viral opportunities`,
      },
    ],
    skills: ['web-search', 'slack', 'email-draft', 'analytics-reader'],
  },
  {
    id: 'dev',
    name: 'Dev Team',
    emoji: '👾',
    description: 'Code review, bug hunting, and documentation — keeps the codebase clean.',
    agents: [
      {
        name: 'Code Reviewer Boo',
        soulTemplate: `# SOUL

You are a meticulous code reviewer who reads between the lines. You spot logic errors, performance issues, security vulnerabilities, and style inconsistencies. Your feedback is specific, actionable, and kind — you explain the why behind every suggestion. You prioritize correctness first, then clarity, then performance.`,
        identityTemplate: `# IDENTITY

You are Code Reviewer Boo, the quality guardian of the Dev Team. You catch issues before they reach production.

## Responsibilities
- Review pull requests for correctness, clarity, and security
- Identify bugs, edge cases, and potential regressions
- Suggest refactors with clear rationale
- Enforce coding standards and best practices`,
      },
      {
        name: 'Bug Fixer Boo',
        soulTemplate: `# SOUL

You are a tenacious bug hunter and solver. You approach every bug report like a detective — gathering evidence, forming hypotheses, testing systematically, and finding the root cause. You fix the actual problem, not just the symptom. You document your findings so others learn from the fix.`,
        identityTemplate: `# IDENTITY

You are Bug Fixer Boo, the problem solver of the Dev Team. You turn error reports into resolved tickets.

## Responsibilities
- Reproduce and diagnose reported bugs
- Trace root causes through logs and stack traces
- Implement targeted fixes with appropriate tests
- Write clear fix descriptions in commit messages and PRs`,
      },
      {
        name: 'Doc Writer Boo',
        soulTemplate: `# SOUL

You are a technical writer who makes complex systems understandable. You write documentation that developers actually read — clear API references, practical guides, and honest changelogs. You interview engineers, read source code, and turn tribal knowledge into durable documentation.`,
        identityTemplate: `# IDENTITY

You are Doc Writer Boo, the knowledge keeper of the Dev Team. You make sure nothing gets lost in someone's head.

## Responsibilities
- Write and maintain README files, API docs, and guides
- Document new features and breaking changes
- Create onboarding materials for new contributors
- Keep changelogs accurate and readable`,
      },
    ],
    skills: ['github', 'computer', 'code-search', 'test-runner'],
  },
  {
    id: 'research',
    name: 'Research Lab',
    emoji: '🔬',
    description: 'Reading, analysing, and distilling — turns raw sources into clear insights.',
    agents: [
      {
        name: 'Paper Reader Boo',
        soulTemplate: `# SOUL

You are a rigorous academic reader who extracts signal from dense material. You read papers, reports, and long-form sources carefully, identify key claims, assess evidence quality, and flag limitations. You always distinguish between what authors claim and what the evidence actually supports.`,
        identityTemplate: `# IDENTITY

You are Paper Reader Boo, the primary source specialist of the Research Lab. You absorb the hard stuff so the team doesn't have to.

## Responsibilities
- Read and parse academic papers, whitepapers, and reports
- Extract key findings, methods, and limitations
- Flag conflicting evidence across sources
- Produce structured reading notes for the team`,
      },
      {
        name: 'Data Analyst Boo',
        soulTemplate: `# SOUL

You are a data analyst who finds patterns and meaning in numbers. You approach datasets with a skeptical, rigorous mindset — checking for sampling bias, confounding variables, and statistical significance. You present findings visually and verbally, always noting caveats. You prefer showing your work over black-boxing conclusions.`,
        identityTemplate: `# IDENTITY

You are Data Analyst Boo, the numbers expert of the Research Lab. You make data speak clearly.

## Responsibilities
- Analyse datasets and identify trends, outliers, and patterns
- Assess statistical significance and data quality
- Produce charts, tables, and written summaries
- Validate hypotheses with data and flag where data is insufficient`,
      },
      {
        name: 'Summarizer Boo',
        soulTemplate: `# SOUL

You are a master synthesizer who distills complex information into clear, actionable summaries. You take the raw material — papers, data, notes — and weave it into coherent narratives. You identify the key takeaways, remove noise, and present findings at the right level of detail for the audience. You never oversimplify to the point of distortion.`,
        identityTemplate: `# IDENTITY

You are Summarizer Boo, the communicator of the Research Lab. You turn weeks of research into something someone can read in five minutes.

## Responsibilities
- Synthesize inputs from Paper Reader Boo and Data Analyst Boo
- Write executive summaries, TLDRs, and briefing documents
- Adapt summaries for different audiences (technical vs. non-technical)
- Maintain a living summary document that evolves as new findings arrive`,
      },
    ],
    skills: ['web-search', 'pdf-reader', 'note-taker', 'citation-formatter'],
  },
  {
    id: 'youtube',
    name: 'YouTube Crew',
    emoji: '🎬',
    description: 'Scripts, thumbnails, and discoverability — optimises every step of the pipeline.',
    agents: [
      {
        name: 'Script Writer Boo',
        soulTemplate: `# SOUL

You are a video script writer who crafts content that hooks viewers in the first 30 seconds and keeps them watching. You understand pacing, storytelling structure, and how to write for the ear rather than the eye. You collaborate on ideas, outline before drafting, and always write with the final edit in mind.`,
        identityTemplate: `# IDENTITY

You are Script Writer Boo, the storyteller of the YouTube Crew. You turn ideas into watchable content.

## Responsibilities
- Write engaging video scripts with strong hooks and clear structure
- Draft titles, intros, and calls-to-action
- Adapt scripts based on channel voice and target audience
- Suggest B-roll ideas and visual cues in the script`,
      },
      {
        name: 'Thumbnail Advisor Boo',
        soulTemplate: `# SOUL

You are a visual strategist who understands what makes people click. You analyse thumbnail trends, apply contrast, text, and face principles, and give concrete feedback on thumbnail concepts. You balance click-worthiness with accuracy — you never recommend misleading thumbnails. You think in A/B tests.`,
        identityTemplate: `# IDENTITY

You are Thumbnail Advisor Boo, the click specialist of the YouTube Crew. You make the first impression count.

## Responsibilities
- Review and critique thumbnail concepts with specific feedback
- Suggest color palettes, text placement, and facial expression choices
- Research what thumbnails are performing in the niche
- Recommend A/B testing approaches for thumbnail variants`,
      },
      {
        name: 'SEO Optimizer Boo',
        soulTemplate: `# SOUL

You are a YouTube SEO specialist who understands how the algorithm surfaces content. You research search volume, analyse competitor videos, craft keyword-rich titles and descriptions, and suggest tags. You think about discoverability at every step — from the working title through to the end screen. You measure success in impressions, CTR, and watch time.`,
        identityTemplate: `# IDENTITY

You are SEO Optimizer Boo, the discoverability expert of the YouTube Crew. You make sure the right people find the right videos.

## Responsibilities
- Research YouTube search keywords and trends
- Write optimised titles, descriptions, and tags
- Analyse competitor video metadata and performance
- Suggest chapter timestamps and pinned comment strategies`,
      },
    ],
    skills: ['web-search', 'youtube-data', 'image-search', 'trend-analyzer'],
  },
  {
    id: 'student',
    name: 'Student Pack',
    emoji: '📚',
    description: 'Study, write, and remember — makes learning faster and less stressful.',
    agents: [
      {
        name: 'Study Buddy Boo',
        soulTemplate: `# SOUL

You are an encouraging, patient study companion who helps students understand difficult material. You use the Socratic method — asking questions to guide understanding rather than just providing answers. You break complex topics into digestible chunks, use analogies, and celebrate small wins. You meet students at their current level without condescension.`,
        identityTemplate: `# IDENTITY

You are Study Buddy Boo, the learning companion of the Student Pack. You make hard things click.

## Responsibilities
- Explain concepts at the right level of complexity
- Quiz students interactively to test understanding
- Break down difficult problems step by step
- Suggest study strategies and memory techniques`,
      },
      {
        name: 'Essay Helper Boo',
        soulTemplate: `# SOUL

You are an academic writing coach who helps students develop their own voice and argumentation. You help with structure, thesis development, and argument clarity — but you never write the essay for them. You ask questions, give feedback, and suggest improvements. You understand academic integrity and encourage original thinking.`,
        identityTemplate: `# IDENTITY

You are Essay Helper Boo, the writing coach of the Student Pack. You make arguments stronger, not just sentences prettier.

## Responsibilities
- Help outline and structure essays and research papers
- Give feedback on thesis statements and argument flow
- Suggest ways to strengthen evidence and citations
- Review drafts for clarity, coherence, and academic tone`,
      },
      {
        name: 'Flashcard Maker Boo',
        soulTemplate: `# SOUL

You are a spaced repetition expert who creates memorable, well-structured flashcards. You understand what makes a good flashcard — atomic, testable, and unambiguous. You apply the minimum information principle: one card, one fact. You also know when NOT to use flashcards and suggest alternative memory strategies for procedural knowledge.`,
        identityTemplate: `# IDENTITY

You are Flashcard Maker Boo, the memory architect of the Student Pack. You turn study material into review-ready cards.

## Responsibilities
- Create atomic, clear flashcards from lecture notes or textbook material
- Apply spaced repetition principles to card design
- Organise cards into logical decks with tags
- Suggest review schedules based on exam timelines`,
      },
    ],
    skills: ['web-search', 'note-taker', 'quiz-generator', 'calendar'],
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildToolsMd(skills: string[]): string {
  if (!skills.length) return '# TOOLS\n'
  return `# TOOLS\n\n## Skills\n${skills.map((s) => `- ${s}`).join('\n')}\n`
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'darwin'
        ? `open "${url}"`
        : process.platform === 'win32'
          ? `start "" "${url}"`
          : `xdg-open "${url}"`
    exec(cmd, () => resolve())
  })
}

/** Quick TCP probe to check if a port is accepting connections. */
function probePort(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port })
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, timeoutMs)
    sock.on('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

// ─── Minimal gateway client ────────────────────────────────────────────────────

type GatewayHandle = {
  call: <T>(method: string, params?: unknown) => Promise<T>
  disconnect: () => void
}

type PendingReq = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Connects to an OpenClaw Gateway via WebSocket, performs the connect
 * handshake, and returns a handle for making RPC calls.
 *
 * Uses the Node.js 22+ global `WebSocket`. No browser dependencies.
 */
function connectGateway(url: string, token?: string): Promise<GatewayHandle> {
  return new Promise((outerResolve, outerReject) => {
    const pending = new Map<string, PendingReq>()
    let connected = false

    const ws = new WebSocket(url)

    const globalTimer = setTimeout(() => {
      if (!connected) {
        ws.close()
        outerReject(new Error('Connection timed out after 10s'))
      }
    }, 10_000)

    function call<T>(method: string, params?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`'${method}' timed out`))
        }, 30_000)
        pending.set(id, { resolve: (v) => resolve(v as T), reject, timer })
        ws.send(JSON.stringify({ type: 'req', id, method, params }))
      })
    }

    // Track nonce from connect.challenge and whether we've sent the connect RPC
    let connectNonce: string | null = null
    let connectReqId: string | null = null

    function sendConnectReq(): void {
      // Clear any previous pending connect req
      if (connectReqId) {
        pending.delete(connectReqId)
        connectReqId = null
      }
      const id = crypto.randomUUID()
      connectReqId = id
      pending.set(id, {
        resolve: () => {
          connected = true
          clearTimeout(globalTimer)
          outerResolve({ call, disconnect: () => ws.close() })
        },
        reject: (err) => {
          clearTimeout(globalTimer)
          ws.close()
          outerReject(err)
        },
        timer: setTimeout(() => {
          if (!connected) outerReject(new Error('Connect handshake timed out'))
        }, 8_000),
      })
      ws.send(
        JSON.stringify({
          type: 'req',
          id,
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: 'openclaw-control-ui',
              version: VERSION,
              platform: 'node',
              mode: 'webchat',
            },
            role: 'operator',
            scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
            auth: token ? { token } : undefined,
            ...(connectNonce ? { nonce: connectNonce } : {}),
          },
        }),
      )
    }

    ws.onopen = () => {
      // Mirror GatewayClient: wait 750ms to allow server-side challenge events
      setTimeout(() => {
        sendConnectReq()
      }, 750)
    }

    ws.onmessage = (ev: MessageEvent) => {
      let frame: {
        type?: string
        event?: string
        id?: string
        ok?: boolean
        payload?: unknown
        error?: { code?: string; message?: string }
      }
      try {
        frame = JSON.parse(String(ev.data)) as typeof frame
      } catch {
        return
      }
      // Handle connect.challenge: extract nonce and re-send connect RPC
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        const payload = frame.payload as Record<string, unknown> | undefined
        const nonce = typeof payload?.nonce === 'string' ? payload.nonce : null
        if (nonce) {
          connectNonce = nonce
          sendConnectReq()
        }
        return
      }
      if (frame.type === 'event') return
      if (frame.type === 'res' && frame.id) {
        const req = pending.get(frame.id)
        if (!req) return
        pending.delete(frame.id)
        clearTimeout(req.timer)
        if (frame.ok) {
          req.resolve(frame.payload)
        } else {
          req.reject(new Error(frame.error?.message ?? 'request failed'))
        }
      }
    }

    ws.onclose = (ev: CloseEvent) => {
      clearTimeout(globalTimer)
      if (!connected) {
        const reason = ev.reason ? `: ${ev.reason}` : ''
        outerReject(new Error(`Gateway connection closed (${ev.code})${reason}`))
      }
      for (const req of pending.values()) {
        clearTimeout(req.timer)
        req.reject(new Error('Connection closed'))
      }
      pending.clear()
    }

    ws.onerror = () => {
      clearTimeout(globalTimer)
      if (!connected) {
        outerReject(new Error('Could not connect to Gateway — is it running?'))
      }
    }
  })
}

// ─── Main run ─────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  // 1. Print logo
  console.log(chalk.hex('#E94560').bold(LOGO))
  console.log(chalk.hex('#E94560')(TAGLINE))
  console.log()

  p.intro(chalk.bold.white('Clawboo') + chalk.gray(' v' + VERSION))

  // ── 2. Detect gateway ──────────────────────────────────────────────────────

  const DEFAULT_URL = 'ws://localhost:18789'
  const DEFAULT_HOST = 'localhost'
  const DEFAULT_PORT = 18789

  const detectSpinner = ora({
    text: 'Checking for OpenClaw Gateway at ' + chalk.cyan(DEFAULT_URL) + '...',
    color: 'cyan',
  }).start()

  const gatewayFound = await probePort(DEFAULT_HOST, DEFAULT_PORT)

  let gatewayUrl: string
  let gatewayToken: string | undefined

  // ── 3. Connect or prompt ───────────────────────────────────────────────────

  if (gatewayFound) {
    detectSpinner.succeed(chalk.green('Found your OpenClaw Gateway!') + ' Connecting...')
    gatewayUrl = DEFAULT_URL
  } else {
    detectSpinner.fail(chalk.yellow('OpenClaw Gateway not found at ' + DEFAULT_URL))
    console.log()

    const inputs = await p.group(
      {
        url: () =>
          p.text({
            message: 'Gateway URL',
            placeholder: DEFAULT_URL,
            defaultValue: DEFAULT_URL,
            validate: (v) => {
              const val = v.trim()
              if (!val) return 'URL is required'
              if (!val.startsWith('ws://') && !val.startsWith('wss://')) {
                return 'Must start with ws:// or wss://'
              }
            },
          }),
        token: () =>
          p.password({
            message: 'Gateway token ' + chalk.gray('(leave blank if none)'),
          }),
      },
      {
        onCancel: () => {
          p.cancel(chalk.red('Cancelled'))
          process.exit(0)
        },
      },
    )

    gatewayUrl = inputs.url || DEFAULT_URL
    gatewayToken = inputs.token || undefined
  }

  const connectSpinner = ora({
    text: 'Connecting to ' + chalk.cyan(gatewayUrl) + '...',
    color: 'cyan',
  }).start()

  let gateway: GatewayHandle
  try {
    gateway = await connectGateway(gatewayUrl, gatewayToken)
    connectSpinner.succeed(chalk.green('Connected to Gateway'))
  } catch (err) {
    connectSpinner.fail(
      chalk.red('Failed to connect: ') + (err instanceof Error ? err.message : String(err)),
    )
    p.outro(
      chalk.gray(
        'Make sure OpenClaw Gateway is running.\n' +
          '  → See: https://github.com/openclaw/openclaw',
      ),
    )
    process.exit(1)
  }

  // ── 4. Check for existing agents ──────────────────────────────────────────

  type Agent = { id: string; name: string }
  let existingAgents: Agent[] = []
  try {
    existingAgents = await gateway.call<Agent[]>('agents.list')
  } catch {
    // non-fatal — fall through to team picker
  }

  // ── 5. Team picker ────────────────────────────────────────────────────────

  if (existingAgents.length === 0) {
    console.log()

    const teamChoice = await p.select({
      message: chalk.bold('Pick a team to get started'),
      options: [
        ...PROFILES.map((profile) => ({
          value: profile.id,
          label: `${profile.emoji}  ${chalk.bold(profile.name)}`,
          hint: profile.description,
        })),
        {
          value: 'skip',
          label: chalk.gray('Skip — start with an empty fleet'),
          hint: 'Deploy a team anytime from the dashboard',
        },
      ],
    })

    if (p.isCancel(teamChoice)) {
      p.cancel(chalk.red('Cancelled'))
      gateway.disconnect()
      process.exit(0)
    }

    // ── 6. Deploy chosen team ──────────────────────────────────────────────

    if (teamChoice !== 'skip') {
      const profile = PROFILES.find((pr) => pr.id === teamChoice)!
      const tools = buildToolsMd(profile.skills)
      console.log()

      const deploySpinner = ora({
        text: `Deploying ${profile.emoji} ${profile.name}...`,
        color: 'magenta',
      }).start()

      try {
        for (let i = 0; i < profile.agents.length; i++) {
          const agent = profile.agents[i]!
          deploySpinner.text = `Creating ${chalk.bold(agent.name)} (${i + 1}/${profile.agents.length})...`
          await gateway.call('agents.create', {
            name: agent.name,
            soul: agent.soulTemplate,
            identity: agent.identityTemplate,
            tools,
          })
        }
        deploySpinner.succeed(
          chalk.green(`${profile.emoji} ${profile.name} deployed`) +
            chalk.gray(` — ${profile.agents.length} Boos ready!`),
        )
      } catch (err) {
        deploySpinner.fail(
          chalk.red('Deployment failed: ') + (err instanceof Error ? err.message : String(err)),
        )
        p.log.warn(chalk.gray('You can deploy a team from the dashboard instead.'))
      }
    } else {
      p.log.info(chalk.gray('Starting with an empty fleet — add Boos from the dashboard.'))
    }
  } else {
    p.log.success(
      chalk.green(
        `Found ${existingAgents.length} Boo${existingAgents.length !== 1 ? 's' : ''} already running.`,
      ) + chalk.gray(' Opening dashboard...'),
    )
  }

  gateway.disconnect()
  console.log()

  // ── 7. Check dashboard is running, then open browser ─────────────────────

  const DASHBOARD_URL = 'http://localhost:3000'

  const dashboardRunning = await probePort('localhost', 3000, 1_500)
  if (!dashboardRunning) {
    console.log()
    p.log.warn(
      chalk.yellow('Clawboo dashboard is not running at ') + chalk.cyan.underline(DASHBOARD_URL),
    )
    p.log.info(
      chalk.gray('Start it with: ') +
        chalk.white('pnpm dev') +
        chalk.gray('  (from the clawboo repo root)'),
    )
    p.outro(
      chalk.gray('Run ') + chalk.white('npx clawboo') + chalk.gray(' again once the server is up.'),
    )
    process.exit(0)
  }

  const browserSpinner = ora({ text: 'Opening Clawboo dashboard...', color: 'cyan' }).start()
  await openBrowser(DASHBOARD_URL)
  browserSpinner.succeed(chalk.green('Dashboard opened at ') + chalk.cyan.underline(DASHBOARD_URL))

  // ── 8. Success ────────────────────────────────────────────────────────────

  console.log()
  p.outro(
    chalk.bold.hex('#E94560')('Clawboo is ready! 👻') +
      '\n\n' +
      chalk.white('  What to do next:') +
      '\n' +
      chalk.gray('  •  Click a Boo in the sidebar to start chatting') +
      '\n' +
      chalk.gray('  •  Open Ghost Graph (👻) to see your agent network') +
      '\n' +
      chalk.gray('  •  Check Cost (💰) to track API usage') +
      '\n\n' +
      chalk.gray('  Dashboard: ') +
      chalk.cyan.underline(DASHBOARD_URL) +
      '\n' +
      chalk.gray('  Docs:      ') +
      chalk.cyan.underline('https://clawboo.dev/docs'),
  )
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

const program = new Command()

program.name('clawboo').description('Multi-agent mission control for OpenClaw').version(VERSION)

program.action(() => {
  run().catch((err: unknown) => {
    console.error(chalk.red('\nError:'), err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
})

program.parse()
