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
// GEMINI 3.7 FLASH (generateContent API)
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
// Exactly four body paragraphs. This has NOT been touched in this
// revision — the essay pipeline (JSON schema, six-part assembly,
// validation) is untouched on purpose.
//
// ----------------------------------------------------------------
// WHAT CHANGED IN THIS VERSION (read this before touching the file)
// ----------------------------------------------------------------
//
// 1-5. (Unchanged from the previous revision — see git history.
//    Summary: normal questions got a lighter config than essays;
//    the system prompt is built per-mode so normal questions never
//    see the essay scaffolding; retrieval count is mode-aware; the
//    function calls generateContent instead of the heavier
//    Interactions API; and there are three answer tiers — SIMPLE,
//    ANALYTICAL, ESSAY — trading thinking depth for speed.)
//
// 6. ROOT CAUSE OF "SOMETHING WENT WRONG" (THIS REVISION'S MAIN FIX)
//    — gemini-3.7-flash is a Gemini 3.x model. Google's own
//    migration guidance for Gemini 3.x models is explicit:
//    "Replace thinking_budget with the string enum thinking_level."
//    Gemini 3 Flash / Flash-Lite also cannot fully disable
//    thinking — there is no "off" state on this model family.
//    The SIMPLE tier (which handles the bulk of real traffic: every
//    one/two-mark question, every "name/list/identify" question)
//    was sending the legacy numeric { thinkingBudget: 0 }. That is
//    precisely the field Gemini 3.x wants removed. This is why the
//    app was failing broadly rather than occasionally — SIMPLE is
//    the most common tier, so most requests hit the failing code
//    path. ALL THREE TIERS now use thinkingLevel exclusively:
//    SIMPLE -> "low" (the actual floor on this model — you cannot
//    go lower), ANALYTICAL -> "medium", ESSAY -> "medium". Because
//    thinking can no longer be fully switched off anyway, there is
//    no accuracy trade-off in dropping thinkingBudget: 0 — "low" is
//    already the cheapest option this model offers.
//
// 7. SPEED — three additions, none of which touch essay structure:
//    a) a lightweight answer cache: identical (book, question) pairs
//       are served straight from question_log instead of re-running
//       embedding + retrieval + generation. Classrooms produce a lot
//       of exact repeat questions ("who is Tuni" gets asked by every
//       student doing that setbook), so this is a large real-world
//       win with near-zero risk (falls through silently on any
//       cache-layer error).
//    b) every outbound fetch (embedding + generateContent) now has a
//       bounded timeout via AbortSignal.timeout(), so a stalled
//       upstream call fails fast into the retry loop instead of
//       hanging the whole request.
//    c) the retry loop no longer retries a request that failed with
//       a non-retryable 4xx (400/403/404) — retrying a malformed
//       request just burns the retry budget on a guaranteed second
//       failure. It only retries on timeouts / 429 / 5xx.
//
// 8. ACCURACY — ANALYTICAL and ESSAY thinking moved from "low" to
//    "medium" now that Gemini 3.7 Flash is fast enough at "medium"
//    that this doesn't cost meaningful latency, and it buys a
//    noticeably more careful reasoning pass on "discuss"/"analyse"
//    questions and on essays. Also added a one-shot wider-retrieval
//    fallback: if the first vector search comes back with zero
//    chunks, the function automatically retries once with a larger
//    match_count before giving up. Short, sparse questions ("who is
//    Tuni") are exactly the case that can under-match on a small
//    first pass.
//
// 9. COVERAGE — explicit detection was added for "who is / who was"
//    character-identification questions and "when" / "where"
//    factual-recall questions, so a plain lookup question like
//    "Who is Tuni?" is recognised as a fast SIMPLE-tier lookup
//    instead of falling into the generic bucket. A guard makes sure
//    a question like "Who is Tuni and discuss his significance to
//    the theme of betrayal?" is NOT misclassified as simple — the
//    analysis-signal words still win.
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

const RETRIEVAL_RETRY_LIMIT = 2;

// Bounded timeouts so a stalled upstream call fails fast into the
// retry loop instead of hanging the whole HTTP request.
const GEMINI_FETCH_TIMEOUT_MS = 20000;
const EMBEDDING_FETCH_TIMEOUT_MS = 8000;

