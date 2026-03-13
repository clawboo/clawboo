import type { Request, Response } from 'express'

export async function ollamaCheckGET(_req: Request, res: Response): Promise<void> {
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) {
      res.json({ running: false, models: [] })
      return
    }
    const data = (await response.json()) as { models?: { name: string }[] }
    const models = (data.models ?? []).map((m) => m.name)
    res.json({ running: true, models })
  } catch {
    res.json({ running: false, models: [] })
  }
}
