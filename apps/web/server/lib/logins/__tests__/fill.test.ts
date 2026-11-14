// The login fill end to end against a fake browser whose pages run the real page
// scripts: a saved login and a 1Password item each land in the agent's page; a page
// on another origin gets nothing; a CAPTCHA hands the task back; and no value shows
// up in what the agent reads, the audit row, the event log or the server's log.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, claimTask, createTask, getTask, listAudit, listEvents, teams } from '@clawboo/db'
import { connectInMemoryClient, createToolsServer } from '@clawboo/mcp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Every line any module logs, so the test can look for a value in it.
const logged = vi.hoisted(() => [] as unknown[])
vi.mock('@clawboo/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawboo/logger')>()
  const record =
    () =>
    (...args: unknown[]) => {
      logged.push(args)
    }
  const fake = {
    trace: record(),
    debug: record(),
    info: record(),
    warn: record(),
    error: record(),
    fatal: record(),
    child: () => fake,
  }
  return { ...actual, createLogger: () => fake }
})

const { getDb, getDbPath, resetDb } = await import('../../db')
const { setAgentPageRunner, setPersonInControlCheck } = await import('../browserLink')
const { fillLogin, outcomeText } = await import('../fill')
const { resetFilledValuesForTests, maskFilledValues } = await import('../filledValues')
const { setOnePasswordClientFactory, connectOnePassword } = await import('../onePassword')
const { addSavedLogin } = await import('../store')
const { loginFillTools } = await import('../tool')
const { openRunRef, resetRunRefsForTests } = await import('../../runPerson')
const { totpCode } = await import('../totp')
const {
  CAPTCHA_FORM,
  CARD_CHECK_PAGE,
  FakeBrowser,
  LOGIN_FORM,
  LOGIN_FORM_WITH_CODE,
  NO_FORM_PAGE,
  makePage,
} = await import('./fakeBrowser')

const AGENT = 'coder'
const TEAM = 'T'
const LOCAL = { id: 'local', name: 'You', role: null }
const ADA = { id: 'user-ada', name: 'Ada', role: 'member' }

// Values long and odd enough that a stray copy anywhere is unmistakable.
const USERNAME = 'ada.lovelace+fill@example.com'
const PASSWORD = 'Pa55-correct-horse-battery-staple'
const OTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const OP_USERNAME = 'grace.hopper.1password@example.com'
const OP_PASSWORD = 'OnePassword-Secret-Value-42xyz'
const OP_TOKEN = 'ops_fake-service-account-token-value-0123456789'

let home: string
const prev: Record<string, string | undefined> = {}
let browser: InstanceType<typeof FakeBrowser> | null = null

/** The agent's browser: `pages[0]` is its current tab. */
function useBrowser(...pages: ReturnType<typeof makePage>[]): InstanceType<typeof FakeBrowser> {
  const fake = new FakeBrowser(pages)
  browser = fake
  setAgentPageRunner((owner, fn, args, origin) =>
    owner.agentId === AGENT
      ? fake.runner(owner, fn, args, origin)
      : Promise.resolve({ kind: 'no_browser' }),
  )
  return fake
}

function fieldValue(page: ReturnType<typeof makePage>, id: string): string {
  return (page.dom.window.document.getElementById(id) as HTMLInputElement).value
}

/** Every string a value could have leaked into, joined. */
function everythingWritten(extra: unknown[] = []): string {
  const db = getDb()
  return JSON.stringify([
    listEvents(db, { limit: 10_000 }),
    listAudit(db, { limit: 10_000 }),
    logged,
    extra,
  ])
}

