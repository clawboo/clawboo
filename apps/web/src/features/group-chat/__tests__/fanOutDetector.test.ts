import { describe, it, expect } from 'vitest'
import { detectFanOutIntent } from '../fanOutDetector'

describe('detectFanOutIntent', () => {
  describe('positive matches — plural routing intent', () => {
    it("matches 'I'll ask all teammates'", () => {
      expect(detectFanOutIntent("I'll ask all teammates for their thoughts.")).toBe(true)
    })

    it("matches 'Got responses from all three teammates'", () => {
      expect(
        detectFanOutIntent('Got responses from all three teammates. Here is what they said:'),
      ).toBe(true)
    })

    it("matches 'Let me route this to each of the team'", () => {
      expect(detectFanOutIntent('Let me route this to each of the team for quick takes.')).toBe(
        true,
      )
    })

    it("matches 'going to delegate to everyone'", () => {
      expect(detectFanOutIntent("I'm going to delegate to everyone in parallel.")).toBe(true)
    })

    it("matches 'all teammates will chime in'", () => {
      expect(detectFanOutIntent('All teammates will chime in on this one.')).toBe(true)
    })

    it("matches 'gonna fan this out to the whole team'", () => {
      expect(detectFanOutIntent('Gonna fan this out to the whole team — back in a sec.')).toBe(true)
    })

    it("matches 'asking each of you'", () => {
      expect(detectFanOutIntent('Asking each of you to share one quick thought.')).toBe(true)
    })

    it("matches 'all three teammates weighed in'", () => {
      expect(detectFanOutIntent('All three teammates weighed in on this.')).toBe(true)
    })

    it('is case-insensitive', () => {
      expect(detectFanOutIntent('LET ME ROUTE THIS TO ALL TEAMMATES')).toBe(true)
    })

    it("matches 'Got fresh takes from all three' (adjective tolerance)", () => {
      expect(detectFanOutIntent('Got fresh takes from all three:')).toBe(true)
    })

    it("matches 'Got their thoughts from everyone'", () => {
      expect(detectFanOutIntent('Got their thoughts from everyone — here is the recap.')).toBe(true)
    })

    it("matches 'all three teammates are aligned' (post-fan-out synthesis)", () => {
      expect(detectFanOutIntent('All three teammates are aligned on this point.')).toBe(true)
    })

    it("matches 'Here's the roundup' (LLM aggregation prose)", () => {
      expect(detectFanOutIntent("Here's the roundup:")).toBe(true)
    })

    it("matches 'Here's the recap' / 'consensus'", () => {
      expect(detectFanOutIntent("Here's the recap of what they said.")).toBe(true)
      expect(detectFanOutIntent("Here's the consensus: everyone agrees.")).toBe(true)
    })
  })

  describe('negative matches — not fan-out intent', () => {
    it("does not match single-target delegation 'I'll ask @Alice'", () => {
      expect(detectFanOutIntent("I'll ask @Alice to handle this.")).toBe(false)
    })

    it("does not match bare plural mention without routing verb 'all teammates are great'", () => {
      expect(detectFanOutIntent('All teammates are great. The team is solid.')).toBe(false)
    })

    it('does not match empty string', () => {
      expect(detectFanOutIntent('')).toBe(false)
    })

    it('does not match null / undefined', () => {
      expect(detectFanOutIntent(null)).toBe(false)
      expect(detectFanOutIntent(undefined)).toBe(false)
    })

    it("does not match 'I'll route this to @Search Boo' (single target with @)", () => {
      expect(detectFanOutIntent("I'll route this to @Search Boo for analysis.")).toBe(false)
    })

    it('does not match prose about teammates without delegation intent', () => {
      expect(detectFanOutIntent('Teammates are amazing. Everyone here is talented.')).toBe(false)
    })
  })
})
