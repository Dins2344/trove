import { describe, expect, it } from 'vitest'
import { separatorOf, withTrailingSeparator } from './path-utils'

/**
 * These assertions are deliberately host-independent. Using `node:path.sep`
 * here would reproduce the original bug: prefix logic that passes on Windows
 * and fails on the Linux CI runner.
 */
describe('separatorOf', () => {
  it('detects Windows paths', () => {
    expect(separatorOf('C:\\notes\\a.md')).toBe('\\')
  })

  it('detects POSIX paths', () => {
    expect(separatorOf('/home/dinso/notes/a.md')).toBe('/')
  })

  it('defaults to POSIX for a bare name', () => {
    expect(separatorOf('notes')).toBe('/')
  })

  it('treats a mixed path by its Windows separator', () => {
    expect(separatorOf('C:/notes\\a.md')).toBe('\\')
  })
})

describe('withTrailingSeparator', () => {
  it('appends the separator the path already uses', () => {
    expect(withTrailingSeparator('C:\\notes')).toBe('C:\\notes\\')
    expect(withTrailingSeparator('/home/notes')).toBe('/home/notes/')
  })

  it('leaves an existing trailing separator alone', () => {
    expect(withTrailingSeparator('C:\\notes\\')).toBe('C:\\notes\\')
    expect(withTrailingSeparator('/home/notes/')).toBe('/home/notes/')
  })

  it('produces a prefix that excludes name-prefix siblings', () => {
    // The whole point: "C:\notes" must not match "C:\notes-archive".
    const prefix = withTrailingSeparator('C:\\notes')

    expect('C:\\notes\\a.md'.startsWith(prefix)).toBe(true)
    expect('C:\\notes-archive\\b.md'.startsWith(prefix)).toBe(false)
  })
})
