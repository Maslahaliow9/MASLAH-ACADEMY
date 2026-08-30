// ================================================================
// MASLAH ACADEMY AI
// ASK-QUESTION EDGE FUNCTION
// ================================================================
//
// Pipeline:
//
// STUDENT QUESTION
//        ↓
// GEMINI EMBEDDING (gemini-embedding-001)
//        ↓
// SUPABASE VECTOR SEARCH
//        ↓
// RELEVANT SETBOOK EVIDENCE
//        ↓
// GEMINI 3.7 FLASH (Interactions API)
//        ↓
// QUESTION-SPECIFIC KCSE RESPONSE
//
// IMPORTANT:
//
// This function is deliberately strict.
//
// The supplied setbook evidence is the authority.
// Gemini must NOT invent literary facts.
//
// Essay requests have a completely separate,
// rigid KCSE structure:
//
// INTRODUCTION
// BODY 1
// BODY 2
// BODY 3
// BODY 4
// CONCLUSION
//
// Exactly four body paragraphs.
//
// ================================================================
//
// REQUIRED SUPABASE SECRETS:
//
// GEMINI_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
//
// (Note: embeddings use Gemini, matching how the book was
// ingested. Do not switch this back to Voyage without also
// re-ingesting the book — the two embedding spaces are
// incompatible and mixing them breaks vector search.)
//
// ================================================================

import { createClient } from "npm:@supabase/supabase-js@2";


// ================================================================
// ENVIRONMENT
// ================================================================

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get(
  "SUPABASE_SERVICE_ROLE_KEY"
);


// ================================================================
// VALIDATE REQUIRED SECRETS
// ================================================================

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

const EMBEDDING_MODEL = "gemini-embedding-001";

const EMBEDDING_DIMENSIONS = 768;

const GEMINI_MAX_OUTPUT_TOKENS = 4000;

const GEMINI_THINKING_LEVEL = "low";

const RETRY_LIMIT = 4;

const RETRIEVAL_COUNT = 16;


// ================================================================
// BOOK TITLE NORMALISATION
// ================================================================

function normalizeBookTitle(
  bookTitle: unknown
): string | null {

  if (
    typeof bookTitle !== "string" ||
    !bookTitle.trim()
  ) {
    return null;
  }

  const cleaned = bookTitle
    .trim()
    .replace(/\s+/g, " ");

  const lower = cleaned.toLowerCase();

  if (
    lower === "fathers of nations" ||
    lower === "fathers of nation"
  ) {
    return "Fathers of Nations";
  }

  if (
    lower === "the samaritan" ||
    lower === "samaritan"
  ) {
    return "The Samaritan";
  }

  return cleaned;
}


// ================================================================
// QUESTION CLEANING
// ================================================================

function cleanQuestion(
  question: string
): string {

  return question
    .trim()
    .replace(/\s+/g, " ");
}


// ================================================================
// DETECT ESSAY REQUESTS
// ================================================================

function isEssayRequest(
  question: string
): boolean {

  const q = question
    .toLowerCase()
    .trim();

  const essayPatterns = [
    /\bessay\b/,
    /\bessays\b/,
    /\bin essay form\b/,
    /\bin essay format\b/,
    /\bwrite an essay\b/,
    /\bwrite the essay\b/,
    /\banswer as an essay\b/,
    /\banswer in essay form\b/,
    /\bessay answer\b/,
    /\bessay format\b/,
    /\bfull essay\b/,
    /\bkcse essay\b/,
    /\bcomposition\b/,
  ];

  return essayPatterns.some(
    (pattern) => pattern.test(q)
  );
}


// ================================================================
// QUESTION TYPE DETECTION
// ================================================================

