/**
 * Generates every app/tray icon from code, with no image dependencies.
 *
 * Icons are a build input, not artwork to be hand-maintained: keeping them as a
 * script means a colour tweak is a one-line diff instead of an opaque binary
 * blob, and the .ico for electron-builder falls out of the same run.
 *
 *   npm run icons
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'icons')
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
/** Sizes Windows actually picks between for taskbar/explorer/alt-tab. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** Supersampling factor. 4x4 subsamples per pixel is plenty for flat shapes. */
const SS = 4

// ---------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // bytes 10-12 stay zero: deflate, adaptive filtering, no interlace

  // Each scanline is prefixed with its filter byte; filter 0 (none) keeps this
  // simple and these images compress fine regardless.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** Vista-era ICOs may embed PNGs directly, which avoids writing a BMP encoder. */
function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + images.length * 16
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size // 0 means 256
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0 // palette count
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)])
}

// -------------------------------------------------------------------- Geometry

/** Signed distance to a rounded rectangle, relative to its centre. */
function sdRoundedRect(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px) - halfW + radius
  const qy = Math.abs(py) - halfH + radius
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
  )
}

/** Signed distance to a thick line segment with rounded caps. */
function sdCapsule(px, py, ax, ay, bx, by, radius) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
  return Math.hypot(pax - bax * t, pay - bay * t) - radius
}

function blend(base, layer, alpha) {
  return base + (layer - base) * alpha
}

/**
 * Renders the Trove mark: a magnifying glass on a rounded gradient tile.
 * All geometry is in unit space so every size is identical bar resolution.
 */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const subsamples = SS * SS

  // Glass centre/radius, and the handle running to the lower right.
  const cx = 0.435
  const cy = 0.415
  const ringRadius = 0.205
  const ringHalfThickness = 0.037
  const diag = Math.SQRT1_2
  const handleFrom = [cx + ringRadius * diag, cy + ringRadius * diag]
  const handleTo = [0.775, 0.775]
  const handleHalfThickness = 0.042

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size
          const v = (y + (sy + 0.5) / SS) / size

          // Tile: rounded square covering most of the canvas.
          if (sdRoundedRect(u - 0.5, v - 0.5, 0.46, 0.46, 0.22) > 0) continue

          // Diagonal gradient, blue -> violet.
          const t = Math.max(0, Math.min(1, (u + v) / 2))
          let pr = blend(46, 124, t)
          let pg = blend(124, 92, t)
          let pb = blend(246, 255, t)

          const ring = Math.abs(Math.hypot(u - cx, v - cy) - ringRadius) - ringHalfThickness
          const handle = sdCapsule(u, v, handleFrom[0], handleFrom[1], handleTo[0], handleTo[1], handleHalfThickness)

          if (Math.min(ring, handle) <= 0) {
            pr = 255
            pg = 255
            pb = 255
          }

          r += pr
          g += pg
          b += pb
          a += 255
        }
      }

      const index = (y * size + x) * 4
      if (a > 0) {
        // Average over covered subsamples only, so edge pixels keep their colour
        // and vary only in alpha -- averaging over all subsamples would darken
        // the border against transparency.
        const covered = a / 255
        rgba[index] = Math.round(r / covered)
        rgba[index + 1] = Math.round(g / covered)
        rgba[index + 2] = Math.round(b / covered)
        rgba[index + 3] = Math.round(a / subsamples)
      }
    }
  }

  return encodePng(size, size, rgba)
}

// ------------------------------------------------------------------------ Main

mkdirSync(OUT_DIR, { recursive: true })

const rendered = new Map()
for (const size of new Set([...PNG_SIZES, ...ICO_SIZES])) {
  rendered.set(size, renderIcon(size))
}

for (const size of PNG_SIZES) {
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), rendered.get(size))
}

// Named entry points the app and packager reference directly.
writeFileSync(join(OUT_DIR, 'tray.png'), rendered.get(32))
writeFileSync(join(OUT_DIR, 'icon.png'), rendered.get(512))
writeFileSync(
  join(OUT_DIR, 'icon.ico'),
  encodeIco(ICO_SIZES.map((size) => ({ size, data: rendered.get(size) })))
)

console.log(`Wrote ${PNG_SIZES.length + 3} icon files to ${OUT_DIR}`)
