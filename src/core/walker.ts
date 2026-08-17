import { opendir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

export interface FileEntry {
  path: string
  sizeBytes: number
  mtimeMs: number
}

/**
 * Directories that are almost never what a user means by "my documents", and
 * which are frequently enormous. Skipping them is the single biggest factor in
 * how long a first index takes.
 */
export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  'venv',
  'env',
  'Library',
  'AppData',
  '$RECYCLE.BIN',
  'System Volume Information',
  'Windows',
  'Program Files',
  'Program Files (x86)'
])

/** Prose and documents. */
const TEXT_EXTENSIONS = [
  '.txt',
  '.md',
  '.markdown',
  '.mdx',
  '.rst',
  '.org',
  '.adoc',
  '.tex',
  '.csv',
  '.log'
]

/** Source files -- a developer's notes live in these as often as in prose. */
const CODE_EXTENSIONS = [
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.scala',
  '.sh',
  '.ps1',
  '.sql',
  '.html',
  '.css',
  '.scss',
  '.vue',
  '.svelte',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.xml'
]

/** Needs a real parser rather than a UTF-8 read. */
const DOCUMENT_EXTENSIONS = ['.pdf', '.docx']

export const DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...TEXT_EXTENSIONS,
  ...CODE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS
])

export interface WalkOptions {
  extensions?: ReadonlySet<string>
  ignoredDirs?: ReadonlySet<string>
  /**
   * Files above this are skipped. Minified bundles, lockfiles and data dumps
   * are mostly noise, and embedding them costs far more than they return.
   */
  maxFileBytes?: number
  signal?: AbortSignal
  /** Called for directories that could not be read, rather than aborting the walk. */
  onError?: (path: string, error: Error) => void
}

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024

/**
 * Recursively yields indexable files.
 *
 * An async generator rather than a collected array: a first index over a large
 * tree should start producing work immediately and stay cancellable, instead of
 * spending its first minute silently building a list of a hundred thousand
 * paths in memory.
 */
export async function* walk(root: string, options: WalkOptions = {}): AsyncGenerator<FileEntry> {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS
  const ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const { signal, onError } = options

  // Explicit stack rather than recursion: a deep tree should not be able to
  // overflow the call stack, and this keeps cancellation checks in one place.
  const pending: string[] = [root]

  while (pending.length > 0) {
    if (signal?.aborted) return
    const directory = pending.pop() as string

    let handle
    try {
      handle = await opendir(directory)
    } catch (error) {
      // Permission denied, or the directory vanished mid-walk. Neither is a
      // reason to abandon the rest of the tree.
      onError?.(directory, error as Error)
      continue
    }

    try {
      for await (const entry of handle) {
        if (signal?.aborted) return

        const fullPath = join(directory, entry.name)

        // Symlinks are skipped outright: following them risks cycles and
        // double-indexing the same content under two paths.
        if (entry.isSymbolicLink()) continue

        if (entry.isDirectory()) {
          if (ignoredDirs.has(entry.name)) continue
          // Dot-directories are tooling state (.git, .venv, .cache), not documents.
          if (entry.name.startsWith('.')) continue
          pending.push(fullPath)
          continue
        }

        if (!entry.isFile()) continue
        if (!extensions.has(extname(entry.name).toLowerCase())) continue

        try {
          const stats = await stat(fullPath)
          if (stats.size > maxFileBytes) continue
          if (stats.size === 0) continue

          yield { path: fullPath, sizeBytes: stats.size, mtimeMs: stats.mtimeMs }
        } catch (error) {
          onError?.(fullPath, error as Error)
        }
      }
    } catch (error) {
      onError?.(directory, error as Error)
    }
  }
}