function expectNoValue(text: string, values: string[]): void {
  for (const v of values) expect(text).not.toContain(v)
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-login-fill-'))
  await mkdir(path.join(home, '.clawboo'), { recursive: true })
  for (const name of ['HOME', 'CLAWBOO_HOME', 'CLAWBOO_SECRETS_MASTER_KEY']) {
    prev[name] = process.env[name]
  }
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = home
  delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
  expect(getDbPath().startsWith(home)).toBe(true)
  const db = getDb()
  const now = Date.now()
  db.insert(teams)
    .values({ id: TEAM, name: 'Team', icon: 'x', color: 'x', createdAt: now, updatedAt: now })
    .run()
  db.insert(agents)
    .values({
      id: AGENT,
      name: 'Coder',
      gatewayId: AGENT,
      teamId: TEAM,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  logged.length = 0
})

afterEach(async () => {
  setAgentPageRunner(null)
  setPersonInControlCheck(null)
  setOnePasswordClientFactory(null)
  resetFilledValuesForTests()
  resetRunRefsForTests()
  browser = null
  resetDb()
  for (const [name, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(home, { recursive: true, force: true })
})

function saveLogin(site: string, ownerId = LOCAL.id, otp = false): void {
  const r = addSavedLogin({
    site,
    username: USERNAME,
    password: PASSWORD,
    ...(otp ? { oneTimeCodeSecret: OTP_SECRET } : {}),
    ownerId,
  })
  expect(r.ok).toBe(true)
}

const asLocal = { person: LOCAL, basis: 'started' as const }

describe('fillLogin with a saved login', () => {
  it('fills the username and password into the agent page and returns no value', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM })
    const fake = useBrowser(page)

    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })

    expect(out).toMatchObject({
      outcome: 'filled',
      fields: ['username', 'password'],
      source: 'saved',
    })
    expect(fieldValue(page, 'user')).toBe(USERNAME)
    expect(fieldValue(page, 'pass')).toBe(PASSWORD)
    // Frameworks hear the change.
    // A probe with no values, then one fill.
    expect(fake.runs.map((r) => r.args.length)).toEqual([0, 4])
    expect(page.inputEvents).toEqual(['user', 'pass'])
    const text = outcomeText(out)
    expect(text).toMatch(/^filled:/)
    expectNoValue(JSON.stringify(out) + text + everythingWritten(), [USERNAME, PASSWORD])
  })

  it('fills the current one-time code when the page asks for one', async () => {
    saveLogin('bank.example', LOCAL.id, true)
    const page = makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM_WITH_CODE })
    useBrowser(page)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'https://bank.example/x',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({
      outcome: 'filled',
      fields: ['username', 'password', 'one_time_code'],
    })
    const code = fieldValue(page, 'code')
    expect(code).toMatch(/^\d{6}$/)
    // The code of now or the step before (a step boundary may pass mid-test).
    expect([totpCode(OTP_SECRET), totpCode(OTP_SECRET, Date.now() - 30_000)]).toContain(code)
    expectNoValue(outcomeText(out) + everythingWritten(), [OTP_SECRET, PASSWORD])
  })

  it('fills only the fields the page shows: a username-first step gets no password', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', {
      url: 'https://bank.example/login',
      html: '<form><input id="user" type="email" autocomplete="username" /><button>Next</button></form>',
    })
    const fake = useBrowser(page)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'filled', fields: ['username'] })
    const sent = JSON.stringify(fake.valueRuns().map((r) => r.args))
    expect(sent).toContain(USERNAME)
    expect(sent).not.toContain(PASSWORD)
  })
})

