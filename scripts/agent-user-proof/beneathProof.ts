// The agent host's share operations stay beneath the share's root on Linux,
// even when a folder is swapped for a link after any check. Bundled by run.sh
// and run in the container (it needs /proc/self/fd).
//
// A share root R holds a folder; a "victim" folder V outside it stands for an
// agent's own home. Every operation goes through `beneath.ts`. Each check
// prints PASS or FAIL; the exit code is the number of failures.

import fs from 'node:fs'
import path from 'node:path'

import {
  beneathAppend,
  beneathAvailable,
  beneathList,
  beneathMkdir,
  beneathRead,
  beneathRename,
  beneathRm,
  beneathRmdir,
  beneathStat,
  beneathWrite,
  openDirBeneath,
} from '../../apps/web/server/agentHost/beneath'

let failures = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}\n`,
  )
}

async function refused(fn: () => unknown): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (err) {
    return (err as { code?: string }).code ?? 'ERR'
  }
}

async function main(): Promise<void> {
  check('descriptor-relative lookups are available', beneathAvailable())
  const base = fs.mkdtempSync('/tmp/beneath-')
  fs.mkdirSync(path.join(base, 'root'))
  const R = fs.realpathSync(path.join(base, 'root'))
  const V = path.join(base, 'victim')
  fs.mkdirSync(path.join(V, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(V, 'secret.txt'), 'secret')

  // What a share needs still works.
  beneathMkdir(R, ['a', 'b'], 0o770)
  beneathWrite(R, ['a', 'b', 'f.txt'], Buffer.from('one'), 0o660, false)
  beneathAppend(R, ['a', 'b', 'f.txt'], Buffer.from('+two'), 0o660)
  check(
    'a file is made, appended and read beneath the root',
    beneathRead(R, ['a', 'b', 'f.txt'], 100, 0).data.toString() === 'one+two',
  )
  check(
    'a listing works',
    (await beneathList(R, ['a', 'b'], 10)).entries.map((e) => e.name).join() === 'f.txt',
  )
  beneathRename(R, ['a', 'b', 'f.txt'], ['a', 'g.txt'])
  check('a rename works', beneathStat(R, ['a', 'g.txt'])?.type === 'file')
  beneathRmdir(R, ['a', 'b'])
  await beneathRm(R, ['a'])
  check('a folder tree is removed', beneathStat(R, ['a']) === null)

  // A folder of the share is a link into the victim (a teammate's swap). `x` is
  // a real file in the share, the source the rename-in case moves.
  fs.symlinkSync(V, path.join(R, 's'))
  fs.writeFileSync(path.join(R, 'x'), 'x')
  const victimIntact = (): boolean =>
    fs.readFileSync(path.join(V, 'secret.txt'), 'utf8') === 'secret' &&
    fs.existsSync(path.join(V, 'sub'))
  for (const [what, op] of [
    ['remove', () => beneathRm(R, ['s', 'secret.txt'])],
    ['remove a folder', () => beneathRmdir(R, ['s', 'sub'])],
    ['rename out', () => beneathRename(R, ['s', 'secret.txt'], ['stolen.txt'])],
    ['make a folder', () => beneathMkdir(R, ['s', 'made'], 0o770)],
    ['write', () => beneathWrite(R, ['s', 'planted.txt'], Buffer.from('x'), 0o660, false)],
    ['append', () => beneathAppend(R, ['s', 'secret.txt'], Buffer.from('x'), 0o660)],
    ['read', () => beneathRead(R, ['s', 'secret.txt'], 100, 0)],
    ['list', () => beneathList(R, ['s'], 10)],
  ] as const) {
    const code = await refused(op)
    check(
      `${what} through a swapped folder is refused (${code})`,
      code !== null && victimIntact(),
      code,
    )
  }
  // Renaming into the swapped folder: the source exists, so a refusal here is
  // the destination check, not a missing file.
  const renameIn = await refused(() => beneathRename(R, ['x'], ['s', 'planted.txt']))
  check(
    `rename in through a swapped folder is refused (${renameIn})`,
    renameIn !== null &&
      renameIn !== 'ENOENT' &&
      fs.existsSync(path.join(R, 'x')) &&
      !fs.existsSync(path.join(V, 'planted.txt')) &&
      victimIntact(),
    renameIn,
  )
  check(
    'nothing was made in the victim',
    !fs.existsSync(path.join(V, 'made')) && !fs.existsSync(path.join(V, 'planted.txt')),
  )

  // A swap while a folder is held: the operation stays with the folder that was
  // opened, not with whatever the name points to now.
  beneathMkdir(R, ['t'], 0o770)
  const held = openDirBeneath(R, ['t'], null)
  fs.renameSync(path.join(R, 't'), path.join(R, 't.old'))
  fs.symlinkSync(V, path.join(R, 't'))
  fs.writeFileSync(`/proc/self/fd/${held}/z.txt`, 'z')
  fs.closeSync(held)
  check(
    'a write through a held folder lands in that folder, not in the link swapped in',
    fs.existsSync(path.join(R, 't.old', 'z.txt')) && !fs.existsSync(path.join(V, 'z.txt')),
  )

  // What this replaces: by name, a remove follows the swapped folder.
  await fs.promises.rm(path.join(R, 's', 'secret.txt'), { force: true })
  check(
    'by name (the old way), a remove through the link deletes the victim file',
    !fs.existsSync(path.join(V, 'secret.txt')),
  )

  fs.rmSync(base, { recursive: true, force: true })
  process.exit(failures)
}

main().catch((err: unknown) => {
  process.stdout.write(
    `FAIL  the beneath proof threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(failures + 1)
})
