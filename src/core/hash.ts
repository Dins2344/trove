import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * Hashes raw file bytes rather than extracted text.
 *
 * The point of the hash is to decide whether extraction is needed at all, so it
 * has to be computable without doing the expensive work first -- reading a
 * 30MB PDF is cheap, parsing one is not.
 */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

export function hashBytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export type ChangeVerdict = 'unchanged' | 'metadata-only' | 'changed' | 'new'

export interface IndexedFileState {
  mtimeMs: number
  sizeBytes: number
  contentHash: string
  /**
   * True when this file failed under an *older* extractor and is therefore
   * worth another attempt.
   *
   * A failed file keeps its real mtime and size, so the metadata gate would
   * otherwise report "unchanged" and never try it again -- meaning a shipped
   * extractor fix never reaches the files it repairs. Restricting the retry to
   * a version change stops permanently unreadable files (an encrypted PDF)
   * from being re-attempted on every scan forever.
   */
  retryable?: boolean
}

export interface ObservedFileState {
  mtimeMs: number
  sizeBytes: number
}

/**
 * First of the two change-detection gates: pure metadata, no file reads.
 *
 * `'unchanged'` short-circuits the whole pipeline for a file, which is what
 * makes re-opening the app after a normal day near-instant instead of a full
 * rebuild.
 */
export function compareMetadata(
  previous: IndexedFileState | undefined,
  observed: ObservedFileState
): 'unchanged' | 'needs-hash' | 'new' {
  if (previous === undefined) return 'new'
  // Always retry a previous failure: the cause is more often a since-fixed
  // extractor bug than the file itself.
  if (previous.retryable === true) return 'needs-hash'
  // Editors routinely rewrite a file byte-for-byte (format-on-save, touch,
  // copy), so a changed mtime is a reason to hash, not to re-embed.
  if (previous.mtimeMs === observed.mtimeMs && previous.sizeBytes === observed.sizeBytes) {
    return 'unchanged'
  }
  return 'needs-hash'
}

/**
 * Second gate, after hashing: distinguishes a real edit from a file that merely
 * looks new. `'metadata-only'` means refresh the stored mtime/size and skip the
 * expensive embedding work.
 */
export function compareContent(
  previous: IndexedFileState | undefined,
  observedHash: string
): ChangeVerdict {
  if (previous === undefined) return 'new'
  // A retryable failure must reach extraction again even when its bytes are
  // identical -- otherwise this gate re-skips everything the first one let
  // through for retry.
  if (previous.retryable === true) return 'changed'
  return previous.contentHash === observedHash ? 'metadata-only' : 'changed'
}
