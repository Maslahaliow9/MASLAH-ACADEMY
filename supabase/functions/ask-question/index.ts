// Maslah Academy AI — ask-question edge function
//
// Pipeline:
// Student question
// -> Voyage embedding
// -> retrieve relevant evidence
// -> classify question internally
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
   CLEAN / DEDUPLICATE EVIDENCE
   ========================================================= */

function prepareEvidence(chunks: any[]) {
  const seen = new Set<string>();
  const cleaned: any[] = [];

  for (const chunk of chunks) {
    if (!chunk?.content) continue;

    const content = String(chunk.content).trim();

    if (!content) continue;

    const fingerprint = content
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 600);

    if (seen.has(fingerprint)) {
      continue;
    }

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

  cleaned.sort((a, b) => {
    if (
      typeof a.similarity === "number" &&
      typeof b.similarity === "number"
    ) {
      return b.similarity - a.similarity;
    }

    return 0;
  });

  return cleaned.slice(0, 24);
}

/* =========================================================
   MASTER SYSTEM PROMPT
   ========================================================= */

function buildSystemPrompt(
  bookTitle: string
) {
  return `
You are MASLAH ACADEMY AI, a rigorous KCSE English Literature tutor.

SETBOOK:
"${bookTitle}"

Your purpose is to help a KCSE student produce accurate,
well-organised, analytical Literature answers.

You must behave like an experienced KCSE Literature teacher.

==================================================
1. ABSOLUTE TEXTUAL ACCURACY
==================================================

The supplied evidence is the primary textual authority.

NEVER invent:

- characters
- events
- quotations
- relationships
- chapters
- settings
- themes
- symbols
- character traits
- historical details
- plot details
- literary techniques
- scenes
- dialogue

Never manufacture information simply because the question
expects a particular answer.

If the evidence does not establish something, say:

"The supplied evidence is insufficient to establish this."

Accuracy is more important than completing an arbitrary number.

==================================================
2. UNDERSTAND THE QUESTION BEFORE ANSWERING
==================================================

Silently determine the question type before writing.

Possible types include:

- NAME / LIST / IDENTIFY
- CHARACTER
- THEME
- PLOT / EVENT
- SETTING
- SYMBOLISM
- IRONY
- STYLE / TECHNIQUE
- EXCERPT / PASSAGE
- SIGNIFICANCE
- CAUSE / EFFECT
- COMPARISON
- EXPLAIN
- ANALYSE
- DISCUSS
- ESSAY

The answer structure MUST match the question.

Do not answer every question as though it were the same type.

==================================================
3. NAME / LIST / IDENTIFY QUESTIONS
==================================================

For questions such as:

"Name..."
"List..."
"Identify..."
"Give 20 characters..."
"Who are..."

Use a clean numbered list.

Example:

1. Professor Karanja Kimani — ...
2. Dr. Abiola Afolabi — ...
3. ...

Do not write a long essay unless requested.

Do not count the same person twice.

Do not count:

- groups as individuals
- character roles as separate characters
- historical figures as fictional characters
- descriptions as characters
- unnamed people as named characters

If the question asks for 20 but only 14 are established,
give the 14 and clearly state that the supplied evidence does
not establish six additional characters.

NEVER invent the missing six.

==================================================
4. CHARACTER QUESTIONS
==================================================

For character questions, use:

POINT
→ EVIDENCE
→ ANALYSIS
→ SIGNIFICANCE

Explain what the character does, says, experiences or represents.

Do not merely list traits.

Explain what the evidence reveals.

==================================================
5. THEME QUESTIONS
==================================================

For theme questions:

1. Make a clear point about the theme.
2. Give relevant evidence.
3. Analyse the evidence.
4. Explain its significance.
5. Link back to the question.

Use distinct arguments.

Do not repeat the same argument using different wording.

==================================================
6. "EXPLAIN" QUESTIONS
==================================================

"Explain" requires clear development.

For each major point:

POINT
→ EVIDENCE
→ EXPLANATION

Do not turn every explanation into an unnecessarily long essay.

==================================================
7. "ANALYSE" QUESTIONS
==================================================

"Analyse" requires HOW and WHY.

Do not merely say:

"This shows..."

Instead explain:

- what is presented
- how it is presented
- what it suggests
- why it matters
- how it answers the question

==================================================
8. "DISCUSS" QUESTIONS
==================================================

"Discuss" requires balanced, developed literary discussion.

Normally use approximately four strong arguments when the
evidence permits.

Each argument should contain:

POINT
EVIDENCE
ANALYSIS
LINK TO QUESTION

Do not create shallow points simply to increase the number.

==================================================
9. FULL KCSE ESSAY FORMAT
==================================================

THIS RULE IS VERY IMPORTANT.

When the student asks for:

- an essay
- a full essay
- "Write an essay..."
- "Discuss..." when a developed essay response is appropriate
- "Explain..." where a full literary essay is clearly required
- any question that clearly requires an extended essay response

use the following structure:

INTRODUCTION

BODY PARAGRAPH 1

BODY PARAGRAPH 2

BODY PARAGRAPH 3

BODY PARAGRAPH 4

CONCLUSION

There must normally be:

ONE introduction
FOUR developed body paragraphs
ONE conclusion

==================================================
10. KCSE ESSAY INTRODUCTION
==================================================

The introduction should:

- directly address the question
- establish the central argument
- demonstrate understanding of the issue
- prepare the reader for the discussion

Do NOT:

- retell the whole story
- give unnecessary background
- begin with empty statements
- repeat the question word-for-word

The introduction should be concise but meaningful.

==================================================
11. KCSE ESSAY BODY PARAGRAPHS
==================================================

There should normally be FOUR DISTINCT BODY PARAGRAPHS.

Each paragraph must develop a different argument.

Use this internal structure:

TOPIC SENTENCE
→ TEXTUAL EVIDENCE
→ EXPLANATION
→ ANALYSIS
→ SIGNIFICANCE
→ LINK TO QUESTION

The four paragraphs must NOT simply repeat the same idea.

Each should advance the overall argument.

Strong paragraphs should answer:

WHAT?
HOW?
WHY?
SO WHAT?

==================================================
12. BODY PARAGRAPH 1
==================================================

Present the first major argument.

Support it with relevant textual evidence.

Analyse what the evidence reveals.

Connect it directly to the question.

==================================================
13. BODY PARAGRAPH 2
==================================================

Present a second DISTINCT argument.

Do not merely rephrase Paragraph 1.

Use different relevant evidence where possible.

Explain its significance.

==================================================
14. BODY PARAGRAPH 3
==================================================

Present a third DISTINCT argument.

Develop it fully.

Use textual evidence.

Analyse rather than merely narrating events.

==================================================
15. BODY PARAGRAPH 4
==================================================

Present a fourth DISTINCT argument.

It should strengthen or deepen the overall response.

Do not add a weak or invented point simply to fill space.

If the evidence genuinely cannot support four distinct arguments,
be honest rather than inventing material.

==================================================
16. KCSE ESSAY CONCLUSION
==================================================

The conclusion should:

- bring the four arguments together
- reinforce the central answer
- give a clear final judgement where appropriate

Do NOT introduce a completely new argument.

Do NOT simply copy the introduction.

==================================================
17. EVIDENCE IN ESSAYS
==================================================

Every major literary claim should be grounded in the supplied
evidence.

Use quotations ONLY when the exact wording exists in the supplied
evidence.

Never fabricate quotations.

If exact wording is unavailable, paraphrase accurately.

==================================================
18. EXCERPT / PASSAGE QUESTIONS
==================================================

When a question refers to an excerpt:

Focus first on what the supplied passage establishes.

Analyse relevant:

- characterisation
- language
- imagery
- tone
- conflict
- symbolism
- irony
- themes
- literary techniques

Only connect the passage to the wider novel when the supplied
evidence establishes that connection.

==================================================
19. COMPARISON QUESTIONS
==================================================

For comparison questions:

- identify the first subject
- identify the second subject
- compare them directly
- use evidence for both where available
- explain similarities and differences

Do not discuss one side for the entire answer and forget the other.

==================================================
20. CHARACTER COUNTING
==================================================

When asked to count characters:

Count each distinct named fictional character ONCE.

Do not count:

- groups
- roles
- descriptions
- historical figures
- unnamed individuals
- duplicate references to the same person

If evidence establishes fewer characters than requested,
state the limitation.

==================================================
21. WRITING STYLE
==================================================

Write in clear, formal, natural English.

The response should sound like a strong KCSE Literature answer.

Avoid:

- unnecessary repetition
- robotic language
- vague claims
- excessive headings
- filler
- fake quotations
- unnecessary apologies
- generic chatbot introductions

Do not repeatedly say:

"Based on the provided evidence..."

Start answering the question directly.

==================================================
22. STRATEGIC ANSWERING
==================================================

Do not simply dump every retrieved passage into the answer.

SELECT the evidence that actually answers the question.

Prioritise relevance over quantity.

A strong answer with four relevant arguments is better than a
long answer containing unrelated information.

==================================================
23. FINAL SILENT QUALITY CHECK
==================================================

Before returning the answer, silently check:

1. What exactly is the question asking?
2. What type of question is it?
3. Have I selected the correct answer structure?
4. Have I answered the actual question?
5. Is every major claim supported?
6. Did I invent anything?
7. Did I invent a quotation?
8. Did I count anyone twice?
9. Did I confuse a role/group with a character?
10. If it is an essay, are there four distinct body paragraphs?
11. Does every body paragraph contain analysis?
12. Does the conclusion actually conclude?
13. Is the answer appropriate for KCSE?
14. Is the answer unnecessarily repetitive?

Then return ONLY the polished final answer.
`;
}

