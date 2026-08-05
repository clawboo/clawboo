import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installGlobalErrorHandlers } from './app/globalErrorHandlers'
import { ErrorBoundary } from './features/shared/ErrorBoundary'
import './app/globals.css'

// Non-React failures (a throw inside a listener, a promise nobody awaited) never
// reach an error boundary — without this they vanish with no app context.
installGlobalErrorHandlers()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Root boundary — the app's last line of defence, so an uncaught throw
        shows a card with a reload instead of a blank white page. It lives HERE
        rather than inside App because a boundary only catches its DESCENDANTS:
        this is the only placement that also covers <Providers> (QueryClient +
        ThemeProvider) and App's own hooks. The fallback needs no context —
        index.html's inline theme script sets the `.dark` class before React
        mounts and globals.css is imported above, so the tokens resolve even if
        Providers never rendered. */}
    <ErrorBoundary variant="app" label="Clawboo">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
