-- Maslah Academy AI — initial schema
-- Enables vector search over setbook content for RAG.

create extension if not exists vector;

-- One row per setbook (e.g. "The Samaritan", "Fathers of Nations")
create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  title text not null unique,
  author text,
  created_at timestamptz not null default now()
);

-- Chunked passages from each book, with embeddings for retrieval.
-- Chunking should respect natural boundaries (chapters/scenes/paragraphs)
-- so each chunk is a coherent, citable piece of evidence.
create table if not exists book_chunks (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  chapter_label text,        -- e.g. "Chapter 4" or "Part Two, Scene 1"
  chunk_index int not null,  -- order within the book, for citation context
  content text not null,     -- the actual setbook text for this chunk
  embedding vector(1024),    -- voyage-3 embedding dimension
  created_at timestamptz not null default now()
);

create index if not exists book_chunks_embedding_idx
  on book_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists book_chunks_book_id_idx
  on book_chunks (book_id);

-- Log of student questions and generated answers, for review/improvement.
create table if not exists question_log (
  id uuid primary key default gen_random_uuid(),
  book_title text,
  question text not null,
  answer text,
  retrieved_chunk_ids uuid[],
  created_at timestamptz not null default now()
);

-- Similarity search RPC used by the ask-question edge function.
create or replace function match_book_chunks (
  query_embedding vector(1024),
  match_book_title text,
  match_count int default 8
)
returns table (
  id uuid,
  chapter_label text,
  content text,
  similarity float
)
language sql stable
as $$
  select
    bc.id,
    bc.chapter_label,
    bc.content,
    1 - (bc.embedding <=> query_embedding) as similarity
  from book_chunks bc
  join books b on b.id = bc.book_id
  where match_book_title is null or b.title = match_book_title
  order by bc.embedding <=> query_embedding
  limit match_count;
$$;

alter table books enable row level security;
alter table book_chunks enable row level security;
alter table question_log enable row level security;

-- Public read access to book content (it's the study material).
create policy "book chunks are publicly readable" on book_chunks
  for select using (true);
create policy "books are publicly readable" on books
  for select using (true);

-- Question log is written only by the edge function (service role bypasses RLS).
