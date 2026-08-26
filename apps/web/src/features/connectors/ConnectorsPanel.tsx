// Connectors as a destination of its own.
//
// It used to be the fourth tab inside the Marketplace, behind Teams, Agents and
// Skills. Those three are a shop: you browse them once, deploy something, and
// rarely go back. Connecting the tools your agents actually use is a different
// errand, and it recurs. Filing it under shopping cost it three clicks and made
// it the hardest thing on the surface to find.

import { ConnectorsBrowser } from '@/features/marketplace/ConnectorsBrowser'
import { ConnectorMarkStyles } from './ConnectorMark'

export function ConnectorsPanel(): React.ReactElement {
  return (
    <div className="flex h-full flex-col">
      {/* Mounted once here rather than per row: every brand colour needs a light
          and a dark value, and an inline style cannot express a media query. */}
      <ConnectorMarkStyles />
      <ConnectorsBrowser />
    </div>
  )
}
