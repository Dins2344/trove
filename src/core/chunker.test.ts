import { describe, expect, it } from 'vitest'
import { chunkText, estimateTokens } from './chunker'

const OPTIONS = { maxTokens: 40, overlapRatio: 0.2, minTokens: 10 }

/** Repeats a distinct word list so token counts are predictable. */
function words(count: number, prefix = 'word'): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ')
}

describe('estimateTokens', () => {
  it('returns zero for blank input', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('   \n  ')).toBe(0)
  })

  it('never underestimates dense, punctuation-heavy text', () => {
    // Identifiers explode into many word-pieces, so the character-based bound
    // must win here. Underestimating causes silent truncation at embed time.
    const code = 'const x=foo.bar({a:1,b:2,c:3});const y=baz.qux({d:4,e:5,f:6});'
    expect(estimateTokens(code)).toBeGreaterThanOrEqual(code.length / 4)
  })
})

describe('chunkText', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkText('', OPTIONS)).toEqual([])
    expect(chunkText('   \n\n  ', OPTIONS)).toEqual([])
  })

  it('keeps a short document as a single chunk', () => {
    const chunks = chunkText('One short paragraph about invoicing.', OPTIONS)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].ordinal).toBe(0)
    expect(chunks[0].startLine).toBe(1)
  })

  it('never emits a chunk over the token budget', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => words(25, `p${i}w`)).join('\n\n')
    const chunks = chunkText(paragraphs, OPTIONS)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(OPTIONS.maxTokens)
    }
  })

  it('numbers chunks consecutively from zero', () => {
    const chunks = chunkText(Array.from({ length: 10 }, (_, i) => words(20, `x${i}`)).join('\n\n'), OPTIONS)
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, i) => i))
  })

  it('splits a single oversized paragraph rather than emitting it whole', () => {
    // One paragraph, no blank lines, far over budget.
    const chunks = chunkText(words(400), OPTIONS)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(OPTIONS.maxTokens)
    }
  })

  it('tracks markdown heading breadcrumbs', () => {
    const document = [
      '# Handbook',
      '',
      'Intro text.',
      '',
      '## Invoicing',
      '',
      'How to submit an invoice.',
      '',
      '### Late payments',
      '',
      'What to do when payment is late.'
    ].join('\n')

    const chunks = chunkText(document, { ...OPTIONS, minTokens: 0 })
    const paths = chunks.map((chunk) => chunk.headingPath)

    expect(paths).toContain('Handbook')
    expect(paths.some((path) => path === 'Handbook > Invoicing')).toBe(true)
    expect(paths.some((path) => path === 'Handbook > Invoicing > Late payments')).toBe(true)
  })

  it('drops deeper headings when returning to a shallower level', () => {
    const document = [
      '# Top',
      '',
      '## Middle',
      '',
      '### Deep',
      '',
      'Deep content.',
      '',
      '## Sibling',
      '',
      'Sibling content.'
    ].join('\n')

    const chunks = chunkText(document, { ...OPTIONS, minTokens: 0 })
    const sibling = chunks.find((chunk) => chunk.text.includes('Sibling content'))

    expect(sibling?.headingPath).toBe('Top > Sibling')
  })

  it('tracks headings in documents that start below level one', () => {
    // Regression: the heading stack is indexed by level, so a document opening
    // at `##` must leave level 1 empty rather than shifting everything up a
    // level -- which previously made the second section read "A > B".
    const document = [
      '## Invoicing',
      '',
      'Content A.',
      '',
      '## Gardening',
      '',
      'Content B.'
    ].join('\n')

    const chunks = chunkText(document, { ...OPTIONS, minTokens: 0 })

    expect(chunks.find((chunk) => chunk.text.includes('Content A'))?.headingPath).toBe('Invoicing')
    expect(chunks.find((chunk) => chunk.text.includes('Content B'))?.headingPath).toBe('Gardening')
  })

  it('reports line numbers that map back into the source', () => {
    const lines = ['# Title', '', 'First paragraph.', '', 'Second paragraph.']
    const chunks = chunkText(lines.join('\n'), { ...OPTIONS, minTokens: 0 })

    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1)
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine)
      expect(chunk.endLine).toBeLessThanOrEqual(lines.length)
    }
  })

  it('keeps a fenced code block intact', () => {
    const document = [
      'Intro paragraph.',
      '',
      '```js',
      'function alpha() {',
      '',
      '  return 1',
      '}',
      '```',
      '',
      'Trailing paragraph.'
    ].join('\n')

    const chunks = chunkText(document, { ...OPTIONS, minTokens: 0 })
    const withFence = chunks.find((chunk) => chunk.text.includes('function alpha'))

    // The blank line inside the fence must not have split the snippet, and the
    // `#`-free fence body must stay with its opening delimiter.
    expect(withFence?.text).toContain('```js')
    expect(withFence?.text).toContain('return 1')
  })

  it('carries a sentence-level tail into the next chunk', () => {
    // Real prose with short sentences. Overlap is deliberately sentence-level:
    // a whole paragraph almost never fits the overlap budget, so a block-level
    // carry would silently never fire.
    const prose = [
      'The invoicing procedure is simple. Submit before the fifth. Finance pays on the tenth.',
      'Late invoices roll to next month. Chase them early. Nobody enjoys the reminder email.',
      'Contractors use a different form. It lives on the intranet. Ask Priya if you cannot find it.',
      'Expenses are separate entirely. Keep receipts. Anything over fifty needs approval.'
    ].join('\n\n')

    const chunks = chunkText(prose, { maxTokens: 40, overlapRatio: 0.25, minTokens: 10 })
    expect(chunks.length).toBeGreaterThan(1)

    // Each chunk after the first should open with text the previous one ended on.
    const overlapping = chunks.slice(1).filter((chunk, index) => {
      const openingBlock = chunk.text.split('\n\n')[0]
      return chunks[index].text.includes(openingBlock)
    })

    expect(overlapping.length).toBe(chunks.length - 1)
  })

  it('keeps chunks within budget even when a tail is carried', () => {
    const prose = Array.from(
      { length: 8 },
      (_, i) => `Section ${i} opens here. It continues briefly. Then it ends.`
    ).join('\n\n')

    const options = { maxTokens: 40, overlapRatio: 0.25, minTokens: 10 }
    for (const chunk of chunkText(prose, options)) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(options.maxTokens)
    }
  })

  it('does not carry overlap across a heading boundary', () => {
    const document = [
      '## Invoicing',
      '',
      'Submit before the fifth. Finance pays on the tenth. Chase late ones early.',
      '',
      '## Gardening',
      '',
      'Water the tomatoes. Prune in autumn. Mulch before the frost.'
    ].join('\n')

    const chunks = chunkText(document, { maxTokens: 30, overlapRatio: 0.3, minTokens: 5 })
    const gardening = chunks.filter((chunk) => chunk.headingPath === 'Gardening')

    expect(gardening.length).toBeGreaterThan(0)
    for (const chunk of gardening) {
      expect(chunk.text).not.toContain('Finance')
    }
  })

  it('starts a new chunk at a heading once the current one has substance', () => {
    const document = [
      '# Alpha',
      '',
      words(35, 'alpha'),
      '',
      '# Beta',
      '',
      words(35, 'beta')
    ].join('\n')

    const chunks = chunkText(document, OPTIONS)
    const betaChunk = chunks.find((chunk) => chunk.text.includes('beta0'))

    // Beta's content must not be glued onto the tail of Alpha's section.
    expect(betaChunk?.text).not.toContain('alpha0')
  })

  it('handles CRLF input without leaking carriage returns', () => {
    const chunks = chunkText('# Title\r\n\r\nSome content here.\r\n', { ...OPTIONS, minTokens: 0 })
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain('\r')
    }
  })
})
