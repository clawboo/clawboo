import { describe, expect, it } from 'vitest'

import { parseLsofPids, parseNetstatPid } from '../index'

describe('parseLsofPids', () => {
  it('parses one PID per line', () => {
    expect(parseLsofPids('1234\n')).toEqual([1234])
    expect(parseLsofPids('1234\n5678\n')).toEqual([1234, 5678])
  })

  // A dual-stack Node listener (0.0.0.0 + ::) reports the same PID twice, and
  // `stopDashboard` compares a re-resolved PID against the one it signaled.
  it('dedupes repeated PIDs', () => {
    expect(parseLsofPids('1234\n1234\n')).toEqual([1234])
    expect(parseLsofPids('1234\n5678\n1234\n')).toEqual([1234, 5678])
  })

  it('tolerates surrounding whitespace and blank lines', () => {
    expect(parseLsofPids('  1234  \n')).toEqual([1234])
    expect(parseLsofPids('\n1234\n\n')).toEqual([1234])
    expect(parseLsofPids('1234\r\n5678\r\n')).toEqual([1234, 5678])
  })

  it('returns nothing for empty or non-numeric output', () => {
    expect(parseLsofPids('')).toEqual([])
    expect(parseLsofPids('\n\n')).toEqual([])
    // lsof -F field output, which we never ask for but must not misread.
    expect(parseLsofPids('p1234\n')).toEqual([])
    expect(parseLsofPids('lsof: WARNING: no pwd entry\n')).toEqual([])
  })

  it('rejects non-positive PIDs', () => {
    expect(parseLsofPids('0\n')).toEqual([])
    expect(parseLsofPids('-1\n')).toEqual([])
  })
})

describe('parseNetstatPid', () => {
  const REALISTIC = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044',
    '  TCP    127.0.0.1:52001        127.0.0.1:18790        ESTABLISHED     9001',
    '  TCP    127.0.0.1:18790        127.0.0.1:52001        ESTABLISHED     4242',
    '  TCP    127.0.0.1:18790        0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:18791        0.0.0.0:0              LISTENING       7777',
    '  UDP    0.0.0.0:5353           *:*                                    2200',
  ].join('\n')

  it('finds the LISTENING row for the port', () => {
    expect(parseNetstatPid(REALISTIC, 18790)).toBe(4242)
    expect(parseNetstatPid(REALISTIC, 18791)).toBe(7777)
  })

  it('reads the LOCAL address, not the foreign one', () => {
    // 9001 holds a connection TO :18790; it is not the listener.
    const connectionsOnly = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:52001        127.0.0.1:18790        ESTABLISHED     9001',
    ].join('\n')
    expect(parseNetstatPid(connectionsOnly, 18790)).toBeNull()

    // Deliberately synthetic: a LISTENING row whose FOREIGN address is our port.
    // Real netstat would not print this, but it is the only shape that isolates
    // the column check — an ESTABLISHED row is already rejected by the state
    // filter, so it would pass even if the parser scanned the whole line.
    const foreignListening =
      '  TCP    127.0.0.1:52001        127.0.0.1:18790        LISTENING       9001'
    expect(parseNetstatPid(foreignListening, 18790)).toBeNull()
  })

  it('handles IPv6 local addresses', () => {
    const ipv6 = '  TCP    [::]:18790             [::]:0                 LISTENING       4242'
    expect(parseNetstatPid(ipv6, 18790)).toBe(4242)
  })

  it('does not match a port that merely shares a prefix', () => {
    const longer = '  TCP    127.0.0.1:187900       0.0.0.0:0              LISTENING       4242'
    expect(parseNetstatPid(longer, 18790)).toBeNull()
    const shorter = '  TCP    127.0.0.1:18790        0.0.0.0:0              LISTENING       4242'
    expect(parseNetstatPid(shorter, 8790)).toBeNull()
  })

  it('parses CRLF output', () => {
    expect(parseNetstatPid(REALISTIC.split('\n').join('\r\n'), 18790)).toBe(4242)
  })

  // netstat.exe translates its state column, so an English-only match finds
  // nothing on a localized Windows install. The all-zero foreign address is a
  // listening socket's structural signature and is never translated.
  it('falls back to the all-zero foreign address on localized Windows', () => {
    const german = [
      '  Proto  Lokale Adresse         Remoteadresse          Status          PID',
      '  TCP    127.0.0.1:18790        0.0.0.0:0              ABHÖREN         4242',
    ].join('\n')
    expect(parseNetstatPid(german, 18790)).toBe(4242)
  })

  it('survives a localized state string containing a space', () => {
    // French `À L'ÉCOUTE` splits into two columns and shifts everything after it;
    // the PID is still last.
    const french = "  TCP    127.0.0.1:18790        0.0.0.0:0              À L'ÉCOUTE      4242"
    expect(parseNetstatPid(french, 18790)).toBe(4242)
  })

  it('prefers an explicit LISTENING row over the structural fallback', () => {
    const mixed = [
      '  TCP    127.0.0.1:18790        0.0.0.0:0              ABHÖREN         1111',
      '  TCP    127.0.0.1:18790        0.0.0.0:0              LISTENING       4242',
    ].join('\n')
    expect(parseNetstatPid(mixed, 18790)).toBe(4242)
  })

  it('ignores UDP rows bound to the same port', () => {
    const udp = '  UDP    0.0.0.0:18790          *:*                                    2200'
    expect(parseNetstatPid(udp, 18790)).toBeNull()
  })

  it('returns null when nothing is listening on the port', () => {
    expect(parseNetstatPid(REALISTIC, 18799)).toBeNull()
    expect(parseNetstatPid('', 18790)).toBeNull()
  })
})
