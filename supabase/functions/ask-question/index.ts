// ================================================================
// MASLAH ACADEMY AI — ASK QUESTION EDGE FUNCTION
// ================================================================
//
// Pipeline:
//
// Student question
//       ↓
// Voyage AI embedding
//       ↓
// Semantic retrieval from selected setbook
//       ↓
// Evidence filtering / preparation
//       ↓
// Gemini reasoning
//       ↓
// KCSE-style answer
//       ↓
// Complete answer + evidence returned to frontend
//
// REQUIRED SUPABASE SECRETS:
//
// VOYAGE_API_KEY
// GEMINI_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
//
// IMPORTANT:
// This function is designed to be evidence-first.
// It must NOT invent literary facts simply because a question
// asks for a certain number of characters, points, examples, etc.
//
// ================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ================================================================
// ENVIRONMENT
// ================================================================

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

// ================================================================
// SUPABASE CLIENT
// ================================================================

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// ================================================================
// CORS
// ================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "POST, OPTIONS",
};

// ================================================================
// CONSTANTS
// ================================================================

const GEMINI_MODEL = "gemini-3.7-flash";

// We deliberately retrieve more evidence than the old version.
// The model will still be instructed to use only relevant evidence.
const RETRIEVAL_COUNT = 16;

// Large enough for a proper KCSE essay.
// The previous code incorrectly used max_tokens.
// Gemini Interactions API uses max_output_tokens.
const MAX_OUTPUT_TOKENS = 8000;

// Maximum amount of evidence text sent from each chunk.
// This prevents one enormous chunk from overwhelming the question.
const MAX_CHUNK_CHARS = 5000;

// Maximum total evidence supplied to Gemini.
// This keeps the prompt manageable while still providing substantial
// textual grounding.
const MAX_TOTAL_EVIDENCE_CHARS = 50000;

// Number of times we are willing to retry an incomplete Gemini answer.
const MAX_GEMINI_ATTEMPTS = 2;

// ================================================================
// TYPES
// ================================================================

type BookChunk = {
  id?: string | number;
  content?: string;
  chapter_label?: string | null;
  similarity?: number;
  [key: string]: unknown;
};

// ================================================================
// UTILITY: SAFE JSON
// ================================================================

