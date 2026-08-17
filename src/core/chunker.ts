/**
 * Splits a document into embedding-sized chunks.
 *
 * Chunk boundaries matter more than they look. An embedding is a single vector
 * for the whole chunk, so a chunk spanning two unrelated sections produces a
 * vector that sits between both topics and matches neither well. The rules
 * below exist to keep each chunk about one thing:
 *
 *   - paragraphs are never split unless a single paragraph is oversized
 *   - fenced code blocks stay intact
 *   - a new markdown heading forces a boundary once the chunk has enough content
 *   - consecutive chunks overlap slightly, so a passage straddling a boundary is
 *     still fully present in at least one chunk
 *
 * This module is deliberately free of Node and Electron imports so it can be
 * unit tested directly and run inside the indexing worker unchanged.
 */

export interface Chunk {
  /** Position within the source document, starting at 0. */
  ordinal: number
  text: string
  /** 1-based, inclusive. Used to jump straight to the passage in an editor. */
  startLine: number
  /** 1-based, inclusive. */
  endLine: number
  /** Breadcrumb of enclosing markdown headings, e.g. `Setup > Installation`. */
  headingPath: string | null
}

export interface ChunkOptions {
  /**
   * all-MiniLM-L6-v2 truncates at 256 word-pieces, and anything past that is
   * silently dropped rather than erroring. Targeting 220 leaves headroom for
   * the estimator being wrong in the unhelpful direction.
   */
  maxTokens?: number
  /** Fraction of `maxTokens` repeated at the start of the next chunk. */
  overlapRatio?: number
  /** A heading only forces a break once the current chunk is at least this big. */
  minTokens?: number
}

const DEFAULTS = {
  maxTokens: 220,
  overlapRatio: 0.15,
  minTokens: 40
} as const satisfies Required<ChunkOptions>

/**
 * Approximates word-piece count without loading a tokenizer.
 *
 * Word count alone badly undercounts code and identifiers, which tokenize into
 * many pieces; character count alone overcounts ordinary prose. Taking the
 * larger of the two keeps the estimate conservative for both, which is the safe
 * direction -- underestimating means silent truncation at embed time.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0

  const words = trimmed.split(/\s+/).length
  return Math.ceil(Math.max(words * 1.35, trimmed.length / 4))
}

interface Block {
  text: string
  startLine: number
  endLine: number
  headingPath: string | null
  isHeading: boolean
  tokens: number
}

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/
const FENCE_PATTERN = /^\s*(```|~~~)/

/**
 * Splits raw text into paragraph-level blocks, tracking the markdown heading
 * stack as it goes. Non-markdown input simply never matches the heading
 * pattern and falls through as plain paragraphs.
 */
function toBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/)
  const blocks: Block[] = []

  // headings[i] is the most recent heading at level i+1. Sparse on purpose:
  // the index *is* the heading level, so a document that starts at `##` leaves
  // index 0 empty rather than shifting everything down a level.
  let headings: (string | undefined)[] = []
  let buffer: string[] = []
  let bufferStart = 0
  let inFence = false

  const currentPath = (): string | null => {
    // Holes are skipped only when rendering the breadcrumb; collapsing them in
    // the array itself would break the level-to-index correspondence.
    const parts = headings.filter((entry): entry is string => entry !== undefined)
    return parts.length > 0 ? parts.join(' > ') : null
  }

  const flush = (endLine: number): void => {
    if (buffer.length === 0) return
    const blockText = buffer.join('\n').trim()
    buffer = []
    if (blockText.length === 0) return

    blocks.push({
      text: blockText,
      startLine: bufferStart + 1,
      endLine: endLine + 1,
      headingPath: currentPath(),
      isHeading: false,
      tokens: estimateTokens(blockText)
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Inside a fence, nothing is interpreted -- a `#` there is a comment, not a
    // heading, and blank lines must not split the snippet.
    if (FENCE_PATTERN.test(line)) {
      if (buffer.length === 0) bufferStart = i
      buffer.push(line)
      if (inFence) {
        inFence = false
        flush(i)
      } else {
        inFence = true
      }
      continue
    }

    if (inFence) {
      buffer.push(line)
      continue
    }

    const heading = HEADING_PATTERN.exec(line)
    if (heading) {
      flush(i - 1)

      const level = heading[1].length
      const title = heading[2].trim()
      // Entering a shallower level discards the deeper trail beneath it.
      headings = headings.slice(0, level - 1)
      headings[level - 1] = title

      const headingText = line.trim()
      blocks.push({
        text: headingText,
        startLine: i + 1,
        endLine: i + 1,
        headingPath: currentPath(),
        isHeading: true,
        tokens: estimateTokens(headingText)
      })
      continue
    }

    if (line.trim().length === 0) {
      flush(i - 1)
      continue
    }

    if (buffer.length === 0) bufferStart = i
    buffer.push(line)
  }

  flush(lines.length - 1)
  return blocks
}

/** Counts the newlines before `offset`, to map a substring back to a line number. */
function lineOffsetAt(text: string, offset: number): number {
  let count = 0
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') count++
  }
  return count
}

/**
 * Breaks a single oversized block (a wall-of-text paragraph, a long code fence)
 * into pieces that fit, preferring sentence boundaries and falling back to a
 * hard word split.
 */