describe('the origin check on the live page', () => {
  it('refuses a page on another origin and sends it nothing', async () => {
    saveLogin('bank.example')
    const phish = makePage('t1', { url: 'https://bank-example.evil.test/login', html: LOGIN_FORM })
    const fake = useBrowser(phish)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toEqual({
      outcome: 'refused',
      origin: 'https://bank.example',
      reason: 'not_on_site',
    })
    expect(fake.valueRuns()).toHaveLength(0)
    expect(fieldValue(phish, 'pass')).toBe('')
  })

  it('does not take the agent at its word: naming the other site finds no login for it', async () => {
    saveLogin('bank.example')
    const phish = makePage('t1', { url: 'https://evil.test/login', html: LOGIN_FORM })
    const fake = useBrowser(phish)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'evil.test',
      runPerson: asLocal,
    })
    expect(out.outcome).toBe('no_saved_login')
    expect(fake.valueRuns()).toHaveLength(0)
  })

  it('refuses http, and a subdomain of the saved site', async () => {
    saveLogin('bank.example')
    const sub = makePage('t1', { url: 'https://login.bank.example/', html: LOGIN_FORM })
    const fake = useBrowser(sub)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'not_on_site' })
    expect(fake.valueRuns()).toHaveLength(0)
    const insecure = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'http://bank.example',
      runPerson: asLocal,
    })
    expect(insecure).toMatchObject({ outcome: 'refused', reason: 'insecure_site' })
    const plain = makePage('t2', { url: 'http://bank.example/', html: LOGIN_FORM })
    const plainBrowser = useBrowser(plain)
    const downgraded = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(downgraded).toMatchObject({ outcome: 'refused', reason: 'not_on_site' })
    expect(plainBrowser.valueRuns()).toHaveLength(0)
  })

  it('refuses a tab whose main frame the browser reports elsewhere', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', {
      url: 'https://bank.example/login',
      html: LOGIN_FORM,
      frameUrl: 'https://evil.test/login',
    })
    const fake = useBrowser(page)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'not_on_site' })
    expect(fake.valueRuns()).toHaveLength(0)
  })

  it("refuses when the page's own origin is not the site, whatever the frame reports", async () => {
    saveLogin('bank.example')
    const page = makePage('t1', {
      url: 'https://evil.test/login',
      html: LOGIN_FORM,
      frameUrl: 'https://bank.example/login',
    })
    const fake = useBrowser(page)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'not_on_site' })
    expect(fake.valueRuns()).toHaveLength(0)
  })

  it('a page that navigated away between the probe and the fill gets nothing', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM })
    const elsewhere = makePage('t1', { url: 'https://evil.test/login', html: LOGIN_FORM })
    const fake = useBrowser(page)
    fake.beforeFill = () => elsewhere
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'not_on_site' })
    expect(fieldValue(elsewhere, 'user')).toBe('')
    expect(fieldValue(elsewhere, 'pass')).toBe('')
  })
})

describe('whose logins a run may use', () => {
  it('a run with no person fills nothing and never opens the browser', async () => {
    saveLogin('bank.example')
    const fake = useBrowser(makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM }))
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: { person: null, basis: 'none' },
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'no_person' })
    expect(fake.runs).toHaveLength(0)
  })

  it("a run of one person never fills another person's login", async () => {
    saveLogin('bank.example', ADA.id)
    const fake = useBrowser(makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM }))
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out.outcome).toBe('no_saved_login')
    // The page is checked first (a probe with no values); nothing is filled.
    expect(fake.valueRuns()).toHaveLength(0)
  })
})