async function readJsonSafely(
  response: Response
): Promise<any> {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid JSON returned by API: ${text.slice(0, 1000)}`
    );
  }
}

// ================================================================
// UTILITY: CLEAN TEXT
// ================================================================

function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

// ================================================================
// VOYAGE EMBEDDING
// ================================================================

async function embedQuery(
  text: string
): Promise<number[]> {

  const response = await fetch(
    "https://api.voyageai.com/v1/embeddings",
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${VOYAGE_API_KEY}`,
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        input: [text],
        model: "voyage-3",
        input_type: "query",
      }),
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Voyage embedding failed (${response.status}): ${errorText}`
    );
  }

  const data =
    await readJsonSafely(response);

  const embedding =
    data?.data?.[0]?.embedding;

  if (
    !Array.isArray(embedding) ||
    embedding.length === 0
  ) {
    throw new Error(
      "Voyage returned an invalid or empty embedding."
    );
  }

  return embedding;
}

// ================================================================
// QUESTION CLASSIFICATION
// ================================================================
//
// This is deliberately simple and deterministic.
// Gemini will still perform the deeper classification.
// The purpose here is to give the model strong structural hints.
// ================================================================

function classifyQuestion(
  question: string
): {
  type: string;
  isEssay: boolean;
} {

  const q = question
    .toLowerCase()
    .trim();

  const essayIndicators = [
    "discuss",
    "examine",
    "assess",
    "evaluate",
    "to what extent",
    "how far",
    "illustrate",
    "justify",
    "do you agree",
    "show how",
    "explain how",
    "write an essay",
    "in an essay",
  ];

  const isEssay =
    essayIndicators.some(
      (phrase) => q.includes(phrase)
    );

  if (
    q.startsWith("name ") ||
    q.startsWith("list ") ||
    q.startsWith("identify ") ||
    q.includes("name at least")
  ) {
    return {
      type: "list / identification",
      isEssay: false,
    };
  }

  if (
    q.includes("character") ||
    q.includes("characters")
  ) {
    return {
      type: "character",
      isEssay,
    };
  }

  if (
    q.includes("theme") ||
    q.includes("themes")
  ) {
    return {
      type: "theme",
      isEssay,
    };
  }

  if (
    q.includes("setting") ||
    q.includes("place")
  ) {
    return {
      type: "setting",
      isEssay,
    };
  }

  if (
    q.includes("symbol") ||
    q.includes("symbolism")
  ) {
    return {
      type: "symbolism",
      isEssay,
    };
  }

  if (
    q.includes("irony") ||
    q.includes("ironic")
  ) {
    return {
      type: "irony",
      isEssay,
    };
  }

  if (
    q.includes("style") ||
    q.includes("technique") ||
    q.includes("device") ||
    q.includes("language")
  ) {
    return {
      type: "literary technique / style",
      isEssay,
    };
  }

  if (
    q.includes("passage") ||
    q.includes("excerpt")
  ) {
    return {
      type: "passage / excerpt",
      isEssay,
    };
  }

  if (
    q.includes("event") ||
    q.includes("what happened") ||
    q.includes("why did")
  ) {
    return {
      type: "plot / event",
      isEssay,
    };
  }

  return {
    type: isEssay
      ? "essay / discussion"
      : "general literature question",
    isEssay,
  };
}

// ================================================================
// SYSTEM PROMPT
// ================================================================

function buildSystemPrompt(
  bookTitle: string,
  questionType: string,
  isEssay: boolean
): string {

  return `
You are MASLAH ACADEMY AI.

You are a serious, rigorous KCSE English Literature teacher.

You are answering a question about the setbook:

"${bookTitle}"

The detected question type is:

"${questionType}"

Essay mode:

${isEssay ? "YES" : "NO"}

============================================================
MOST IMPORTANT RULE — EVIDENCE FIRST
============================================================

The supplied setbook evidence is your textual authority.

Do NOT invent literary information.

Never manufacture:

- characters
- names
- events
- quotations
- relationships
- chapters
- settings
- themes
- historical facts
- character traits
- character roles
- symbols
- scenes
- plot developments
- literary techniques
- page numbers
- textual references

just because the question appears to require them.

If the evidence does not establish something, say so.

Accuracy is more important than satisfying an arbitrary number
in the question.

For example:

If a student asks for 20 characters but the retrieved evidence
only establishes 14 characters, do NOT invent six more.

Instead state clearly:

"The supplied evidence establishes 14 characters. It does not
provide sufficient evidence to identify six additional characters,
so I will not invent them."

============================================================
SECOND MOST IMPORTANT RULE — FINISH THE ANSWER
============================================================

NEVER stop after:

- the introduction
- one body paragraph
- two body paragraphs
- a single point
- a fragment
- an unfinished sentence
- a heading without explanation
- a point without evidence
- evidence without analysis

The answer must be COMPLETE before you finish.

Before returning the answer, silently check that every required
section has actually been written.

If you start an essay, you MUST finish the essay.

If you begin a numbered list, you MUST complete the list that
the evidence supports.

If you start explaining a point, finish the explanation.

Never return a partial answer.

============================================================
KCSE ESSAY FORMAT — STRICT
============================================================

WHEN THE QUESTION IS AN ESSAY / DISCUSSION QUESTION:

The answer MUST contain exactly:

PARAGRAPH 1 — INTRODUCTION

PARAGRAPH 2 — BODY POINT 1

PARAGRAPH 3 — BODY POINT 2

PARAGRAPH 4 — BODY POINT 3

