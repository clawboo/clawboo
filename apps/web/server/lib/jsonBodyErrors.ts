// A request body that is not valid JSON is answered here, without its text.
//
// Express's own handler prints the parser's error to the console, and that error
// quotes the body around where parsing stopped. A login or a token sent with one
// stray character would land in the server's output that way. So a parse failure
// gets a plain 400 and nothing is printed; every other error goes on as before.

import type { NextFunction, Request, Response } from 'express'

export function jsonBodyErrors(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const type = (err as { type?: unknown } | null)?.type
  if (type === 'entity.parse.failed') {
    res.status(400).json({ ok: false, error: 'invalid_json' })
    return
  }
  next(err)
}
