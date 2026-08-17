/**
 * Bumped whenever extraction logic changes in a way that could turn a previous
 * failure into a success.
 *
 * This is what decides whether a failed file is worth another attempt. Two
 * kinds of failure look identical in the database:
 *
 *   - fixable: a parser bug or missing capability, which a later version fixes
 *   - permanent: an encrypted PDF with no password, which will never succeed
 *
 * Retrying everything on every scan wastes work on the permanent ones forever;
 * retrying nothing means a shipped fix never reaches the files it repairs.
 * Recording the version that failed resolves both: a failure is retried exactly
 * once per extractor change, and otherwise only if the file itself changes.
 *
 * History:
 *   1 - pdfjs-dist directly; threw "DOMMatrix is not defined" on any real PDF
 *   2 - unpdf, which ships pdfjs without the browser globals
 */
export const EXTRACTOR_VERSION = 2