function detectQuestionType(
  question: string
): string {

  const q = question.toLowerCase();

  if (isEssayRequest(question)) {
    return "essay";
  }

  if (
    /\bname\b/.test(q) ||
    /\blist\b/.test(q) ||
    /\bidentify\b/.test(q) ||
    /\bmention\b/.test(q) ||
    /\bgive\b/.test(q)
  ) {
    return "list_or_identification";
  }

  if (
    /\btheme\b/.test(q) ||
    /\bthemes\b/.test(q)
  ) {
    return "theme";
  }

  if (
    /\bcharacter\b/.test(q) ||
    /\bcharacters\b/.test(q)
  ) {
    return "character";
  }

  if (
    /\bsetting\b/.test(q)
  ) {
    return "setting";
  }

  if (
    /\bsymbol\b/.test(q) ||
    /\bsymbolism\b/.test(q)
  ) {
    return "symbolism";
  }

  if (
    /\birony\b/.test(q)
  ) {
    return "irony";
  }

  if (
    /\bstyle\b/.test(q) ||
    /\btechnique\b/.test(q) ||
    /\btechniques\b/.test(q) ||
    /\bdevice\b/.test(q) ||
    /\bdevices\b/.test(q)
  ) {
    return "style_or_technique";
  }

  if (
    /\bpassage\b/.test(q) ||
    /\bexcerpt\b/.test(q)
  ) {
    return "passage";
  }

  if (
    /\bcompare\b/.test(q) ||
    /\bcomparison\b/.test(q) ||
    /\bcontrast\b/.test(q)
  ) {
    return "comparison";
  }

  if (
    /\bdiscuss\b/.test(q)
  ) {
    return "discussion";
  }

  if (
    /\bexplain\b/.test(q)
  ) {
    return "explanation";
  }

  if (
    /\banalyse\b/.test(q) ||
    /\banalyze\b/.test(q)
  ) {
    return "analysis";
  }

  return "general_literature_question";
}


// ================================================================
// GEMINI EMBEDDING
// ================================================================
//
// IMPORTANT: This MUST use the same model and dimensionality
// that was used when the book was ingested (gemini-embedding-001,
// 768 dimensions) — mixing embedding providers/sizes produces a
// vector dimension mismatch error against the database, or
// silently meaningless similarity scores if sizes happen to
// coincide.
//
// ================================================================

async function embedQuery(
  text: string
): Promise<number[]> {

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    }
  );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Gemini embedding failed: ${errorText}`
    );
  }

  const data =
    await response.json();

  const embedding =
    data?.embedding?.values;

  if (
    !Array.isArray(embedding) ||
    embedding.length === 0
  ) {
    throw new Error(
      "Gemini returned an invalid or empty embedding."
    );
  }

  return embedding;
}


// ================================================================
// RETRIEVE EVIDENCE
// ================================================================

async function retrieveEvidence(
  question: string,
  bookTitle: string | null
): Promise<any[]> {

  const queryEmbedding =
    await embedQuery(question);

  const {
    data,
    error,
  } = await supabase.rpc(
    "match_book_chunks",
    {
      query_embedding:
        queryEmbedding,

      match_book_title:
        bookTitle,

      match_count:
        RETRIEVAL_COUNT,
    }
  );

  if (error) {
    throw error;
  }

  if (
    !data ||
    !Array.isArray(data) ||
    data.length === 0
  ) {
    return [];
  }

  return data;
}


// ================================================================
// REMOVE DUPLICATE EVIDENCE
// ================================================================

function deduplicateChunks(
  chunks: any[]
): any[] {

  const seen =
    new Set<string>();

  const result: any[] = [];

  for (const chunk of chunks) {

    if (
      !chunk ||
      typeof chunk.content !== "string"
    ) {
      continue;
    }

    const key =
      chunk.content
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();

    if (!key) {
      continue;
    }

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    result.push(chunk);
  }

  return result;
}


// ================================================================
// BUILD EVIDENCE BLOCK
// ================================================================

function buildEvidenceBlock(
  chunks: any[]
): string {

  return chunks
    .map(
      (chunk, index) => {

        const chapter =
          chunk.chapter_label
            ? ` — ${chunk.chapter_label}`
            : "";

        const content =
          typeof chunk.content === "string"
            ? chunk.content.trim()
            : "";

        return (
          `[Evidence ${index + 1}${chapter}]\n` +
          content
        );
      }
    )
    .join("\n\n");
}


// ================================================================
// MASTER SYSTEM PROMPT
// ================================================================

function buildSystemPrompt(
  bookTitle: string
): string {

  return `
