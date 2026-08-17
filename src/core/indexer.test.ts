import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from './db/database'
import { getIndexStats, loadIndexedState } from './db/repository'
import { indexFolder } from './indexer'

let db: Database
let root: string

beforeEach(async () => {
  db = openDatabase(':memory:')
  root = await mkdtemp(join(tmpdir(), 'trove-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Counts FTS hits, i.e. what keyword search would actually return. */
function ftsMatches(query: string): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?')
    .get(query) as { n: number }
  return row.n
}

async function writeCorpus(): Promise<void> {
  await writeFile(
    join(root, 'handbook.md'),
    ['# Handbook', '', '## Invoicing', '', 'Submit invoices before the fifth of the month.'].join(
      '\n'
    ),
    'utf8'
  )
  await writeFile(join(root, 'notes.txt'), 'Gardening notes about tomatoes and mulch.', 'utf8')

  const nested = join(root, 'projects', 'alpha')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'readme.md'), 'Alpha project deployment runbook.', 'utf8')

  // Must be skipped by the walker's ignore rules.
  const ignored = join(root, 'node_modules', 'left-pad')
  await mkdir(ignored, { recursive: true })
  await writeFile(join(ignored, 'index.js'), 'module.exports = () => {}', 'utf8')

  // Dot-directories are tooling state, not documents.
  const dotDir = join(root, '.git')
  await mkdir(dotDir, { recursive: true })
  await writeFile(join(dotDir, 'COMMIT_EDITMSG'), 'chore: nothing to see here', 'utf8')

  // Right extension, binary payload -- must not be indexed as mojibake.
  await writeFile(join(root, 'blob.txt'), Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43]))
}

describe('indexFolder', () => {
  it('indexes a folder into chunks that are searchable by keyword', async () => {
    await writeCorpus()

    const progress = await indexFolder(db, root)

    expect(progress.phase).toBe('done')
    expect(progress.filesIndexed).toBe(3)
    expect(progress.filesFailed).toBe(0)
    expect(progress.chunksWritten).toBeGreaterThan(0)

    const stats = getIndexStats(db)
    expect(stats.chunks).toBeGreaterThan(0)
    // Embedding is the worker's job; chunks land with a NULL vector.
    expect(stats.embeddedChunks).toBe(0)

    expect(ftsMatches('invoices')).toBeGreaterThan(0)
    expect(ftsMatches('tomatoes')).toBeGreaterThan(0)
    expect(ftsMatches('runbook')).toBeGreaterThan(0)
  })

  it('skips ignored directories and binary files', async () => {
    await writeCorpus()
    await indexFolder(db, root)

    const paths = [...loadIndexedState(db).keys()]

    expect(paths.some((path) => path.includes('node_modules'))).toBe(false)
    expect(paths.some((path) => path.includes('.git'))).toBe(false)
    // The binary file is recorded so it is not re-read every scan, but it
    // contributes no chunks.
    expect(ftsMatches('ABC')).toBe(0)
  })

  it('preserves heading breadcrumbs and line numbers through to storage', async () => {
    await writeCorpus()
    await indexFolder(db, root)

    const row = db
      .prepare(
        `SELECT heading_path, start_line, end_line
         FROM chunks WHERE text LIKE '%before the fifth%' LIMIT 1`
      )
      .get() as { heading_path: string | null; start_line: number; end_line: number } | undefined

    expect(row).toBeDefined()
    expect(row?.heading_path).toBe('Handbook > Invoicing')
    expect(row?.start_line).toBeGreaterThanOrEqual(1)
    expect(row?.end_line).toBeGreaterThanOrEqual(row?.start_line ?? 0)
  })

  it('does no work on a second run when nothing changed', async () => {
    await writeCorpus()
    const first = await indexFolder(db, root)
    expect(first.filesIndexed).toBe(3)

    const second = await indexFolder(db, root)

    // This is the fast path that makes reopening the app cheap.
    expect(second.filesIndexed).toBe(0)
    expect(second.filesSkipped).toBe(second.filesSeen)
    expect(second.filesRemoved).toBe(0)
  })

  it('re-indexes only the file whose content actually changed', async () => {
    await writeCorpus()
    await indexFolder(db, root)

    await writeFile(join(root, 'notes.txt'), 'Gardening notes now mention beetroot instead.', 'utf8')
    const progress = await indexFolder(db, root)

    expect(progress.filesIndexed).toBe(1)
    expect(ftsMatches('beetroot')).toBeGreaterThan(0)
    // Stale content must not survive the replace.
    expect(ftsMatches('tomatoes')).toBe(0)
  })

  it('skips re-embedding a file rewritten with identical bytes', async () => {
    await writeCorpus()
    await indexFolder(db, root)

    // Simulates format-on-save or a copy: mtime moves, content does not.
    const target = join(root, 'notes.txt')
    const future = new Date(Date.now() + 60_000)
    await utimes(target, future, future)

    const progress = await indexFolder(db, root)

    // The hash gate catches it, so no chunks are rewritten.
    expect(progress.filesIndexed).toBe(0)
    expect(progress.filesSkipped).toBe(progress.filesSeen)
  })

  it('prunes files that have been deleted from disk', async () => {
    await writeCorpus()
    await indexFolder(db, root)
    expect(ftsMatches('tomatoes')).toBeGreaterThan(0)

    await rm(join(root, 'notes.txt'))
    const progress = await indexFolder(db, root)

    expect(progress.filesRemoved).toBe(1)
    // A deleted file must stop returning as a search result.
    expect(ftsMatches('tomatoes')).toBe(0)
  })

  it('reports progress as it goes', async () => {
    await writeCorpus()

    const phases = new Set<string>()
    await indexFolder(db, root, {
      progressIntervalMs: 0,
      onProgress: (progress) => phases.add(progress.phase)
    })

    expect(phases.has('scanning')).toBe(true)
    expect(phases.has('done')).toBe(true)
  })

  it('stops promptly when aborted', async () => {
    await writeCorpus()

    const controller = new AbortController()
    controller.abort()

    const progress = await indexFolder(db, root, { signal: controller.signal })

    expect(progress.filesIndexed).toBe(0)
    // An aborted run must not prune, or a cancelled scan would delete the index.
    expect(progress.filesRemoved).toBe(0)
  })
})