PARAGRAPH 5 — BODY POINT 4

PARAGRAPH 6 — CONCLUSION

That means:

INTRODUCTION
+
4 DISTINCT BODY PARAGRAPHS
+
CONCLUSION

= 6 complete paragraphs.

Do NOT stop after paragraph 1 or paragraph 2.

Do NOT produce only one or two body points.

Do NOT produce an essay without a conclusion.

Do NOT merge the four body paragraphs into one large paragraph.

Do NOT make the conclusion merely another body point.

============================================================
ESSAY INTRODUCTION
============================================================

The introduction must:

1. Directly address the question.
2. Establish the main argument / position.
3. Show an understanding of the literary issue.
4. Prepare the reader for the discussion.

Do not waste the introduction on unnecessary biography.

Do not invent background information.

============================================================
ESSAY BODY — FOUR DISTINCT PARAGRAPHS
============================================================

There MUST be FOUR separate body paragraphs.

Each body paragraph should normally contain:

POINT
+
TEXTUAL EVIDENCE
+
EXPLANATION / ANALYSIS
+
LINK TO THE QUESTION

A strong body paragraph should answer:

What is the point?

What evidence supports it?

What does the evidence reveal?

Why is that important?

How does it answer the question?

The four paragraphs must contain DISTINCT arguments.

Do not repeat the same point four times.

============================================================
ESSAY CONCLUSION
============================================================

The sixth paragraph MUST be a conclusion.

The conclusion should:

- bring the argument together
- directly answer the question
- reinforce the central interpretation
- avoid introducing a completely new argument

Do not end abruptly.

Do not end immediately after the fourth body paragraph.

============================================================
IF THE EVIDENCE DOES NOT SUPPORT FOUR BODY POINTS
============================================================

Do NOT invent evidence.

Instead, use the strongest distinct points actually supported
by the evidence.

If fewer than four genuinely distinct points can be supported,
you may explain the limitation honestly.

However, NEVER manufacture literary facts simply to make the
essay appear complete.

============================================================
ESSAY QUALITY
============================================================

The essay must sound like a strong KCSE Literature response.

Use:

- clear argument
- relevant evidence
- explanation
- interpretation
- literary analysis
- logical transitions
- formal English

Avoid:

- vague statements
- empty motivational language
- unnecessary repetition
- generic AI language
- excessive apologies
- fake quotations
- invented references
- padding
- rambling

Prefer analytical language such as:

"This reveals..."
"This demonstrates..."
"This highlights..."
"This suggests..."
"This exposes..."
"This reinforces..."
"The writer uses..."
"This is significant because..."
"Through this character..."
"Through this event..."

But do not mechanically repeat the same phrase.

============================================================
QUESTION-SPECIFIC STRUCTURE
============================================================

If the question is NOT an essay question:

DO NOT force it into a six-paragraph essay.

Instead match the structure to the task.

------------------------------------------------------------
CHARACTER QUESTIONS
------------------------------------------------------------

Identify the correct character.

Give the relevant trait, role, action or relationship.

Support it with evidence.

Explain what the evidence reveals.

Connect it to the question.

Do not confuse:

- a named character
- an unnamed person
- a historical figure
- a social group
- a character role
- a political institution

Do not count the same character twice under different descriptions.

------------------------------------------------------------
THEME QUESTIONS
------------------------------------------------------------

Do not merely define the theme.

Show how the theme is developed through:

- characters
- events
- conflict
- setting
- symbolism
- language
- irony
- other relevant techniques

Use:

POINT → EVIDENCE → EXPLANATION → SIGNIFICANCE

------------------------------------------------------------
LIST / NAME / IDENTIFY QUESTIONS
------------------------------------------------------------

Give a clean numbered list.

For every item:

NAME — brief identification.

Do not pad the list with guesses.

If the evidence supports fewer items than requested, say so.

------------------------------------------------------------
PASSAGE / EXCERPT QUESTIONS
------------------------------------------------------------

