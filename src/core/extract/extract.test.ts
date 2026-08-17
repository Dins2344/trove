import { crc32 } from 'node:zlib'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractDocument, pageForLine } from './index'
import { looksBinary } from './text'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'trove-extract-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// ------------------------------------------------------------- PDF fixture

/**
 * Builds a minimal but structurally valid PDF.
 *
 * Generated rather than committed as a binary so the fixture is auditable, and
 * so it exercises the real pdfjs parse path -- including the dynamic ESM import
 * that a CJS bundle would otherwise break.
 */
function buildPdf(lines: string[]): Buffer {
  const content =
    // Graphics operators on purpose. A text-only PDF never exercises pdfjs's
    // transform handling, which is how the original stock-pdfjs implementation
    // passed this test while failing on every real-world PDF with
    // "DOMMatrix is not defined".
    'q\n0.5 0.5 0.5 rg\n0.75 0 0 0.75 40 40 cm\n0 0 200 100 re\nf\nQ\n' +
    'BT\n/F1 12 Tf\n72 720 Td\n' +
    lines.map((line, index) => `${index === 0 ? '' : '0 -16 Td\n'}(${line}) Tj\n`).join('') +
    'ET'

  const objects: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    4: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  }

  let pdf = '%PDF-1.4\n'
  const offsets: Record<number, number> = {}

  for (let id = 1; id <= 5; id++) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  // Each xref entry must be exactly 20 bytes.
  pdf += 'xref\n0 6\n0000000000 65535 f \n'
  for (let id = 1; id <= 5; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}

// ------------------------------------------------------------ DOCX fixture

/** Writes a ZIP with stored (uncompressed) entries -- enough for a .docx. */
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.data)

    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)

    locals.push(local, entry.data)
    centrals.push(central)
    offset += local.length + entry.data.length
  }

  const centralDirectory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralDirectory, end])
}

function buildDocx(paragraphs: string[]): Buffer {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') }
  ])
}

// ------------------------------------------------------------------- tests

describe('looksBinary', () => {
  it('flags content containing NUL bytes', () => {
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true)
  })

  it('accepts ordinary UTF-8 text', () => {
    expect(looksBinary(Buffer.from('hello, world — with punctuation', 'utf8'))).toBe(false)
  })
})

describe('extractDocument', () => {
  it('reads plain text and normalises CRLF', async () => {
    const file = join(root, 'notes.txt')
    await writeFile(file, 'First line.\r\nSecond line.\r\n', 'utf8')

    const result = await extractDocument(file)

    expect(result?.text).toBe('First line.\nSecond line.\n')
    expect(result?.text).not.toContain('\r')
  })

  it('strips a UTF-8 BOM', async () => {
    const file = join(root, 'bom.md')
    await writeFile(file, '﻿# Title', 'utf8')

    const result = await extractDocument(file)
    expect(result?.text.startsWith('#')).toBe(true)
  })

  it('returns null for binary content behind a text extension', async () => {
    const file = join(root, 'blob.txt')
    await writeFile(file, Buffer.from([0x41, 0x00, 0x42, 0x00]))

    expect(await extractDocument(file)).toBeNull()
  })

  it('returns null for an empty file', async () => {
    const file = join(root, 'empty.md')
    await writeFile(file, '   \n\n  ', 'utf8')

    expect(await extractDocument(file)).toBeNull()
  })

  it('extracts text from a PDF and reports page starts', async () => {
    const file = join(root, 'handbook.pdf')
    await writeFile(file, buildPdf(['The invoicing procedure', 'Submit before the fifth']))

    const result = await extractDocument(file)

    expect(result).not.toBeNull()
    expect(result?.text).toContain('invoicing')
    expect(result?.text).toContain('fifth')
    expect(result?.pageStarts).toHaveLength(1)
  })

  it('extracts text from a DOCX', async () => {
    const file = join(root, 'memo.docx')
    await writeFile(file, buildDocx(['Quarterly invoicing memo.', 'Gardening budget approved.']))

    const result = await extractDocument(file)

    expect(result).not.toBeNull()
    expect(result?.text).toContain('invoicing')
    expect(result?.text).toContain('Gardening')
  })
})

describe('pageForLine', () => {
  it('maps line numbers onto their page', () => {
    const pageStarts = [0, 20, 45]

    expect(pageForLine(pageStarts, 1)).toBe(1)
    expect(pageForLine(pageStarts, 20)).toBe(1)
    expect(pageForLine(pageStarts, 21)).toBe(2)
    expect(pageForLine(pageStarts, 46)).toBe(3)
  })
})
