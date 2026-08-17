import { readFile } from 'node:fs/promises'
import { importEsm, type ExtractedDocument } from './types'

/**
 * PDF text extraction.
 *
 * Uses `unpdf` rather than `pdfjs-dist` directly. Stock pdfjs expects browser
 * globals -- `DOMMatrix`, `Path2D`, `ImageData` -- and throws
 * "DOMMatrix is not defined" inside a plain Node utility process the moment a
 * document contains any graphics, which in practice is nearly every real PDF.
 * unpdf ships a pdfjs build with those dependencies removed.
 *
 * This was not caught by the original unit test because the generated fixture
 * was pure text: pdfjs never reached the code path that constructs a matrix.
 * The fixture now includes graphics operators for that reason.
 */

interface UnpdfModule {
  getDocumentProxy(data: Uint8Array): Promise<unknown>
  extractText(
    document: unknown,
    options?: { mergePages?: boolean }
  ): Promise<{ totalPages: number; text: string | string[] }>
}

let unpdf: UnpdfModule | null = null

async function loadUnpdf(): Promise<UnpdfModule> {
  if (unpdf) return unpdf
  // Several megabytes, and most indexing runs never open a PDF.
  unpdf = (await importEsm('unpdf')) as UnpdfModule
  return unpdf
}

export async function extractPdf(filePath: string): Promise<ExtractedDocument | null> {
  const { getDocumentProxy, extractText } = await loadUnpdf()
  const bytes = await readFile(filePath)

  // pdfjs takes ownership of the buffer and may detach it, so hand over a copy.
  const document = await getDocumentProxy(new Uint8Array(bytes))
  const result = await extractText(document, { mergePages: false })

  // mergePages:false yields one entry per page, which is what lets a chunk's
  // line range be translated back into a page number.
  const pages = Array.isArray(result.text) ? result.text : [result.text]

  const lines: string[] = []
  const pageStarts: number[] = []

  for (const page of pages) {
    pageStarts.push(lines.length)
    for (const line of page.split(/\r?\n/)) {
      lines.push(line.trimEnd())
    }
    // Blank line between pages so the chunker treats them as separate blocks.
    lines.push('')
  }

  const text = lines.join('\n')
  return text.trim().length === 0 ? null : { text, pageStarts }
}

/** Maps a 1-based line number back to its 1-based page number. */
export function pageForLine(pageStarts: readonly number[], line: number): number {
  const lineIndex = line - 1
  for (let page = pageStarts.length - 1; page >= 0; page--) {
    if (lineIndex >= pageStarts[page]) return page + 1
  }
  return 1
}
