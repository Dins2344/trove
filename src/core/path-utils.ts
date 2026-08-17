/**
 * Path helpers that derive their separator from the path itself rather than
 * from `node:path`'s host-dependent `sep`.
 *
 * Indexed paths are stored as strings and compared as strings. A Windows path
 * is still a Windows path when the comparison happens on Linux -- in CI, or if
 * an index were ever inspected off-machine -- so using the *host's* separator
 * makes prefix matching silently wrong there. Reading the separator out of the
 * path keeps the comparison a property of the data.
 */

/** Returns the separator a path is written with, defaulting to POSIX. */
export function separatorOf(path: string): '\\' | '/' {
  return path.includes('\\') ? '\\' : '/'
}

/**
 * Appends a trailing separator if absent, so `startsWith`/prefix comparisons
 * cannot match a sibling that merely shares a name prefix
 * (`C:\notes` must not match `C:\notes-archive`).
 */
export function withTrailingSeparator(path: string): string {
  const separator = separatorOf(path)
  return path.endsWith(separator) ? path : `${path}${separator}`
}
