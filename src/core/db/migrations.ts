export interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * Append-only. Never edit a migration that has shipped -- add a new one.
 * `PRAGMA user_version` tracks which have been applied.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: /* sql */ `
      -- One row per indexed file on disk.
      CREATE TABLE files (
        id           INTEGER PRIMARY KEY,
        path         TEXT    NOT NULL UNIQUE,
        mtime_ms     INTEGER NOT NULL,
        size_bytes   INTEGER NOT NULL,
        -- sha256 of the raw bytes, so a rewritten-but-identical file is cheap
        -- to detect and does not trigger re-embedding.
        content_hash TEXT    NOT NULL,
        indexed_at   INTEGER NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'indexed',
        error_message TEXT
      );

      CREATE TABLE chunks (
        id           INTEGER PRIMARY KEY,
        file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        ordinal      INTEGER NOT NULL,
        text         TEXT    NOT NULL,
        start_line   INTEGER NOT NULL,
        end_line     INTEGER NOT NULL,
        heading_path TEXT,
        -- Float32Array bytes, L2-normalised at write time so search only needs
        -- a dot product. NULL until the embedding worker fills it in.
        embedding    BLOB
      );

      CREATE INDEX idx_chunks_file ON chunks(file_id);
      CREATE INDEX idx_chunks_embedded ON chunks(id) WHERE embedding IS NOT NULL;

      -- External-content FTS5: the index stores only the inverted index and
      -- reads the text back from the chunks table, rather than duplicating every
      -- document. Porter stemming is what lets "invoice" match "invoicing".
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text,
        content='chunks',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      -- External-content tables are not maintained automatically; without these
      -- triggers the FTS index silently drifts out of sync with chunks.
      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;

      CREATE TRIGGER chunks_au AFTER UPDATE OF text ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END;

      -- Folders the user has asked Trove to watch.
      CREATE TABLE folders (
        id       INTEGER PRIMARY KEY,
        path     TEXT    NOT NULL UNIQUE,
        added_at INTEGER NOT NULL
      );

      -- Key/value scratch space. Critically holds model_id: if the embedding
      -- model changes, every stored vector is meaningless and must be rebuilt
      -- rather than silently compared against vectors from a different space.
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    name: 'index-pending-chunks',
    sql: /* sql */ `
      -- v1 indexed the wrong half of the predicate. The embedding loop polls
      -- "WHERE embedding IS NULL" once per batch, but the only partial index
      -- covered IS NOT NULL, so every batch fell back to a full table scan --
      -- invisible at a few thousand chunks, quadratic by the time an index has
      -- a hundred thousand.
      CREATE INDEX idx_chunks_pending ON chunks(id) WHERE embedding IS NULL;
    `
  },
  {
    version: 3,
    name: 'track-extractor-version',
    sql: /* sql */ `
      -- Which extractor version last processed this file. Lets a failure be
      -- retried exactly once after the extractor improves, instead of either
      -- never (a shipped fix never reaches broken files) or on every single
      -- scan (encrypted PDFs re-fail forever).
      -- Existing rows default to 0, so everything already indexed is re-checked
      -- once against the current extractor.
      ALTER TABLE files ADD COLUMN extractor_version INTEGER NOT NULL DEFAULT 0;
    `
  }
]
