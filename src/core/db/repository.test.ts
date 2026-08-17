import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Database } from './database'
import { MIGRATIONS } from './migrations'
import {
  addFolder,
  clearEmbeddings,
  deleteFileByPath,
  deleteFilesUnder,
  getFileByPath,
  getIndexStats,
  getMeta,
  isModelMismatched,
  listFolders,
  loadIndexedState,
  removeFolder,
  replaceChunks,
  setMeta,
  touchFileMetadata,
  upsertFile,
  META_MODEL_ID
} from './repository'
import { blobToEmbedding, normalize } from '../vectors'

let db: Database

beforeEach(() => {
  db = openDatabase(':memory:')
})

function seedFile(path = 'C:\\notes\\alpha.md'): number {
  return upsertFile(db, {
    path,
    mtimeMs: 1_000,
    sizeBytes: 42,
    contentHash: 'hash-a'
  })
}

describe('migrations', () => {
  const latestVersion = Math.max(...MIGRATIONS.map((migration) => migration.version))

  function userVersion(): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  }

  it('applies every migration and records the latest version', () => {
    expect(userVersion()).toBe(latestVersion)
  })

  it('is idempotent', () => {
    expect(() => migrate(db)).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
    expect(userVersion()).toBe(latestVersion)
  })

  it('numbers migrations uniquely and in ascending order', () => {
    const versions = MIGRATIONS.map((migration) => migration.version)
    expect(new Set(versions).size).toBe(versions.length)
    expect([...versions].sort((a, b) => a - b)).toEqual(versions)
  })

  it('indexes the predicate the embedding loop actually queries', () => {
    // Regression: v1 indexed "embedding IS NOT NULL" while the worker polls for
    // "IS NULL", so every batch fell back to a full scan.
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT id, text FROM chunks WHERE embedding IS NULL LIMIT 32')
      .all() as { detail: string }[]

    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_chunks_pending')
  })
})

describe('files', () => {
  it('returns a stable id across insert and update', () => {
    const first = seedFile()
    const second = upsertFile(db, {
      path: 'C:\\notes\\alpha.md',
      mtimeMs: 2_000,
      sizeBytes: 84,
      contentHash: 'hash-b'
    })

    expect(second).toBe(first)
    expect(getIndexStats(db).files).toBe(1)
  })

  it('loads all indexed state in one pass', () => {
    seedFile('C:\\notes\\a.md')
    seedFile('C:\\notes\\b.md')

    const state = loadIndexedState(db)
    expect(state.size).toBe(2)
    expect(state.get('C:\\notes\\a.md')).toEqual({
      mtimeMs: 1_000,
      sizeBytes: 42,
      contentHash: 'hash-a',
      retryable: false
    })
  })

  it('does not mark a fresh failure retryable under the same extractor', () => {
    // Written by the current extractor, so re-running it would fail identically.
    upsertFile(db, {
      path: 'C:\\notes\\encrypted.pdf',
      mtimeMs: 1,
      sizeBytes: 1,
      contentHash: '',
      status: 'failed',
      errorMessage: 'No password given'
    })
    seedFile('C:\\notes\\fine.md')

    const state = loadIndexedState(db)
    expect(state.get('C:\\notes\\encrypted.pdf')?.retryable).toBe(false)
    expect(state.get('C:\\notes\\fine.md')?.retryable).toBe(false)
  })

  it('marks a failure from an older extractor retryable', () => {
    upsertFile(db, {
      path: 'C:\\notes\\broken.pdf',
      mtimeMs: 1,
      sizeBytes: 1,
      contentHash: '',
      status: 'failed',
      errorMessage: 'DOMMatrix is not defined'
    })
    // Simulates a row written before the extractor was upgraded.
    db.prepare('UPDATE files SET extractor_version = 0 WHERE path = ?').run('C:\\notes\\broken.pdf')

    expect(loadIndexedState(db).get('C:\\notes\\broken.pdf')?.retryable).toBe(true)
  })

  it('clears the failed state once a file indexes successfully', () => {
    upsertFile(db, {
      path: 'C:\\notes\\broken.pdf',
      mtimeMs: 1,
      sizeBytes: 1,
      contentHash: '',
      status: 'failed',
      errorMessage: 'boom'
    })
    upsertFile(db, {
      path: 'C:\\notes\\broken.pdf',
      mtimeMs: 2,
      sizeBytes: 9,
      contentHash: 'recovered'
    })

    expect(getFileByPath(db, 'C:\\notes\\broken.pdf')?.status).toBe('indexed')
    expect(loadIndexedState(db).get('C:\\notes\\broken.pdf')?.retryable).toBe(false)
  })

  it('refreshes metadata without disturbing chunks', () => {
    const fileId = seedFile()
    replaceChunks(db, fileId, [
      { ordinal: 0, text: 'the invoicing procedure', startLine: 1, endLine: 2, headingPath: null }
    ])

    touchFileMetadata(db, 'C:\\notes\\alpha.md', 9_999, 4_242)

    const state = loadIndexedState(db).get('C:\\notes\\alpha.md')
    expect(state?.mtimeMs).toBe(9_999)
    expect(state?.sizeBytes).toBe(4_242)
    // The point of the metadata-only path: chunks survive, so nothing is re-embedded.
    expect(getIndexStats(db).chunks).toBe(1)
  })

  it('cascades chunk deletion when a file is removed', () => {
    const fileId = seedFile()
    replaceChunks(db, fileId, [
      { ordinal: 0, text: 'alpha', startLine: 1, endLine: 1, headingPath: null },
      { ordinal: 1, text: 'beta', startLine: 2, endLine: 2, headingPath: null }
    ])
    expect(getIndexStats(db).chunks).toBe(2)

    deleteFileByPath(db, 'C:\\notes\\alpha.md')
    expect(getIndexStats(db).chunks).toBe(0)
  })
})