describe('1Password as a source', () => {
  function fake1Password(websites: { url: string; autofillBehavior?: string }[]) {
    const tokensSeen: string[] = []
    setOnePasswordClientFactory(async (token) => {
      tokensSeen.push(token)
      return {
        listVaultIds: async () => ['v1'],
        listLoginItems: async () => [{ id: 'i1', vaultId: 'v1', websites }],
        getItem: async () => ({
          fields: [
            { id: 'username', title: 'username', fieldType: 'Text', value: OP_USERNAME },
            { id: 'password', title: 'password', fieldType: 'Concealed', value: OP_PASSWORD },
          ],
        }),
      }
    })
    return tokensSeen
  }

  it('fills a 1Password item found by the page site', async () => {
    const tokens = fake1Password([
      { url: 'https://shop.example/account', autofillBehavior: 'AnywhereOnWebsite' },
    ])
    expect(await connectOnePassword(LOCAL.id, OP_TOKEN)).toEqual({ ok: true, vaults: 1 })
    const page = makePage('t1', { url: 'https://shop.example/signin', html: LOGIN_FORM })
    useBrowser(page)

    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'shop.example',
      runPerson: asLocal,
    })

    expect(out).toMatchObject({
      outcome: 'filled',
      source: '1password',
      fields: ['username', 'password'],
    })
    expect(fieldValue(page, 'user')).toBe(OP_USERNAME)
    expect(fieldValue(page, 'pass')).toBe(OP_PASSWORD)
    expect(tokens.every((t) => t === OP_TOKEN)).toBe(true)
    expectNoValue(outcomeText(out) + everythingWritten([out]), [OP_USERNAME, OP_PASSWORD, OP_TOKEN])
    // What the agent's own browser tools return is masked from now on.
    expect(maskFilledValues(AGENT, `value="${OP_PASSWORD}"`)).not.toContain(OP_PASSWORD)
  })

  it('skips an item set never to fill, and an item for another site', async () => {
    fake1Password([
      { url: 'https://shop.example', autofillBehavior: 'Never' },
      { url: 'https://other.example' },
    ])
    await connectOnePassword(LOCAL.id, OP_TOKEN)
    const page = makePage('t1', { url: 'https://shop.example/signin', html: LOGIN_FORM })
    useBrowser(page)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'shop.example',
      runPerson: asLocal,
    })
    expect(out.outcome).toBe('no_saved_login')
    expect(fieldValue(page, 'pass')).toBe('')
  })

  it('a 1Password that cannot be read is a needs-you, not a value in an error', async () => {
    fake1Password([{ url: 'https://shop.example' }])
    await connectOnePassword(LOCAL.id, OP_TOKEN)
    setOnePasswordClientFactory(async () => {
      throw new Error(`invalid service account token ${OP_TOKEN}`)
    })
    useBrowser(makePage('t1', { url: 'https://shop.example/signin', html: LOGIN_FORM }))
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'shop.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'needs_you', reason: 'login_source' })
    expectNoValue(outcomeText(out) + everythingWritten([out]), [OP_TOKEN])
  })
})

describe('what only a person can do', () => {
  function boundTask(): string {
    const db = getDb()
    const t = createTask(db, { title: 'buy the thing', teamId: TEAM, requestedBy: ADA })
    claimTask(db, t.id, AGENT)
    return t.id
  }

  it('a CAPTCHA fills what it can, then hands the task back to its person', async () => {
    saveLogin('bank.example')
    const taskId = boundTask()
    const page = makePage('t1', { url: 'https://bank.example/login', html: CAPTCHA_FORM })
    useBrowser(page)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
      taskId,
    })
    expect(out).toMatchObject({ outcome: 'needs_you', reason: 'captcha', handedBack: true })
    expect(fieldValue(page, 'pass')).toBe(PASSWORD)
    const task = getTask(getDb(), taskId)
    expect(task?.status).toBe('blocked')
    expect(task?.assigneePersonId).toBe(ADA.id)
    const announced = listEvents(getDb(), { limit: 100 }).filter(
      (e) => e.kind === 'status_changed' && e.taskId === taskId,
    )
    expect(announced.some((e) => JSON.parse(e.data).reason === 'login_needs_person')).toBe(true)
    expectNoValue(outcomeText(out) + everythingWritten([out, task]), [USERNAME, PASSWORD])
  })

  it('a card check is never filled', async () => {
    saveLogin('bank.example')
    const fake = useBrowser(
      makePage('t1', { url: 'https://bank.example/pay', html: CARD_CHECK_PAGE }),
    )
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'needs_you', reason: 'card_check', handedBack: false })
    expect(fake.valueRuns()).toHaveLength(0)
    expect(outcomeText(out)).toMatch(/tell the person/)
  })

  it('a page with no sign-in field gets no value', async () => {
    saveLogin('bank.example')
    const fake = useBrowser(makePage('t1', { url: 'https://bank.example/', html: NO_FORM_PAGE }))
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'no_form' })
    expect(fake.valueRuns()).toHaveLength(0)
  })

  it('an agent with no browser open is told to open one', async () => {
    saveLogin('bank.example')
    setAgentPageRunner(async () => ({ kind: 'no_browser' }))
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'no_browser' })
  })
})

