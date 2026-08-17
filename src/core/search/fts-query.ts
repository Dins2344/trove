/**
 * Builds a safe FTS5 MATCH expression from raw user input.
 *
 * FTS5 has its own query language -- `AND`, `OR`, `NOT`, `NEAR`, `^`, `*`,
 * column filters, and phrase quoting. Passing a search box straight through
 * means a stray quote or a colon throws a syntax error mid-typing, and a word
 * like "and" silently becomes an operator. Every token is therefore quoted as a
 * literal phrase and the operators are rebuilt deliberately.
 */

/** Tokens that carry no retrieval signal but do crowd out the ones that do. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'do',
  'does',
  'did',
  'of',
  'to',
  'in',
  'on',
  'at',
  'it',
  'i',
  'my',
  'how',
  'what',
  'when',
  'where',
  'why',
  'can'
])

export interface FtsQueryOptions {
  /**
   * Treats the final token as a prefix, so results update sensibly while the
   * user is still typing the last word.
   */
  prefixLastToken?: boolean
}

/**
 * @returns an FTS5 MATCH expression, or null when the input has nothing
 * searchable in it (in which case the keyword leg should be skipped entirely
 * rather than run with an empty query).
 */
export function buildFtsQuery(raw: string, options: FtsQueryOptions = {}): string | null {
  const prefixLastToken = options.prefixLastToken ?? true

  // Split on anything that is not a word character. This drops the FTS
  // operators along with the punctuation, which is the point.
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0)

  if (tokens.length === 0) return null

  // Keep stop words only if that is all the user typed, so a search for "the"
  // still does something rather than nothing.
  const meaningful = tokens.filter((token) => !STOP_WORDS.has(token))
  const effective = meaningful.length > 0 ? meaningful : tokens

  const clauses = effective.map((token, index) => {
    const isLast = index === effective.length - 1
    // Double quotes make the token a literal phrase; FTS5 escapes an embedded
    // quote by doubling it, though the tokenizer above already removed them.
    const quoted = `"${token.replace(/"/g, '""')}"`
    return prefixLastToken && isLast && token.length >= 2 ? `${quoted}*` : quoted
  })

  // OR rather than AND: the keyword leg is one half of a hybrid search, so
  // recall is worth more here than precision. Requiring every term would return
  // nothing for a natural-language question, leaving the semantic leg to carry
  // the whole query alone -- and BM25 already ranks multi-term matches higher.
  return clauses.join(' OR ')
}