describe('deleteFilesUnder', () => {
  function seedAt(path: string): void {
    const fileId = upsertFile(db, { path, mtimeMs: 1, sizeBytes: 1, contentHash: `h-${path}` })
    replaceChunks(db, fileId, [
      { ordinal: 0, text: `content of ${path}`, startLine: 1, endLine: 1, headingPath: null }
    ])
  }

  it('removes the folder and everything beneath it', () => {
    seedAt('C:\\notes\\a.md')
    seedAt('C:\\notes\\deep\\b.md')
    seedAt('C:\\other\\c.md')

    expect(deleteFilesUnder(db, 'C:\\notes')).toBe(2)

    const remaining = [...loadIndexedState(db).keys()]
    expect(remaining).toEqual(['C:\\other\\c.md'])
  })

  it('does not remove a sibling folder sharing a name prefix', () => {
    // The classic prefix bug: "C:\notes" must not match "C:\notes-archive".
    seedAt('C:\\notes\\a.md')
    seedAt('C:\\notes-archive\\b.md')

    deleteFilesUnder(db, 'C:\\notes')

    expect([...loadIndexedState(db).keys()]).toEqual(['C:\\notes-archive\\b.md'])
  })

  it('treats path wildcards as literal characters', () => {
    // A folder containing % or _ would be a LIKE wildcard; the prefix
    // comparison used instead has no such problem.
    seedAt('C:\\100%_backup\\a.md')
    seedAt('C:\\100X9backup\\b.md')

    deleteFilesUnder(db, 'C:\\100%_backup')

    expect([...loadIndexedState(db).keys()]).toEqual(['C:\\100X9backup\\b.md'])
  })

  it('drops the removed files from keyword search', () => {
    seedAt('C:\\notes\\a.md')
    deleteFilesUnder(db, 'C:\\notes')

    const row = db
      .prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'content'")
      .get() as { n: number }
    expect(row.n).toBe(0)
  })

  it('tolerates a trailing separator on the folder path', () => {
    seedAt('C:\\notes\\a.md')
    expect(deleteFilesUnder(db, 'C:\\notes\\')).toBe(1)
  })

  it('handles POSIX paths on any host', () => {
    // Runs identically on Windows and on the Linux CI runner: the separator is
    // read from the path, not from node:path.sep.
    seedAt('/home/dinso/notes/a.md')
    seedAt('/home/dinso/notes/deep/b.md')
    seedAt('/home/dinso/notes-archive/c.md')

    expect(deleteFilesUnder(db, '/home/dinso/notes')).toBe(2)
    expect([...loadIndexedState(db).keys()]).toEqual(['/home/dinso/notes-archive/c.md'])
  })
})

