export interface ExtractedDocument {
  /** Plain text, normalised to LF line endings. */
  text: string
  /**
   * 0-based line indices where each page starts. Only produced by formats with
   * real pages (PDF), and used to translate a chunk's line range back into a
   * page number for display.
   */
  pageStarts?: number[]
}

/**
 * Loads a heavy, optional parser at first use.
 *
 * `@vite-ignore` stops the bundler trying to resolve and inline the specifier:
 * pdfjs-dist is ESM-only and several megabytes, and most indexing runs never
 * open a PDF at all.
 *
 * An earlier version hid this behind `new Function('return import(s)')` to
 * defeat rollup's CJS transform, but that form throws
 * ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING inside a VM sandbox (Vitest), leaving
 * these paths untestable. The worker that owns extraction is built as ESM, so
 * a plain dynamic import survives bundling intact.
 */
export function importEsm(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier)
}
