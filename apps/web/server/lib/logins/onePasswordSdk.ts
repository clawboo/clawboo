// 1Password's SDK, installed on first use into Clawboo's runtimes folder.
//
// It is not a dependency of Clawboo: its core is about 14 MB of WebAssembly that
// only someone who connects 1Password needs. The first Connect installs the pinned
// release into a folder of its own under the runtimes folder, the same way Claude
// Code's SDK and Codex install (`runNpmRuntimeInstall`): npm on the Node this server
// runs on, all or nothing, and a failed download changes nothing. From then on the
// server loads it from there by file URL. The SDK pins its WebAssembly core to the
// same exact version, so the spec below pins both.
//
// Tests never install or load it: they replace the installer and the client.

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createLogger } from '@clawboo/logger'

import { currentInstallFolder } from '../runtimeFolder'
import { agentSdkEntryFile } from '../runtimes/agentSdkBinary'
import { runNpmRuntimeInstall, type NpmRuntime } from '../runtimes/npmRuntimeInstall'

const log = createLogger('website-logins-1password-sdk')

export const ONE_PASSWORD_SDK_PACKAGE = '@1password/sdk'
export const ONE_PASSWORD_SDK_VERSION = '0.5.0'

/** Its folder under the runtimes folder, and the exact release it installs. */
export const ONE_PASSWORD_SDK: NpmRuntime = {
  id: '1password-sdk',
  spec: `${ONE_PASSWORD_SDK_PACKAGE}@${ONE_PASSWORD_SDK_VERSION}`,
  bins: [],
}

export type SdkInstallError =
  /** The download failed on the network: offline, a proxy, a certificate. */
  | 'install_offline'
  /** Anything else: npm missing, the runtimes folder refused, npm failed. */
  | 'install_failed'

export type SdkInstallResult = { ok: true } | { ok: false; error: SdkInstallError }

/** npm's codes for a download the network stopped. */
const NETWORK_CODES =
  /^(ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ESOCKETTIMEDOUT|ERR_SOCKET_TIMEOUT|EPROXY|E407|ECONNABORTED|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT)$/

export function sdkInstallErrorOf(code: string): SdkInstallError {
  return NETWORK_CODES.test(code) ? 'install_offline' : 'install_failed'
}

/** The installed SDK's package folder, or null when it is not installed (or the
 *  runtimes folder is not one Clawboo will run from). */
export function ownOnePasswordSdkDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const folder = currentInstallFolder(ONE_PASSWORD_SDK.id, env)
  if (!folder) return null
  const dir = path.join(folder, 'node_modules', ...ONE_PASSWORD_SDK_PACKAGE.split('/'))
  if (!existsSync(path.join(dir, 'package.json'))) return null
  try {
    return realpathSync(dir)
  } catch {
    return null
  }
}

/** Load the installed SDK, or null when it is not installed. */
export async function loadOnePasswordSdk(): Promise<unknown | null> {
  const dir = ownOnePasswordSdkDir()
  if (!dir) return null
  return import(/* @vite-ignore */ pathToFileURL(agentSdkEntryFile(dir)).href)
}

type Installer = () => Promise<SdkInstallResult>

const npmInstaller: Installer = async () => {
  const run = runNpmRuntimeInstall(ONE_PASSWORD_SDK)
  const result = await run.result
  if (result.ok) return { ok: true }
  // Only the code: npm's own words can name a proxy address, credentials included.
  log.warn({ code: result.code }, 'could not install the 1Password SDK')
  return { ok: false, error: sdkInstallErrorOf(result.code) }
}

let installer: Installer = npmInstaller
let installed: () => boolean = () => ownOnePasswordSdkDir() !== null
let inFlight: Promise<SdkInstallResult> | null = null

/** Whether the SDK is installed. */
export function onePasswordSdkInstalled(): boolean {
  return installed()
}

/** Install the SDK, once: a second caller while one runs gets the same answer. */
export function installOnePasswordSdk(): Promise<SdkInstallResult> {
  if (installed()) return Promise.resolve({ ok: true })
  if (!inFlight) {
    inFlight = installer().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

/** Whether an install is running right now. */
export function onePasswordSdkInstalling(): boolean {
  return inFlight !== null
}

/** Test seam: replace the installer and the installed check, or restore both. */
export function setOnePasswordSdkInstallForTests(
  next: { install: Installer; installed: () => boolean } | null,
): void {
  installer = next?.install ?? npmInstaller
  installed = next?.installed ?? (() => ownOnePasswordSdkDir() !== null)
  inFlight = null
}
