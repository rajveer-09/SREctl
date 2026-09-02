-- Corpus tables for hybrid retrieval.
--
-- repo_files is the incrementality key: a file whose content_hash is unchanged
-- is never re-embedded. import_edges is rebuilt in full on every run because it
-- is deterministic and costs no API calls.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS repo_files (
  repo          text        NOT NULL,
  path          text        NOT NULL,
  content_hash  text        NOT NULL,
  size_bytes    integer     NOT NULL,
  indexed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, path)
);

CREATE TABLE IF NOT EXISTS file_chunks (
  id           bigserial PRIMARY KEY,
  repo         text    NOT NULL,
  path         text    NOT NULL,
  chunk_index  integer NOT NULL,
  kind         text    NOT NULL,
  symbol       text,
  start_line   integer NOT NULL,
  end_line     integer NOT NULL,
  content      text    NOT NULL,
  embedding    vector(768),
  UNIQUE (repo, path, chunk_index)
);

CREATE TABLE IF NOT EXISTS import_edges (
  repo       text NOT NULL,
  from_path  text NOT NULL,
  to_path    text NOT NULL,
  PRIMARY KEY (repo, from_path, to_path)
);

-- Reverse lookup is the one that matters: "who imports the file I changed?"
CREATE INDEX IF NOT EXISTS import_edges_to_idx ON import_edges (repo, to_path);
CREATE INDEX IF NOT EXISTS file_chunks_path_idx ON file_chunks (repo, path);

-- Cosine, to match the normalized embeddings the indexer writes.
CREATE INDEX IF NOT EXISTS file_chunks_embedding_idx
  ON file_chunks USING hnsw (embedding vector_cosine_ops);
