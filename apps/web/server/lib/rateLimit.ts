// Request-rate ceilings for the HTTP surface.
//
// Clawboo runs as a local, single-operator dashboard. The browser polls a
// handful of endpoints on timers and a busy board fans out dozens of requests a
// second, so the general ceiling sits far above anything real usage produces:
// it is there to stop a runaway client, a page left open in a reload loop, or a
// script pointed at the port from pinning the machine, not to meter a shared
// multi-tenant API.
//
// The strict ceiling guards the routes where one request costs far more than a
// database read: installing or reconfiguring a runtime, driving the gateway,
// launching a CLI login, approving a device, and replacing the running binary.
// Those are operator actions taken a few times a session, so a low ceiling
// never inconveniences a real operator while sharply limiting how fast anything
// else can drive them.
//
// Counting is per client address in the default in-memory store, which suits a
// process that owns its port and keeps no cross-process state. The app sets no
// `trust proxy`, so the address is the socket's and cannot be spoofed by a
// forwarded-for header.

import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit'

const WINDOW_MS = 60_000

/** Ordinary API traffic, including the UI's polling loops. */
export const generalLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: WINDOW_MS,
  limit: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Wait a moment and retry.' },
})

/** Routes that spawn processes, rewrite runtime config, or grant access. */
export const sensitiveLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: WINDOW_MS,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests for this operation. Wait a moment and retry.' },
})

/** The static SPA shell and its deep-link fallback. */
export const staticLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: WINDOW_MS,
  limit: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Wait a moment and retry.' },
})
