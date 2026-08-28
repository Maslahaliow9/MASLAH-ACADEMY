# Maslah Academy AI

An AI-powered KCSE English literature study assistant that answers setbook
questions using retrieval-augmented generation (RAG) grounded in the actual
text — currently *The Samaritan* and *Fathers of Nations*.

Instead of relying on a general-purpose model's fuzzy memory of a book, every
answer is generated from passages retrieved directly from the setbook, so
plot details, character names, and evidence stay accurate.

## How it works

1. The setbook PDFs are chunked and embedded (Voyage AI `voyage-3`) and
   stored in Supabase Postgres with `pgvector`.
2. A student's question is embedded the same way, and the most relevant
   chunks are retrieved via cosine similarity.
3. Those chunks are passed to Claude along with a system prompt that enforces
   KCSE English literature answering conventions (thesis, evidence,
   explanation, conclusion).
4. Claude's answer, plus the evidence it used, is returned to the student.

## Project structure

```
frontend/                 React + Vite PWA
  src/App.jsx              Chat UI
  src/lib/supabase.js      Supabase client + ask-question call
  src/styles/index.css     Design system
supabase/
  migrations/0001_init.sql pgvector schema + similarity search RPC
  functions/ask-question/  Edge function: embed → retrieve → generate
scripts/ingest-book.mjs   One-off script to embed & load a setbook PDF
```

## 1. Set up Supabase

```bash
npm install -g supabase
supabase login
supabase init          # if not already a supabase project
supabase link --project-ref <your-project-ref>
supabase db push        # applies migrations/0001_init.sql
```

Set the edge function secrets:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set VOYAGE_API_KEY=pa-...
```

Deploy the edge function:

```bash
supabase functions deploy ask-question
```

Get an Anthropic API key at console.anthropic.com and a Voyage AI key at
voyageai.com (Voyage embeddings are Anthropic's recommended embedding
provider).

## 2. Ingest the setbooks

```bash
cd scripts
npm install pdf-parse @supabase/supabase-js
export SUPABASE_URL=https://<project-ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...   # from Supabase dashboard > Settings > API
export VOYAGE_API_KEY=pa-...

node ingest-book.mjs --file "./The Samaritan.pdf" --title "The Samaritan"
node ingest-book.mjs --file "./Fathers of Nations.pdf" --title "Fathers of Nations"
```

Re-running with the same `--title` upserts the book and appends chunks — if
you re-ingest a corrected PDF, clear the old chunks first via the Supabase
dashboard (`delete from book_chunks where book_id = ...`).

## 3. Run the frontend locally

```bash
cd frontend
npm install
cp .env.example .env      # fill in your Supabase URL + anon key
npm run dev
```

## 4. Deploy

**GitHub**: push this repo to a new GitHub repository.

```bash
git init
git add .
git commit -m "Initial commit: Maslah Academy AI"
git branch -M main
git remote add origin https://github.com/<you>/maslah-academy-ai.git
git push -u origin main
```

**Cloudflare Pages**: connect the GitHub repo in the Cloudflare dashboard.

- Build command: `npm run build`
- Build output directory: `frontend/dist`
- Root directory: `frontend`
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

Every push to `main` will auto-deploy.

## Notes on accuracy

- The edge function retrieves 8 chunks per question by default
  (`match_count` in `ask-question/index.ts`) — raise this for broad essay
  questions, lower it for narrow excerpt questions.
- The system prompt instructs Claude to answer only from retrieved evidence
  and to say so plainly if the evidence is insufficient, rather than
  inventing plot details.
- `question_log` in the database records every question/answer pair with the
  evidence used, so you can review and improve retrieval quality over time.
