// The access gate on the shared e2e server, which runs locked the way a default
// install does (playwright.config.ts gives it a fixed token, and every page and
// request carries the cookie). A signed-out browser is a context with empty
// storage: it gets the locked screen, and a one-time launch code signs it in.

import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test'

import { test, expect, connectToMockGateway, API_BASE, SIGNED_OUT } from './helpers/fixtures'
import { startMockGateway, type MockGateway } from './helpers/mockGateway'

test.describe('the access gate', () => {
  test('a signed-out browser gets the locked screen and nothing else', async ({ browser }) => {
    const context = await browser.newContext({ storageState: SIGNED_OUT })
    const page = await context.newPage()
    const apiCalls: string[] = []
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) apiCalls.push(r.url())
    })
    await page.goto(`${API_BASE}/`)
    await expect(page.getByRole('heading', { name: /locked to your computer/i })).toBeVisible()
    await expect(page.getByText('clawboo open', { exact: true })).toBeVisible()
    // Only the one read that found the lock: nothing behind it loaded.
    await page.waitForLoadState('networkidle').catch(() => undefined)
    expect(apiCalls).toEqual([`${API_BASE}/api/settings`])
    await context.close()
  })

  test('the API refuses a request without the cookie', async ({ playwright }) => {
    const bare = await playwright.request.newContext({ storageState: SIGNED_OUT })
    const res = await bare.get(`${API_BASE}/api/settings`)
    expect(res.status()).toBe(401)
    expect(((await res.json()) as { gate?: string }).gate).toBe('clawboo-access')
    await bare.dispose()
  })

  test('a launch code signs a fresh browser in, once', async ({ browser, request }) => {
    const minted = await request.post(`${API_BASE}/api/access/launch-code`)
    expect(minted.ok()).toBe(true)
    const { code } = (await minted.json()) as { code: string }

    const first = await browser.newContext({ storageState: SIGNED_OUT })
    const page = await first.newPage()
    await page.goto(`${API_BASE}/?access_code=${code}`)
    // The code is stripped from the address bar.
    await expect(page).toHaveURL(`${API_BASE}/`)
    await expect(page.locator('#root')).not.toBeEmpty()
    await expect(page.getByTestId('access-locked')).toHaveCount(0)
    expect((await first.cookies()).some((c) => c.name === 'clawboo_access')).toBe(true)
    await first.close()

    const second = await browser.newContext({ storageState: SIGNED_OUT })
    const late = await second.newPage()
    await late.goto(`${API_BASE}/?access_code=${code}`)
    await expect(late.getByTestId('access-locked')).toBeVisible()
    await second.close()
  })
})

test.describe('a launch code without fetch metadata', () => {
  // Browsers send Sec-Fetch-* only to HTTPS and loopback addresses, so a phone
  // opening a plain-HTTP LAN link sends none. Playwright's request context sends
  // none either, so it stands in for that phone here.
  test('gets a sign-in page, and the button signs the device in once', async ({
    request,
    playwright,
  }) => {
    const minted = await request.post(`${API_BASE}/api/access/launch-code`)
    const { code } = (await minted.json()) as { code: string }
    const phone = await playwright.request.newContext({ storageState: SIGNED_OUT })
    const url = `${API_BASE}/?access_code=${code}`

    const page = await phone.get(url, { maxRedirects: 0 })
    expect(page.status()).toBe(200)
    expect(page.headers()['set-cookie']).toBeUndefined()
    expect(await page.text()).toContain('method="post"')

    // The form's POST: form-encoded, as the sign-in page's button sends it.
    const signedIn = await phone.post(url, { form: {}, maxRedirects: 0 })
    expect(signedIn.status()).toBe(303)
    expect(signedIn.headers()['set-cookie']).toContain('clawboo_access=')
    expect((await phone.get(`${API_BASE}/api/settings`)).status()).toBe(200)

    const late = await playwright.request.newContext({ storageState: SIGNED_OUT })
    const again = await late.post(url, { form: {}, maxRedirects: 0 })
    expect(again.headers()['set-cookie']).toBeUndefined()
    await late.dispose()
    await phone.dispose()
  })
})