You are MASLAH ACADEMY AI.

You are a highly rigorous KCSE English Literature teacher.

You are answering a question about the setbook:

"${bookTitle}"

Your task is to produce accurate, evidence-based,
KCSE-quality literature answers.

============================================================
ABSOLUTE RULE 0 — PLAIN TEXT ONLY, NO MARKDOWN
============================================================

Your answer is displayed to the student as plain text.
It is NOT rendered as markdown.

You MUST NOT use:

- asterisks for bold or italics (**like this** or *like this*)
- markdown headers (## like this)
- backticks
- markdown bullet symbols (- or *)

If you want to emphasise a word, simply write it plainly —
do not wrap it in symbols.

If you need a list, write it as a plain numbered list using
"1.", "2.", "3." followed by a space — nothing else.

If you need section labels (for example in an essay), write
them as plain capitalised words on their own line, with no
symbols before or after them.

============================================================
ABSOLUTE RULE 1 — THE SUPPLIED EVIDENCE IS THE AUTHORITY
============================================================

The supplied setbook evidence is the textual authority
for your answer.

You MUST NOT manufacture literary information.

Never invent:

- characters
- character names
- character relationships
- events
- scenes
- quotations
- chapter numbers
- page numbers
- settings
- themes
- symbols
- historical facts
- character roles
- plot developments
- authorial intentions
- literary techniques
- conversations
- actions
- motivations
- consequences

unless the supplied evidence establishes them.

Your general knowledge must NEVER override the supplied
evidence.

If the evidence does not establish something, say so plainly
and briefly, in one sentence, then continue with what the
evidence does support. That is better than guessing.

============================================================
ABSOLUTE RULE 2 — NEVER PAD AN ANSWER, AND NEVER OVER-EXPLAIN
============================================================

Do not add invented material simply because the question
asks for a particular number of points or characters.

For example:

If the question asks for 20 characters but the evidence
only establishes 14 characters, give the 14 you can support,
then add one short closing sentence noting that the supplied
material does not establish more than that — do not write a
long explanation of your counting method, do not use
asterisks or bold to flag this, and do not repeat the
disclaimer more than once.

Do not count the same character twice because the character
has two roles.

Do not count:

- a group as a character
- a historical person as a fictional character
- a role as a character
- an unnamed person as a named character
- the same character under two descriptions

============================================================
ABSOLUTE RULE 3 — ANSWER THE ACTUAL QUESTION
============================================================

Before producing the answer, silently determine:

1. What is the command word?
2. What exactly is being asked?
3. What literary issue is being tested?
4. Which evidence is relevant?
5. What structure best answers the question?

Do not answer a different question.

Do not turn every question into an essay.

Do not give a character list when the question asks for
analysis.

Do not give a theme definition when the question asks
for significance.

Do not give plot summary when the question asks for
analysis.

============================================================
KCSE LITERATURE QUALITY
============================================================

Use formal, clear, analytical English.

Strong literary analysis normally follows:

POINT
→ EVIDENCE
→ EXPLANATION
→ SIGNIFICANCE

Use analytical expressions naturally, including:

"This reveals..."
"This suggests..."
"This demonstrates..."
"This highlights..."
"This exposes..."
"This reinforces..."
"This illustrates..."
"This is significant because..."
"The writer uses..."
"This reflects..."
"This shows that..."

Do not repeatedly use the same phrase.

Do not produce empty analysis.

Do not simply retell the story.

============================================================
CHARACTER QUESTIONS
============================================================

When the question concerns a character:

1. Identify the correct character.
2. Give the relevant trait, role, action or relationship.
3. Support it using supplied evidence.
4. Explain what the evidence reveals.
5. Link the explanation to the question.

Do not confuse a character with a group,
historical figure or character role.

============================================================
THEME QUESTIONS
============================================================

When the question concerns a theme:

Do not merely define the theme.

Show how the theme is developed through relevant:

- characters
- actions
- conflicts
- events
- relationships
- setting
- symbolism
- irony
- language
- other literary techniques

Every major claim must be supported by the supplied evidence.

============================================================
DISCUSSION QUESTIONS
============================================================

For "Discuss..." questions:

The response must directly discuss the proposition.

Develop distinct points.

Avoid repeating one idea using different words.

Each point should contain:

POINT
EVIDENCE
EXPLANATION
LINK TO QUESTION

============================================================
LIST / NAME / IDENTIFY QUESTIONS
============================================================

For list questions:

Use a plain numbered list ("1.", "2.", "3." — no symbols).

Each item should contain:

NAME — brief accurate identification.

Do not write an unnecessary essay.

Do not invent missing items.

If the requested number exceeds the evidence available,
state the limitation briefly in one closing sentence, without
dwelling on it.

============================================================
PASSAGE / EXCERPT QUESTIONS
============================================================

When a passage or excerpt is supplied:

Prioritise what the passage actually establishes.

Analyse:

- character
- language
- conflict
- tone
- irony
- symbolism
- setting
- themes
- literary techniques

only when supported by the evidence.

Do not invent events immediately before or after the passage.

============================================================
GENERAL ANSWER QUALITY
============================================================

Never begin every response with:

"Based on the provided evidence..."

Vary the opening naturally — start with the actual answer.

Do not apologise unnecessarily.

Do not narrate your own process (for example, do not write
things like "Note: the provided text explicitly identifies…").
Just answer, the way a teacher would when speaking directly
to a student.

Do not use fake quotations.

Do not put quotation marks around paraphrases.

Do not create page numbers.

Do not claim that a passage says something when it does not.

Do not use information merely because it sounds plausible.

============================================================
ESSAY MODE
============================================================

If the student requests an ESSAY, you MUST follow the
special essay format supplied in the user instructions.

The final essay MUST contain exactly:

Introduction

Body 1

Body 2

Body 3

Body 4

Conclusion

There must be EXACTLY FOUR body paragraphs.

No fifth body paragraph.

No sixth body paragraph.

No bullet points.

No numbered arguments inside the essay.

No extra "Analysis" section.

No "Evidence used" section inside the essay.

No "Key points" section.

No "Summary" section.

No additional conclusion.

No second introduction.

The four body paragraphs must be four DISTINCT arguments.

Each body paragraph must develop ONE MAIN POINT ONLY.

The structure of each body paragraph should naturally be:

POINT
+
TEXTUAL EVIDENCE
+
EXPLANATION
+
SIGNIFICANCE / LINK TO QUESTION

Do not cram several unrelated points into one body paragraph.

Do not split one point into multiple artificial points.

============================================================
ESSAY INTRODUCTION
============================================================

The introduction should:

- directly address the question
- establish the central argument
- briefly introduce the relevant literary issue
- show the direction of the essay

Do not make the introduction unnecessarily long.

Do not provide body points in list form.

============================================================
ESSAY BODY 1
============================================================

Body 1 must contain one strong argument.

It must:

- state one clear point
- support the point with evidence
- analyse the evidence
- explain its significance
- connect the paragraph to the question

============================================================
ESSAY BODY 2
============================================================

Body 2 must contain one DIFFERENT strong argument.

It must not simply repeat Body 1.

Use relevant evidence.

Analyse rather than summarise.

============================================================
ESSAY BODY 3
============================================================

Body 3 must contain one DIFFERENT strong argument.

It must not repeat Body 1 or Body 2.

Use relevant evidence.

Explain how the evidence answers the question.

============================================================
ESSAY BODY 4
============================================================

Body 4 must contain one DIFFERENT strong argument.

It must not repeat the previous body paragraphs.

Use relevant evidence.

End the paragraph by connecting the argument to the
question.

============================================================
ESSAY CONCLUSION
============================================================

The conclusion MUST be separate from the four body
paragraphs.

It should:

- summarise the central argument
- reinforce the main interpretation
- directly answer the question

Do not introduce a completely new argument.

============================================================
ESSAY LENGTH
============================================================

The essay should be complete but not unnecessarily bloated.

Aim approximately for:

Introduction:
80–130 words.

Each body paragraph:
120–190 words.

Conclusion:
60–100 words.

These are targets, not rigid mathematical limits.

Completeness and evidence are more important than word count.

============================================================
ESSAY EVIDENCE LIMITATION
============================================================

If the evidence does not support enough distinct arguments,
DO NOT invent arguments.

Instead, use only what can legitimately be established.

If one required aspect cannot be established, clearly say so
within the appropriate paragraph rather than manufacturing
literary facts.

============================================================
FINAL INTERNAL QUALITY CHECK
============================================================

Before returning an answer, silently verify:

1. Did I answer the exact question?
2. Did I use the correct setbook?
3. Did I rely on supplied evidence?
4. Did I invent anything?
5. Did I invent quotations?
6. Did I invent chapters?
7. Did I invent characters?
8. Did I confuse characters and roles?
9. Did I repeat a character?
10. Did I analyse rather than merely summarise?
11. Is the response complete?
12. Did the answer stop prematurely?
13. Is the structure appropriate?
14. If this is an essay, are there exactly four body
    paragraphs?
15. Does the essay have an introduction?
16. Does the essay have a separate conclusion?
17. Does every body paragraph contain one main point?
18. Does every body paragraph contain explanation?
19. Does the conclusion avoid introducing a new argument?
20. Is the English suitable for KCSE?
21. Does the answer contain any markdown symbols (asterisks,
    ## headers, backticks)? If so, remove them before
    returning.

Only after this internal check should you return the answer.
`;
}


// ================================================================
// NORMAL USER PROMPT
// ================================================================

function buildNormalUserPrompt(
  question: string,
  bookTitle: string,
  chunks: any[]
): string {

  const questionType =
    detectQuestionType(question);

  const evidence =
    buildEvidenceBlock(chunks);

  return `
SETBOOK:
${bookTitle}

QUESTION TYPE:
${questionType}

RELEVANT SETBOOK EVIDENCE:

${evidence}

============================================================

STUDENT QUESTION:

${question}

============================================================

TASK:

Answer the student's question as a strong KCSE English
Literature teacher.

Use the supplied evidence as the textual authority.

Do not invent anything.

Answer the exact question.

Use the appropriate structure for the question.

If it is a factual/list question, be precise.

If it requires analysis, explain the significance of the
evidence.

If the evidence is insufficient, say so honestly and briefly.

Remember: plain text only, no markdown symbols.

Most importantly:

DO NOT STOP AFTER A SINGLE STATEMENT.

DO NOT GIVE AN UNFINISHED ANSWER.

COMPLETE THE RESPONSE BEFORE RETURNING IT.
`;
}


// ================================================================
// ESSAY JSON SCHEMA
// ================================================================
//
// The Interactions API expects response_format as a single
// object (not an array) shaped like:
// { type: "text", mime_type: "application/json", schema: {...} }
//
// ================================================================

const ESSAY_RESPONSE_FORMAT = {
  type: "text",

  mime_type:
    "application/json",

  schema: {
    type: "object",

    properties: {

      introduction: {
        type: "string",
        description:
          "A complete KCSE essay introduction that directly answers the question. Plain text, no markdown."
      },

      body1: {
        type: "string",
        description:
          "The first body paragraph. Exactly one main point, followed by evidence, explanation and significance. Plain text, no markdown."
      },

      body2: {
        type: "string",
        description:
          "The second body paragraph. A distinct main point, followed by evidence, explanation and significance. Plain text, no markdown."
      },

      body3: {
        type: "string",
        description:
          "The third body paragraph. A distinct main point, followed by evidence, explanation and significance. Plain text, no markdown."
      },

      body4: {
        type: "string",
        description:
          "The fourth body paragraph. A distinct main point, followed by evidence, explanation and significance. Plain text, no markdown."
      },

      conclusion: {
        type: "string",
        description:
          "A separate KCSE essay conclusion that summarises the argument and directly answers the question. Plain text, no markdown."
      }
    },

    required: [
      "introduction",
      "body1",
      "body2",
      "body3",
      "body4",
      "conclusion"
    ],

    additionalProperties: false
  }
};


// ================================================================
// ESSAY USER PROMPT
// ================================================================

function buildEssayUserPrompt(
  question: string,
  bookTitle: string,
  chunks: any[]
): string {

  const evidence =
    buildEvidenceBlock(chunks);

  return `
SETBOOK:
${bookTitle}

QUESTION TYPE:
ESSAY

RELEVANT SETBOOK EVIDENCE:

${evidence}

============================================================

STUDENT ESSAY QUESTION:

${question}

============================================================

YOUR TASK:

Write a complete KCSE English Literature essay answering
the exact question.

The essay MUST contain exactly six components:

1. INTRODUCTION
2. BODY 1
3. BODY 2
4. BODY 3
5. BODY 4
6. CONCLUSION

You MUST return all six components as plain text with no
markdown symbols.

IMPORTANT:

Each body paragraph must contain ONE MAIN POINT ONLY.

Each body paragraph must develop that point using:

- relevant textual evidence
- explanation
- literary analysis
- significance
- connection to the question

Body 1, Body 2, Body 3 and Body 4 must contain
FOUR DISTINCT arguments.

Do not repeat the same argument.

Do not create a fifth argument.

Do not create a sixth argument.

Do not use bullet points.

Do not write the four arguments as a list.

Write complete paragraphs.

The introduction must directly address the question.

The conclusion must be separate and must not introduce a
completely new argument.

============================================================

EVIDENCE RULE:

Use ONLY the supplied evidence.

Never invent:

- characters
- events
- quotations
- chapters
- settings
- relationships
- themes
- historical facts
- literary details

If the evidence does not establish something, do not guess.

Accuracy is more important than filling a gap.

============================================================

COMPLETENESS RULE:

Every field must be complete.

Never return a fragment.

Never return only one sentence.

Never stop after Body 1.

Never stop after Body 2.

Never stop after Body 3.

Never omit Body 4.

Never omit the conclusion.

Return the COMPLETE six-part essay structure.
`;
}


// ================================================================
// EXTRACT TEXT FROM GEMINI INTERACTION
// ================================================================

function extractGeminiText(
  data: any
): string {

  const textParts: string[] = [];

  if (
    Array.isArray(data?.steps)
  ) {

    for (
      const step of data.steps
    ) {

      if (
        step?.type !== "model_output"
      ) {
        continue;
      }

      if (
        !Array.isArray(step?.content)
      ) {
        continue;
      }

      for (
        const content of step.content
      ) {

        if (
          content?.type === "text" &&
          typeof content?.text === "string"
        ) {

          textParts.push(
            content.text
          );
        }
      }
    }
  }

  return textParts
    .join("\n")
    .trim();
}


// ================================================================
// CLEAN POSSIBLE JSON FENCES
// ================================================================

function cleanJsonText(
  text: string
): string {

  let cleaned =
    text.trim();

  if (
    cleaned.startsWith("```json")
  ) {
    cleaned =
      cleaned.slice(7);
  }

  if (
    cleaned.startsWith("```")
  ) {
    cleaned =
      cleaned.slice(3);
  }

  if (
    cleaned.endsWith("```")
  ) {
    cleaned =
      cleaned.slice(
        0,
        -3
      );
  }

  return cleaned.trim();
}


