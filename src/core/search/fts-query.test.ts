import { describe, expect, it } from 'vitest'
import { buildFtsQuery } from './fts-query'

describe('buildFtsQuery', () => {
  it('returns null when there is nothing searchable', () => {
    expect(buildFtsQuery('')).toBeNull()
    expect(buildFtsQuery('   ')).toBeNull()
    expect(buildFtsQuery('!!! ??? ***')).toBeNull()
  })

  it('quotes every token as a literal phrase', () => {
    const query = buildFtsQuery('invoicing procedure', { prefixLastToken: false })
    expect(query).toBe('"invoicing" OR "procedure"')
  })

  it('marks the final token as a prefix for search-as-you-type', () => {
    expect(buildFtsQuery('invoicing proc')).toBe('"invoicing" OR "proc"*')
  })

  it('does not prefix a single-character final token', () => {
    // "a"* would match a huge share of the index for no benefit.
    expect(buildFtsQuery('deployment r')).toBe('"deployment" OR "r"')
  })

  it('strips FTS operators instead of letting them execute', () => {
    // Unquoted, these are FTS5 syntax: NEAR, column filters, and negation.
    const query = buildFtsQuery('NEAR(a b) column:value -excluded', { prefixLastToken: false })

    expect(query).not.toContain('NEAR(')
    expect(query).not.toContain(':')
    expect(query).not.toContain('-')
    expect(query).toContain('"excluded"')
  })

  it('survives quotes without producing invalid syntax', () => {
    const query = buildFtsQuery('say "hello" now', { prefixLastToken: false })
    expect(query).toBe('"say" OR "hello" OR "now"')
  })

  it('drops stop words that would crowd out real terms', () => {
    expect(buildFtsQuery('how do I get paid', { prefixLastToken: false })).toBe('"get" OR "paid"')
  })

  it('keeps stop words when they are all the user typed', () => {
    // Better to search for something than to return nothing.
    expect(buildFtsQuery('the', { prefixLastToken: false })).toBe('"the"')
  })

  it('handles non-ASCII words', () => {
    expect(buildFtsQuery('café münchen', { prefixLastToken: false })).toBe('"café" OR "münchen"')
  })

  it('lowercases input for consistent matching', () => {
    expect(buildFtsQuery('INVOICING', { prefixLastToken: false })).toBe('"invoicing"')
  })
})
