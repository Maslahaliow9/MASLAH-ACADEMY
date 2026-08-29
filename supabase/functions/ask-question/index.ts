// Maslah Academy AI — ask-question edge function
//
// Pipeline:
// Student question
// -> Voyage embedding
// -> retrieve relevant evidence from the selected setbook
// -> Gemini reasoning
// -> KCSE-style answer
//
// Required secrets:
// VOYAGE_API_KEY
// GEMINI_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "npm:@supabase/supabase-js@2";

const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is not configured");
if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is not configured");
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function embedQuery(text: string): Promise<number[]> {
  const res = await fetch(
    "https://api.voyageai.com/v1/embeddings",
    {
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
    }
  );

  if (!res.ok) {
    throw new Error(
      `Voyage embedding failed: ${await res.text()}`
    );
  }

  const data = await res.json();

  return data.data[0].embedding;
}

/**
 * Strong instructions for Maslah Academy AI.
 *
 * The most important rule:
 * NEVER manufacture literary facts simply to satisfy
 * the wording of a question.
 */
function buildSystemPrompt(bookTitle: string) {
  return `
You are Maslah Academy AI, a rigorous KCSE English Literature tutor.

You are answering a question about the setbook:
"${bookTitle}"

YOUR PRIMARY RULE:
The supplied evidence is the authority for this answer.

Do NOT invent:
- characters
- events
- quotations
- relationships
- chapters
- themes
- settings
- historical details
- character roles
- textual evidence

If the supplied evidence does not establish something, say that clearly.

Do not pretend that an answer is supported when it is not.

==================================================
1. UNDERSTAND THE QUESTION FIRST
==================================================

Before answering, silently determine what kind of question this is.

Possible types include:

- character
- theme
- setting
- plot/event
- symbolism
- irony
- style/technique
- excerpt/passage
- comparison
- essay
- list/name/identify
- significance
- cause/effect
- "discuss"
- "explain"
- "analyse"

The structure of the answer must match the question.

==================================================
2. EVIDENCE DISCIPLINE
==================================================

Use only information contained in the supplied evidence.

You may combine pieces of evidence when they clearly refer
to the same person, event, theme, or idea.

Do not fill missing information from your general knowledge.

If the question asks for a specific number of items and the
evidence establishes fewer items, DO NOT invent additional ones.

Instead say something like:

"The supplied evidence establishes 14 named characters.
It does not provide sufficient evidence for six additional
characters, so I will not invent them."

Accuracy is more important than satisfying an arbitrary number.

==================================================
3. CHARACTER QUESTIONS
==================================================

For character questions:

- identify the character accurately
- state the relevant role or trait
- give evidence
- explain what the evidence reveals
- connect the point to the question

Do not confuse:
- a named character
- a historical person mentioned in passing
- a social group
- a character role
- an unnamed person

Do not count the same character twice under different descriptions.

==================================================
4. THEME QUESTIONS
==================================================

For theme questions:

Do not merely define the theme.

Instead:

POINT
→ EVIDENCE
→ EXPLANATION
→ SIGNIFICANCE

Show how the writer develops the theme through
characters, events, conflict, setting, symbolism,
language or other relevant techniques.

==================================================
5. ESSAY QUESTIONS
==================================================

For essay-type questions use:

INTRODUCTION

POINT 1
Evidence
Analysis

POINT 2
Evidence
Analysis

POINT 3
Evidence
Analysis

CONCLUSION

Use several distinct arguments.

Do not repeat the same argument using different wording.

==================================================
6. EXCERPT QUESTIONS
==================================================

For passage/excerpt questions:

- focus first on what the supplied passage actually shows
- explain important details
- analyse relevant language or literary technique
- connect the passage to the wider text ONLY when the evidence
  supplied establishes that connection

Do not invent surrounding events.

==================================================
7. "NAME / LIST / IDENTIFY" QUESTIONS
==================================================

These questions require factual precision.

Create a clean numbered list.

For each item:
NAME — brief identifying role or evidence.

Do not pad the list with guesses.

If fewer items are supported by the evidence, state the limitation.

==================================================
8. KCSE QUALITY
==================================================

Write formal, clear, exam-quality English.

Be analytical rather than merely descriptive.

Prefer:

"this reveals..."
"this suggests..."
"this demonstrates..."
"this highlights..."
"the writer uses..."
"this is significant because..."

Avoid empty phrases and unnecessary repetition.

==================================================
9. DO NOT SOUND LIKE A GENERIC CHATBOT
==================================================

Do not begin every answer with:

"Based on the provided evidence..."

Do not repeatedly apologise.

Do not use excessive headings when a short answer is appropriate.

Do not produce inflated or vague analysis.

Answer the actual question directly.

==================================================
10. EVIDENCE LIMITATION
==================================================

If evidence is insufficient, be honest.

Use:

"The supplied evidence is insufficient to establish this."

rather than inventing an answer.

==================================================
11. FINAL QUALITY CHECK
==================================================

Before returning the answer, silently check:

1. Did I answer the actual question?
2. Did I use only supplied evidence?
3. Did I accidentally invent a fact?
4. Did I count the same character twice?
5. Did I distinguish characters from roles/groups?
6. Did I give analysis rather than mere summary?
7. Is the structure appropriate to the question?
8. Is the English suitable for KCSE?
9. If evidence was insufficient, did I say so?

Only then provide the final answer.
`;
}

