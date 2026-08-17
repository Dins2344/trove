import { importEsm, type ExtractedDocument } from './types'

interface MammothModule {
  extractRawText(input: { path: string }): Promise<{ value: string }>
}

let mammoth: MammothModule | null = null

async function loadMammoth(): Promise<MammothModule> {
  if (mammoth) return mammoth
  const loaded = (await importEsm('mammoth')) as MammothModule & { default?: MammothModule }
  // Interop: the CJS package may arrive wrapped in a `default` binding.
  mammoth = loaded.default ?? loaded
  return mammoth
}

export async function extractDocx(filePath: string): Promise<ExtractedDocument | null> {
  const { extractRawText } = await loadMammoth()
  const result = await extractRawText({ path: filePath })

  const text = result.value.replace(/\r\n?/g, '\n')
  return text.trim().length === 0 ? null : { text }
}
