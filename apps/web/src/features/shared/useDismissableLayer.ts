// The dismissable-layer stack — one shared owner for "dismiss the thing on top".
//
// Every overlay in the app (dropdown, popover, context menu, modal, drawer,
// sheet, wizard) registers itself here while it is open. Exactly ONE `keydown`
// and ONE `mousedown` listener exist; each hands the event to the TOPMOST open
// layer and to nobody else. That replaces the old convention of hand-rolling a
// pair of listeners per overlay, where every layer independently decided the
// event was "outside me" and dismissed itself. Two overlays therefore closed on
// one gesture: a `<Select>` inside a dialog lost the whole half-filled form on
// Escape, and clicking the dialog's scrim with the dropdown open closed both.
//
// ── Why a document listener in the BUBBLE phase ──────────────────────────────
// React attaches its synthetic-event listeners to the ROOT CONTAINER (#root),
// which sits below `document`. A capture-phase listener on document/window
// would therefore run BEFORE every React `onKeyDown` in the app and, combined
// with `stopImmediatePropagation()`, silently kill them all while any layer is
// open. Bubbling gives the ordering an overlay system actually wants:
//
//   innermost DOM handler  →  this layer stack  →  the app-shell fallback
//
// Handlers closer to the event target (a React `onKeyDown`, CodeMirror's
// keymap) run first and can VETO the stack by calling `preventDefault()`.
// That is the contract for element-scoped Escape handlers: consume the key with
// `preventDefault()` and the surrounding dialog is left alone.
//
// ── Why the listener is registered at module scope ───────────────────────────
// So it is the FIRST document-bubble listener in the app. `stopImmediatePropagation()`
// only suppresses listeners registered LATER on the same target in the same
// phase, and every other one (the app shell, dnd-kit's keyboard sensor, any
// stray handler) is added from an effect — i.e. after this module is evaluated.
// Attaching lazily on first push would make this listener LAST and defeat it.
// `hasOpenLayer()` is the belt-and-braces the app shell consults so its
// behaviour never depends on module-import order.
//
// ── Why the outside-press pass does NOT stop the event ───────────────────────
// Escape is a pure dismissal, so the stack consumes it. A press is not: clicking
// a button inside a dialog while a dropdown is open must dismiss the dropdown
// AND still activate the button. So the press pass only dismisses the topmost
// press-owning layer and lets the gesture continue. Nothing below double-fires,
// because every layer's outside-press dismissal — a dropdown's, and a dialog's
// scrim — runs through here rather than through its own listener.

import { useEffect, useRef } from 'react'

/** Priority tier. A popover always outranks a dialog: a dropdown opened inside
 *  a modal must be dismissed first, no matter which effect ran first. */
export type LayerLevel = 'popover' | 'dialog'

export interface DismissableLayerOptions {
  /** Register as a layer while this is true. */
  active: boolean
  /** Priority tier — see {@link LayerLevel}. */
  level: LayerLevel
  /**
   * Escape, while this is the topmost Escape-owning layer. Omit for a layer
   * whose Escape belongs to something else (the Settings modal's belongs to the
   * app shell, which keeps a "skip while the user is typing" guard the stack
   * has no business replicating).
   */
  onEscape?: () => void
  /**
   * Does `target` sit inside this layer's own DOM? Required — together with
   * `onPressOutside` — to take part in outside-press dismissal; a layer that
   * supplies neither simply never reacts to a press.
   */
  contains?: (target: Node) => boolean
  /** A press outside `contains`, while this is the topmost press-owning layer. */
  onPressOutside?: () => void
}

interface Layer {
  level: LayerLevel
  // Read through refs so a changing callback identity never re-orders the stack.
  options: () => DismissableLayerOptions
}

const LEVEL_RANK: Record<LayerLevel, number> = { dialog: 0, popover: 1 }

// Open layers in push (= open) order. Never `pop()` — layers can unmount out of
// order, so removal is by identity.
const stack: Layer[] = []

// Highest level wins; ties go to the most recently opened layer.
function topLayer(
  owns: (o: DismissableLayerOptions) => boolean,
): DismissableLayerOptions | undefined {
  let top: Layer | undefined
  for (const layer of stack) {
    if (!owns(layer.options())) continue
    if (!top || LEVEL_RANK[layer.level] >= LEVEL_RANK[top.level]) top = layer
  }
  return top?.options()
}

const ownsEscape = (o: DismissableLayerOptions): boolean => o.onEscape !== undefined
const ownsPress = (o: DismissableLayerOptions): boolean =>
  o.contains !== undefined && o.onPressOutside !== undefined

/** True while an overlay owns Escape. The app shell consults this to stay out of
 *  the way instead of hard-coding a list of the overlays it knows about. */
export function hasOpenLayer(): boolean {
  return stack.some((layer) => ownsEscape(layer.options()))
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // Mid-IME-composition Escape cancels the composition, not the overlay.
  // `keyCode === 229` is the WebKit spelling that leaves `isComposing` unset.
  if (e.isComposing || e.keyCode === 229) return
  // Something nearer the target already consumed the key — leave it alone.
  if (e.defaultPrevented) return
  const top = topLayer(ownsEscape)
  if (!top) return // no overlay open: stay completely inert
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
  top.onEscape?.()
}

function onMouseDown(e: MouseEvent): void {
  const top = topLayer(ownsPress)
  if (!top) return // no press-owning overlay open: stay completely inert
  const target = e.target
  if (!(target instanceof Node) || top.contains?.(target)) return
  // Deliberately NOT stopped — see the header note. The press dismisses this one
  // layer and otherwise behaves like any other click.
  top.onPressOutside?.()
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('mousedown', onMouseDown)
}

/**
 * Register this component as a dismissable layer while `active`.
 *
 * A callback runs only when this layer is the topmost one that owns that
 * channel. Escape is consumed either way, so a dialog can no-op (e.g. while a
 * write is in flight) without leaking the key to whatever is behind it.
 *
 * Call it where the layer's OPEN state lives — never inside an `<AnimatePresence>`
 * child, or the layer would linger on the stack through the exit animation and
 * swallow the next dismissal.
 */
export function useDismissableLayer(options: DismissableLayerOptions): void {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const { active, level } = options
  useEffect(() => {
    if (!active) return
    // A fresh identity per effect run, removed by identity on cleanup — so
    // layers that unmount out of order (and StrictMode's dev-only
    // mount → cleanup → mount) can never leave a zombie owning a channel.
    const layer: Layer = { level, options: () => optionsRef.current }
    stack.push(layer)
    return () => {
      const i = stack.indexOf(layer)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [active, level])
}
