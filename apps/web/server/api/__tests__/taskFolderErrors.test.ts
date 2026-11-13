// The task folder routes' failures: a folder removed while it was read (the
// boot cleanup, a team delete) is not found, and any other failure is logged
// and answered without the server's paths.

import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listTaskFolderDir = vi.fn()
const readTaskFolderFile = vi.fn()

vi.mock('../../lib/workspaceFs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/workspaceFs')>()),
  listTaskFolderDir: (...args: unknown[]) => listTaskFolderDir(...args),
  readTaskFolderFile: (...args: unknown[]) => readTaskFolderFile(...args),
}))

const { boardTaskFolderFileGET, boardTaskFolderTreeGET } = await import('../board')

function fakeRes(): { res: Response; status: () => number; body: () => unknown } {
  let code = 200
  let payload: unknown
  const res = {
    status(n: number) {
      code = n
      return res
    },
    json(b: unknown) {
      payload = b
      return res
    },
  } as unknown as Response
  return { res, status: () => code, body: () => payload }
}

const req = (query: Record<string, string>): Request =>
  ({ params: { taskId: 'task-1' }, query }) as unknown as Request

const gone = (): Error =>
  Object.assign(
    new Error("ENOENT: no such file or directory, scandir '/srv/work/teams/T/tasks/task-1'"),
    {
      code: 'ENOENT',
    },
  )

describe('task folder routes: failures', () => {
  beforeEach(() => {
    listTaskFolderDir.mockReset()
    readTaskFolderFile.mockReset()
  })

  it('answer 404 for a folder removed while it was read', async () => {
    listTaskFolderDir.mockRejectedValue(gone())
    readTaskFolderFile.mockRejectedValue(gone())
    const tree = fakeRes()
    await boardTaskFolderTreeGET(req({}), tree.res)
    expect(tree.status()).toBe(404)
    expect(tree.body()).toMatchObject({ reason: 'gone' })
    const file = fakeRes()
    await boardTaskFolderFileGET(req({ path: 'a.md' }), file.res)
    expect(file.status()).toBe(404)
  })

  it('answer 500 without the server path for any other failure', async () => {
    listTaskFolderDir.mockRejectedValue(new Error('EIO reading /srv/work/teams/T/tasks/task-1'))
    const tree = fakeRes()
    await boardTaskFolderTreeGET(req({}), tree.res)
    expect(tree.status()).toBe(500)
    expect(JSON.stringify(tree.body())).not.toContain('/srv/work')
  })
})
