// ============================================================
// MASLAH ACADEMY AI
// ask-question Edge Function
//
// FINAL PRODUCTION VERSION
//
// Pipeline:
//
// Student question
//        ↓
// Validate request
//        ↓
// Identify question type
//        ↓
// Voyage query embedding
//        ↓
// Supabase semantic retrieval
//        ↓
// Evidence selection by Gemini
//        ↓
// KCSE answer generation
//        ↓
// Structured-output validation
//        ↓
// Essay structure validation / repair when required
//        ↓
// Log question + answer
//        ↓
// Return answer + evidence
//
// Required Supabase secrets:
//
// VOYAGE_API_KEY
// GEMINI_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
//
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// ENVIRONMENT
// ============================================================

const VOYAGE_API_KEY =
  Deno.env.get("VOYAGE_API_KEY");

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY");

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL");

const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Fail immediately if required configuration is missing.

if (!VOYAGE_API_KEY) {
  throw new Error(
    "VOYAGE_API_KEY is not configured"
  );
}

if (!GEMINI_API_KEY) {
  throw new Error(
    "GEMINI_API_KEY is not configured"
  );
}

if (!SUPABASE_URL) {
  throw new Error(
    "SUPABASE_URL is not configured"
  );
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "SUPABASE_SERVICE_ROLE_KEY is not configured"
  );
}

// ============================================================
// SUPABASE CLIENT
// ============================================================

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// CONSTANTS
// ============================================================

const GEMINI_MODEL =
  "gemini-3.7-flash";

const VOYAGE_MODEL =
  "voyage-3";

const MATCH_COUNT = 12;

const GEMINI_MAX_OUTPUT_TOKENS = 8000;

const REQUEST_TIMEOUT_MS = 60_000;

// ============================================================
// CORS
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "POST, OPTIONS",
  "Content-Type":
    "application/json",
};

// ============================================================
// TYPES
// ============================================================

type QuestionType =
  | "essay"
  | "list"
  | "comparison"
  | "theme"
  | "character"
  | "literary-technique"
  | "excerpt"
  | "explanation"
  | "general";

interface EvidenceChunk {
  id: string | number;
  content: string;
  chapter_label?: string | null;
  similarity?: number | null;
  [key: string]: unknown;
}

interface StructuredAnswer {
  question_type: QuestionType;

  answer: string;

  introduction: string;

  body_paragraph_1: string;

  body_paragraph_2: string;

  body_paragraph_3: string;

  body_paragraph_4: string;

  conclusion: string;

  list_items: string[];

  evidence_refs: string[];
}

// ============================================================
// SAFE STRING HELPERS
// ============================================================