describe('fill_login as the agent calls it', () => {
  it('goes through the tools server: the result and the audit row hold no value', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM })
    useBrowser(page)
    const run = openRunRef(AGENT, { person: LOCAL, basis: 'started' })
    const server = createToolsServer(getDb(), {
      agentId: AGENT,
      teamId: TEAM,
      hostTools: () => loginFillTools({ agentId: AGENT, taskId: null, runRef: run.ref }),
    })
    const client = await connectInMemoryClient(server)
    try {
      const tools = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('fill_login')
      const result = await client.callTool('fill_login', { site: 'bank.example' })
      expect(result.isError).toBe(false)
      expect(result.output).toMatch(/^filled:/)
      expect(fieldValue(page, 'pass')).toBe(PASSWORD)
      const audit = listAudit(getDb(), { toolName: 'fill_login' })
      expect(audit.length).toBeGreaterThan(0)
      expectNoValue(result.output + everythingWritten([audit]), [USERNAME, PASSWORD])
    } finally {
      await client.close()
      run.release()
    }
  })

  it('is not offered to a run with no person, to another agent, or after the run ends', async () => {
    useBrowser()
    const none = openRunRef(AGENT, { person: null, basis: 'none' })
    expect(loginFillTools({ agentId: AGENT, taskId: null, runRef: none.ref })).toHaveLength(0)
    const mine = openRunRef(AGENT, { person: LOCAL, basis: 'started' })
    expect(
      loginFillTools({ agentId: 'someone-else', taskId: null, runRef: mine.ref }),
    ).toHaveLength(0)
    expect(loginFillTools({ agentId: AGENT, taskId: null, runRef: mine.ref })).toHaveLength(1)
    mine.release()
    expect(loginFillTools({ agentId: AGENT, taskId: null, runRef: mine.ref })).toHaveLength(0)
  })

  it('is offered to a session with no run reference (a live URL), and refuses there with no run', async () => {
    saveLogin('bank.example')
    const fake = useBrowser(makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM }))
    const [tool] = loginFillTools({ agentId: AGENT, taskId: null, runRef: null })
    expect(tool?.name).toBe('fill_login')
    const text = await tool!.executor({ site: 'bank.example' }, { availability: {} as never })
    expect(String(text)).toMatch(/^refused: this run belongs to no person/)
    expect(fake.runs).toHaveLength(0)
  })

  it('is not offered while nothing can reach agent browsers', () => {
    setAgentPageRunner(null)
    const mine = openRunRef(AGENT, { person: LOCAL, basis: 'started' })
    expect(loginFillTools({ agentId: AGENT, taskId: null, runRef: mine.ref })).toHaveLength(0)
  })

  it('a run released after the list was built fills nothing', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM })
    useBrowser(page)
    const run = openRunRef(AGENT, { person: LOCAL, basis: 'started' })
    const [tool] = loginFillTools({ agentId: AGENT, taskId: null, runRef: run.ref })
    run.release()
    const text = await tool!.executor({ site: 'bank.example' }, { availability: {} as never })
    expect(String(text)).toMatch(/^refused: this run belongs to no person/)
    expect(fieldValue(page, 'pass')).toBe('')
    expect(browser?.runs ?? []).toHaveLength(0)
  })
})

