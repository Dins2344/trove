import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../db/database'
import { replaceChunks, upsertFile } from '../db/repository'
import { normalize } from '../vectors'
import { search } from './index'
import { FlatVectorIndex } from './vector-index'

let db: Database

beforeEach(() => {
  db = openDatabase(':memory:')
})

/**
 * Three-dimensional vectors standing in for real embeddings, so the semantic
 * leg's behaviour can be asserted exactly rather than inferred from a model.
 * Axis 0 = "money", axis 1 = "gardening", axis 2 = "deployment".
 */
const AXES = {
  money: normalize(new Float32Array([1, 0, 0])),
  gardening: normalize(new Float32Array([0, 1, 0])),
  deployment: normalize(new Float32Array([0, 0, 1]))
} as const

function addFile(path: string, chunks: { text: string; embedding?: Float32Array }[]): void {
  const fileId = upsertFile(db, {
    path,
    mtimeMs: 1,
    sizeBytes: 1,
    contentHash: `hash-${path}`
  })

  replaceChunks(
    db,
    fileId,
    chunks.map((chunk, ordinal) => ({
      ordinal,
      text: chunk.text,
      startLine: ordinal * 10 + 1,
      endLine: ordinal * 10 + 5,
      headingPath: null,
      embedding: chunk.embedding
    }))
  )
}

/** Stands in for the model: returns whichever axis the caller asks for. */
function fakeEmbedder(vector: Float32Array) {
  return async (): Promise<Float32Array> => vector
}

describe('search', () => {
  it('returns nothing for an empty query', async () => {
    addFile('C:\\notes\\a.md', [{ text: 'invoicing procedure', embedding: AXES.money }])
    const index = FlatVectorIndex.load(db)

    expect(await search(db, index, fakeEmbedder(AXES.money), '')).toEqual([])
    expect(await search(db, index, fakeEmbedder(AXES.money), '   ')).toEqual([])
  })

  it('finds a chunk by keyword alone when no vectors exist', async () => {
    // Embeddings still pending: keyword search must work on its own, which is
    // what keeps a half-finished index useful.
    addFile('C:\\notes\\handbook.md', [{ text: 'the invoicing procedure for contractors' }])
    const index = FlatVectorIndex.load(db)

    const results = await search(db, index, fakeEmbedder(AXES.money), 'invoicing')

    expect(results).toHaveLength(1)
    expect(results[0].fileName).toBe('handbook.md')
    expect(results[0].matchedKeyword).toBe(true)
    expect(results[0].matchedSemantic).toBe(false)
  })

  it('finds a document with no shared keywords via the semantic leg', async () => {
    // The headline capability: the query and the target share no words.
    addFile('C:\\notes\\finance.md', [
      { text: 'Submit your expenses before the fifth.', embedding: AXES.money }
    ])
    addFile('C:\\notes\\garden.md', [
      { text: 'Prune the tomatoes before frost.', embedding: AXES.gardening }
    ])

    const index = FlatVectorIndex.load(db)
    const results = await search(db, index, fakeEmbedder(AXES.money), 'remuneration')

    expect(results.length).toBeGreaterThan(0)
    expect(results[0].fileName).toBe('finance.md')
    expect(results[0].matchedSemantic).toBe(true)
    expect(results[0].matchedKeyword).toBe(false)
  })

  it('ranks a chunk both legs agree on above one only a single leg found', async () => {
    addFile('C:\\notes\\both.md', [
      { text: 'invoicing and payment schedules', embedding: AXES.money }
    ])
    addFile('C:\\notes\\keyword-only.md', [{ text: 'invoicing trivia', embedding: AXES.gardening }])
    addFile('C:\\notes\\vector-only.md', [{ text: 'unrelated wording', embedding: AXES.money }])

    const index = FlatVectorIndex.load(db)
    const results = await search(db, index, fakeEmbedder(AXES.money), 'invoicing')

    expect(results[0].fileName).toBe('both.md')
    expect(results[0].matchedKeyword).toBe(true)
    expect(results[0].matchedSemantic).toBe(true)
  })

  it('caps how many passages one file contributes', async () => {
    addFile(
      'C:\\notes\\long.md',
      Array.from({ length: 8 }, (_, i) => ({
        text: `invoicing section number ${i}`,
        embedding: AXES.money
      }))
    )
    addFile('C:\\notes\\other.md', [{ text: 'invoicing elsewhere', embedding: AXES.money }])

    const index = FlatVectorIndex.load(db)
    const results = await search(db, index, fakeEmbedder(AXES.money), 'invoicing', {
      maxPerFile: 2
    })

    const fromLong = results.filter((result) => result.fileName === 'long.md')
    expect(fromLong).toHaveLength(2)
    // The cap must leave room for other files rather than truncating the list.
    expect(results.some((result) => result.fileName === 'other.md')).toBe(true)
  })

  it('respects the result limit', async () => {
    addFile(
      'C:\\notes\\a.md',
      Array.from({ length: 5 }, (_, i) => ({ text: `invoicing ${i}`, embedding: AXES.money }))
    )
    addFile(
      'C:\\notes\\b.md',
      Array.from({ length: 5 }, (_, i) => ({ text: `invoicing ${i}`, embedding: AXES.money }))
    )

    const index = FlatVectorIndex.load(db)
    const results = await search(db, index, fakeEmbedder(AXES.money), 'invoicing', {
      limit: 3,
      maxPerFile: 5
    })

    expect(results).toHaveLength(3)
  })

  it('carries line numbers and heading breadcrumbs through to results', async () => {
    const fileId = upsertFile(db, {
      path: 'C:\\notes\\handbook.md',
      mtimeMs: 1,
      sizeBytes: 1,
      contentHash: 'h'
    })
    replaceChunks(db, fileId, [
      {
        ordinal: 0,
        text: 'submit invoices before the fifth',
        startLine: 12,
        endLine: 18,
        headingPath: 'Handbook > Invoicing',
        embedding: AXES.money
      }
    ])

    const index = FlatVectorIndex.load(db)
    const results = await search(db, index, fakeEmbedder(AXES.money), 'invoices')

    expect(results[0].startLine).toBe(12)
    expect(results[0].endLine).toBe(18)
    expect(results[0].headingPath).toBe('Handbook > Invoicing')
    expect(results[0].filePath).toBe('C:\\notes\\handbook.md')
  })

  it('does not throw on punctuation-only or operator-like input', async () => {
    addFile('C:\\notes\\a.md', [{ text: 'invoicing', embedding: AXES.money }])
    const index = FlatVectorIndex.load(db)

    // Raw FTS5 syntax would be a query error if passed through unescaped.
    await expect(
      search(db, index, fakeEmbedder(AXES.money), 'NEAR(a b) OR col:x -y "unclosed')
    ).resolves.toBeInstanceOf(Array)
  })
})