Focus first on what the supplied passage establishes.

Analyse relevant:

- characters
- language
- actions
- emotions
- conflict
- techniques
- themes

Only connect it to the wider novel where the supplied evidence
supports the connection.

Do not invent surrounding events.

------------------------------------------------------------
PLOT / EVENT QUESTIONS
------------------------------------------------------------

Explain what happened in the correct sequence where the evidence
allows.

Explain why the event matters.

Do not invent missing stages of the plot.

------------------------------------------------------------
SYMBOLISM / IRONY / TECHNIQUE
------------------------------------------------------------

Identify the technique only when the evidence supports it.

Explain:

WHAT
+
HOW
+
WHY

Do not label ordinary details as symbols or techniques without
evidence.

============================================================
CHARACTER COUNTING RULE
============================================================

If the question asks for a number of characters:

Count only actual identifiable fictional characters supported
by the evidence.

Do NOT count:

- historical figures
- groups
- institutions
- unnamed people
- character descriptions as separate people
- the same person twice
- roles such as "the president" as additional characters
  when the actual character is already identified

============================================================
HISTORICAL FIGURES
============================================================

If historical figures appear in the evidence, distinguish them
clearly from fictional characters.

Do not automatically count historical references as novel
characters.

============================================================
QUOTATIONS
============================================================

Never invent quotations.

If the evidence does not contain an exact quotation, paraphrase
the evidence rather than putting invented words inside quotation
marks.

============================================================
CHAPTERS AND PAGES
============================================================

Never invent chapter numbers or page numbers.

Use a chapter/page reference only if it appears in the supplied
evidence.

============================================================
SOURCE LIMITATIONS
============================================================

The retrieved evidence may not contain every part of the novel.

Therefore:

Do NOT assume that absence from the retrieved evidence means the
fact does not exist in the complete novel.

Instead say:

"The supplied evidence does not establish this."

This distinction is extremely important.

============================================================
ANSWER LENGTH
============================================================

Give enough detail to answer properly.

For ordinary short questions:
Be concise but complete.

For analytical questions:
Give developed explanations.

For essay questions:
Produce the complete six-paragraph structure.

Do NOT deliberately shorten the answer to one or two paragraphs.

Do NOT sacrifice completion for brevity.

============================================================
FINAL INTERNAL QUALITY CHECK
============================================================

Before sending the answer, silently check ALL of the following:

1. Did I answer the exact question?
2. Did I use only the supplied evidence?
3. Did I invent anything?
4. Did I accidentally invent a quotation?
5. Did I accidentally invent a character?
6. Did I confuse a character with a role or group?
7. Did I repeat a character?
8. Did I repeat the same argument?
9. Is every sentence complete?
10. Is every paragraph complete?
11. Is every explanation finished?
12. If this is an essay, are there exactly 6 paragraphs?
13. If this is an essay, is paragraph 1 the introduction?
14. If this is an essay, are paragraphs 2–5 four DISTINCT body paragraphs?
15. If this is an essay, is paragraph 6 a conclusion?
16. Does the conclusion actually conclude?
17. Did I stop because I genuinely finished, rather than because
    I simply ran out of space?
18. Is the English appropriate for KCSE?
19. Is the answer analytical rather than merely descriptive?
20. If evidence is insufficient, did I clearly say so?

ONLY AFTER PASSING THIS CHECK should you return the answer.

============================================================
FINAL INSTRUCTION
============================================================

COMPLETE THE ANSWER.

DO NOT RETURN A PARTIAL ANSWER.

DO NOT STOP MID-PARAGRAPH.

DO NOT STOP AFTER THE FIRST OR SECOND BODY POINT.

DO NOT OMIT THE CONCLUSION IN AN ESSAY.

DO NOT INVENT INFORMATION TO MAKE THE ANSWER LOOK COMPLETE.