describe('fields that are not this site sign-in form', () => {
  it('a form that posts to another site gets nothing, even on the right origin', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', {
      url: 'https://bank.example/forum/post-1',
      html: `<form action="https://evil.example/collect">
          <input id="user" type="email" autocomplete="username" />
          <input id="pass" type="password" autocomplete="current-password" />
        </form>`,
    })
    const fake = useBrowser(page)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'no_form' })
    expect(fake.valueRuns()).toHaveLength(0)
  })

  it('a submit button that posts elsewhere disqualifies its form', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', {
      url: 'https://bank.example/login',
      html: `<form action="/session">
          <input id="user" type="email" autocomplete="username" />
          <input id="pass" type="password" autocomplete="current-password" />
          <button formaction="https://evil.example/collect">Sign in</button>
        </form>`,
    })
    const fake = useBrowser(page)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'no_form' })
    expect(fake.valueRuns()).toHaveLength(0)
  })

  it('a field named action cannot hide where its form posts', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', {
      url: 'https://bank.example/login',
      html: `<form action="https://evil.example/collect">
          <input name="action" type="hidden" value="/session" />
          <input id="user" type="email" autocomplete="username" />
          <input id="pass" type="password" autocomplete="current-password" />
        </form>`,
    })
    const fake = useBrowser(page)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'no_form' })
    expect(fake.valueRuns()).toHaveLength(0)
  })

  it('a password field nobody can see, transparent or off the page, gets no password', async () => {
    saveLogin('bank.example')
    for (const hiddenStyle of ['opacity:0', 'position:absolute;left:-9999px']) {
      const page = makePage('t1', {
        url: 'https://bank.example/login',
        html: `<form action="/session">
            <input id="user" type="email" autocomplete="username" />
            <input id="pass" type="password" autocomplete="current-password" style="${hiddenStyle}" />
          </form>`,
      })
      const fake = useBrowser(page)
      const out = await fillLogin({
        db: getDb(),
        agentId: AGENT,
        site: 'bank.example',
        runPerson: asLocal,
      })
      expect(out).toMatchObject({ outcome: 'filled', fields: ['username'] })
      expect(fieldValue(page, 'pass')).toBe('')
      expect(JSON.stringify(fake.valueRuns().map((r) => r.args))).not.toContain(PASSWORD)
    }
  })
})

describe('masking what a fill put in the page', () => {
  it('masks a filled password as an address or a form body spells it', async () => {
    const { noteFilledValues } = await import('../filledValues')
    const odd = 'Hunter 2!x&y/z'
    noteFilledValues(AGENT, [odd])
    for (const spelled of [encodeURIComponent(odd), encodeURIComponent(odd).replace(/%20/g, '+')]) {
      expect(maskFilledValues(AGENT, `password=${spelled}`)).not.toContain(spelled)
    }
    expect(maskFilledValues(AGENT, JSON.stringify({ value: odd }))).not.toContain('Hunter')
  })
})

describe('while a person holds the browser', () => {
  it('fills nothing and says to wait', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM })
    const fake = useBrowser(page)
    setPersonInControlCheck((agentId) => agentId === AGENT)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'person_in_control' })
    expect(fake.runs).toHaveLength(0)
    expect(outcomeText(out)).toMatch(/taken over your browser/)
  })

  it('a check that throws counts as a person being there', async () => {
    saveLogin('bank.example')
    const fake = useBrowser(makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM }))
    setPersonInControlCheck(() => {
      throw new Error('unknown')
    })
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'person_in_control' })
    expect(fake.runs).toHaveLength(0)
  })
})