// ----------------------------------------------------------------
// MODE-AWARE TUNING
//
// Normal questions (definitions, one-mark recall, list/identify,
// character/theme/style analysis, discussion, passage questions,
// etc.) are the vast majority of traffic and should feel instant.
// Essays are rarer and genuinely need more evidence, more room to
// write, and more thinking — but even they don't need a 64k token
// ceiling; that was pure latency with no quality benefit, since a
// KCSE essay tops out at a few hundred words.
//
// THREE TIERS, not two — this is the balance between speed and
// accuracy:
//
// - SIMPLE: pure recall (name/list/identify a setting, character,
//   etc.) or anything worth 1-2 marks regardless of type. These
//   have one correct-ish answer sitting directly in the evidence.
//   Thinking set to the lowest level this model offers, smallest
//   evidence set (6 chunks), smallest token ceiling. Gemini 3.7
//   Flash cannot fully disable thinking, so "low" is the actual
//   floor — there's nothing cheaper to reach for here.
//
// - ANALYTICAL: theme/character/discussion/comparison/etc. above
//   2 marks. A "medium" thinking pass, more evidence (10 chunks).
//   This is where accuracy actually depends on the model being
//   allowed to think properly — a "discuss how the writer uses X"
//   question needs a real reasoning pass, not a token-saving one.
//
// - ESSAY: unchanged structurally from before — "medium" thinking,
//   14 chunks, the full four-body-paragraph structure.
// ----------------------------------------------------------------

const SIMPLE_RETRIEVAL_COUNT = 6;
const ANALYTICAL_RETRIEVAL_COUNT = 10;
const ESSAY_RETRIEVAL_COUNT = 14;

// Gemini 3.x models use the string-valued thinkingLevel field
// exclusively (thinkingBudget is the deprecated, pre-Gemini-3 way
// of controlling this, and mixing the two APIs is what broke the
// SIMPLE tier — see changelog item 6 above). "low" is the cheapest
// level this model family offers; there is no "off".
const SIMPLE_THINKING_LEVEL = "low";
const ANALYTICAL_THINKING_LEVEL = "medium";
const ESSAY_THINKING_LEVEL = "medium";

const SIMPLE_MAX_OUTPUT_TOKENS = 1024;
const ANALYTICAL_MAX_OUTPUT_TOKENS = 2048;
const ESSAY_MAX_OUTPUT_TOKENS = 4096;

// Question types that are pure recall/identification — no analysis
// required, so the lightest thinking level is appropriate even at
// full mark value.
const SIMPLE_QUESTION_TYPES = new Set([
  "list_or_identification",
  "setting",
  "character_identification",
  "recall_fact",
]);

