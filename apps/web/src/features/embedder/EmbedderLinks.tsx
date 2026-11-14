// Headless: in an app that shows the dashboard in its own window, a click on one
// of the app's notifications opens what it was about. Mounted once at the app
// root, so a click from before the dashboard was signed in waits in the app
// until this subscribes. See ./openTargets.

import { useEffect } from 'react'

import { startEmbedderLinks } from './openTargets'

export function EmbedderLinks(): null {
  useEffect(() => {
    startEmbedderLinks()
  }, [])
  return null
}
