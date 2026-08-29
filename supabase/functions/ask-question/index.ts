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
// ----------------------------------------------------------------
// WHAT CHANGED IN THIS VERSION (read this before touching the file)
// ----------------------------------------------------------------
//
// 1. SPEED — normal (non-essay) questions were using the SAME
//    heavy settings as full essays: thinking_level "high",
//    max_output_tokens 64000, and 16 retrieved chunks. A
//    one-mark "name the setting" question does not need any of
//    that, and "high" thinking + a 64k token budget is the
//    single biggest source of latency. Normal questions now use
//    a much lighter, faster config (NORMAL_* constants below);
//    essays keep a richer config (ESSAY_* constants) since they
//    genuinely need more room and more evidence.
//
// 2. ACCURACY / "IT ONLY ANSWERS LIKE AN ESSAY" — the root cause:
//    buildSystemPrompt() always included the full ESSAY MODE
//    section (six required components, four body paragraphs,
//    word-count targets, etc.) in EVERY call, even for plain
//    factual or one-mark questions. That section biased the
//    model toward essay-shaped output regardless of what was
//    actually asked. The system prompt is now built per mode:
//    normal questions get a system prompt with explicit
//    "this is NOT an essay" instructions and none of the essay
//    scaffolding; only true essay requests get the essay section.
//
// 3. Retrieval count is now mode-aware (fewer, more targeted
//    chunks for normal questions = faster vector search + a
//    smaller prompt = faster generation), and every question
//    type (list, one-mark, definition, analysis, discussion,
//    etc.) is explicitly covered by the normal-mode prompt, not
//    just essays.
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

const RETRY_LIMIT = 2;

// ----------------------------------------------------------------
// MODE-AWARE TUNING
//
// Normal questions (definitions, one-mark recall, list/identify,
// character/theme/style analysis, discussion, passage questions,
// etc.) are the vast majority of traffic and should feel instant.
// Essays are rarer and genuinely need more evidence, more room to
// write, and a bit more thinking — but even they don't need
// "high" thinking or a 64k token ceiling; that was pure latency
// with no quality benefit, since a KCSE essay tops out at a few
// hundred words.
// ----------------------------------------------------------------

const NORMAL_RETRIEVAL_COUNT = 8;
const ESSAY_RETRIEVAL_COUNT = 14;

const NORMAL_THINKING_LEVEL = "low";
const ESSAY_THINKING_LEVEL = "medium";

const NORMAL_MAX_OUTPUT_TOKENS = 2048;
const ESSAY_MAX_OUTPUT_TOKENS = 4096;


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
// DETECT MARK ALLOCATION (e.g. "(1 mark)", "(4 marks)")
// ================================================================
//
// Used only to give the model a length hint so a 1-mark question
// doesn't get a paragraph and a 20-mark question doesn't get one
// sentence. Purely advisory — never overrides the essay check.
//
// ================================================================