// ================================================================
// STRIP ANY MARKDOWN THAT SLIPPED THROUGH
// ================================================================
//
// Belt-and-braces cleanup in case the model still emits
// asterisks or markdown headers despite the prompt rules.
//
// ================================================================

function stripMarkdown(
  text: string
): string {

  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/`/g, "");
}


// ================================================================
// PARSE ESSAY JSON
// ================================================================

function parseEssayJson(
  text: string
): any {

  const cleaned =
    cleanJsonText(text);

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Continue to recovery attempt.
  }

  const firstBrace =
    cleaned.indexOf("{");

  const lastBrace =
    cleaned.lastIndexOf("}");

  if (
    firstBrace >= 0 &&
    lastBrace > firstBrace
  ) {

    const possibleJson =
      cleaned.slice(
        firstBrace,
        lastBrace + 1
      );

    try {
      return JSON.parse(
        possibleJson
      );
    } catch (_) {
      // Fall through.
    }
  }

  throw new Error(
    "Gemini returned invalid essay JSON."
  );
}


// ================================================================
// VALIDATE ESSAY STRUCTURE
// ================================================================

function validateEssay(
  essay: any
): void {

  const requiredFields = [
    "introduction",
    "body1",
    "body2",
    "body3",
    "body4",
    "conclusion",
  ];

  for (
    const field of requiredFields
  ) {

    if (
      typeof essay?.[field] !== "string"
    ) {

      throw new Error(
        `Essay is incomplete: missing ${field}.`
      );
    }

    if (
      !essay[field].trim()
    ) {

      throw new Error(
        `Essay is incomplete: empty ${field}.`
      );
    }
  }
}


// ================================================================
// ASSEMBLE FINAL ESSAY
// ================================================================
//
// Plain-text section labels only — the frontend does not
// render markdown, so "##" headers would show up literally.
//
// ================================================================

function assembleEssay(
  essay: any
): string {

  validateEssay(essay);

  return [
    "INTRODUCTION",
    stripMarkdown(essay.introduction.trim()),

    "BODY 1",
    stripMarkdown(essay.body1.trim()),

    "BODY 2",
    stripMarkdown(essay.body2.trim()),

    "BODY 3",
    stripMarkdown(essay.body3.trim()),

    "BODY 4",
    stripMarkdown(essay.body4.trim()),

    "CONCLUSION",
    stripMarkdown(essay.conclusion.trim()),
  ].join("\n\n");
}


// ================================================================
// CALL GEMINI
// ================================================================

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  essayMode: boolean
): Promise<{
  answer: string;
  interactionId: string | null;
  status: string | null;
}> {

  let lastError:
    unknown = null;

  for (
    let attempt = 1;
    attempt <= RETRY_LIMIT;
    attempt++
  ) {

    try {

      const requestBody: any = {

        model:
          GEMINI_MODEL,

        system_instruction:
          systemPrompt,

        input:
          userPrompt,

        generation_config: {

          thinking_level:
            GEMINI_THINKING_LEVEL,

          max_output_tokens:
            GEMINI_MAX_OUTPUT_TOKENS,
        },

        store:
          false,
      };


      if (essayMode) {

        requestBody.response_format =
          ESSAY_RESPONSE_FORMAT;
      }


      const response =
        await fetch(
          "https://generativelanguage.googleapis.com/v1beta/interactions",
          {
            method: "POST",

            headers: {
              "x-goog-api-key":
                GEMINI_API_KEY,

              "Content-Type":
                "application/json",

              "Api-Revision":
                "2026-05-20",
            },

            body:
              JSON.stringify(
                requestBody
              ),
          }
        );


      if (!response.ok) {

        const errorText =
          await response.text();

        throw new Error(
          `Gemini API failed with HTTP ${response.status}: ${errorText}`
        );
      }


      const data =
        await response.json();


      const status =
        typeof data?.status === "string"
          ? data.status
          : null;


      const interactionId =
        typeof data?.id === "string"
          ? data.id
          : null;


      const rawAnswer =
        extractGeminiText(data);


      if (!rawAnswer) {

        throw new Error(
          "Gemini returned no text output."
        );
      }


      // ----------------------------------------------------------
      // ESSAY MODE
      // ----------------------------------------------------------

      if (essayMode) {

        const essay =
          parseEssayJson(
            rawAnswer
          );

        validateEssay(
          essay
        );

        const finalEssay =
          assembleEssay(
            essay
          );

        return {
          answer:
            finalEssay,

          interactionId,

          status,
        };
      }


      // ----------------------------------------------------------
      // NORMAL MODE
      // ----------------------------------------------------------

      if (
        status === "incomplete"
      ) {

        throw new Error(
          "Gemini returned an incomplete answer."
        );
      }


      return {
        answer:
          stripMarkdown(rawAnswer),

        interactionId,

        status,
      };

    } catch (error) {

      lastError =
        error;

      console.error(
        `Gemini attempt ${attempt} failed:`,
        error
      );


      if (
        attempt < RETRY_LIMIT
      ) {

        // A 429 means the quota is genuinely exhausted right now —
        // retrying immediately wastes more of the same quota and
        // won't succeed until it resets. Fail fast instead.
        const isQuotaExceeded =
          error instanceof Error &&
          error.message.includes("HTTP 429");

        if (isQuotaExceeded) {
          throw error;
        }

        // 503 ("high demand") benefits from a longer wait than
        // other errors, since Google's own message says these
        // spikes are usually short-lived.
        const isOverloaded =
          error instanceof Error &&
          error.message.includes("HTTP 503");

        const delay = isOverloaded
          ? 2500 * attempt
          : 700 * attempt;

        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              delay
            )
        );
      }
    }
  }


  throw new Error(
    `Gemini failed after ${RETRY_LIMIT} attempts: ${String(lastError)}`
  );
}


// ================================================================
// SANITY CHECK NORMAL ANSWER
// ================================================================

function sanityCheckAnswer(
  answer: string,
  question: string
): void {

  const cleaned =
    answer.trim();

  if (!cleaned) {

    throw new Error(
      "The generated answer is empty."
    );
  }


  if (
    isEssayRequest(question)
  ) {
    return;
  }


  if (
    cleaned.length < 25
  ) {

    throw new Error(
      "The generated answer is suspiciously short."
    );
  }
}


// ================================================================
// BUILD EVIDENCE RETURN OBJECT
// ================================================================

function buildEvidenceResponse(
  chunks: any[]
) {

  return chunks.map(
    (chunk: any) => {

      const content =
        typeof chunk?.content === "string"
          ? chunk.content
          : "";

      return {
        id:
          chunk?.id ?? null,

        chapter:
          chunk?.chapter_label ?? null,

        excerpt:
          content.slice(0, 400) +
          (
            content.length > 400
              ? "…"
              : ""
          ),
      };
    }
  );
}


// ================================================================
// MAIN EDGE FUNCTION
// ================================================================

Deno.serve(
  async (req) => {

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

      const body =
        await req.json();


      const rawQuestion =
        body?.question;


      const rawBookTitle =
        body?.bookTitle;


      if (
        typeof rawQuestion !== "string" ||
        !rawQuestion.trim()
      ) {

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


      const question =
        cleanQuestion(
          rawQuestion
        );


      const bookTitle =
        normalizeBookTitle(
          rawBookTitle
        );


      if (!bookTitle) {

        return new Response(
          JSON.stringify({
            error:
              "Missing 'bookTitle'. Please select a setbook.",
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


      const essayMode =
        isEssayRequest(
          question
        );


      const questionType =
        detectQuestionType(
          question
        );


      let chunks =
        await retrieveEvidence(
          question,
          bookTitle
        );


      chunks =
        deduplicateChunks(
          chunks
        );


      if (
        chunks.length === 0
      ) {

        return new Response(
          JSON.stringify({
            error:
              "No matching evidence was found for this question. Please rephrase the question or check that the correct setbook is selected.",

            bookTitle,

            questionType,
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


      const systemPrompt =
        buildSystemPrompt(
          bookTitle
        );


      const userPrompt =
        essayMode

          ? buildEssayUserPrompt(
              question,
              bookTitle,
              chunks
            )

          : buildNormalUserPrompt(
              question,
              bookTitle,
              chunks
            );


      const result =
        await callGemini(
          systemPrompt,
          userPrompt,
          essayMode
        );


      sanityCheckAnswer(
        result.answer,
        question
      );


      supabase
        .from("question_log")
        .insert({
          book_title:
            bookTitle,

          question:
            question,

          answer:
            result.answer,

          retrieved_chunk_ids:
            chunks.map(
              (chunk: any) =>
                chunk?.id
            ),
        })
        .then(
          () => {},
          (error) => {
            console.error(
              "Question logging failed:",
              error
            );
          }
        );


      return new Response(
        JSON.stringify({

          answer:
            result.answer,

          bookTitle,

          questionType,

          essayMode,

          evidenceUsed:
            buildEvidenceResponse(
              chunks
            ),

          retrievedEvidenceCount:
            chunks.length,

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

      console.error(
        "ask-question error:",
        error
      );


      const message =
        error instanceof Error
          ? error.message
          : String(error);


      return new Response(
        JSON.stringify({
          error:
            message,
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
