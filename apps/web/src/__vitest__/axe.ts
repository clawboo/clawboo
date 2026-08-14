// Shared jest-axe entry point for component suites.
//
// Why this exists: every `.test.tsx` a11y sweep used to pass
// `{ rules: { 'color-contrast': { enabled: false } } }` by hand — ten copies of
// the same literal. That option was dead code. jest-axe's `configureAxe()` runs
// at import time and calls `axeCore.configure()` with every `cat.color` rule
// (`color-contrast`, `color-contrast-enhanced`, `link-in-text-block`) already
// disabled, because jsdom loads no CSS and has no layout. Even force-enabling
// the rule can't fail a suite: axe reports such nodes as `incomplete`, and
// `toHaveNoViolations` reads only `results.violations`.
//
// Colour contrast is guarded at the TOKEN level instead — see
// `src/app/__tests__/tokenContrast.test.ts`, which parses `globals.css` and
// asserts WCAG ratios directly. That guard has teeth; an axe sweep in jsdom
// never could.
//
// Note the ruleset is deliberately left at axe's default (no `runOnly` tag
// filter): narrowing it to wcag2a/wcag2aa would silently drop the best-practice
// rules these suites exercise today.

import { axe as jestAxe } from 'jest-axe'

type AxeResults = Awaited<ReturnType<typeof jestAxe>>

/** Run the jest-axe sweep over a rendered container. */
export function axe(container: Element): Promise<AxeResults> {
  return jestAxe(container)
}