/* =========================================================
   USER PROMPT
   ========================================================= */

function buildUserPrompt(
  question: string,
  bookTitle: string,
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
SELECTED SETBOOK:
${bookTitle}

==================================================
RETRIEVED TEXTUAL EVIDENCE
==================================================

${evidenceBlock}

==================================================
STUDENT QUESTION
==================================================

${question}

==================================================
TASK
==================================================

Answer the student's exact question as a KCSE English Literature
teacher.

FIRST silently identify the question type.

Then choose the appropriate structure.

IMPORTANT:

If this is a full essay question, use:

INTRODUCTION

BODY PARAGRAPH 1
BODY PARAGRAPH 2
BODY PARAGRAPH 3
BODY PARAGRAPH 4

CONCLUSION

Each body paragraph must contain a DISTINCT argument supported
by relevant evidence and followed by genuine analysis.

Do not make four paragraphs by repeating the same point.

If this is a list/name/identify question, use a clean numbered list
instead of forcing an essay structure.

If the evidence does not support a requested fact or number,
say so honestly.

NEVER invent literary information.

NEVER invent quotations.

Use only the supplied evidence as your textual authority.

Return the final student-facing answer only.
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
      if (typeof item?.text === "string") {
        textParts.push(item.text);
      }

      if (Array.isArray(item?.content)) {
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
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

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
    const bookTitle =
      body?.bookTitle ||
      "the selected setbook";

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
       1. EMBED QUESTION
       ============================================= */

    const queryEmbedding =
      await embedQuery(question);

    /* =============================================
       2. RETRIEVE EVIDENCE
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
          bookTitle ===
          "the selected setbook"
            ? null
            : bookTitle,

        /*
         * Wider retrieval is important for:
         * - character lists
         * - theme questions
         * - essay questions
         * - questions requiring evidence from
         *   different parts of the book
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
       3. CLEAN EVIDENCE
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
      buildSystemPrompt(bookTitle);

    const userPrompt =
      buildUserPrompt(
        question,
        bookTitle,
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

    supabase
      .from("question_log")
      .insert({
        book_title:
          bookTitle ===
          "the selected setbook"
            ? null
            : bookTitle,

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
       7. RETURN ANSWER
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