test.describe('pasting a sign-in link on the locked screen', () => {
  // How an app added to an iPhone's home screen signs in: its cookies are its own
  // and a tapped link opens Safari, so the link is pasted into the app. These run
  // at a phone's width, as that app would.
  const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true }

  async function lockedPhone(browser: Browser) {
    const context = await browser.newContext({ storageState: SIGNED_OUT, ...PHONE })
    const page = await context.newPage()
    // Every address the tab commits to: the code must never be one of them.
    const committed: string[] = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) committed.push(frame.url())
    })
    await page.goto(`${API_BASE}/`)
    await expect(page.getByTestId('access-locked')).toBeVisible()
    return { context, page, committed }
  }

  async function paste(page: Page, text: string) {
    await page.getByLabel('Paste a sign-in link').fill(text)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }

  async function mint(request: APIRequestContext): Promise<string> {
    const minted = await request.post(`${API_BASE}/api/access/launch-code`)
    expect(minted.ok()).toBe(true)
    return ((await minted.json()) as { code: string }).code
  }

  const signedIn = async (context: BrowserContext) =>
    (await context.cookies()).some((c) => c.name === 'clawboo_access')

  test('a pasted link signs the app in once, and the code never reaches the address bar', async ({
    browser,
    request,
  }) => {
    const code = await mint(request)
    const { context, page, committed } = await lockedPhone(browser)
    // The locked screen fits the phone: nothing scrolls sideways.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)

    const firstRead = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/settings' && r.status() === 200,
    )
    await paste(page, `${API_BASE}/?access_code=${code}`)
    await firstRead
    await expect(page).toHaveURL(`${API_BASE}/`)
    await expect(page.getByTestId('access-locked')).toHaveCount(0)
    await expect(page.locator('#root')).not.toBeEmpty()
    expect(await signedIn(context)).toBe(true)
    expect(committed.join('\n')).not.toContain(code)
    const stored = await page.evaluate(() =>
      JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
    )
    expect(stored).not.toContain(code)
    await context.close()

    // The same link pasted again: spent, so it is refused and signs nothing in.
    const late = await lockedPhone(browser)
    await paste(late.page, `${API_BASE}/?access_code=${code}`)
    await expect(late.page.getByRole('alert')).toHaveText(/did not sign you in/)
    await expect(late.page).toHaveURL(`${API_BASE}/`)
    expect(await signedIn(late.context)).toBe(false)
    expect(late.committed.join('\n')).not.toContain(code)
    await late.context.close()
  })

  test('an address typed or shared with the mark says nothing about a link', async ({
    browser,
  }) => {
    // Only the gate's redirect after a posted link brings a page here with
    // `signin=pasted`; arriving at it directly is not a refused link.
    const context = await browser.newContext({ storageState: SIGNED_OUT, ...PHONE })
    const page = await context.newPage()
    await page.goto(`${API_BASE}/?signin=pasted`)
    await expect(page.getByTestId('access-locked')).toBeVisible()
    await expect(page).toHaveURL(`${API_BASE}/`)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await context.close()
  })

  test('a link for another address, or text that is not a link, is refused before anything is sent', async ({
    browser,
    request,
  }) => {
    const code = await mint(request)
    const { context, page } = await lockedPhone(browser)
    const sent: string[] = []
    page.on('request', (r) => sent.push(r.url()))

    await paste(page, `http://evil.example/?access_code=${code}`)
    await expect(page.getByRole('alert')).toHaveText(/That link is for http:\/\/evil\.example/)
    await paste(page, 'not a link at all')
    await expect(page.getByRole('alert')).toHaveText(/not a sign-in link/)
    expect(sent).toEqual([])
    expect(await signedIn(context)).toBe(false)

    // Nothing was spent: the code still signs in when pasted for this address.
    await paste(page, code)
    await expect(page.getByTestId('access-locked')).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => signedIn(context)).toBe(true)
    await context.close()
  })
})

test.describe('Open on another device', () => {
  // A private gateway: the worker-scoped one is closed by 15-live-reconnect.
  let ownGateway: MockGateway

  test.beforeAll(async () => {
    ownGateway = await startMockGateway()
  })
  test.afterAll(() => {
    ownGateway?.close()
  })

  test('the dashboard makes a one-time link that signs another browser in', async ({
    page,
    request,
    browser,
  }) => {
    await connectToMockGateway(page, request, ownGateway.url)
    await page.getByTestId('open-on-another-device').click()
    const dialog = page.getByRole('dialog', { name: 'Open on another device' })
    await expect(dialog).toBeVisible()
    const link = (await dialog.getByTestId('device-link').textContent())?.trim() ?? ''
    expect(link).toMatch(new RegExp(`^${API_BASE}/\\?access_code=[A-Za-z0-9_-]{32,}$`))
    // A loopback address cannot reach a phone, and the dialog says so.
    await expect(dialog.getByText(/only on this computer/i)).toBeVisible()

    const other = await browser.newContext({ storageState: SIGNED_OUT })
    const otherPage = await other.newPage()
    await otherPage.goto(link)
    await expect(otherPage).toHaveURL(`${API_BASE}/`)
    await expect(otherPage.locator('#root')).not.toBeEmpty()
    await expect(otherPage.getByTestId('access-locked')).toHaveCount(0)
    await other.close()
  })
})