// Words that signal the question wants real analysis, not a bare
// lookup. Used to stop "who is X" / "when did X" style questions
// from being misclassified as SIMPLE when they're actually asking
// for discussion (e.g. "Who is Tuni and what does he symbolise?").
const ANALYSIS_SIGNAL_PATTERN =
  /\b(discuss|explain|analyse|analyze|significan|develop|compare|contrast|contribut|role of|impact|importance|symbol)/;


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

  const hasAnalysisSignal =
    ANALYSIS_SIGNAL_PATTERN.test(q);

  // "Who is X" / "Who was X" — a plain character lookup, unless the
  // question also carries an analysis signal (in which case it
  // falls through to the theme/character/discussion checks below,
  // which correctly route it to the ANALYTICAL tier).
  if (
    !hasAnalysisSignal &&
    /\bwho['’]?s?\s+(is|was|are|were)?\b/.test(q) &&
    /\bwho\b/.test(q)
  ) {
    return "character_identification";
  }

  // "When did X happen" / "Where does X take place" — plain factual
  // recall, same guard against analysis-signal questions.
  if (
    !hasAnalysisSignal &&
    (/^\s*when\b/.test(q) ||
      /\bwhen\s+(did|does|is|was)\b/.test(q))
  ) {
    return "recall_fact";
  }

  if (
    !hasAnalysisSignal &&
    /\bwhere\b/.test(q) &&
    /\b(take place|set|located|happen|based)\b/.test(q)
  ) {
    return "setting";
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

  // Plain "who is X" fallback that didn't match the guarded check
  // above (e.g. contained an analysis signal) still deserves a
  // sensible type rather than the generic bucket.
  if (/\bwho\b/.test(q)) {
    return "character";
  }

  return "general_literature_question";
}


// ================================================================
// DETERMINE ANSWER TIER (simple / analytical / essay)
// ================================================================
//
// This is the speed/accuracy dial. Essay is decided earlier via
// isEssayRequest() and handled as its own branch throughout: this
// function only chooses between SIMPLE and ANALYTICAL for
// everything else.
//
// Rule: marks win over type. A question explicitly worth 1-2 marks
// gets the fast/simple treatment regardless of its detected type,
// because even a "character" or "theme" question at 1-2 marks is
// really just asking for a short, direct fact. Anything without an
// explicit low mark value defaults to ANALYTICAL unless its type is
// known pure-recall — erring toward giving the model a reasoning
// pass rather than risking a sloppy fast answer on something that
// actually needs analysis.
//
// ================================================================

type AnswerTier = "simple" | "analytical";

function determineAnswerTier(
  questionType: string,
  marks: number | null
): AnswerTier {

  if (
    marks !== null &&
    marks <= 2
  ) {
    return "simple";
  }

  if (
    SIMPLE_QUESTION_TYPES.has(
      questionType
    )
  ) {
    return "simple";
  }

  return "analytical";
}


// ================================================================
// NON-RETRYABLE HTTP ERROR CHECK
// ================================================================
//
// A 400/403/404 from the Gemini API means the request itself was
// rejected — retrying the identical request will fail identically.
// Only timeouts, 429 (rate limit), and 5xx are worth a retry.
//
// ================================================================

function isNonRetryableHttpError(
  error: unknown
): boolean {

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const match = message.match(
    /HTTP (\d{3})/
  );

  if (!match) {
    return false;
  }

  const status = parseInt(match[1], 10);

  return (
    status === 400 ||
    status === 403 ||
    status === 404
  );
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

      signal: AbortSignal.timeout(
        EMBEDDING_FETCH_TIMEOUT_MS
      ),

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
      `Gemini embedding failed: HTTP ${response.status}: ${errorText}`
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
// GATHER EVIDENCE — retry on transient failure + widen on empty
// ================================================================
//
// Two independent resilience layers, both new in this revision:
//
// 1. RETRY: embedding/vector-search calls can fail transiently
//    (network blip, momentary Supabase hiccup). Retry once before
//    giving up, same pattern as the Gemini generation retry.
//
// 2. WIDEN: a short, sparse question ("Who is Tuni?") can under-
//    match against a small match_count on the first pass. If the
//    first search comes back empty, retry once with a
//    meaningfully larger match_count before returning the
//    "no evidence found" error to the student.
//
// ================================================================

async function gatherEvidence(
  question: string,
  bookTitle: string,
  matchCount: number
): Promise<any[]> {

  let lastError: unknown = null;

  let chunks: any[] = [];

  for (
    let attempt = 1;
    attempt <= RETRIEVAL_RETRY_LIMIT;
    attempt++
  ) {

    try {

      chunks =
        await retrieveEvidence(
          question,
          bookTitle,
          matchCount
        );

      lastError = null;

      break;

    } catch (error) {

      lastError = error;

      console.error(
        `Evidence retrieval attempt ${attempt} failed:`,
        error
      );

      if (attempt < RETRIEVAL_RETRY_LIMIT) {

        await new Promise(
          (resolve) =>
            setTimeout(resolve, 300 * attempt)
        );
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  chunks = deduplicateChunks(chunks);

  if (chunks.length === 0) {

    const widerCount =
      Math.max(matchCount * 2, matchCount + 8);

    try {

      let widerChunks =
        await retrieveEvidence(
          question,
          bookTitle,
          widerCount
        );

      widerChunks =
        deduplicateChunks(widerChunks);

      if (widerChunks.length > 0) {
        return widerChunks;
      }

    } catch (error) {

      // If the wider retry also fails, fall through and let the
      // caller handle the empty-evidence case as before — no need
      // to surface a second error here.
      console.error(
        "Wider evidence retry failed:",
        error
      );
    }
  }

  return chunks;
}


// ================================================================
// ANSWER CACHE
// ================================================================
//
// Classrooms produce a lot of exact repeat questions against the
// same setbook ("Who is Tuni?" gets asked by every student on that
// book). Rather than re-running embedding + vector search +
// generation for a question that has already been answered
// identically, check question_log first. This is a pure speed win
// with no accuracy trade-off — it only fires on an exact
// (bookTitle, question) match, and any failure here is swallowed
// silently so a caching problem can never break a live answer.
//
// ================================================================

async function getCachedAnswer(
  bookTitle: string,
  question: string
): Promise<string | null> {

  try {

    const { data, error } =
      await supabase
        .from("question_log")
        .select("answer")
        .eq("book_title", bookTitle)
        .eq("question", question)
        .limit(1);

    if (error || !data || data.length === 0) {
      return null;
    }

    const answer = data[0]?.answer;

    return (
      typeof answer === "string" &&
      answer.trim()
    )
      ? answer
      : null;

  } catch (error) {

    console.error(
      "Answer cache lookup failed (non-fatal):",
      error
    );

    return null;
  }
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
- A "who is X" question needs a short, direct identification:
  who the character is, their role, and their key relevance —
  a few sentences, not an essay.
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
CHARACTER QUESTIONS (INCLUDING "WHO IS X")
============================================================

Identify the correct character, give the relevant trait, role,
action or relationship, support it using supplied evidence,
explain what the evidence reveals, and link the explanation to
the question. Do not confuse a character with a group,
historical figure, or character role. For a plain "who is X"
question, lead with a direct identification sentence (who they
are and their role in the story), then add one or two
supporting sentences grounded in the evidence — do not expand
this into a full character analysis unless the question asks
for one.

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
// an essay shape. UNCHANGED in this revision, as requested — the
// essay structure stays exactly as it was.
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
factual/list/identification question (including "who is X"),
be precise and brief. If it requires analysis, explain the
significance of the evidence, but do not over-write. If the
evidence is insufficient, say so honestly and briefly.

Remember: plain text only, no markdown symbols. Complete the
response before returning it — do not stop mid-answer.
`;
}


// ================================================================
// ESSAY JSON SCHEMA
// ================================================================
//
// generateContent takes this directly as generationConfig.
// responseSchema (paired with responseMimeType:
// "application/json") — a plain OpenAPI-subset schema, no
// wrapper object needed. UNCHANGED in this revision.
//
// ================================================================

const ESSAY_RESPONSE_SCHEMA = {
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
  ]
};


// ================================================================
// ESSAY USER PROMPT (UNCHANGED)
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
// EXTRACT TEXT FROM A generateContent RESPONSE
// ================================================================
//
// generateContent returns:
// { candidates: [ { content: { parts: [ { text: "..." } ] },
//                    finishReason: "STOP" | "MAX_TOKENS" | ... } ] }
//
// ================================================================

function extractGeminiText(
  data: any
): string {

  const candidate =
    Array.isArray(data?.candidates)
      ? data.candidates[0]
      : null;

  const parts =
    candidate?.content?.parts;

  if (!Array.isArray(parts)) {
    return "";
  }

  const textParts: string[] = [];

  for (const part of parts) {

    if (
      typeof part?.text === "string"
    ) {
      textParts.push(part.text);
    }
  }

  return textParts
    .join("\n")
    .trim();
}


function getFinishReason(
  data: any
): string | null {

  const candidate =
    Array.isArray(data?.candidates)
      ? data.candidates[0]
      : null;

  return typeof candidate?.finishReason === "string"
    ? candidate.finishReason
    : null;
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
  mode: AnswerTier | "essay"
): Promise<{
  answer: string;
  status: string | null;
}> {

  const essayMode = mode === "essay";

  let lastError:
    unknown = null;

  const maxOutputTokens =
    mode === "essay"
      ? ESSAY_MAX_OUTPUT_TOKENS
      : mode === "analytical"
      ? ANALYTICAL_MAX_OUTPUT_TOKENS
      : SIMPLE_MAX_OUTPUT_TOKENS;

  // ----------------------------------------------------------------
  // THINKING — the speed/accuracy dial
  //
  // Gemini 3.x models use thinkingLevel (a string: low / medium /
  // high) exclusively. The legacy numeric thinkingBudget field is
  // being retired on this model family and mixing it in is what
  // broke the SIMPLE tier before this revision (see changelog item
  // 6 at the top of the file). There is also no "off" state on
  // Gemini 3 Flash, so "low" is simply the cheapest option
  // available — not a compromise.
  //
  // SIMPLE  -> "low"    (pure recall / 1-2 mark questions)
  // ANALYTICAL -> "medium" (theme/character/discussion/etc.)
  // ESSAY   -> "medium" (four-body-paragraph KCSE essays)
  // ----------------------------------------------------------------

  const thinkingLevel =
    mode === "simple"
      ? SIMPLE_THINKING_LEVEL
      : mode === "analytical"
      ? ANALYTICAL_THINKING_LEVEL
      : ESSAY_THINKING_LEVEL;

  const thinkingConfig = { thinkingLevel };

  for (
    let attempt = 1;
    attempt <= RETRY_LIMIT;
    attempt++
  ) {

    try {

      const requestBody: any = {

        contents: [
          {
            role: "user",
            parts: [
              { text: userPrompt },
            ],
          },
        ],

        systemInstruction: {
          parts: [
            { text: systemPrompt },
          ],
        },

        generationConfig: {

          thinkingConfig,

          maxOutputTokens,

          ...(essayMode
            ? {
                responseMimeType:
                  "application/json",

                responseSchema:
                  ESSAY_RESPONSE_SCHEMA,
              }
            : {}),
        },
      };


      const response =
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
          {
            method: "POST",

            headers: {
              "x-goog-api-key":
                GEMINI_API_KEY,

              "Content-Type":
                "application/json",
            },

            signal: AbortSignal.timeout(
              GEMINI_FETCH_TIMEOUT_MS
            ),

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


      const finishReason =
        getFinishReason(data);


      const rawAnswer =
        extractGeminiText(data);


      if (!rawAnswer) {

        throw new Error(
          `Gemini returned no text output (finishReason: ${finishReason ?? "unknown"}).`
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

          status:
            finishReason,
        };
      }


      // ----------------------------------------------------------
      // NORMAL MODE
      // ----------------------------------------------------------

      if (
        finishReason === "MAX_TOKENS" &&
        rawAnswer.trim().length < 20
      ) {

        throw new Error(
          "Gemini returned an incomplete answer (hit token limit too early)."
        );
      }


      return {
        answer:
          stripMarkdown(rawAnswer),

        status:
          finishReason,
      };

    } catch (error) {

      lastError =
        error;

      console.error(
        `Gemini attempt ${attempt} failed:`,
        error
      );

      // Don't burn the retry budget on a request that is guaranteed
      // to fail again identically — a 400/403/404 means the request
      // itself was rejected, not that anything transient happened.
      if (isNonRetryableHttpError(error)) {
        break;
      }

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


      // "simple" | "analytical" | "essay" — the speed/accuracy
      // tier for this specific question. Essay is decided first
      // since it overrides everything else.
      const answerTier =
        essayMode
          ? ("essay" as const)
          : determineAnswerTier(
              questionType,
              marks
            );


      // ------------------------------------------------------------
      // ANSWER CACHE — exact-match fast path
      //
      // Skips embedding, vector search, and generation entirely for
      // a question that has already been asked, word-for-word, for
      // this same book. Safe to check unconditionally: it only
      // returns a value on an exact match, and any lookup failure
      // returns null so the normal pipeline runs as before.
      // ------------------------------------------------------------

      const cachedAnswer =
        await getCachedAnswer(
          bookTitle,
          question
        );

      if (cachedAnswer) {

        return new Response(
          JSON.stringify({

            answer:
              cachedAnswer,

            bookTitle,

            questionType,

            essayMode,

            answerTier,

            cached: true,

            evidenceUsed: [],

            retrievedEvidenceCount: 0,

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
      }


      const matchCount =
        answerTier === "essay"
          ? ESSAY_RETRIEVAL_COUNT
          : answerTier === "analytical"
          ? ANALYTICAL_RETRIEVAL_COUNT
          : SIMPLE_RETRIEVAL_COUNT;


      const chunks =
        await gatherEvidence(
          question,
          bookTitle,
          matchCount
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
          answerTier
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

          answerTier,

          cached: false,

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