function detectMarks(
  question: string
): number | null {

  const match = question.match(
    /\(?\s*(\d{1,2})\s*marks?\s*\)?/i
  );

  if (!match) {
    return null;
  }

  const marks = parseInt(match[1], 10);

  if (
    Number.isNaN(marks) ||
    marks <= 0 ||
    marks > 30
  ) {
    return null;
  }

  return marks;
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
  bookTitle: string | null,
  matchCount: number
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
        matchCount,
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
// SHARED CORE RULES (used in every system prompt, both modes)
// ================================================================

function buildCoreRules(
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

============================================================
ABSOLUTE RULE 1 — THE SUPPLIED EVIDENCE IS THE AUTHORITY
============================================================

The supplied setbook evidence is the textual authority
for your answer.

You MUST NOT manufacture literary information.

Never invent:

- characters, character names, character relationships
- events, scenes, quotations
- chapter numbers, page numbers
- settings, themes, symbols
- historical facts, character roles, plot developments
- authorial intentions, literary techniques
- conversations, actions, motivations, consequences

unless the supplied evidence establishes them.

Your general knowledge must NEVER override the supplied
evidence.

If the evidence does not establish something, say so plainly
and briefly, in one sentence, then continue with what the
evidence does support. That is better than guessing.

============================================================
ABSOLUTE RULE 2 — NEVER PAD, NEVER OVER-EXPLAIN
============================================================

Do not add invented material simply because the question
asks for a particular number of points or characters.

If the question asks for 20 characters but the evidence only
establishes 14, give the 14 you can support, then add one
short closing sentence noting the limitation — do not write a
long explanation of your counting method, and do not repeat
the disclaimer more than once.

Do not count the same character twice because it has two
roles. Do not count a group, a historical person, a role, or
an unnamed person as a named character.

============================================================
ABSOLUTE RULE 3 — ANSWER THE ACTUAL QUESTION, AT THE RIGHT LENGTH
============================================================

Before producing the answer, silently determine:

1. What is the command word?
2. What exactly is being asked?
3. How many marks is this question worth (if stated)?
4. Which evidence is relevant?
5. What structure and length actually fits this question?

Match your answer length to what is actually being asked:

- A 1–2 mark question ("name", "state", "identify") needs a
  short, direct answer — a sentence or a short list. It does
  NOT need an introduction, explanation paragraph, or essay
  structure.
- A "list/name/identify" question needs a plain numbered list,
  each item briefly identified — not a discussion.
- A question asking to "explain", "discuss", "analyse", or
  "describe" needs real analysis (point, evidence, explanation,
  significance) but only as long as the question warrants —
  usually a focused paragraph or a few short paragraphs, not a
  full essay with introduction/body/conclusion, UNLESS the
  question explicitly asks for an essay.
- Do not turn every question into an essay. Do not give a
  character list when the question asks for analysis. Do not
  give plot summary when the question asks for analysis.

============================================================
KCSE LITERATURE QUALITY
============================================================

Use formal, clear, analytical English.

Where analysis is warranted, follow:

POINT → EVIDENCE → EXPLANATION → SIGNIFICANCE

Use analytical expressions naturally, including:

"This reveals..." "This suggests..." "This demonstrates..."
"This highlights..." "This exposes..." "This reinforces..."
"This illustrates..." "This is significant because..."
"The writer uses..." "This reflects..." "This shows that..."

Do not repeatedly use the same phrase. Do not produce empty
analysis. Do not simply retell the story when analysis is
asked for.

============================================================
CHARACTER QUESTIONS
============================================================

Identify the correct character, give the relevant trait, role,
action or relationship, support it using supplied evidence,
explain what the evidence reveals, and link the explanation to
the question. Do not confuse a character with a group,
historical figure, or character role.

============================================================
THEME QUESTIONS
============================================================

Do not merely define the theme. Show how it is developed
through relevant characters, actions, conflicts, events,
relationships, setting, symbolism, irony, language, or other
techniques — each claim supported by the supplied evidence.

============================================================
DISCUSSION / EXPLAIN / ANALYSE QUESTIONS
============================================================

Directly address the proposition. Develop distinct points,
each with POINT, EVIDENCE, EXPLANATION, and a LINK TO THE
QUESTION. Avoid repeating one idea in different words. Use as
many points as the question's mark allocation reasonably
implies — do not stretch a 2-mark question into five points,
and do not compress an 8-mark "discuss" question into one.

============================================================
LIST / NAME / IDENTIFY QUESTIONS
============================================================

Use a plain numbered list ("1.", "2.", "3." — no symbols).
Each item: NAME — brief accurate identification. No
unnecessary essay. Do not invent missing items. If the
requested number exceeds the evidence available, state the
limitation briefly in one closing sentence.

============================================================
PASSAGE / EXCERPT QUESTIONS
============================================================

Prioritise what the passage actually establishes. Analyse
character, language, conflict, tone, irony, symbolism, setting,
themes, or technique only when supported by the evidence. Do
not invent events immediately before or after the passage.

============================================================
GENERAL ANSWER QUALITY
============================================================

Never begin every response with "Based on the provided
evidence...". Vary the opening naturally — start with the
actual answer. Do not apologise unnecessarily. Do not narrate
your own process. Just answer, the way a teacher would when
speaking directly to a student. Do not use fake quotations. Do
not put quotation marks around paraphrases. Do not create page
numbers. Do not claim a passage says something it does not. Do
not use information merely because it sounds plausible.
`;
}


// ================================================================
// ESSAY-ONLY ADDENDUM
//
// This section is appended ONLY when essayMode is true. Keeping
// it out of the normal-mode prompt is what stops the model from
// defaulting every answer — including one-mark questions — into
// an essay shape.
// ================================================================

function buildEssayAddendum(): string {

  return `
============================================================
ESSAY MODE — THIS QUESTION IS AN ESSAY REQUEST
============================================================

The student has explicitly asked for an ESSAY. You MUST follow
the special essay format supplied in the user instructions.

The final essay MUST contain exactly:

Introduction
Body 1
Body 2
Body 3
Body 4
Conclusion

There must be EXACTLY FOUR body paragraphs. No fifth. No
sixth. No bullet points. No numbered arguments inside the
essay. No "Analysis" section. No "Evidence used" section. No
"Key points" section. No "Summary" section. No additional
conclusion. No second introduction.

The four body paragraphs must be four DISTINCT arguments, each
developing ONE MAIN POINT ONLY, structured as:

POINT + TEXTUAL EVIDENCE + EXPLANATION + SIGNIFICANCE/LINK

Do not cram several unrelated points into one body paragraph.
Do not split one point into multiple artificial points.

INTRODUCTION: directly addresses the question, establishes the
central argument, briefly introduces the relevant literary
issue, shows the direction of the essay. Not unnecessarily
long. No list of body points.

BODY 1–4: each one clear point, evidence, analysis,
significance, and a connection back to the question. Each must
be genuinely different from the others — no repeated
arguments.

CONCLUSION: separate from the four body paragraphs. Summarises
the central argument, reinforces the main interpretation,
directly answers the question. Does not introduce a completely
new argument.

TARGET LENGTH (targets, not rigid limits — completeness and
evidence matter more than exact word count):

Introduction: 80–130 words.
Each body paragraph: 120–190 words.
Conclusion: 60–100 words.

If the evidence does not support enough distinct arguments, do
NOT invent arguments — use only what can legitimately be
established, and say so briefly within the relevant paragraph.

FINAL INTERNAL CHECK before returning: exactly four distinct
body paragraphs, a separate intro and conclusion, no invented
literary facts, no markdown symbols, and the essay is complete
(never stop after Body 1, 2, or 3 — always finish through the
conclusion).
`;
}


// ================================================================
// MASTER SYSTEM PROMPT (mode-aware)
// ================================================================

function buildSystemPrompt(
  bookTitle: string,
  essayMode: boolean
): string {

  const core = buildCoreRules(bookTitle);

  if (essayMode) {
    return core + "\n" + buildEssayAddendum();
  }

  // Normal mode: explicitly tell the model NOT to write an essay,
  // since without this guardrail models tend to default toward
  // the fullest, safest-looking structure for any literature
  // question.
  return (
    core +
    `
============================================================
THIS IS NOT AN ESSAY REQUEST
============================================================

Do not write an introduction/body/conclusion essay structure.
Do not write four body paragraphs. Answer only what this
specific question asks, at a length appropriate to it — from a
single short sentence for a one-mark recall question, up to a
few focused paragraphs for a "discuss" or "analyse" question.
Never pad a short answer into an essay.
`
  );
}


// ================================================================
// NORMAL USER PROMPT
// ================================================================

function buildNormalUserPrompt(
  question: string,
  bookTitle: string,
  chunks: any[],
  marks: number | null
): string {

  const questionType =
    detectQuestionType(question);

  const evidence =
    buildEvidenceBlock(chunks);

  const marksLine =
    marks !== null
      ? `\nMARKS ALLOCATED: ${marks} — calibrate the length and depth of your answer to this. A 1–2 mark question wants a short, direct answer, not a paragraph.\n`
      : "";

  return `
SETBOOK:
${bookTitle}

QUESTION TYPE:
${questionType}
${marksLine}
RELEVANT SETBOOK EVIDENCE:

${evidence}

============================================================

STUDENT QUESTION:

${question}

============================================================

TASK:

Answer the student's question as a strong KCSE English
Literature teacher, using the supplied evidence as the textual
authority. Do not invent anything. Answer the exact question,
in the structure and length it actually calls for — this is
NOT an essay unless the question itself says so. If it is a
factual/list question, be precise and brief. If it requires
analysis, explain the significance of the evidence, but do not
over-write. If the evidence is insufficient, say so honestly
and briefly.

Remember: plain text only, no markdown symbols. Complete the
response before returning it — do not stop mid-answer.
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

Write a complete KCSE English Literature essay answering the
exact question. The essay MUST contain exactly six components:

1. INTRODUCTION
2. BODY 1
3. BODY 2
4. BODY 3
5. BODY 4
6. CONCLUSION

Return all six as plain text, no markdown symbols. Each body
paragraph must contain ONE MAIN POINT ONLY, developed with
relevant textual evidence, explanation, literary analysis,
significance, and connection to the question. Body 1–4 must be
FOUR DISTINCT arguments — no repeats, no fifth, no sixth, no
bullet points, no list form. Write complete paragraphs.

The introduction must directly address the question. The
conclusion must be separate and must not introduce a
completely new argument.

============================================================

EVIDENCE RULE: use ONLY the supplied evidence. Never invent
characters, events, quotations, chapters, settings,
relationships, themes, historical facts, or literary details.
If the evidence does not establish something, do not guess —
accuracy matters more than filling a gap.

COMPLETENESS RULE: every field must be complete. Never return
a fragment or stop after Body 1, 2, or 3. Never omit Body 4 or
the conclusion. Return the COMPLETE six-part structure.
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

  const thinkingLevel =
    essayMode
      ? ESSAY_THINKING_LEVEL
      : NORMAL_THINKING_LEVEL;

  const maxOutputTokens =
    essayMode
      ? ESSAY_MAX_OUTPUT_TOKENS
      : NORMAL_MAX_OUTPUT_TOKENS;

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
            thinkingLevel,

          max_output_tokens:
            maxOutputTokens,
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

        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              400 * attempt
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

  // Lowered from 25 — a genuine 1-mark answer ("The setting is
  // Nairobi.") can legitimately be short. This only catches
  // truly empty/near-empty responses now.
  if (
    cleaned.length < 8
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


      const marks =
        detectMarks(
          question
        );


      const matchCount =
        essayMode
          ? ESSAY_RETRIEVAL_COUNT
          : NORMAL_RETRIEVAL_COUNT;


      let chunks =
        await retrieveEvidence(
          question,
          bookTitle,
          matchCount
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
          bookTitle,
          essayMode
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
              chunks,
              marks
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
