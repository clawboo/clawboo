// SVG <defs> with the arrowhead marker referenced by `DependencyEdge`'s
// `markerEnd`. Mounted ONCE at the top of `GhostGraph` so every dependency
// edge can reference `url(#dependency-arrow)` without re-defining the
// marker per-edge. Marker IDs are global to the document, so a single
// mount is sufficient.
//
// The marker is intentionally kept compact (8×8) and inset slightly from
// the target node (`refX=9` on a 0–10 viewBox) so the arrow tip sits at
// the edge of the target Boo without overlapping its body.

export function EdgeMarkers() {
  return (
    <svg
      // Hidden — this is just a host for the <defs> block. Width/height 0
      // and absolute positioning keep it out of the layout flow.
      style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
      aria-hidden
    >
      <defs>
        <marker
          id="dependency-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(233,69,96,0.85)" />
        </marker>
      </defs>
    </svg>
  )
}