describe('chunks and the FTS index', () => {
  function ftsMatches(query: string): number {
    const row = db
      .prepare('SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?')
      .get(query) as { n: number }
    return row.n
  }

  it('indexes inserted chunks for keyword search', () => {
    const fileId = seedFile()
    replaceChunks(db, fileId, [
      {
        ordinal: 0,
        text: 'The invoicing procedure for contractors',
        startLine: 1,
        endLine: 3,
        headingPath: 'Handbook > Invoicing'
      }
    ])

    expect(ftsMatches('invoicing')).toBe(1)
    // Porter stemming is why a search for "invoice" finds "invoicing".
    expect(ftsMatches('invoice')).toBe(1)
  })

  it('keeps the FTS index in step when chunks are replaced', () => {
    const fileId = seedFile()
    replaceChunks(db, fileId, [
      { ordinal: 0, text: 'gardening in autumn', startLine: 1, endLine: 1, headingPath: null }
    ])
    expect(ftsMatches('gardening')).toBe(1)

    replaceChunks(db, fileId, [
      { ordinal: 0, text: 'invoicing in autumn', startLine: 1, endLine: 1, headingPath: null }
    ])

    // Without the delete trigger the stale row would linger and surface as a
    // search hit for a document that no longer contains the word.
    expect(ftsMatches('gardening')).toBe(0)
    expect(ftsMatches('invoicing')).toBe(1)
  })

  it('drops FTS rows when the parent file is deleted', () => {
    const fileId = seedFile()
    replaceChunks(db, fileId, [
      { ordinal: 0, text: 'ephemeral content', startLine: 1, endLine: 1, headingPath: null }
    ])
    expect(ftsMatches('ephemeral')).toBe(1)

    deleteFileByPath(db, 'C:\\notes\\alpha.md')
    expect(ftsMatches('ephemeral')).toBe(0)
  })

  it('round-trips embeddings through the blob column', () => {
    const fileId = seedFile()
    const embedding = normalize(new Float32Array([3, 0, 4, 0]))

    replaceChunks(db, fileId, [
      { ordinal: 0, text: 'vector chunk', startLine: 1, endLine: 1, headingPath: null, embedding }
    ])

    const row = db.prepare('SELECT embedding FROM chunks WHERE ordinal = 0').get() as {
      embedding: Uint8Array
    }
    const restored = blobToEmbedding(row.embedding)

    expect(restored.length).toBe(4)
    expect(restored[0]).toBeCloseTo(0.6, 5)
    expect(restored[2]).toBeCloseTo(0.8, 5)
  })

  it('counts embedded chunks separately from total chunks', () => {
    const fileId = seedFile()
    replaceChunks(db, fileId, [
      {
        ordinal: 0,
        text: 'embedded',
        startLine: 1,
        endLine: 1,
        headingPath: null,
        embedding: normalize(new Float32Array([1, 0]))
      },
      { ordinal: 1, text: 'not yet embedded', startLine: 2, endLine: 2, headingPath: null }
    ])

    expect(getIndexStats(db)).toEqual({ files: 1, chunks: 2, embeddedChunks: 1 })
  })
})

describe('meta and model identity', () => {
  it('stores and reads key/value pairs', () => {
    setMeta(db, 'greeting', 'hello')
    expect(getMeta(db, 'greeting')).toBe('hello')

    setMeta(db, 'greeting', 'goodbye')
    expect(getMeta(db, 'greeting')).toBe('goodbye')
  })

  it('reports no mismatch before a model has been recorded', () => {
    expect(isModelMismatched(db, 'minilm-v1')).toBe(false)
  })

  it('detects a model change, which invalidates every stored vector', () => {
    setMeta(db, META_MODEL_ID, 'minilm-v1')

    expect(isModelMismatched(db, 'minilm-v1')).toBe(false)
    expect(isModelMismatched(db, 'other-model-v2')).toBe(true)
  })

  it('can clear embeddings while keeping chunks searchable by keyword', () => {
    const fileId = seedFile()
    replaceChunks(db, fileId, [
      {
        ordinal: 0,
        text: 'invoicing',
        startLine: 1,
        endLine: 1,
        headingPath: null,
        embedding: normalize(new Float32Array([1, 0]))
      }
    ])

    clearEmbeddings(db)

    const stats = getIndexStats(db)
    expect(stats.chunks).toBe(1)
    expect(stats.embeddedChunks).toBe(0)
  })
})

describe('folders', () => {
  it('adds, lists and removes watched folders', () => {
    addFolder(db, 'C:\\notes')
    addFolder(db, 'C:\\docs')
    // Adding twice must not duplicate.
    addFolder(db, 'C:\\notes')

    expect(listFolders(db).map((folder) => folder.path)).toEqual(['C:\\docs', 'C:\\notes'])

    removeFolder(db, 'C:\\docs')
    expect(listFolders(db).map((folder) => folder.path)).toEqual(['C:\\notes'])
  })
})
