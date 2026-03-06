import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return NextResponse.json({ running: false, models: [] })
    const data = (await response.json()) as { models?: { name: string }[] }
    const models = (data.models ?? []).map((m) => m.name)
    return NextResponse.json({ running: true, models })
  } catch {
    return NextResponse.json({ running: false, models: [] })
  }
}
