// The dashboard installs as a web app: a phone's "Add to Home Screen" or a
// desktop browser's install button reads `manifest.webmanifest` from the shell.
//
// What has to hold for that to work behind the access gate and under a base
// path, served the way the server really serves it (the prefix strip, the gate,
// then the static SPA):
//   - the manifest answers with its own media type, without the access cookie
//     (a browser fetches it with no credentials unless the link asks for them);
//   - every URL in it is relative, so the one prebuilt file resolves under any
//     mount and the installed app starts at the mount, not at the origin root;
//   - nothing in it carries a query, so no token or launch code can ride into
//     the address the installed app opens;
//   - the icons it names exist, at the sizes it claims.
//
// No service worker is shipped. Current Chrome and Safari install from the
// manifest alone, and without one nothing can cache an /api/ answer.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createAccessGate } from '@clawboo/gateway-proxy'
import express from 'express'
import { afterAll, describe, expect, it } from 'vitest'

import { createBasePathMiddleware } from '../basePathMiddleware'
import { mountSpa } from '../serveSpa'

const WEB_DIR = path.resolve(__dirname, '../../..')
const PUBLIC_DIR = path.join(WEB_DIR, 'public')
const TOKEN = 'manifestTestToken123'

interface ManifestIcon {
  src: string
  type?: string
  sizes?: string
  purpose?: string
}

interface Manifest {
  name?: string
  short_name?: string
  id?: string
  start_url?: string
  scope?: string
  display?: string
  background_color?: string
  theme_color?: string
  icons?: ManifestIcon[]
  serviceworker?: unknown
}

/** Every ui dir a test made, removed once the suite is done. */
const uiDirs: string[] = []

/** A ui dir holding the real public assets, as the Vite build copies them. */
function makeUiDir(): string {
  const uiDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-manifest-'))
  uiDirs.push(uiDir)
  cpSync(PUBLIC_DIR, uiDir, { recursive: true })
  writeFileSync(
    path.join(uiDir, 'index.html'),
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  )
  return uiDir
}

const servers: http.Server[] = []

/** The server's own order: the prefix strip, the access gate, then the SPA. */
function serve(basePath: string): Promise<string> {
  const app = express()
  const gate = createAccessGate({ token: TOKEN, basePath })
  app.use(createBasePathMiddleware(basePath))
  app.use((req, res, next) => {
    if (gate.handleHttp(req, res)) return
    next()
  })
  mountSpa(app, makeUiDir(), basePath)
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server)
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

afterAll(() => {
  for (const server of servers) server.close()
  for (const dir of uiDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** A colour token's value in one block of the dashboard's stylesheet. */
function cssToken(css: string, selector: string, token: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} block in globals.css`).toBeGreaterThanOrEqual(0)
  const block = css.slice(start, css.indexOf('}', start))
  const match = new RegExp(`${token}:\\s*([^;]+);`).exec(block)
  expect(match, `${token} in ${selector}`).not.toBeNull()
  return match![1]!.trim().toLowerCase()
}

describe.each([
  ['at the origin root', ''],
  ['under a base path', '/clawboo'],
])('the web app manifest, served %s', (_label, basePath) => {
  const mount = `${basePath}/`

  it('answers with the manifest media type, without the access cookie', async () => {
    const origin = await serve(basePath)
    const res = await fetch(`${origin}${mount}manifest.webmanifest`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/manifest\+json/)
    const manifest = (await res.json()) as Manifest
    expect(manifest.name).toBe('Clawboo')
  })

  it('starts the installed app at the mount, and keeps its scope there', async () => {
    const origin = await serve(basePath)
    const manifestUrl = `${origin}${mount}manifest.webmanifest`
    const manifest = (await (await fetch(manifestUrl)).json()) as Manifest
    for (const key of ['id', 'start_url', 'scope'] as const) {
      const value = manifest[key]
      expect(value, key).toBeTypeOf('string')
      // Relative, so one prebuilt file works under every mount.
      expect(value!.startsWith('/'), `${key} must be relative`).toBe(false)
      const resolved = new URL(value!, manifestUrl)
      expect(resolved.pathname, key).toBe(mount)
      // Nothing an installed app opens may carry a token or a launch code.
      expect(resolved.search, key).toBe('')
    }
  })

  it('names icons that load under the mount, without the cookie, at their sizes', async () => {
    const origin = await serve(basePath)
    const manifestUrl = `${origin}${mount}manifest.webmanifest`
    const manifest = (await (await fetch(manifestUrl)).json()) as Manifest
    expect(manifest.icons?.length).toBeGreaterThan(0)
    for (const icon of manifest.icons ?? []) {
      expect(icon.src.startsWith('/'), `${icon.src} must be relative`).toBe(false)
      const url = new URL(icon.src, manifestUrl)
      expect(url.pathname.startsWith(mount), icon.src).toBe(true)
      const res = await fetch(url)
      expect(res.status, icon.src).toBe(200)
      expect(res.headers.get('content-type'), icon.src).toContain(icon.type!)
      if (icon.type === 'image/png') {
        const { width, height } = pngSize(Buffer.from(await res.arrayBuffer()))
        expect(`${width}x${height}`, icon.src).toBe(icon.sizes)
      }
    }
  })
})

describe('the web app manifest itself', () => {
  const readManifest = () =>
    JSON.parse(readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8')) as Manifest

  it('carries what a browser needs to offer the install', () => {
    const manifest = readManifest()
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name).toBeTruthy()
    expect(manifest.display).toBe('standalone')
    const icons = manifest.icons ?? []
    const any = (size: string) =>
      icons.some(
        (i) => i.type === 'image/png' && i.sizes === size && (i.purpose ?? 'any') === 'any',
      )
    expect(any('192x192'), 'a 192 px icon').toBe(true)
    expect(any('512x512'), 'a 512 px icon').toBe(true)
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true)
  })

  it('registers no service worker, so nothing can cache the API', () => {
    expect(readManifest().serviceworker).toBeUndefined()
  })

  it('takes its colours from the dashboard light theme, the default for a fresh install', () => {
    const manifest = readManifest()
    const css = readFileSync(path.join(WEB_DIR, 'src/app/globals.css'), 'utf8')
    const background = cssToken(css, ':root', '--background')
    expect(manifest.background_color?.toLowerCase()).toBe(background)
    expect(manifest.theme_color?.toLowerCase()).toBe(background)
  })

  it('is linked from the shell, asking for credentials a sign-in proxy may need', () => {
    const manifest = readManifest()
    const html = readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8')
    const link = /<link[^>]*rel="manifest"[^>]*>/.exec(html)?.[0]
    expect(link, 'a <link rel="manifest"> in index.html').toBeTruthy()
    // Root-absolute in the source: the build rewrites public paths against its
    // relative base, so the shipped shell asks for `./manifest.webmanifest` and
    // the injected <base href> puts that under the mount.
    expect(link).toContain('href="/manifest.webmanifest"')
    expect(link).toContain('crossorigin="use-credentials"')
    const themeColor = /<meta[^>]*name="theme-color"[^>]*>/.exec(html)?.[0]
    expect(themeColor).toContain(`content="${manifest.theme_color}"`)
  })
})
