// Maslah Academy AI — ask-question edge function
//
// Pipeline: embed the student's question -> retrieve top matching chunks
// from the target setbook via pgvector -> build a KCSE-style prompt with
// that evidence -> call Claude -> return the answer + the evidence used.
//
// Required secrets (set via `supabase secrets set`):
//   VOYAGE_API_KEY   - embeddings (voyage-3)
//   ANTHROPIC_API_KEY - Claude
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY - injected automatically by Supabase

import { createClient } from "npm:@supabase/supabase-js@2";

const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function embedQuery(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [text],
      model: "voyage-3",
      input_type: "query",
    }),
  });
  if (!res.ok) throw new Error(`Voyage embedding failed: ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

function buildSystemPrompt(bookTitle: string) {
  return `You are Maslah Academy AI, a specialist KCSE English literature tutor for the setbook "${bookTitle}".

You answer ONLY using the evidence passages provided to you in each request — never from general knowledge about the book, since your job is to be more accurate than a general-purpose model on this specific text and edition.

Follow KCSE English literature answering conventions:
- Open with a brief statement addressing the question directly (a thesis/topic sentence).
- Organize the body into clear points, each with: a claim, textual evidence (paraphrase the evidence — do not quote long passages verbatim), and an explanation of how the evidence supports the claim.
- Use precise literary terminology where relevant (characterization, foreshadowing, irony, motif, setting, theme, etc.).
- Write in formal, exam-quality English suitable for a KCSE English paper.
- End essay-type answers with a brief conclusion that ties back to the question.
- For character or theme questions, cover multiple distinct points/examples rather than repeating one idea.
- If the provided evidence does not contain enough information to answer confidently, say so plainly rather than inventing plot details.`;
}

function buildUserPrompt(question: string, chunks: { chapter_label: string | null; content: string }[]) {
  const evidenceBlock = chunks
    .map((c, i) => `[Evidence ${i + 1}${c.chapter_label ? ` — ${c.chapter_label}` : ""}]\n${c.content}`)
    .join("\n\n");

  return `Evidence from the setbook:\n\n${evidenceBlock}\n\n---\n\nStudent question:\n${question}\n\nWrite a complete KCSE-style answer using only the evidence above.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { question, bookTitle } = await req.json();

    if (!question || typeof question !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'question' string" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Embed the question
    const queryEmbedding = await embedQuery(question);

    // 2. Retrieve top matching chunks from the target book
    const { data: chunks, error: matchError } = await supabase.rpc("match_book_chunks", {
      query_embedding: queryEmbedding,
      match_book_title: bookTitle ?? null,
      match_count: 8,
    });

    if (matchError) throw matchError;
    if (!chunks || chunks.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No matching evidence found. Check the book title or try rephrasing the question.",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3. Call Claude with the retrieved evidence
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: buildSystemPrompt(bookTitle ?? "the setbook"),
        messages: [{ role: "user", content: buildUserPrompt(question, chunks) }],
      }),
    });

    if (!claudeRes.ok) throw new Error(`Claude API failed: ${await claudeRes.text()}`);
    const claudeData = await claudeRes.json();
    const answer = claudeData.content.find((b: any) => b.type === "text")?.text ?? "";

    // 4. Log for review (best-effort, don't block the response on failure)
    supabase
      .from("question_log")
      .insert({
        book_title: bookTitle ?? null,
        question,
        answer,
        retrieved_chunk_ids: chunks.map((c: any) => c.id),
      })
      .then(() => {});

    return new Response(
      JSON.stringify({
        answer,
        evidenceUsed: chunks.map((c: any) => ({
          chapter: c.chapter_label,
          excerpt: c.content.slice(0, 200) + (c.content.length > 200 ? "…" : ""),
        })),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
