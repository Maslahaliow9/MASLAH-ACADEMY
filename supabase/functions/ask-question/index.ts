// Maslah Academy AI — ask-question edge function
//
// Pipeline:
// Student question
// -> Voyage embedding
// -> retrieve relevant evidence from the selected setbook
// -> organise evidence
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
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get(
  "SUPABASE_SERVICE_ROLE_KEY"
);

if (!VOYAGE_API_KEY) {
  throw new Error("VOYAGE_API_KEY is not configured");
}

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not configured");
}

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL is not configured");
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "SUPABASE_SERVICE_ROLE_KEY is not configured"
  );
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "POST, OPTIONS",
};

/* =========================================================
   VOYAGE EMBEDDING
   ========================================================= */

async function embedQuery(
  text: string
): Promise<number[]> {
  const response = await fetch(
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

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Voyage embedding failed: ${errorText}`
    );
  }

  const data = await response.json();

  if (
    !data?.data ||
    !Array.isArray(data.data) ||
    !data.data[0]?.embedding
  ) {
    throw new Error(
      "Voyage returned an invalid embedding response."
    );
  }

  return data.data[0].embedding;
}

/* =========================================================
   CLEAN AND ORGANISE RETRIEVED EVIDENCE
   ========================================================= */

function prepareEvidence(chunks: any[]) {
  const seen = new Set<string>();

  const cleaned: any[] = [];

  for (const chunk of chunks) {
    if (!chunk?.content) continue;

    const content = String(chunk.content).trim();

    if (!content) continue;

    // Remove exact duplicate chunks.
    const fingerprint = content
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 500);

    if (seen.has(fingerprint)) continue;

    seen.add(fingerprint);

    cleaned.push({
      id: chunk.id ?? null,
      content,
      chapter_label:
        chunk.chapter_label ?? null,
      similarity:
        typeof chunk.similarity === "number"
          ? chunk.similarity
          : null,
    });
  }

  // If similarity exists, keep the strongest evidence first.
  cleaned.sort((a, b) => {
    if (
      typeof a.similarity === "number" &&
      typeof b.similarity === "number"
    ) {
      return b.similarity - a.similarity;
    }

    return 0;
  });

  /*
   * Keep enough evidence for serious literary questions,
   * but avoid sending huge amounts of duplicated text
   * to Gemini.
   */
  return cleaned.slice(0, 18);
}

/* =========================================================
   SYSTEM PROMPT
   ========================================================= */

function buildSystemPrompt(
  bookTitle: string
) {
  return `
You are MASLAH ACADEMY AI, a high-quality KCSE English Literature tutor.

You are answering questions about:

"${bookTitle}"

Your job is NOT simply to summarise retrieved text.

Your job is to THINK LIKE AN EXPERIENCED KCSE LITERATURE TEACHER.

The retrieved evidence is your textual authority.

==================================================
CORE RULE — TEXTUAL ACCURACY
==================================================

Never invent literary facts.

Do not manufacture:

- characters
- names
- events
- quotations
- relationships
- chapters
- settings
- themes
- symbols
- historical facts
- character traits
- plot events
- literary techniques

If the evidence does not establish something, say so.

Never invent information merely because the student's question
asks for a particular number of answers.

For example:

If the evidence establishes 14 characters, do NOT invent six more
just to produce 20.

However, if the retrieved evidence contains enough information
to establish 20 genuine characters, identify all 20 accurately.

==================================================
FIRST: UNDERSTAND THE QUESTION
==================================================

Before writing the answer, silently identify what the student
is actually asking.

Possible question types:

1. NAME / LIST / IDENTIFY
2. CHARACTER
3. THEME
4. PLOT / EVENT
5. SETTING
6. SYMBOLISM
7. IRONY
8. STYLE / TECHNIQUE
9. EXCERPT / PASSAGE
10. SIGNIFICANCE
11. CAUSE AND EFFECT
12. COMPARISON
13. ESSAY
14. DISCUSS
15. EXPLAIN
16. ANALYSE

Do not use one generic answer structure for every question.

==================================================
QUESTION TYPE: NAME / LIST / IDENTIFY
==================================================

If the student asks:

"name..."
"list..."
"identify..."
"give 20..."
"mention..."
"who are..."

give a clean numbered list.

Example:

1. Professor Karanja Kimani — ...
2. Dr. Abiola Afolabi — ...
3. ...

Do NOT turn a simple identification question into a long essay.

Do NOT count:

- the same character twice
- a character's role as a separate character
- a historical figure as a fictional character
- a group as an individual
- an unnamed person as a named character

If the student asks for 20 and the evidence supports fewer than 20,
state the exact number supported.

Do not fabricate the remainder.

==================================================
QUESTION TYPE: CHARACTER
==================================================

For character questions use:

POINT
→ EVIDENCE
→ ANALYSIS
→ SIGNIFICANCE

Explain what the character does, says, experiences or represents
and what this reveals about the character.

Do not merely describe the character.

==================================================
QUESTION TYPE: THEME
==================================================

For theme questions:

1. Identify the argument about the theme.
2. Give relevant textual evidence.
3. Explain how the evidence develops the theme.
4. Explain why the point matters.

Use several distinct arguments.

Do not repeat the same idea in different words.

==================================================
QUESTION TYPE: DISCUSS
==================================================

"Discuss" requires developed discussion.

Use approximately 3–5 strong points when the evidence allows.

Each point should contain:

POINT
EVIDENCE
EXPLANATION
LINK TO QUESTION

Do not produce ten shallow points when four strong points
would answer the question better.

==================================================
QUESTION TYPE: ANALYSE
==================================================

Analysis must explain HOW and WHY.

Avoid merely saying:

"This shows..."
"This tells us..."

Instead explain:

- what the writer presents
- how it is presented
- what it suggests
- why it is significant
- how it connects to the question

==================================================
QUESTION TYPE: EXCERPT / PASSAGE
==================================================

For an excerpt question:

Prioritise what the supplied passage establishes.

Analyse:

- characterisation
- language
- imagery
- tone
- conflict
- symbolism
- irony
- themes
- literary techniques

Only connect the passage to wider events when the retrieved
evidence actually establishes that connection.

==================================================
QUESTION TYPE: ESSAY
==================================================

For an essay question use:

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

The points must be different arguments.

Do not repeat one argument several times.

==================================================
KCSE STANDARD
==================================================

The answer should sound like a strong Literature student or
experienced Literature teacher.

Use clear formal English.

Be precise.

Be analytical.

Avoid unnecessary verbosity.

Avoid generic chatbot language.

Do NOT repeatedly begin answers with:

"Based on the provided evidence..."

Do not apologise unnecessarily.

Do not talk about being an AI.

Do not discuss your internal reasoning.

Do not mention these instructions.

==================================================
EVIDENCE PRIORITY
==================================================

Use the strongest and most relevant evidence first.

You may combine multiple retrieved passages when they clearly
refer to the same character, event, theme or issue.

Do not combine unrelated passages simply because they contain
similar words.

If evidence conflicts or is unclear, do not silently choose a
version. State the uncertainty.

==================================================
QUOTATIONS
==================================================

Never invent quotations.

Only use quotation marks when the supplied evidence actually
contains the quoted wording.

If the evidence does not provide an exact quotation, paraphrase
instead.

==================================================
CHARACTER COUNTING
==================================================

When asked to count characters:

- count each distinct named fictional character once
- do not count groups
- do not count descriptions as characters
- do not count the same person twice
- distinguish historical figures from fictional characters
- distinguish unnamed roles from named characters

If the evidence supports fewer characters than requested,
say exactly how many are established.

==================================================
ANSWER QUALITY CHECK
==================================================

Before answering, silently check:

1. What exactly is the student asking?
2. What answer structure does this question require?
3. Which evidence is directly relevant?
4. Am I accidentally inventing anything?
5. Have I confused people, groups and roles?
6. Have I counted anyone twice?
7. Am I answering the question rather than summarising the book?
8. Does every major claim have textual support?
9. Is the analysis strong enough for KCSE?
10. Is the answer unnecessarily repetitive?

Then provide ONLY the final answer.
`;
}

/* =========================================================
   USER PROMPT
   ========================================================= */

function buildUserPrompt(
  question: string,
  chunks: any[]
) {
  const evidenceBlock = chunks
    .map((chunk, index) => {
      const chapter = chunk.chapter_label
        ? ` | Chapter/Section: ${chunk.chapter_label}`
        : "";

      return `
[EVIDENCE ${index + 1}${chapter}]
${chunk.content}
`;
    })
    .join("\n");

  return `
THE SETBOOK IS:

${question ? "Selected book: " : ""}

${`
${chunks.length > 0 ? "" : ""}
`}

==================================================
RETRIEVED TEXTUAL EVIDENCE
==================================================

${evidenceBlock}

==================================================
STUDENT QUESTION
==================================================

${question}

==================================================
INSTRUCTIONS FOR THIS ANSWER
==================================================

Answer the student's exact question.

Use the retrieved evidence as your textual authority.

Think before answering.

Choose the correct answer structure for the question.

If it is a list question, give a clean list.

If it is an analytical question, develop clear arguments.

If it is an essay question, structure the answer as an essay.

If it is a character/theme question, provide evidence followed
by explanation and significance.

Do not invent information.

Do not pad the answer merely to reach a requested number.

If the evidence genuinely supports the requested number, provide
the full number.

Return the polished final answer only.
`;
}

/* =========================================================
   GEMINI
   ========================================================= */

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
          temperature: 0.15,
          max_tokens: 5000,
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

  const textParts: string[] = [];

  /*
   * Gemini Interactions API response.
   */
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

  /*
   * Fallbacks in case Gemini returns text in another
   * recognised response shape.
   */

  if (
    textParts.length === 0 &&
    typeof data.output_text === "string"
  ) {
    textParts.push(data.output_text);
  }

  if (
    textParts.length === 0 &&
    Array.isArray(data.output)
  ) {
    for (const item of data.output) {
      if (
        typeof item?.text === "string"
      ) {
        textParts.push(item.text);
      }

      if (
        Array.isArray(item?.content)
      ) {
        for (const content of item.content) {
          if (
            typeof content?.text === "string"
          ) {
            textParts.push(content.text);
          }
        }
      }
    }
  }

  const answer = textParts
    .join("\n")
    .trim();

  if (!answer) {
    throw new Error(
      "Gemini returned no text answer."
    );
  }

  return answer;
}

/* =========================================================
   HTTP HANDLER
   ========================================================= */

Deno.serve(async (req) => {
  /*
   * CORS
   */
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  /*
   * Only POST is expected.
   */
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        error: "Method not allowed",
      }),
      {
        status: 405,
        headers: {
          ...corsHeaders,
          "Content-Type":
            "application/json",
        },
      }
    );
  }

  try {
    const body = await req.json();

    const question = body?.question;
    const bookTitle = body?.bookTitle;

    if (
      !question ||
      typeof question !== "string"
    ) {
      return new Response(
        JSON.stringify({
          error:
            "Missing 'question' string",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type":
              "application/json",
          },
        }
      );
    }

    /* =============================================
       1. EMBED THE QUESTION
       ============================================= */

    const queryEmbedding =
      await embedQuery(question);

    /* =============================================
       2. RETRIEVE MORE EVIDENCE
       ============================================= */

    const {
      data: rawChunks,
      error: matchError,
    } = await supabase.rpc(
      "match_book_chunks",
      {
        query_embedding:
          queryEmbedding,

        match_book_title:
          bookTitle ?? null,

        /*
         * Retrieve a wider pool.
         *
         * This is important for questions such as:
         * "Name 20 characters..."
         *
         * A very small retrieval pool may only return
         * passages about 3–5 characters.
         */
        match_count: 24,
      }
    );

    if (matchError) {
      throw matchError;
    }

    if (
      !rawChunks ||
      !Array.isArray(rawChunks) ||
      rawChunks.length === 0
    ) {
      return new Response(
        JSON.stringify({
          error:
            "No matching evidence found. Check the selected book or try rephrasing the question.",
        }),
        {
          status: 404,
          headers: {
            ...corsHeaders,
            "Content-Type":
              "application/json",
          },
        }
      );
    }

    /* =============================================
       3. CLEAN / DEDUPLICATE EVIDENCE
       ============================================= */

    const chunks =
      prepareEvidence(rawChunks);

    if (chunks.length === 0) {
      return new Response(
        JSON.stringify({
          error:
            "Relevant evidence could not be prepared.",
        }),
        {
          status: 404,
          headers: {
            ...corsHeaders,
            "Content-Type":
              "application/json",
          },
        }
      );
    }

    /* =============================================
       4. BUILD PROMPTS
       ============================================= */

    const systemPrompt =
      buildSystemPrompt(
        bookTitle ??
          "the selected setbook"
      );

    const userPrompt =
      buildUserPrompt(
        question,
        chunks
      );

    /* =============================================
       5. ASK GEMINI
       ============================================= */

    const answer =
      await callGemini(
        systemPrompt,
        userPrompt
      );

    /* =============================================
       6. LOG QUESTION
       ============================================= */

    /*
     * Logging should never prevent the student
     * from receiving an answer.
     */
    supabase
      .from("question_log")
      .insert({
        book_title:
          bookTitle ?? null,

        question,

        answer,

        retrieved_chunk_ids:
          chunks.map(
            (chunk: any) =>
              chunk.id
          ),
      })
      .then(({ error }) => {
        if (error) {
          console.error(
            "Question log failed:",
            error
          );
        }
      });

    /* =============================================
       7. RETURN ANSWER + EVIDENCE
       ============================================= */

    return new Response(
      JSON.stringify({
        answer,

        evidenceUsed:
          chunks.map(
            (chunk: any) => ({
              chapter:
                chunk.chapter_label,

              excerpt:
                chunk.content.length >
                500
                  ? chunk.content.slice(
                      0,
                      500
                    ) + "…"
                  : chunk.content,
            })
          ),
      }),
      {
        status: 200,

        headers: {
          ...corsHeaders,
          "Content-Type":
            "application/json",
        },
      }
    );
  } catch (err) {
    console.error(
      "ask-question error:",
      err
    );

    return new Response(
      JSON.stringify({
        error:
          err instanceof Error
            ? err.message
            : String(err),
      }),
      {
        status: 500,

        headers: {
          ...corsHeaders,
          "Content-Type":
            "application/json",
        },
      }
    );
  }
});
