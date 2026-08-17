import { extname } from 'node:path'
import { extractDocx } from './docx'
import { extractPdf } from './pdf'
import { extractPlainText } from './text'
import type { ExtractedDocument } from './types'

export type { ExtractedDocument } from './types'
export { pageForLine } from './pdf'

/**
 * Turns a file into plain text, or null when there is nothing worth indexing
 * (binary content, an empty file, an unsupported type).
 *
 * Extraction failures are returned as null rather than thrown: one corrupt PDF
 * in a folder of ten thousand files should cost that file, not the run.
 */
export async function extractDocument(filePath: string): Promise<ExtractedDocument | null> {
  const extension = extname(filePath).toLowerCase()

  switch (extension) {
    case '.pdf':
      return extractPdf(filePath)
    case '.docx':
      return extractDocx(filePath)
    default:
      return extractPlainText(filePath)
  }
}