describe('review fixes for the fill', () => {
  it('masks the username, password and code before they reach the page', async () => {
    saveLogin('bank.example', LOCAL.id, true)
    const page = makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM_WITH_CODE })
    const fake = useBrowser(page)
    const seenBeforeFill: string[] = []
    fake.beforeFill = () => {
      // A browser result that comes back while the fill is running.
      seenBeforeFill.push(maskFilledValues(AGENT, `user ${USERNAME} pass ${PASSWORD}`))
    }
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out.outcome).toBe('filled')
    expect(seenBeforeFill.join(' ')).not.toContain(USERNAME)
    expect(seenBeforeFill.join(' ')).not.toContain(PASSWORD)
    const code = fieldValue(page, 'code')
    expect(maskFilledValues(AGENT, `the code is ${code}`)).not.toContain(code)
  })

  it('masks a short password too', async () => {
    const short = 'k7#Qz'
    expect(
      addSavedLogin({
        site: 'bank.example',
        username: USERNAME,
        password: short,
        ownerId: LOCAL.id,
      }).ok,
    ).toBe(true)
    useBrowser(makePage('t1', { url: 'https://bank.example/login', html: LOGIN_FORM }))
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out.outcome).toBe('filled')
    expect(maskFilledValues(AGENT, `value="${short}"`)).not.toContain(short)
  })

  it('a <base href> pointing elsewhere sends the form away, so nothing is filled', async () => {
    saveLogin('bank.example')
    const page = makePage('t1', {
      url: 'https://bank.example/login',
      html: `<!doctype html><html><head><base href="https://evil.example/" /></head><body>
        <form action="/session">
          <input id="user" type="email" autocomplete="username" />
          <input id="pass" type="password" autocomplete="current-password" />
        </form></body></html>`,
    })
    const fake = useBrowser(page)
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'no_form' })
    expect(fake.valueRuns()).toHaveLength(0)
  })

  it('a page with a certificate error is refused, and told to the person', async () => {
    saveLogin('bank.example')
    const fake = useBrowser(
      makePage('t1', {
        url: 'https://bank.example/login',
        html: LOGIN_FORM,
        certificateError: true,
      }),
    )
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'insecure_page' })
    expect(fake.valueRuns()).toHaveLength(0)
    expect(outcomeText(out)).toMatch(/certificate error/)
  })

  it('a browser that cannot show the certificate is refused, and says where to fill instead', async () => {
    saveLogin('bank.example')
    setAgentPageRunner(async () => ({ kind: 'unverifiable' }))
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'certificate_unverifiable' })
    expect(outcomeText(out)).toMatch(/cannot show Clawboo the certificate/)
  })

  it('cannot ask about a site from another page: the same answer with or without a login', async () => {
    saveLogin('bank.example')
    useBrowser(makePage('t1', { url: 'https://evil.test/', html: LOGIN_FORM }))
    const withLogin = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    const withoutLogin = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'other.example',
      runPerson: asLocal,
    })
    expect(withLogin).toMatchObject({ outcome: 'refused', reason: 'not_on_site' })
    expect(withoutLogin).toMatchObject({ outcome: 'refused', reason: 'not_on_site' })
  })

  it('an agent that holds no browser connector is told so, not that no browser is open', async () => {
    saveLogin('bank.example')
    setAgentPageRunner(async () => ({ kind: 'not_granted' }))
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'browser_not_granted' })
    expect(outcomeText(out)).toMatch(/not been given a browser/)
  })

  it('logs a page call that throws, by its class and never its message', async () => {
    saveLogin('bank.example')
    setAgentPageRunner(async () => {
      throw new TypeError(`the page said ${PASSWORD}`)
    })
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'bank.example',
      runPerson: asLocal,
    })
    expect(out.outcome).not.toBe('filled')
    const log = JSON.stringify(logged)
    expect(log).toContain('TypeError')
    expect(log).toContain('login fill')
    expectNoValue(log, [PASSWORD, USERNAME])
  })

  it('logs a 1Password search that stopped at its item limit', async () => {
    const items = Array.from({ length: 2_001 }, (_, i) => ({
      id: `i${i}`,
      vaultId: 'v1',
      websites: [{ url: 'https://other.example' }],
    }))
    setOnePasswordClientFactory(async () => ({
      listVaultIds: async () => ['v1'],
      listLoginItems: async () => items,
      getItem: async () => ({ fields: [] }),
    }))
    expect(await connectOnePassword(LOCAL.id, OP_TOKEN)).toMatchObject({ ok: true })
    useBrowser(makePage('t1', { url: 'https://shop.example/signin', html: LOGIN_FORM }))
    const out = await fillLogin({
      db: getDb(),
      agentId: AGENT,
      site: 'shop.example',
      runPerson: asLocal,
    })
    expect(out.outcome).toBe('no_saved_login')
    expect(JSON.stringify(logged)).toContain('stopped searching 1Password')
  })
})
