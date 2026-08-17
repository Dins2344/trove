import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * The indexing worker is built separately from main/preload, and as ESM.
 *
 * electron-vite emits CommonJS for the main process, and rollup rewrites a
 * dynamic `import()` in CJS output into a `require()` shim. That shim throws on
 * an ESM-only package, and pdfjs-dist v6 is exactly that. Emitting the worker
 * as a real ES module keeps `import()` intact at runtime.
 */
const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  // Heavy or native; loaded from node_modules at runtime rather than inlined.
  '@huggingface/transformers',
  'onnxruntime-node',
  'unpdf',
  'mammoth',
  'chokidar'
]

export default defineConfig({
  build: {
    ssr: resolve(__dirname, 'src/worker/index.ts'),
    outDir: 'out/worker',
    emptyOutDir: true,
    target: 'node22',
    // Readable stack traces matter more here than a few saved kilobytes.
    minify: false,
    rollupOptions: {
      external,
      output: {
        format: 'es',
        entryFileNames: 'index.mjs'
      }
    }
  }
})
