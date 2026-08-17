import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from './migrations'

/**
 * Storage runs on Node's built-in SQLite rather than a native addon.
 *
 * The original plan called for better-sqlite3, but it needs node-gyp, which
 * needs Visual Studio Build Tools, and which additionally refuses to build
 * under a path containing a space. `node:sqlite` ships inside Electron's own
 * Node build: no compile step, no `electron-rebuild`, no per-platform prebuilds
 * to package, and CI stays a plain `npm ci`.
 *
 * The trade is that `node:sqlite` is still flagged experimental, so everything
 * touching it goes through this module. Swapping engines means rewriting this
 * file and `repository.ts`, not the whole app.
 */
export type Database = DatabaseSync

export interface OpenOptions {
  /**
   * Reader connections are used by the search path. WAL lets them run
   * concurrently with the indexing worker's writer without blocking.
   */
  readonly?: boolean
}

let warningSuppressed = false

/**
 * Node prints an ExperimentalWarning the first time `node:sqlite` is used.
 * It is accurate but it is not actionable for the user, and it would otherwise
 * appear in the packaged app's logs on every launch.
 */
function suppressExperimentalWarning(): void {
  if (warningSuppressed) return
  warningSuppressed = true

  const original = process.emitWarning.bind(process)
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message
    if (message.includes('SQLite is an experimental feature')) return
    // @ts-expect-error -- forwarding the original variadic overloads verbatim
    return original(warning, ...rest)
  }) as typeof process.emitWarning
}

export function openDatabase(file: string, options: OpenOptions = {}): Database {
  suppressExperimentalWarning()

  const readonly = options.readonly ?? false
  const db = new DatabaseSync(file, { readOnly: readonly })

  if (!readonly) {
    // WAL is what makes "worker writes while main reads" safe. It is a
    // persistent property of the file, so only the writer needs to set it.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  db.exec('PRAGMA foreign_keys = ON')
  // Two processes share this file; a reader hitting a checkpoint should wait
  // rather than immediately throwing SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000')

  if (!readonly) migrate(db)

  return db
}

export function migrate(db: Database): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  const current = row?.user_version ?? 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    if (!Number.isInteger(migration.version)) {
      throw new Error(`Migration version must be an integer: ${migration.version}`)
    }

    transaction(db, () => {
      db.exec(migration.sql)
      // PRAGMA cannot be parameterised; the value is an integer literal from
      // our own source, checked above.
      db.exec(`PRAGMA user_version = ${migration.version}`)
    })
  }
}

/**
 * `node:sqlite` has no equivalent of better-sqlite3's `.transaction()` wrapper,
 * so this fills the gap. Not re-entrant -- do not nest calls.
 */
export function transaction<T>(db: Database, run: () => T): T {
  db.exec('BEGIN')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw error
  }
}