function cleanString(
  value: unknown
): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizeText(
  value: string
): string {
  return value
    .toLowerCase()
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function countWords(
  value: string
): number {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

// ============================================================
// BOOK TITLE NORMALISATION
//
// This does NOT replace arbitrary titles.
//
// It only makes common variations of the two current
// setbooks consistent.
//
// Future books can still pass their own database title.
// ============================================================

function normalizeBookTitle(
  title: unknown
): string | null {
  if (
    typeof title !== "string" ||
    !title.trim()
  ) {
    return null;
  }

  const value =
    title.trim();

  const lower =
    value.toLowerCase();

  if (
    lower === "fathers of nations" ||
    lower === "father of nations" ||
    lower === "the fathers of nations"
  ) {
    return "Fathers of Nations";
  }

  if (
    lower === "the samaritan" ||
    lower === "samaritan"
  ) {
    return "The Samaritan";
  }

  // Preserve future setbook titles.
  return value;
}

// ============================================================
// QUESTION TYPE DETECTION
//
// This is deliberately conservative.
//
// "Discuss", "examine", "assess", etc. are treated as essay
// questions because KCSE literature commonly expects developed
// essay-style responses for these commands.
//
// "Name", "list", "identify" remain list questions.
// ============================================================

function detectQuestionType(
  question: string
): QuestionType {
  const q =
    normalizeText(question);

  // ----------------------------------------------------------
  // LIST / IDENTIFICATION
  // ----------------------------------------------------------

  if (
    /^(name|list|identify|mention|state)\b/.test(q) ||
    /\bname at least\b/.test(q) ||
    /\blist at least\b/.test(q) ||
    /\bidentify at least\b/.test(q) ||
    /\bwho are\b/.test(q)
  ) {
    return "list";
  }

  // ----------------------------------------------------------
  // ESSAY COMMANDS
  // ----------------------------------------------------------

  if (
    /\bdiscuss\b/.test(q) ||
    /\bexamine\b/.test(q) ||
    /\bassess\b/.test(q) ||
    /\bevaluate\b/.test(q) ||
    /\bto what extent\b/.test(q) ||
    /\bhow far\b/.test(q) ||
    /\bdo you agree\b/.test(q) ||
    /\bjustify\b/.test(q) ||
    /\billustrate\b/.test(q) ||
    /\bcritically discuss\b/.test(q) ||
    /\bcritically examine\b/.test(q) ||
    /\bwrite an essay\b/.test(q) ||
    /\bessay on\b/.test(q)
  ) {
    return "essay";
  }

  // ----------------------------------------------------------
  // COMPARISON
  // ----------------------------------------------------------

  if (
    /\bcompare\b/.test(q) ||
    /\bcontrast\b/.test(q) ||
    /\bcompare and contrast\b/.test(q) ||
    /\bsimilarities\b/.test(q) ||
    /\bdifferences\b/.test(q)
  ) {
    return "comparison";
  }

  // ----------------------------------------------------------
  // THEME
  // ----------------------------------------------------------

  if (
    /\btheme\b/.test(q) ||
    /\bthemes\b/.test(q) ||
    /\bthematic\b/.test(q)
  ) {
    return "theme";
  }

  // ----------------------------------------------------------
  // CHARACTER
  // ----------------------------------------------------------

  if (
    /\bcharacter\b/.test(q) ||
    /\bcharacters\b/.test(q) ||
    /\bcharacterisation\b/.test(q) ||
    /\bcharacterization\b/.test(q) ||
    /\bportray\b/.test(q) ||
    /\bportrays\b/.test(q) ||
    /\brole of\b/.test(q)
  ) {
    return "character";
  }

  // ----------------------------------------------------------
  // LITERARY TECHNIQUES
  // ----------------------------------------------------------

  if (
    /\bsymbol\b/.test(q) ||
    /\bsymbolism\b/.test(q) ||
    /\birony\b/.test(q) ||
    /\bironic\b/.test(q) ||
    /\bsatire\b/.test(q) ||
    /\bsatirical\b/.test(q) ||
    /\bimagery\b/.test(q) ||
    /\bmetaphor\b/.test(q) ||
    /\bsimile\b/.test(q) ||
    /\btechnique\b/.test(q) ||
    /\btechniques\b/.test(q) ||
    /\blanguage\b/.test(q) ||
    /\bstyle\b/.test(q)
  ) {
    return "literary-technique";
  }

  // ----------------------------------------------------------
  // PASSAGE / EXCERPT
  // ----------------------------------------------------------

  if (
    /\bpassage\b/.test(q) ||
    /\bexcerpt\b/.test(q) ||
    /\bextract\b/.test(q)
  ) {
    return "excerpt";
  }

  // ----------------------------------------------------------
  // EXPLANATION
  // ----------------------------------------------------------

  if (
    /\bwhy\b/.test(q) ||
    /\bhow\b/.test(q) ||
    /\bexplain\b/.test(q) ||
    /\bdescribe\b/.test(q) ||
    /\bsignificance\b/.test(q) ||
    /\bimportance\b/.test(q) ||
    /\beffect\b/.test(q) ||
    /\bcause\b/.test(q) ||
    /\breasons\b/.test(q)
  ) {
    return "explanation";
  }

  return "general";
}

// ============================================================
// FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal,
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// VOYAGE EMBEDDING
//
// IMPORTANT:
// We intentionally keep voyage-3 here because your existing
// database embeddings must be generated with the same model
// used for querying.
//
// Do NOT casually change this to another Voyage model unless
// the entire embedding corpus is regenerated consistently.
// ============================================================

async function embedQuery(
  text: string
): Promise<number[]> {
  const response =
    await fetchWithTimeout(
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

          model:
            VOYAGE_MODEL,

          input_type:
            "query",
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
    await response.json();

  const embedding =
    data?.data?.[0]?.embedding;

  if (
    !Array.isArray(embedding) ||
    embedding.length === 0
  ) {
    throw new Error(
      "Voyage returned an invalid embedding."
    );
  }

  return embedding;
}

// ============================================================
// EVIDENCE CLEANING
//
// Prevent malformed database rows from reaching Gemini.
// ============================================================

function cleanEvidence(
  chunks: unknown[]
): EvidenceChunk[] {
  const cleaned: EvidenceChunk[] = [];

  for (
    const raw of chunks
  ) {
    if (
      !raw ||
      typeof raw !== "object"
    ) {
      continue;
    }

    const item =
      raw as Record<string, unknown>;

    const id =
      item.id;

    const content =
      cleanString(
        item.content
      );

    if (
      id === undefined ||
      id === null ||
      !content
    ) {
      continue;
    }

    cleaned.push({
      ...item,

      id:
        String(id),

      content,

      chapter_label:
        item.chapter_label == null
          ? null
          : cleanString(
              item.chapter_label
            ),

      similarity:
        typeof item.similarity ===
        "number"
          ? item.similarity
          : null,
    });
  }

  return cleaned;
}

// ============================================================
// EVIDENCE BLOCK
// ============================================================

function buildEvidenceBlock(
  chunks: EvidenceChunk[]
): string {
  return chunks
    .map(
      (
        chunk,
        index
      ) => {
        const chapter =
          chunk.chapter_label
            ? ` — ${chunk.chapter_label}`
            : "";

        return `
[EVIDENCE ${index + 1}]
Evidence ID: ${chunk.id}${chapter}

${chunk.content}
`;
      }
    )
    .join("\n");
}

// ============================================================
// GEMINI STRUCTURED OUTPUT SCHEMA
//
// This is the major architectural improvement.
//
// Instead of merely asking Gemini:
//
// "Please give me four paragraphs"
//
// we require a structured object containing:
//
// introduction
// body_paragraph_1
// body_paragraph_2
// body_paragraph_3
// body_paragraph_4
// conclusion
//
// Gemini's structured-output feature is designed for this kind
// of predictable machine-readable response.
// ============================================================

const ANSWER_SCHEMA = {
  type: "object",

  properties: {
    question_type: {
      type: "string",

      enum: [
        "essay",
        "list",
        "comparison",
        "theme",
        "character",
        "literary-technique",
        "excerpt",
        "explanation",
        "general",
      ],
    },

    answer: {
      type: "string",

      description:
        "The complete answer for non-essay questions. For essay questions this may be empty because the application constructs the final essay from the dedicated sections.",
    },

    introduction: {
      type: "string",

      description:
        "Essay introduction. Required for essay questions. Must directly answer the question and establish the central argument.",
    },

    body_paragraph_1: {
      type: "string",

      description:
        "First distinct essay body paragraph. Must contain point, evidence, analysis and significance.",
    },

    body_paragraph_2: {
      type: "string",

      description:
        "Second distinct essay body paragraph. Must contain a different argument from body paragraph 1.",
    },

    body_paragraph_3: {
      type: "string",

      description:
        "Third distinct essay body paragraph. Must contain a different argument from body paragraphs 1 and 2.",
    },

    body_paragraph_4: {
      type: "string",

      description:
        "Fourth distinct essay body paragraph. Must contain a different argument from body paragraphs 1, 2 and 3.",
    },

    conclusion: {
      type: "string",

      description:
        "Essay conclusion. Must directly answer the question and synthesise the four body arguments without introducing an unsupported new argument.",
    },

    list_items: {
      type: "array",

      items: {
        type: "string",
      },

      description:
        "Numbered list items for list or identification questions.",
    },

    evidence_refs: {
      type: "array",

      items: {
        type: "string",
      },

      description:
        "Evidence IDs used in constructing the answer.",
    },
  },

  required: [
    "question_type",
    "answer",
    "introduction",
    "body_paragraph_1",
    "body_paragraph_2",
    "body_paragraph_3",
    "body_paragraph_4",
    "conclusion",
    "list_items",
    "evidence_refs",
  ],
};

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(
  bookTitle: string,
  questionType: QuestionType
): string {
  return `
You are MASLAH ACADEMY AI.

You are a rigorous KCSE English Literature teacher.

You are answering a question about:

"${bookTitle}"

The detected question type is:

"${questionType}"

============================================================
MOST IMPORTANT RULE: TEXTUAL ACCURACY
============================================================

The supplied evidence is the authority for the answer.

You MUST NOT invent literary facts.

Never manufacture:

- characters
- events
- quotations
- dialogue
- relationships
- chapters
- settings
- themes
- character traits
- character roles
- historical details
- symbols
- scenes
- plot developments
- textual evidence

If the supplied evidence does not establish something, do not
pretend that it does.

Say clearly that the supplied evidence is insufficient.

Accuracy is more important than satisfying an arbitrary number
requested by the student.

For example:

If the student asks for 20 characters but the supplied evidence
supports only 14 characters, provide only the supported characters
and explain the limitation.

NEVER invent six additional characters.

============================================================
EVIDENCE SELECTION
============================================================

You will receive multiple retrieved evidence passages.

Not every retrieved passage is necessarily relevant.

You MUST:

1. Read all supplied evidence.
2. Identify which passages genuinely answer the question.
3. Ignore irrelevant passages.
4. Combine passages when they clearly concern the same character,
   event, theme or issue.
5. Use only supported evidence in the final answer.

Do not use a passage merely because it was retrieved.

============================================================
EVIDENCE REFERENCES
============================================================

When you use evidence, record the corresponding Evidence ID in
"evidence_refs".

Only use Evidence IDs actually supplied to you.

Do not invent Evidence IDs.

============================================================
CHARACTER DISCIPLINE
============================================================

Distinguish carefully between:

1. Named fictional characters.
2. Historical figures.
3. Groups.
4. Social categories.
5. Character roles.
6. Unnamed people.

A role is NOT automatically a character.

For example, descriptions such as:

"father"
"leader"
"professor"
"politician"
"engineer"

must not automatically become separate characters.

Do not count one person twice because the text describes that
person in more than one way.

============================================================
KCSE ANALYSIS
============================================================

Do not merely retell the story.

Strong literature analysis normally follows:

POINT
+
EVIDENCE
+
EXPLANATION
+
SIGNIFICANCE

Use analytical language naturally:

"this reveals..."
"this demonstrates..."
"this highlights..."
"this suggests..."
"this exposes..."
"this reinforces..."
"this is significant because..."
"the writer uses..."
"this contrast shows..."

Avoid empty repetition.

============================================================
ESSAY QUESTIONS — ABSOLUTE STRUCTURE
============================================================

If this is an essay question, the answer MUST contain:

1. INTRODUCTION
2. BODY PARAGRAPH 1
3. BODY PARAGRAPH 2
4. BODY PARAGRAPH 3
5. BODY PARAGRAPH 4
6. CONCLUSION

There MUST be exactly FOUR body paragraphs.

Do not write only one body paragraph.

Do not write only two body paragraphs.

Do not stop after paragraph two.

Do not combine paragraphs 3 and 4.

Do not omit the conclusion.

Do not write placeholders such as:

"Body paragraph 3 would discuss..."

Actually write the complete paragraph.

============================================================
ESSAY INTRODUCTION
============================================================

The introduction should:

- directly address the question
- establish the central argument
- demonstrate understanding of the issue
- briefly establish the direction of the essay

Do not make the introduction a long plot summary.

============================================================
ESSAY BODY PARAGRAPHS
============================================================

Each of the four body paragraphs MUST present a distinct argument.

Each paragraph should normally contain:

1. Point
2. Relevant evidence
3. Explanation
4. Analysis
5. Significance
6. Connection to the question

The four arguments must not simply repeat one another.

============================================================
ESSAY CONCLUSION
============================================================

The conclusion must:

- directly answer the question
- synthesise the main arguments
- reinforce the central interpretation

Do not introduce a completely new unsupported argument.

============================================================
ESSAY LENGTH
============================================================

Aim for a developed KCSE response.

Introduction:
approximately 60–120 words.

Each body paragraph:
approximately 120–220 words.

Conclusion:
approximately 60–120 words.

These are guidance, not mathematical requirements.

Quality and evidence take priority.

============================================================
LIST QUESTIONS
============================================================

For:

"name"
"list"
"identify"
"mention"
"state"

questions:

Use list_items.

Do not force a list question into an essay.

Do not pad a list with guesses.

If the evidence supports fewer items than requested, say so.

============================================================
THEME QUESTIONS
============================================================

When analysing a theme:

- identify the theme
- identify relevant characters/events
- provide evidence
- explain how the evidence develops the theme
- explain significance
- connect directly to the question

Do not merely define the theme.

============================================================
CHARACTER QUESTIONS
============================================================

For character questions:

- identify the correct character
- state the relevant trait/role
- support it with evidence
- analyse the evidence
- explain significance
- connect directly to the question

============================================================
COMPARISON QUESTIONS
============================================================

For comparison questions:

- establish the basis of comparison
- identify meaningful similarities
- identify meaningful differences where supported
- use evidence for both sides
- avoid discussing only one side

============================================================
LITERARY TECHNIQUE QUESTIONS
============================================================

For symbolism, irony, satire, imagery, metaphor and similar
questions:

Identify the technique accurately.

Then explain:

TECHNIQUE
→ EXAMPLE/EVIDENCE
→ EFFECT
→ MEANING
→ SIGNIFICANCE

Do not merely name a technique.

============================================================
EXCERPT QUESTIONS
============================================================

For passages/extracts:

First explain what the supplied passage establishes.

Then analyse relevant:

- character
- conflict
- tone
- language
- literary technique
- theme
- significance

Do not invent events outside the supplied evidence.

============================================================
WRITING STYLE
============================================================

Write natural, formal, intelligent KCSE English.

Do not sound like a generic chatbot.

Do not repeatedly begin with:

"Based on the provided evidence..."

Do not apologise unnecessarily.

Do not use inflated vocabulary merely to sound sophisticated.

Be clear.

Be analytical.

Be direct.

============================================================
FINAL INTERNAL CHECK
============================================================

Before returning your structured answer, silently check:

1. Did I answer the exact question?
2. Did I use only supplied evidence?
3. Did I invent anything?
4. Did I confuse a character with a role?
5. Did I count anyone twice?
6. Did I use relevant evidence?
7. Did I analyse rather than merely narrate?
8. If this is an essay, did I write an introduction?
9. If this is an essay, did I write FOUR distinct body paragraphs?
10. If this is an essay, did I write a conclusion?
11. Did I actually write every paragraph?
12. Are the evidence references real?
13. Is the answer suitable for KCSE?

Only then return the structured response.
`;
}

// ============================================================
// USER PROMPT
// ============================================================

function buildUserPrompt(
  question: string,
  questionType: QuestionType,
  bookTitle: string,
  chunks: EvidenceChunk[]
): string {
  const evidence =
    buildEvidenceBlock(
      chunks
    );

  let specialInstructions =
    "";

  if (
    questionType ===
    "essay"
  ) {
    specialInstructions = `
THIS IS AN ESSAY.

You MUST fill all of these fields with substantial writing:

introduction
body_paragraph_1
body_paragraph_2
body_paragraph_3
body_paragraph_4
conclusion

The four body paragraphs MUST contain four distinct arguments.

Do not leave any of these fields empty.

Do not merge paragraphs.

Do not provide a shortened essay.
`;
  }

  if (
    questionType ===
    "list"
  ) {
    specialInstructions = `
THIS IS A LIST / IDENTIFICATION QUESTION.

Use list_items.

Do not manufacture additional entries.

If the evidence supports fewer entries than requested, give the
supported entries and explicitly state the limitation.
`;
  }

  return `
SETBOOK:
${bookTitle}

============================================================
STUDENT QUESTION
============================================================

${question}

============================================================
QUESTION TYPE
============================================================

${questionType}

============================================================
SUPPLIED SETBOOK EVIDENCE
============================================================

${evidence}

============================================================
TASK
============================================================

Answer the student's question using the supplied evidence as
your textual authority.

${specialInstructions}

Remember:

- Do not invent facts.
- Do not invent characters.
- Do not invent quotations.
- Do not invent events.
- Do not use unsupported general knowledge.
- Ignore irrelevant retrieved passages.
- Use only genuine evidence.
- Make the answer analytical and KCSE appropriate.

Return the structured answer.
`;
}

// ============================================================
// EXTRACT TEXT FROM GEMINI RESPONSE
// ============================================================

function extractGeminiText(
  data: any
): string {
  // Current SDK-style convenience field,
  // if exposed by the endpoint.
  if (
    typeof data?.output_text ===
    "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const parts: string[] =
    [];

  if (
    Array.isArray(
      data?.steps
    )
  ) {
    for (
      const step of data.steps
    ) {
      if (
        step?.type !==
        "model_output"
      ) {
        continue;
      }

      if (
        !Array.isArray(
          step?.content
        )
      ) {
        continue;
      }

      for (
        const content of
          step.content
      ) {
        if (
          content?.type ===
            "text" &&
          typeof content?.text ===
            "string"
        ) {
          parts.push(
            content.text
          );
        }
      }
    }
  }

  return parts
    .join("\n")
    .trim();
}

// ============================================================
// JSON EXTRACTION
//
// Structured output should already be valid JSON.
//
// This fallback handles accidental markdown fences.
// ============================================================

function parseJsonObject(
  text: string
): any {
  const clean =
    text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

  try {
    return JSON.parse(
      clean
    );
  } catch {
    // Try extracting the outermost object.
    const start =
      clean.indexOf("{");

    const end =
      clean.lastIndexOf("}");

    if (
      start !== -1 &&
      end > start
    ) {
      return JSON.parse(
        clean.slice(
          start,
          end + 1
        )
      );
    }

    throw new Error(
      "Gemini returned invalid JSON."
    );
  }
}

// ============================================================
// NORMALISE STRUCTURED ANSWER
// ============================================================

function normalizeStructuredAnswer(
  raw: any,
  questionType: QuestionType
): StructuredAnswer {
  const safeArray =
    Array.isArray(
      raw?.list_items
    )
      ? raw.list_items
          .filter(
            (item: unknown) =>
              typeof item ===
              "string"
          )
          .map(
            (item: string) =>
              item.trim()
          )
          .filter(Boolean)
      : [];

  const evidenceRefs =
    Array.isArray(
      raw?.evidence_refs
    )
      ? raw.evidence_refs
          .filter(
            (item: unknown) =>
              typeof item ===
              "string"
          )
          .map(
            (item: string) =>
              item.trim()
          )
          .filter(Boolean)
      : [];

  return {
    question_type:
      questionType,

    answer:
      cleanString(
        raw?.answer
      ),

    introduction:
      cleanString(
        raw?.introduction
      ),

    body_paragraph_1:
      cleanString(
        raw?.body_paragraph_1
      ),

    body_paragraph_2:
      cleanString(
        raw?.body_paragraph_2
      ),

    body_paragraph_3:
      cleanString(
        raw?.body_paragraph_3
      ),

    body_paragraph_4:
      cleanString(
        raw?.body_paragraph_4
      ),

    conclusion:
      cleanString(
        raw?.conclusion
      ),

    list_items:
      safeArray,

    evidence_refs:
      evidenceRefs,
  };
}

// ============================================================
// EVIDENCE REFERENCE VALIDATION
// ============================================================

function validateEvidenceRefs(
  answer: StructuredAnswer,
  chunks: EvidenceChunk[]
): boolean {
  const validIds =
    new Set(
      chunks.map(
        (chunk) =>
          String(chunk.id)
      )
    );

  for (
    const ref of
      answer.evidence_refs
  ) {
    if (
      validIds.has(ref)
    ) {
      continue;
    }

    // Allow "Evidence 1" style references.
    const match =
      ref.match(
        /^evidence\s+(\d+)$/i
      );

    if (match) {
      const index =
        Number(
          match[1]
        );

      if (
        index >= 1 &&
        index <= chunks.length
      ) {
        continue;
      }
    }

    return false;
  }

  return true;
}

// ============================================================
// ESSAY VALIDATION
//
// This is intentionally stricter than merely checking whether
// the model mentioned "paragraph 3".
//
// We verify:
// - all six sections exist
// - all four body paragraphs have real content
// - minimum word counts
// - paragraphs are not identical
// - conclusion exists
// - introduction exists
// ============================================================

function validateEssay(
  answer: StructuredAnswer
): {
  valid: boolean;
  problems: string[];
} {
  const problems: string[] =
    [];

  const introduction =
    answer.introduction;

  const p1 =
    answer.body_paragraph_1;

  const p2 =
    answer.body_paragraph_2;

  const p3 =
    answer.body_paragraph_3;

  const p4 =
    answer.body_paragraph_4;

  const conclusion =
    answer.conclusion;

  if (
    countWords(
      introduction
    ) < 35
  ) {
    problems.push(
      "Introduction is too short."
    );
  }

  if (
    countWords(p1) < 70
  ) {
    problems.push(
      "Body paragraph 1 is too short."
    );
  }

  if (
    countWords(p2) < 70
  ) {
    problems.push(
      "Body paragraph 2 is too short."
    );
  }

  if (
    countWords(p3) < 70
  ) {
    problems.push(
      "Body paragraph 3 is too short."
    );
  }

  if (
    countWords(p4) < 70
  ) {
    problems.push(
      "Body paragraph 4 is too short."
    );
  }

  if (
    countWords(
      conclusion
    ) < 35
  ) {
    problems.push(
      "Conclusion is too short."
    );
  }

  const paragraphs = [
    p1,
    p2,
    p3,
    p4,
  ].map(
    normalizeText
  );

  const unique =
    new Set(
      paragraphs
    );

  if (
    unique.size !==
    paragraphs.length
  ) {
    problems.push(
      "Two or more body paragraphs are identical."
    );
  }

  return {
    valid:
      problems.length === 0,

    problems,
  };
}

// ============================================================
// GENERAL ANSWER VALIDATION
// ============================================================

function validateNonEssayAnswer(
  answer: StructuredAnswer,
  questionType: QuestionType
): {
  valid: boolean;
  problems: string[];
} {
  const problems: string[] =
    [];

  if (
    questionType ===
    "list"
  ) {
    if (
      answer.list_items
        .length === 0
    ) {
      problems.push(
        "List question has no list items."
      );
    }

    return {
      valid:
        problems.length === 0,
      problems,
    };
  }

  if (
    answer.answer.length <
    20
  ) {
    problems.push(
      "Answer is too short."
    );
  }

  return {
    valid:
      problems.length === 0,
    problems,
  };
}

// ============================================================
// GEMINI CALL
// ============================================================

async function callGeminiStructured(
  systemPrompt: string,
  userPrompt: string
): Promise<StructuredAnswer> {
  const response =
    await fetchWithTimeout(
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
          model:
            GEMINI_MODEL,

          system_instruction:
            systemPrompt,

          input:
            userPrompt,

          response_format: {
            type: "text",

            mime_type:
              "application/json",

            schema:
              ANSWER_SCHEMA,
          },

          generation_config: {
            max_output_tokens:
              GEMINI_MAX_OUTPUT_TOKENS,

            thinking_level:
              "high",
          },

          // We don't need Gemini to retain the interaction
          // because the evidence is supplied explicitly.
          store: false,
        }),
      }
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Gemini API failed (${response.status}): ${errorText}`
    );
  }

  const data =
    await response.json();

  if (
    data?.status ===
    "failed"
  ) {
    throw new Error(
      "Gemini interaction failed."
    );
  }

  if (
    data?.status ===
    "incomplete"
  ) {
    throw new Error(
      "Gemini answer was incomplete because the output limit was reached."
    );
  }

  const text =
    extractGeminiText(
      data
    );

  if (!text) {
    throw new Error(
      "Gemini returned no answer text."
    );
  }

  const parsed =
    parseJsonObject(
      text
    );

  return normalizeStructuredAnswer(
    parsed,
    "general"
  );
}

// ============================================================
// REPAIR PROMPT
//
// IMPORTANT:
// The evidence is included AGAIN during repair.
//
// This prevents the repair call from "fixing" the essay by
// inventing information that was never in the original evidence.
// ============================================================

function buildRepairPrompt(
  question: string,
  questionType: QuestionType,
  bookTitle: string,
  chunks: EvidenceChunk[],
  draft: StructuredAnswer,
  problems: string[]
): string {
  const evidence =
    buildEvidenceBlock(
      chunks
    );

  return `
MASLAH ACADEMY AI — ANSWER REPAIR

SETBOOK:
${bookTitle}

QUESTION:
${question}

QUESTION TYPE:
${questionType}

============================================================
ORIGINAL SUPPLIED EVIDENCE
============================================================

${evidence}

============================================================
DRAFT ANSWER
============================================================

${JSON.stringify(
  draft,
  null,
  2
)}

============================================================
VALIDATION PROBLEMS
============================================================

${problems
  .map(
    (problem) =>
      `- ${problem}`
  )
  .join("\n")}

============================================================
REPAIR TASK
============================================================

Correct the answer.

IMPORTANT:

You are NOT allowed to add literary facts that are absent from
the supplied evidence.

Do not invent:

- characters
- events
- quotations
- relationships
- chapters
- themes
- settings
- historical facts

Preserve valid evidence from the draft.

Remove unsupported claims.

============================================================
IF THIS IS AN ESSAY
============================================================

The repaired answer MUST contain:

INTRODUCTION

BODY PARAGRAPH 1

BODY PARAGRAPH 2

BODY PARAGRAPH 3

BODY PARAGRAPH 4

CONCLUSION

All four body paragraphs must be complete.

All four must present distinct arguments.

Do not merge them.

Do not omit paragraph 3.

Do not omit paragraph 4.

Do not omit the conclusion.

Return the corrected structured JSON answer.
`;
}

// ============================================================
// FORMAT FINAL ANSWER
//
// This is what the frontend receives as "answer".
//
// For essays, the six sections are explicitly rendered.
//
// This guarantees that the frontend doesn't have to guess how
// Gemini intended to structure the essay.
// ============================================================

function formatFinalAnswer(
  answer: StructuredAnswer,
  questionType: QuestionType
): string {
  // ----------------------------------------------------------
  // ESSAY
  // ----------------------------------------------------------

  if (
    questionType ===
    "essay"
  ) {
    return [
      "## Introduction",
      "",
      answer.introduction,

      "",
      "## Body Paragraph 1",
      "",
      answer.body_paragraph_1,

      "",
      "## Body Paragraph 2",
      "",
      answer.body_paragraph_2,

      "",
      "## Body Paragraph 3",
      "",
      answer.body_paragraph_3,

      "",
      "## Body Paragraph 4",
      "",
      answer.body_paragraph_4,

      "",
      "## Conclusion",
      "",
      answer.conclusion,
    ].join("\n");
  }

  // ----------------------------------------------------------
  // LIST
  // ----------------------------------------------------------

  if (
    questionType ===
    "list"
  ) {
    return answer.list_items
      .map(
        (
          item,
          index
        ) =>
          `${index + 1}. ${item}`
      )
      .join("\n");
  }

  // ----------------------------------------------------------
  // ALL OTHER QUESTIONS
  // ----------------------------------------------------------

  return answer.answer;
}

// ============================================================
// REPAIR LOOP
//
// First generation.
// If invalid:
//   repair #1
//
// If still invalid:
//   repair #2
//
// We intentionally cap the number of repairs so one request
// cannot loop forever.
// ============================================================

async function generateReliableAnswer(
  question: string,
  questionType: QuestionType,
  bookTitle: string,
  chunks: EvidenceChunk[]
): Promise<{
  structured: StructuredAnswer;
  repairCount: number;
}> {
  const systemPrompt =
    buildSystemPrompt(
      bookTitle,
      questionType
    );

  const userPrompt =
    buildUserPrompt(
      question,
      questionType,
      bookTitle,
      chunks
    );

  let answer =
    await callGeminiStructured(
      systemPrompt,
      userPrompt
    );

  answer.question_type =
    questionType;

  // ----------------------------------------------------------
  // Evidence validation
  // ----------------------------------------------------------

  if (
    !validateEvidenceRefs(
      answer,
      chunks
    )
  ) {
    answer.evidence_refs =
      [];
  }

  // ----------------------------------------------------------
  // First validation
  // ----------------------------------------------------------

  let validation =
    questionType ===
    "essay"
      ? validateEssay(
          answer
        )
      : validateNonEssayAnswer(
          answer,
          questionType
        );

  let repairCount = 0;

  // ----------------------------------------------------------
  // Repair up to TWO times
  // ----------------------------------------------------------

  while (
    !validation.valid &&
    repairCount < 2
  ) {
    repairCount++;

    const repairPrompt =
      buildRepairPrompt(
        question,
        questionType,
        bookTitle,
        chunks,
        answer,
        validation.problems
      );

    answer =
      await callGeminiStructured(
        systemPrompt,
        repairPrompt
      );

    answer.question_type =
      questionType;

    if (
      !validateEvidenceRefs(
        answer,
        chunks
      )
    ) {
      answer.evidence_refs =
        [];
    }

    validation =
      questionType ===
      "essay"
        ? validateEssay(
            answer
          )
        : validateNonEssayAnswer(
            answer,
            questionType
          );
  }

  // ----------------------------------------------------------
  // Final safety behaviour
  //
  // We do NOT invent missing content in JavaScript.
  //
  // If Gemini somehow fails after the repair passes, we still
  // return the best evidence-grounded answer generated rather
  // than fabricating paragraphs ourselves.
  // ----------------------------------------------------------

  return {
    structured:
      answer,

    repairCount,
  };
}

// ============================================================
// RETRIEVE BOOK EVIDENCE
// ============================================================

async function retrieveEvidence(
  question: string,
  bookTitle: string | null
): Promise<EvidenceChunk[]> {
  const embedding =
    await embedQuery(
      question
    );

  const {
    data,
    error,
  } =
    await supabase.rpc(
      "match_book_chunks",
      {
        query_embedding:
          embedding,

        match_book_title:
          bookTitle,

        match_count:
          MATCH_COUNT,
      }
    );

  if (error) {
    throw new Error(
      `Evidence retrieval failed: ${error.message}`
    );
  }

  if (
    !Array.isArray(data)
  ) {
    return [];
  }

  return cleanEvidence(
    data
  );
}

// ============================================================
// LOG QUESTION
//
// Logging must NEVER make the student request fail.
//
// Therefore this is deliberately fire-and-forget.
// ============================================================

function logQuestion(
  bookTitle: string | null,
  question: string,
  answer: string,
  chunks: EvidenceChunk[],
  questionType: QuestionType,
  repairCount: number
): void {
  supabase
    .from("question_log")
    .insert({
      book_title:
        bookTitle,

      question,

      answer,

      retrieved_chunk_ids:
        chunks.map(
          (
            chunk
          ) =>
            chunk.id
        ),

      // These columns may not exist in your current table.
      // Therefore we DO NOT send them here.
      //
      // Keep the existing schema compatible.
    })
    .then(
      ({
        error,
      }) => {
        if (error) {
          console.error(
            "Question logging failed:",
            error.message
          );
        }
      }
    );
}

// ============================================================
// RESPONSE HELPERS
// ============================================================

function jsonResponse(
  body: unknown,
  status = 200
): Response {
  return new Response(
    JSON.stringify(
      body
    ),
    {
      status,

      headers:
        corsHeaders,
    }
  );
}

// ============================================================
// MAIN EDGE FUNCTION
// ============================================================

Deno.serve(
  async (
    req
  ) => {
    // --------------------------------------------------------
    // CORS preflight
    // --------------------------------------------------------

    if (
      req.method ===
      "OPTIONS"
    ) {
      return new Response(
        "ok",
        {
          headers:
            corsHeaders,
        }
      );
    }

    // --------------------------------------------------------
    // Only POST is allowed
    // --------------------------------------------------------

    if (
      req.method !==
      "POST"
    ) {
      return jsonResponse(
        {
          error:
            "Method not allowed. Use POST.",
        },
        405
      );
    }

    try {
      // ------------------------------------------------------
      // Parse request
      // ------------------------------------------------------

      let body: any;

      try {
        body =
          await req.json();
      } catch {
        return jsonResponse(
          {
            error:
              "Invalid JSON request body.",
          },
          400
        );
      }

      const question =
        cleanString(
          body?.question
        );

      const bookTitle =
        normalizeBookTitle(
          body?.bookTitle
        );

      // ------------------------------------------------------
      // Validate question
      // ------------------------------------------------------

      if (
        !question
      ) {
        return jsonResponse(
          {
            error:
              "Missing 'question' string.",
          },
          400
        );
      }

      // Reasonable upper bound prevents accidental huge requests.
      if (
        question.length >
        10_000
      ) {
        return jsonResponse(
          {
            error:
              "Question is too long.",
          },
          400
        );
      }

      // ------------------------------------------------------
      // Identify question type
      // ------------------------------------------------------

      const questionType =
        detectQuestionType(
          question
        );

      console.log(
        JSON.stringify({
          event:
            "question_received",

          bookTitle,

          questionType,
        })
      );

      // ------------------------------------------------------
      // Retrieve evidence
      // ------------------------------------------------------

      const chunks =
        await retrieveEvidence(
          question,
          bookTitle
        );

      if (
        chunks.length ===
        0
      ) {
        return jsonResponse(
          {
            error:
              "No matching setbook evidence was found. Check the selected book or try rephrasing the question.",
          },
          404
        );
      }

      // ------------------------------------------------------
      // Generate reliable answer
      // ------------------------------------------------------

      const {
        structured,
        repairCount,
      } =
        await generateReliableAnswer(
          question,
          questionType,
          bookTitle ??
            "the selected setbook",
          chunks
        );

      // ------------------------------------------------------
      // Format answer for frontend
      // ------------------------------------------------------

      const answer =
        formatFinalAnswer(
          structured,
          questionType
        );

      // ------------------------------------------------------
      // Final sanity check
      // ------------------------------------------------------

      if (
        !answer ||
        answer.trim()
          .length < 10
      ) {
        throw new Error(
          "Generated answer was empty or unusable."
        );
      }

      // ------------------------------------------------------
      // Log
      // ------------------------------------------------------

      logQuestion(
        bookTitle,
        question,
        answer,
        chunks,
        questionType,
        repairCount
      );

      // ------------------------------------------------------
      // Evidence returned to frontend
      // ------------------------------------------------------

      const evidenceUsed =
        chunks.map(
          (
            chunk
          ) => ({
            id:
              String(
                chunk.id
              ),

            chapter:
              chunk.chapter_label ??
              null,

            similarity:
              chunk.similarity ??
              null,

            excerpt:
              chunk.content
                .slice(
                  0,
                  350
                ) +
              (
                chunk.content
                  .length >
                350
                  ? "…"
                  : ""
              ),
          })
        );

      // ------------------------------------------------------
      // Final response
      // ------------------------------------------------------

      return jsonResponse(
        {
          answer,

          questionType,

          bookTitle,

          repairCount,

          evidenceUsed,
        },
        200
      );
    } catch (
      error
    ) {
      // ------------------------------------------------------
      // Server error
      // ------------------------------------------------------

      console.error(
        "ask-question error:",
        error
      );

      const message =
        error instanceof Error
          ? error.message
          : String(
              error
            );

      return jsonResponse(
        {
          error:
            message,
        },
        500
      );
    }
  }
);