/**
 * Build the evidence sent to Gemini.
 */
function buildUserPrompt(
  question: string,
  chunks: any[]
) {
  const evidenceBlock = chunks
    .map((c, i) => {
      const label = c.chapter_label
        ? ` — ${c.chapter_label}`
        : "";

      return `[Evidence ${i + 1}${label}]
${c.content}`;
    })
    .join("\n\n");

  return `
RELEVANT EVIDENCE FROM THE SETBOOK:

${evidenceBlock}

==================================================

STUDENT QUESTION:

${question}

==================================================

TASK:

Answer the student's question as a KCSE English Literature
teacher.

Use the evidence above as your textual authority.

Do not invent information that is not supported by it.

Give a direct, well-organised and analytical answer.
`;
}

/**
 * Call Gemini through the current REST API.
 */
async function callGemini(
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.7-flash",
        system_instruction: systemPrompt,
        input: userPrompt,
        generation_config: {
          temperature: 0.2,
          max_tokens: 4000,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Gemini API failed: ${errorText}`
    );
  }

  const data = await response.json();

  // Current Interactions API response format.
  const textParts: string[] = [];

  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (
        step?.type === "model_output" &&
        Array.isArray(step.content)
      ) {
        for (const content of step.content) {
          if (
            content?.type === "text" &&
            typeof content.text === "string"
          ) {
            textParts.push(content.text);
          }
        }
      }
    }
  }

  const answer = textParts.join("\n").trim();

  if (!answer) {
    throw new Error(
      "Gemini returned no text answer."
    );
  }

  return answer;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  try {
    const { question, bookTitle } = await req.json();

    if (!question || typeof question !== "string") {
      return new Response(
        JSON.stringify({
          error: "Missing 'question' string",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // ---------------------------------------------
    // 1. Convert question into an embedding
    // ---------------------------------------------

    const queryEmbedding = await embedQuery(question);

    // ---------------------------------------------
    // 2. Retrieve evidence from the selected book
    // ---------------------------------------------

    const { data: chunks, error: matchError } =
      await supabase.rpc(
        "match_book_chunks",
        {
          query_embedding: queryEmbedding,
          match_book_title: bookTitle ?? null,

          // More evidence than before.
          match_count: 12,
        }
      );

    if (matchError) {
      throw matchError;
    }

    if (!chunks || chunks.length === 0) {
      return new Response(
        JSON.stringify({
          error:
            "No matching evidence found. Check the book title or try rephrasing the question.",
        }),
        {
          status: 404,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // ---------------------------------------------
    // 3. Ask Gemini to reason over the evidence
    // ---------------------------------------------

    const systemPrompt = buildSystemPrompt(
      bookTitle ?? "the setbook"
    );

    const userPrompt = buildUserPrompt(
      question,
      chunks
    );

    const answer = await callGemini(
      systemPrompt,
      userPrompt
    );

    // ---------------------------------------------
    // 4. Log the question and answer
    // ---------------------------------------------

    supabase
      .from("question_log")
      .insert({
        book_title: bookTitle ?? null,
        question,
        answer,
        retrieved_chunk_ids: chunks.map(
          (c: any) => c.id
        ),
      })
      .then(() => {});

    // ---------------------------------------------
    // 5. Return answer + evidence
    // ---------------------------------------------

    return new Response(
      JSON.stringify({
        answer,

        evidenceUsed: chunks.map((c: any) => ({
          chapter: c.chapter_label,
          excerpt:
            c.content.slice(0, 300) +
            (c.content.length > 300 ? "…" : ""),
        })),
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );

  } catch (err) {
    console.error(err);

    return new Response(
      JSON.stringify({
        error: String(err),
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
