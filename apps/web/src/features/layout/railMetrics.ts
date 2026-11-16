// The team rail's measurements, in one place so the rail, its error fallback,
// the hover peek's toggle and the resize drag all agree on them.

/** The rail's width: as wide as the macOS window buttons (close, minimise,
 *  zoom span about x 12 to 68), so in a window with a hidden title bar the
 *  rail's column lines up under them. */
export const RAIL_WIDTH = 72

/** A team icon, Boo Zero's icon and the archived group's button: 12px of rail
 *  on either side. */
export const RAIL_ICON_SIZE = 48

/** The sidebar toggle's size (SidebarToggle is h-8 w-8). */
export const TOGGLE_SIZE = 32

/** The furthest right the rail's toggle may sit and still fit inside the rail. */
export const MAX_TOGGLE_LEFT = RAIL_WIDTH - TOGGLE_SIZE

/** The radius of the rounded top-left corner of the sheet right of the rail,
 *  under the slim top bar (12px, matched to the owner's reference crop). */
export const SHEET_RADIUS = 12

/** With no agent column (Boo Zero's view), dragging the sidebar's edge this far
 *  left of the rail's edge collapses it: two thirds of the rail. */
export const RAIL_COLLAPSE_DRAG = -Math.round((RAIL_WIDTH * 2) / 3)
