// Maslah Academy AI — book ingestion script
//
// Usage:
//   node scripts/ingest-book.mjs --file "./The Samaritan.pdf" --title "The Samaritan" --author "John Lara"
//
// What it does:
//   1. Extracts text from the PDF
//   2. Splits it into coherent chunks (~800-1200 chars, on paragraph boundaries)
//   3. Embeds each chunk with Voyage AI (voyage-3)
//   4. Inserts book + chunks into Supabase
//
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY
// Requires: npm install pdf-parse @supabase/supabase-js

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pdfParse from "pdf-parse";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const { file, title, author } = args;
if (!file || !title) {
  console.error('Usage: node ingest-book.mjs --file "<path>.pdf" --title "<Book Title>" [--author "<Author>"]');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !VOYAGE_API_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- 1. Extract text -------------------------------------------------------

async function extractText(path) {
  const buffer = fs.readFileSync(path);
  const parsed = await pdfParse(buffer);
  return parsed.text;
}

// --- 2. Chunk on paragraph boundaries, ~1000 chars per chunk --------------

function chunkText(text, targetSize = 1000) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);

  const chunks = [];
  let current = "";
  let currentChapter = null;

  const chapterRe = /^(chapter|part)\s+[\divxlc]+/i;

  for (const para of paragraphs) {
    if (chapterRe.test(para)) {
      currentChapter = para.slice(0, 60);
    }
    if ((current + " " + para).length > targetSize && current.length > 0) {
      chunks.push({ chapter_label: currentChapter, content: current.trim() });
      current = para;
    } else {
      current = current ? `${current} ${para}` : para;
    }
  }
  if (current.trim()) chunks.push({ chapter_label: currentChapter, content: current.trim() });

  return chunks.map((c, i) => ({ ...c, chunk_index: i }));
}

// --- 3. Embed in batches ----------------------------------------------------

async function embedBatch(texts) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: texts, model: "voyage-3", input_type: "document" }),
  });
  if (!res.ok) throw new Error(`Voyage embedding failed: ${await res.text()}`);
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

// --- 4. Run ------------------------------------------------------------------

async function main() {
  console.log(`Extracting text from ${file}...`);
  const text = await extractText(file);
  console.log(`Extracted ${text.length} characters.`);

  const chunks = chunkText(text);
  console.log(`Split into ${chunks.length} chunks.`);

  console.log(`Upserting book record: "${title}"...`);
  const { data: book, error: bookErr } = await supabase
    .from("books")
    .upsert({ title, author: author ?? null }, { onConflict: "title" })
    .select()
    .single();
  if (bookErr) throw bookErr;

  const BATCH = 20;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    console.log(`Embedding chunks ${i + 1}-${i + batch.length} of ${chunks.length}...`);
    const embeddings = await embedBatch(batch.map((c) => c.content));

    const rows = batch.map((c, j) => ({
      book_id: book.id,
      chapter_label: c.chapter_label,
      chunk_index: c.chunk_index,
      content: c.content,
      embedding: embeddings[j],
    }));

    const { error: insertErr } = await supabase.from("book_chunks").insert(rows);
    if (insertErr) throw insertErr;
  }

  console.log(`Done. "${title}" ingested with ${chunks.length} chunks.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