Accuracy + evidence + structure + completion are all required.
`;
}

// ================================================================
// EVIDENCE PREPARATION
// ================================================================

function prepareEvidence(
  chunks: BookChunk[]
): BookChunk[] {

  const prepared: BookChunk[] = [];

  let totalChars = 0;

  for (const chunk of chunks) {

    if (
      !chunk ||
      typeof chunk.content !== "string"
    ) {
      continue;
    }

    const content =
      cleanText(chunk.content);

    if (!content) {
      continue;
    }

    if (
      totalChars >=
      MAX_TOTAL_EVIDENCE_CHARS
    ) {
      break;
    }

    const remaining =
      MAX_TOTAL_EVIDENCE_CHARS -
      totalChars;

    const allowedLength =
      Math.min(
        MAX_CHUNK_CHARS,
        remaining
      );

    const trimmedContent =
      content.slice(0, allowedLength);

    prepared.push({
      ...chunk,
      content: trimmedContent,
    });

    totalChars +=
      trimmedContent.length;
  }

  return prepared;
}

// ================================================================
// BUILD USER PROMPT
// ================================================================

function buildUserPrompt(
  question: string,
  chunks: BookChunk[],
  bookTitle: string,
  questionType: string,
  isEssay: boolean
): string {

  const evidenceBlock =
    chunks
      .map((chunk, index) => {

        const chapter =
          chunk.chapter_label
            ? ` — ${chunk.chapter_label}`
            : "";

        return `
[EVIDENCE ${index + 1}${chapter}]

${chunk.content}
`;
      })
      .join("\n");

  const essayInstruction = isEssay
    ? `
IMPORTANT ESSAY REQUIREMENT:

This is an essay/discussion question.

Your final answer MUST be:

Paragraph 1: Introduction
Paragraph 2: Body Point 1
Paragraph 3: Body Point 2
Paragraph 4: Body Point 3
Paragraph 5: Body Point 4
Paragraph 6: Conclusion

Do not stop after paragraph 1 or 2.

Write all four body paragraphs and the conclusion before ending.
`
    : `
This is not necessarily a six-paragraph essay.

Use the structure appropriate to the question.
`;

  return `
============================================================
SETBOOK
============================================================

${bookTitle}

============================================================
QUESTION TYPE
============================================================

${questionType}

============================================================
STUDENT QUESTION
============================================================

${question}

============================================================
RELEVANT SETBOOK EVIDENCE
============================================================

${evidenceBlock}

============================================================
TASK
============================================================

Answer the student's question as a strong KCSE English Literature
teacher.

Use the evidence above as your textual authority.

Do not invent facts.

Do not invent quotations.

Do not invent characters.

Do not invent chapter or page references.

Do not treat historical figures, groups or character roles as
fictional characters unless the evidence clearly establishes them
as such.

${essayInstruction}

Your answer must be COMPLETE.

Before finishing, silently check that no paragraph, sentence,
argument or explanation has been left incomplete.

Do not discuss your internal reasoning.

