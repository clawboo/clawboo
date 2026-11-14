// A browser key press, as the X keysym an agent's display understands.
//
// Keys are sent by what they PRODUCE (`event.key`), not by where they sit on the
// keyboard, so a person on a French keyboard types the letters they see. Named
// keys come from the table below; any single printed character maps directly:
// Latin-1 keysyms equal their code point, and every other character has the
// Unicode keysym 0x01000000 + its code point.

const NAMED: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  AltGraph: 0xfe03,
  Meta: 0xffe7,
  OS: 0xffeb,
  CapsLock: 0xffe5,
  ContextMenu: 0xff67,
  PrintScreen: 0xff61,
  Pause: 0xff13,
  ScrollLock: 0xff14,
  NumLock: 0xff7f,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
}

/** Right-hand modifiers have keysyms of their own. */
const RIGHT: Record<string, number> = {
  Shift: 0xffe2,
  Control: 0xffe4,
  Alt: 0xffea,
  Meta: 0xffe8,
}

/** The keysym for a key event, or null for one with no meaning to send
 *  (a dead key mid-composition, an unidentified key). */
export function keysymFor(e: { key: string; location?: number }): number | null {
  if (e.location === 2 && RIGHT[e.key] !== undefined) return RIGHT[e.key]!
  const named = NAMED[e.key]
  if (named !== undefined) return named
  if (e.key === ' ') return 0x20
  const chars = [...e.key]
  if (chars.length !== 1) return null
  const cp = chars[0]!.codePointAt(0)!
  if (cp < 0x20 || cp === 0x7f) return null
  if (cp <= 0xff) return cp
  return 0x01000000 + cp
}