function splitOversizedBlock(block: Block, maxTokens: number): Block[] {
  const pieces: Block[] = []
  // Keep the separator attached to the preceding sentence so offsets stay exact.
  const segments = block.text.split(/(?<=[.!?])(\s+)/)

  let current = ''
  let currentOffset = 0
  let cursor = 0

  const emit = (): void => {
    const trimmed = current.trim()
    if (trimmed.length === 0) return

    const startLine = block.startLine + lineOffsetAt(block.text, currentOffset)
    const endLine = block.startLine + lineOffsetAt(block.text, currentOffset + current.length)
    pieces.push({
      text: trimmed,
      startLine,
      endLine,
      headingPath: block.headingPath,
      isHeading: false,
      tokens: estimateTokens(trimmed)
    })
  }

  for (const segment of segments) {
    if (segment.length === 0) continue

    if (current.length > 0 && estimateTokens(current + segment) > maxTokens) {
      emit()
      current = ''
      currentOffset = cursor
    }

    // A single sentence longer than the budget still has to be cut somewhere;
    // a hard word split is the least-bad option.
    if (estimateTokens(segment) > maxTokens) {
      const words = segment.split(/(\s+)/)
      for (const word of words) {
        if (current.length > 0 && estimateTokens(current + word) > maxTokens) {
          emit()
          current = ''
          currentOffset = cursor
        }
        current += word
        cursor += word.length
      }
      continue
    }

    current += segment
    cursor += segment.length
  }

  emit()
  return pieces
}

/** Character spans of each sentence in `text`, so tails keep exact offsets. */
function sentenceSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  const boundary = /[.!?]\s+/g

  let start = 0
  let match: RegExpExecArray | null
  while ((match = boundary.exec(text)) !== null) {
    spans.push({ start, end: match.index + 1 })
    start = boundary.lastIndex
  }
  if (start < text.length) spans.push({ start, end: text.length })

  return spans
}

/**
 * Builds the overlap carried into the next chunk: the trailing sentences of a
 * block, up to the token budget.
 *
 * Overlap has to be finer-grained than a whole paragraph. A typical prose
 * paragraph is 50-150 tokens while the overlap budget is ~33, so carrying whole
 * blocks means carrying nothing at all -- which silently disables the feature
 * for exactly the documents it exists to protect.
 */
function overlapTail(block: Block, budgetTokens: number): Block | null {
  if (budgetTokens <= 0 || block.isHeading) return null
  // Carrying half a code snippet helps nobody.
  if (FENCE_PATTERN.test(block.text)) return null

  const spans = sentenceSpans(block.text)
  let taken = 0
  let tokens = 0

  for (let i = spans.length - 1; i >= 0; i--) {
    const sentence = block.text.slice(spans[i].start, spans[i].end)
    const sentenceTokens = estimateTokens(sentence)
    if (tokens + sentenceTokens > budgetTokens) break
    tokens += sentenceTokens
    taken++
  }

  if (taken === 0) return null

  const from = spans[spans.length - taken].start
  const tailText = block.text.slice(from).trim()
  if (tailText.length === 0) return null

  return {
    text: tailText,
    startLine: block.startLine + lineOffsetAt(block.text, from),
    endLine: block.endLine,
    headingPath: block.headingPath,
    isHeading: false,
    tokens: estimateTokens(tailText)
  }
}

/**
 * Packs blocks into chunks, greedily filling to the token budget.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const { maxTokens, overlapRatio, minTokens } = { ...DEFAULTS, ...options }
  const overlapBudget = Math.floor(maxTokens * overlapRatio)

  // Guarantee every block fits, so the packing loop below always makes progress.
  const blocks = toBlocks(text).flatMap((block) =>
    block.tokens > maxTokens ? splitOversizedBlock(block, maxTokens) : [block]
  )

  const chunks: Chunk[] = []
  let pending: Block[] = []
  let pendingTokens = 0

  const emit = (): void => {
    if (pending.length === 0) return

    // Label the chunk by the section its first real content sits in, not its
    // first block. A chunk opening "# Handbook / ## Invoicing / Submit..." is
    // about Invoicing; a bare heading carries no content of its own.
    const firstContent = pending.find((block) => !block.isHeading) ?? pending[0]

    chunks.push({
      ordinal: chunks.length,
      text: pending.map((block) => block.text).join('\n\n'),
      startLine: pending[0].startLine,
      endLine: pending[pending.length - 1].endLine,
      headingPath: firstContent.headingPath
    })
  }

  /** Emits the pending chunk and seeds the next one with its overlapping tail. */
  const flushWithOverlap = (): void => {
    if (pending.length === 0) return
    emit()

    const last = pending[pending.length - 1]
    const tail = overlapTail(last, overlapBudget)

    pending = tail ? [tail] : []
    pendingTokens = tail ? tail.tokens : 0
  }

  for (const block of blocks) {
    // A heading starts a new section; break here so the section's content is not
    // glued onto the tail of the previous one.
    if (block.isHeading && pendingTokens >= minTokens) {
      emit()
      // Overlap carried across a section boundary would drag the old topic into
      // the new section, which is exactly what the break exists to prevent.
      pending = []
      pendingTokens = 0
    }

    if (pendingTokens + block.tokens > maxTokens && pending.length > 0) {
      flushWithOverlap()

      // The carried tail is a courtesy, not a guarantee. If keeping it would
      // push this chunk over budget, drop it -- staying under the model's
      // truncation limit matters more than the overlap.
      if (pendingTokens + block.tokens > maxTokens) {
        pending = []
        pendingTokens = 0
      }
    }

    pending.push(block)
    pendingTokens += block.tokens
  }

  // Final chunk: no successor, so nothing to overlap into.
  emit()

  return chunks
}
