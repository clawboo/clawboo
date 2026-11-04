// The access gate on the shared e2e server, which runs locked the way a default
// install does (playwright.config.ts gives it a fixed token, and every page and
// request carries the cookie). A signed-out browser is a context with empty
// storage: it gets the locked screen, and a one-time launch code signs it in.

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
