---
'clawboo': patch
---

Welcome redesign, lighter install, and team color collections:

- **New calm Day-sky welcome** — a soft animated sky with drifting clouds (pure CSS/SVG) replaces the WebGL ShaderGradient atmosphere on the onboarding splash and home welcome, with a faint "boo-verse" of distant boo silhouettes drifting behind the clouds. The welcome is theme-independent (always the bright sky).
- **Removed the WebGL/three.js stack** (`@shadergradient/react`, `@react-three/fiber`, `three`, `three-stdlib`) — smaller install/bundle, no GPU cost on first paint.
- **Fresh installs default to light theme** so onboarding happens in light mode; switch to light/dark/system anytime after.
- **Team color collections** — each team picks from 8 color palettes with per-team hue rotation, and the create-team preview matches the deployed palette (DB migration 0004).
- **Token-usage tracking by team & agent**; onboarding flow improvements; removed the unused Ollama-check API.
