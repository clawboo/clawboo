// The write half of `clawboo backup`, apart from index.ts so it can be unit-tested
// (importing index.ts parses argv and runs the CLI).

import fs from 'fs'

/**
 * Copy the database at `source` to a new file at `dest`, readable only by its owner.
 *
 * The database holds every board, chat and memory plus the secret that signs MCP
 * attach URLs, so its copy gets the same 0600 the original has. The file is created
 * 0600 BEFORE any page is copied: SQLite treats an empty file as an empty database
 * and keeps the mode of a file it did not create, so the copy is never readable by
 * other users, even mid-write. `dest` must not exist. On failure the partial file
 * is removed, so a retry does not trip over it. POSIX modes are advisory on Windows,
 * where the mode is a no-op.
 *
 * Opens the source read-only, so a backup can run while the server is live without
 * taking a write lock. better-sqlite3's online `.backup()` reads pages via the
 * shared WAL and produces a single checkpoint-consistent file with no `-wal`/`-shm`
 * sidecars: the documented "one-file" backup recipe.
 */
export async function writeDatabaseBackup(source: string, dest: string): Promise<void> {
  fs.closeSync(fs.openSync(dest, 'wx', 0o600))
  try {
    const Database = (await import('better-sqlite3')).default as typeof import('better-sqlite3')
    const src = new Database(source, { readonly: true, fileMustExist: true })
    try {
      await src.backup(dest)
    } finally {
      src.close()
    }
  } catch (err) {
    fs.rmSync(dest, { force: true })
    throw err
  }
}