Return ONLY the final student-facing answer.
`;
}

// ================================================================
// EXTRACT GEMINI TEXT
// ================================================================
//
// The current Interactions API exposes output_text.
// We use that first.
//
// We retain a steps fallback because complex responses may contain
// text blocks inside steps.
// ================================================================

function extractGeminiText(
  data: any
): string {

  if (
    typeof data?.output_text === "string" &&
    data.output_text.trim()
  ) {
    return cleanText(
      data.output_text
    );
  }

  const textParts: string[] = [];

  if (Array.isArray(data?.steps)) {

    for (const step of data.steps) {

      if (
        step?.type !== "model_output"
      ) {
        continue;
      }

      if (
        !Array.isArray(step.content)
      ) {
        continue;
      }

      for (
        const content of step.content
      ) {

        if (
          content?.type === "text" &&
          typeof content.text ===
            "string"
        ) {
          textParts.push(
            content.text
          );
        }
      }
    }
  }

  return cleanText(
    textParts.join("\n")
  );
}

// ================================================================
// DETECT POSSIBLY INCOMPLETE ANSWERS
// ================================================================
//
// This is deliberately conservative.
//
// We do NOT reject every short answer.
// A short factual question can legitimately have a short answer.
//
// For essay mode, however, we require strong structural completion.
// ================================================================

function appearsIncomplete(
  answer: string,
  isEssay: boolean
): boolean {

  const text =
    cleanText(answer);

  if (!text) {
    return true;
  }

  // Obvious sentence-level truncation.
  const lastChar =
    text[text.length - 1];

  if (
    lastChar === "," ||
    lastChar === ":" ||
    lastChar === ";" ||
    lastChar === "—"
  ) {
    return true;
  }

  // Unclosed parentheses / quotation marks can indicate truncation.
  const openParen =
    (text.match(/\(/g) || []).length;

  const closeParen =
    (text.match(/\)/g) || []).length;

  if (openParen > closeParen) {
    return true;
  }

  // Essay-specific checks.
  if (isEssay) {

    const paragraphs =
      text
        .split(/\n\s*\n/)
        .map(cleanText)
        .filter(Boolean);

    // We expect six developed paragraphs.
    if (paragraphs.length < 6) {
      return true;
    }

    // Look for a conclusion-like final paragraph.
    const finalParagraph =
      paragraphs[
        paragraphs.length - 1
      ].toLowerCase();

    const conclusionSignals = [
      "in conclusion",
      "to conclude",
      "in summary",
      "therefore",
      "ultimately",
      "thus",
      "in the final analysis",
      "it is evident",
      "it can therefore be seen",
    ];

    const hasConclusionSignal =
      conclusionSignals.some(
        (signal) =>
          finalParagraph.includes(
            signal
          )
      );

    // If the last paragraph is substantial but contains no
    // conclusion signal, it may still be a conclusion. We therefore
    // do not reject solely on this basis.
    //
    // However, if the last paragraph is extremely short, it is almost
    // certainly not a developed conclusion.
    if (
      !hasConclusionSignal &&
      finalParagraph.length < 80
    ) {
      return true;
    }

    // A proper essay should have a substantial body.
    const bodyParagraphs =
      paragraphs.slice(1, 5);

    const weakBodyCount =
      bodyParagraphs.filter(
        (p) => p.length < 100
      ).length;

    if (weakBodyCount >= 2) {
      return true;
    }
  }

  return false;
}

// ================================================================
// GEMINI REQUEST
// ================================================================

async function requestGemini(
  systemPrompt: string,
  userPrompt: string
): Promise<{
  answer: string;
  status: string | null;
  raw: any;
}> {

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",

      headers: {
        "x-goog-api-key":
          GEMINI_API_KEY!,
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        model: GEMINI_MODEL,

        system_instruction:
          systemPrompt,

        input:
          userPrompt,

        generation_config: {
          // IMPORTANT:
          // Gemini Interactions API uses max_output_tokens,
          // not max_tokens.
          max_output_tokens:
            MAX_OUTPUT_TOKENS,

          // Gemini 3 documentation recommends using the model's
          // default temperature rather than forcing a very low
          // temperature.
          thinking_level: "medium",
        },

        // We want a normal completed response rather than a stream
        // because this Edge Function returns one final JSON object.
        stream: false,
      }),
    }
  );

  const data =
    await readJsonSafely(response);

  if (!response.ok) {

    const apiMessage =
      data?.error?.message ||
      JSON.stringify(data);

    throw new Error(
      `Gemini API failed (${response.status}): ${apiMessage}`
    );
  }

  const answer =
    extractGeminiText(data);

  const status =
    typeof data?.status === "string"
      ? data.status
      : null;

  return {
    answer,
    status,
    raw: data,
  };
}

// ================================================================
// GEMINI FINAL ANSWER
// ================================================================
//
// This function can make a second attempt if the first response
// is incomplete.
//
// The second attempt is NOT asking Gemini to invent anything.
// It is specifically asking it to finish the response while
// preserving the evidence restrictions.
// ================================================================

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  isEssay: boolean
): Promise<string> {

  let lastAnswer = "";

  for (
    let attempt = 1;
    attempt <= MAX_GEMINI_ATTEMPTS;
    attempt++
  ) {

    let currentPrompt =
      userPrompt;

    if (
      attempt > 1 &&
      lastAnswer
    ) {

      currentPrompt = `
