// Who answers on the Hermes gateway's port: read before the gateway is sent its
// key, so another program that took the port first never gets it.

import { describe, expect, it } from 'vitest'

import {
  gatewayPortOwner,
  parseDarwinListeners,
  parseProcNetTcpListeners,
  parseStatusUid,
} from '../portOwner'

const DARWIN = [
  'Active Internet connections (including servers)',
  'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs',
  'tcp4       0      0  127.0.0.1.8642         *.*                    LISTEN                 0            0  131072  131072        Python:4242  00100 00000106 00000000065352db 00000001 00000800      1      0 000000',
  'tcp4       0      0  *.8643                 *.*                    LISTEN                 0            0  131072  131072   My Server App:777  00100 00000106 00000000065352dc 00000001 00000800      1      0 000000',
  'tcp4       0      0  127.0.0.1.8642         127.0.0.1.50000        ESTABLISHED            0            0  131072  131072          node:99  00102 00000106 00000000065352dd 00000001 00000800      1      0 000000',
].join('\n')

const PROC_NET_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:21C2 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10002        0 123 1 0000000000000000 100 0 0 10 0',
  '   1: 00000000:21C3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 124 1 0000000000000000 100 0 0 10 0',
  '   2: 0100007F:21C2 0100007F:C350 01 00000000:00000000 00:00000000 00000000 10002        0 125 1 0000000000000000 100 0 0 10 0',
].join('\n')

describe('reading who listens on a port', () => {
  it('reads the listening process from macOS netstat, a name with spaces included', () => {
    expect(parseDarwinListeners(DARWIN, 8642)).toEqual([4242])
    expect(parseDarwinListeners(DARWIN, 8643)).toEqual([777])
    expect(parseDarwinListeners(DARWIN, 9000)).toEqual([])
  })

  it("reads the listening user from Linux's /proc/net/tcp", () => {
    expect(parseProcNetTcpListeners(PROC_NET_TCP, 8642)).toEqual([10002])
    expect(parseProcNetTcpListeners(PROC_NET_TCP, 8643)).toEqual([1000])
    expect(parseProcNetTcpListeners(PROC_NET_TCP, 9000)).toEqual([])
    expect(parseStatusUid('Name:\tpython3\nUid:\t10002\t10002\t10002\t10002\n')).toBe(10002)
  })
})

describe('gatewayPortOwner', () => {
  const darwin = (parents: Record<number, number>) => ({
    platform: 'darwin' as const,
    run: async (command: string, args: string[]) => {
      if (command === 'netstat') return DARWIN
      if (command === 'ps') return `${parents[Number(args.at(-1))] ?? 1}\n`
      throw new Error(`unexpected ${command}`)
    },
  })

  it('is ours when the listener is the gateway, or a process it started', async () => {
    expect(await gatewayPortOwner(8642, 4242, darwin({}))).toBe('ours')
    expect(await gatewayPortOwner(8642, 4000, darwin({ 4242: 4000 }))).toBe('ours')
  })

  it("is another's when the listener is no process of the gateway's", async () => {
    expect(await gatewayPortOwner(8642, 5000, darwin({ 4242: 300, 300: 1 }))).toBe('other')
  })

  it('is unknown when nothing can be read, and never throws', async () => {
    expect(await gatewayPortOwner(9000, 4242, darwin({}))).toBe('unknown')
    const broken = {
      platform: 'darwin' as const,
      run: async () => {
        throw new Error('netstat: not found')
      },
    }
    expect(await gatewayPortOwner(8642, 4242, broken)).toBe('unknown')
  })

  it("on Linux, is ours when the listener is the gateway's user", async () => {
    const linux = (gatewayUid: number) => ({
      platform: 'linux' as const,
      readFile: async (file: string) =>
        file === '/proc/net/tcp'
          ? PROC_NET_TCP
          : `Uid:\t${gatewayUid}\t${gatewayUid}\t${gatewayUid}\t${gatewayUid}\n`,
    })
    expect(await gatewayPortOwner(8642, 4242, linux(10002))).toBe('ours')
    expect(await gatewayPortOwner(8642, 4242, linux(10001))).toBe('other')
  })
})
