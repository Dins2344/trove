import { readFile } from 'node:fs/promises'
import type { ExtractedDocument } from './types'

/** How much of the file to inspect when deciding whether it is binary. */
const SNIFF_BYTES = 8192

/**
 * Files with a matching extension are not necessarily text -- a `.log` can be
 * a binary dump, and a mislabelled file would otherwise be embedded as mojibake.
 * A NUL byte in the first few KB is the standard, cheap heuristic.
 */
export function looksBinary(bytes: Buffer): boolean {
  const limit = Math.min(bytes.length, SNIFF_BYTES)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

export async function extractPlainText(filePath: string): Promise<ExtractedDocument | null> {
  const bytes = await readFile(filePath)
  if (looksBinary(bytes)) return null

  const text = bytes
    .toString('utf8')
    // A leading BOM would otherwise become part of the first token.
    .replace(/^﻿/, '')
    // Normalise line endings so line numbers agree across platforms.
    .replace(/\r\n?/g, '\n')

  return text.trim().length === 0 ? null : { text }
}