describe('FlatVectorIndex', () => {
  it('is empty when nothing has been embedded', () => {
    addFile('C:\\notes\\a.md', [{ text: 'no vector yet' }])
    expect(FlatVectorIndex.load(db).size).toBe(0)
  })

  it('loads only embedded chunks and reports the model dimension', () => {
    addFile('C:\\notes\\a.md', [
      { text: 'embedded', embedding: AXES.money },
      { text: 'pending' }
    ])

    const index = FlatVectorIndex.load(db)
    expect(index.size).toBe(1)
    expect(index.dimension).toBe(3)
  })

  it('ranks by cosine similarity, best first', () => {
    addFile('C:\\notes\\money.md', [{ text: 'money', embedding: AXES.money }])
    addFile('C:\\notes\\garden.md', [{ text: 'garden', embedding: AXES.gardening }])
    addFile('C:\\notes\\deploy.md', [{ text: 'deploy', embedding: AXES.deployment }])

    const index = FlatVectorIndex.load(db)
    const hits = index.search(AXES.money, 3)

    expect(hits).toHaveLength(3)
    expect(hits[0].score).toBeCloseTo(1, 5)
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })

  it('honours the requested limit', () => {
    addFile(
      'C:\\notes\\a.md',
      Array.from({ length: 10 }, (_, i) => ({ text: `chunk ${i}`, embedding: AXES.money }))
    )

    expect(FlatVectorIndex.load(db).search(AXES.money, 4)).toHaveLength(4)
  })

  it('rejects a query of the wrong width', () => {
    addFile('C:\\notes\\a.md', [{ text: 'x', embedding: AXES.money }])
    const index = FlatVectorIndex.load(db)

    // A dimension mismatch means the model changed; failing loudly beats
    // returning silently meaningless rankings.
    expect(() => index.search(new Float32Array([1, 0]), 5)).toThrow(/dims/)
  })
})
