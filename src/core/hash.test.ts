import { describe, expect, it } from 'vitest'
import { compareContent, compareMetadata, hashBytes, type IndexedFileState } from './hash'

const stored: IndexedFileState = {
  mtimeMs: 1_000,
  sizeBytes: 500,
  contentHash: hashBytes('original content')
}

describe('compareMetadata', () => {
  it('treats an unknown path as new', () => {
    expect(compareMetadata(undefined, { mtimeMs: 1, sizeBytes: 1 })).toBe('new')
  })

  it('short-circuits when mtime and size both match', () => {
    // This is the fast path that makes reopening the app near-instant.
    expect(compareMetadata(stored, { mtimeMs: 1_000, sizeBytes: 500 })).toBe('unchanged')
  })

  it('requires a hash when mtime moves', () => {
    expect(compareMetadata(stored, { mtimeMs: 2_000, sizeBytes: 500 })).toBe('needs-hash')
  })

  it('requires a hash when size changes even if mtime somehow did not', () => {
    expect(compareMetadata(stored, { mtimeMs: 1_000, sizeBytes: 501 })).toBe('needs-hash')
  })
})

describe('retrying previous failures', () => {
  const retryable: IndexedFileState = { ...stored, retryable: true }
  /** Failed under the current extractor: nothing has changed, so do not retry. */
  const permanentlyFailed: IndexedFileState = { ...stored, retryable: false }

  it('re-attempts a file that failed under an older extractor', () => {
    // The 98 PDFs that failed on "DOMMatrix is not defined" kept their real
    // mtime and size, so without this they would never be retried after the
    // extractor was fixed.
    expect(compareMetadata(retryable, { mtimeMs: 1_000, sizeBytes: 500 })).toBe('needs-hash')
  })

  it('re-extracts such a file even when its bytes are identical', () => {
    // Otherwise the second gate would re-skip everything the first let through.
    expect(compareContent(retryable, hashBytes('original content'))).toBe('changed')
  })

  it('does not retry a failure the current extractor already produced', () => {
    // An encrypted PDF fails identically every time; re-parsing it on every
    // scan is pure waste.
    expect(compareMetadata(permanentlyFailed, { mtimeMs: 1_000, sizeBytes: 500 })).toBe('unchanged')
  })

  it('leaves successfully indexed files on the fast path', () => {
    expect(compareMetadata(stored, { mtimeMs: 1_000, sizeBytes: 500 })).toBe('unchanged')
  })
})

describe('compareContent', () => {
  it('reports a rewritten-but-identical file as metadata-only', () => {
    // Format-on-save and file copies bump mtime without changing bytes.
    // Re-embedding these is the most common form of wasted work.
    expect(compareContent(stored, hashBytes('original content'))).toBe('metadata-only')
  })

  it('reports a genuine edit as changed', () => {
    expect(compareContent(stored, hashBytes('edited content'))).toBe('changed')
  })

  it('treats an unknown path as new', () => {
    expect(compareContent(undefined, hashBytes('anything'))).toBe('new')
  })
})

describe('hashBytes', () => {
  it('is stable and content-addressed', () => {
    expect(hashBytes('abc')).toBe(hashBytes('abc'))
    expect(hashBytes('abc')).not.toBe(hashBytes('abd'))
  })

  it('agrees between string and buffer input', () => {
    expect(hashBytes('hello')).toBe(hashBytes(Buffer.from('hello', 'utf8')))
  })
})