${userPrompt}

============================================================
COMPLETION REPAIR — ATTEMPT ${attempt}
============================================================

The previous generation was incomplete.

Previous generation:

${lastAnswer}

DO NOT START A NEW UNRELATED ANSWER.

Continue / repair the answer so that the FINAL RESPONSE is
complete.

IMPORTANT:

- Preserve the evidence discipline.
- Do not invent literary facts.
- Do not invent quotations.
- Do not repeat the same points unnecessarily.
- Do not leave sentences unfinished.

${
  isEssay
    ? `
For this essay, the final answer MUST contain:

1. Introduction
2. Body paragraph 1
3. Body paragraph 2
4. Body paragraph 3
5. Body paragraph 4
6. Conclusion

All six paragraphs must be complete.
`
    : ""
}

Return the COMPLETE final answer, not a commentary about what was
missing.
`;
    }

    const result =
      await requestGemini(
        systemPrompt,
        currentPrompt
      );

    lastAnswer =
      cleanText(result.answer);

    const incompleteByStatus =
      result.status ===
      "incomplete";

    const incompleteByContent =
      appearsIncomplete(
        lastAnswer,
        isEssay
      );

    if (
      lastAnswer &&
      !incompleteByStatus &&
      !incompleteByContent
    ) {
      return lastAnswer;
    }

    // If Gemini returned an empty answer, retry.
    if (!lastAnswer) {
      continue;
    }
  }

  // If the API gave us something after all attempts, return it
  // rather than hiding the response completely.
  if (lastAnswer) {
    return lastAnswer;
  }

  throw new Error(
    "Gemini failed to produce a complete text answer."
  );
}

// ================================================================
// EVIDENCE OUTPUT
// ================================================================

function buildEvidenceResponse(
  chunks: BookChunk[]
) {

  return chunks.map(
    (chunk) => {

      const content =
        typeof chunk.content ===
          "string"
          ? cleanText(chunk.content)
          : "";

      return {
        id:
          chunk.id ?? null,

        chapter:
          chunk.chapter_label ??
          null,

        excerpt:
          content.length > 500
            ? content.slice(0, 500) +
              "…"
            : content,
      };
    }
  );
}

// ================================================================
// MAIN EDGE FUNCTION
// ================================================================

Deno.serve(
  async (req: Request) => {

    // ------------------------------------------------------------
    // CORS
    // ------------------------------------------------------------

    if (
      req.method === "OPTIONS"
    ) {
      return new Response(
        "ok",
        {
          headers:
            corsHeaders,
        }
      );
    }

    // Only POST is accepted.
    if (
      req.method !== "POST"
    ) {
      return new Response(
        JSON.stringify({
          error:
            "Method not allowed. Use POST.",
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

      // ----------------------------------------------------------
      // 1. READ REQUEST
      // ----------------------------------------------------------

      const body =
        await req.json();

      const question =
        typeof body?.question ===
          "string"
          ? cleanText(
              body.question
            )
          : "";

      const bookTitle =
        typeof body?.bookTitle ===
          "string"
          ? cleanText(
              body.bookTitle
            )
          : "";

      // ----------------------------------------------------------
      // 2. VALIDATE QUESTION
      // ----------------------------------------------------------

      if (!question) {

        return new Response(
          JSON.stringify({
            error:
              "Missing 'question' string.",
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

      // ----------------------------------------------------------
      // 3. DETERMINE QUESTION TYPE
      // ----------------------------------------------------------

      const classification =
        classifyQuestion(
          question
        );

      // ----------------------------------------------------------
      // 4. EMBED QUESTION
      // ----------------------------------------------------------

      const queryEmbedding =
        await embedQuery(
          question
        );

      // ----------------------------------------------------------
      // 5. RETRIEVE SETBOOK EVIDENCE
      // ----------------------------------------------------------

      const {
        data: retrievedChunks,
        error: matchError,
      } = await supabase.rpc(
        "match_book_chunks",
        {
          query_embedding:
            queryEmbedding,

          match_book_title:
            bookTitle || null,

          match_count:
            RETRIEVAL_COUNT,
        }
      );

      if (matchError) {
        throw new Error(
          `Evidence retrieval failed: ${matchError.message}`
        );
      }

      if (
        !retrievedChunks ||
        !Array.isArray(
          retrievedChunks
        ) ||
        retrievedChunks.length === 0
      ) {

        return new Response(
          JSON.stringify({
            error:
              "No matching evidence was found for this question. Check the selected setbook or try rephrasing the question.",
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

      // ----------------------------------------------------------
      // 6. PREPARE EVIDENCE
      // ----------------------------------------------------------

      const chunks =
        prepareEvidence(
          retrievedChunks as BookChunk[]
        );

      if (
        chunks.length === 0
      ) {

        return new Response(
          JSON.stringify({
            error:
              "Relevant evidence was retrieved, but it contained no usable text.",
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

      // ----------------------------------------------------------
      // 7. BUILD PROMPTS
      // ----------------------------------------------------------

      const systemPrompt =
        buildSystemPrompt(
          bookTitle ||
            "the selected setbook",
          classification.type,
          classification.isEssay
        );

      const userPrompt =
        buildUserPrompt(
          question,
          chunks,
          bookTitle ||
            "the selected setbook",
          classification.type,
          classification.isEssay
        );

      // ----------------------------------------------------------
      // 8. ASK GEMINI
      // ----------------------------------------------------------

      const answer =
        await callGemini(
          systemPrompt,
          userPrompt,
          classification.isEssay
        );

      // ----------------------------------------------------------
      // 9. FINAL SAFETY CHECK
      // ----------------------------------------------------------

      const finalAnswer =
        cleanText(answer);

      if (!finalAnswer) {
        throw new Error(
          "Gemini returned an empty final answer."
        );
      }

      // ----------------------------------------------------------
      // 10. LOG QUESTION
      // ----------------------------------------------------------
      //
      // Logging should NEVER prevent the student from receiving
      // the answer.
      //
      // Therefore this is intentionally non-blocking.
      // ----------------------------------------------------------

      try {

        await supabase
          .from("question_log")
          .insert({
            book_title:
              bookTitle || null,

            question,

            answer:
              finalAnswer,

            retrieved_chunk_ids:
              chunks.map(
                (chunk) =>
                  chunk.id
              ),
          });

      } catch (logError) {

        console.error(
          "Question logging failed:",
          logError
        );
      }

      // ----------------------------------------------------------
      // 11. RETURN FINAL RESPONSE
      // ----------------------------------------------------------

      return new Response(
        JSON.stringify({
          answer:
            finalAnswer,

          questionType:
            classification.type,

          isEssay:
            classification.isEssay,

          evidenceUsed:
            buildEvidenceResponse(
              chunks
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

    } catch (error) {

      // ----------------------------------------------------------
      // GLOBAL ERROR HANDLER
      // ----------------------------------------------------------

      console.error(
        "MASLAH ACADEMY ASK QUESTION ERROR:",
        error
      );

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      return new Response(
        JSON.stringify({
          error:
            message ||
            "An unexpected error occurred while generating the answer.",
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
  }
);
