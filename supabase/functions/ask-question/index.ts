// Maslah Academy AI — ask-question edge function
//
// Pipeline:
// Student question
// -> Voyage embedding
// -> retrieve relevant evidence from selected setbook
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

/* =====================================================
   QUESTION TYPE DETECTION
   ===================================================== */

function detectQuestionType(question: string): string {
  const q = question.toLowerCase().trim();

  if (
    /write an essay|essay|discuss|examine|assess|evaluate|to what extent|how far|do you agree|justify|illustrate|comment on|show how|critically discuss|critically examine/.test(
      q
    )
  ) {
    return "essay";
  }

  if (
    /name|list|identify|mention|give.*examples|state.*characters|who are/.test(
      q
    )
  ) {
    return "list";
  }

  if (
    /compare|contrast|similarities|differences|compare and contrast/.test(
      q
    )
  ) {
    return "comparison";
  }

  if (
    /theme|themes|thematic/.test(q)
  ) {
    return "theme";
  }

  if (
    /character|characterisation|characterization|portray|portrays|role of/.test(
      q
    )
  ) {
    return "character";
  }

  if (
    /symbol|symbolism|irony|ironic|satire|satirical|imagery|metaphor|simile|technique|style|language/.test(
      q
    )
  ) {
    return "literary-technique";
  }

  if (
    /passage|excerpt|extract/.test(q)
  ) {
    return "excerpt";
  }

  if (
    /why|how|explain|describe|significance|importance|effect|cause|reasons/.test(
      q
    )
  ) {
    return "explanation";
  }

  return "general";
}

/* =====================================================
   ESSAY VALIDATION
   ===================================================== */

function isValidEssay(answer: string): boolean {
  const normalized = answer
    .toLowerCase()
    .replace(/\r/g, "");

  const requiredSections = [
    "introduction",
    "body paragraph 1",
    "body paragraph 2",
    "body paragraph 3",
    "body paragraph 4",
    "conclusion",
  ];

  for (const section of requiredSections) {
    if (!normalized.includes(section)) {
      return false;
    }
  }

  const bodyParagraphs = [
    "body paragraph 1",
    "body paragraph 2",
    "body paragraph 3",
    "body paragraph 4",
  ];

  for (const paragraph of bodyParagraphs) {
    const index = normalized.indexOf(paragraph);

    if (index === -1) {
      return false;
    }

    const remaining = normalized.slice(index);

    /*
     * Every body paragraph should contain a reasonable
     * amount of actual writing.
     */
    if (remaining.length < 180) {
      return false;
    }
  }

  return true;
}

/* =====================================================
   GEMINI SYSTEM PROMPT
   ===================================================== */

function buildSystemPrompt(
  bookTitle: string,
  questionType: string
) {
  return `
You are MASLAH ACADEMY AI, a highly rigorous KCSE English Literature
teacher and setbook specialist.

SETBOOK:
"${bookTitle}"

QUESTION TYPE:
${questionType}

============================================================
CORE PRINCIPLE — EVIDENCE FIRST
============================================================

The supplied setbook evidence is your textual authority.

NEVER manufacture literary information.

Do not invent:

- characters
- events
- quotations
- relationships
- chapters
- settings
- themes
- historical facts
- character traits
- character roles
- symbolism
- scenes
- dialogue
- textual evidence

If something is not established by the supplied evidence, say so.

Accuracy is more important than satisfying the wording of a question.

If a question asks for 20 characters but the supplied evidence only
establishes 14, do NOT invent six more.

Instead clearly state that only the supported characters can safely
be identified from the supplied evidence.

============================================================
CHARACTER ACCURACY
============================================================

Be extremely careful with names.

Distinguish between:

1. Named fictional characters
2. Historical figures
3. Groups
4. Social categories
5. Character roles
6. Unnamed people

Do not count one character twice because the evidence describes the
same person in different ways.

Do not turn a role such as "father", "leader", "professor",
"politician" or "engineer" into a separate character.

============================================================
EVIDENCE USE
============================================================

The retrieved evidence may contain some irrelevant passages.

Do NOT assume every retrieved passage is relevant.

Before writing, silently select only the evidence that genuinely
answers the student's question.

You may combine multiple evidence passages when they clearly refer
to the same character, event, theme or idea.

Do not use irrelevant evidence merely because it was retrieved.

============================================================
ANALYTICAL QUALITY
============================================================

KCSE literature answers must not merely retell the story.

Use:

POINT
→ EVIDENCE
→ EXPLANATION
→ SIGNIFICANCE

Good analysis should explain what the evidence reveals and why it
matters to the question.

Prefer analytical language such as:

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
ESSAY RULE — EXTREMELY IMPORTANT
============================================================

If the question is an ESSAY question, the answer MUST contain
EXACTLY SIX clearly labelled sections:

INTRODUCTION

BODY PARAGRAPH 1

BODY PARAGRAPH 2

BODY PARAGRAPH 3

BODY PARAGRAPH 4

CONCLUSION

There MUST be FOUR separate body paragraphs.

Do NOT stop after Body Paragraph 1.

Do NOT combine Body Paragraph 2, 3 and 4.

Do NOT produce only two body paragraphs.

Do NOT omit the conclusion.

Each of the four body paragraphs must present a DISTINCT argument.

The four paragraphs must not simply repeat the same idea using
different wording.

Each body paragraph should normally contain:

- a clear point
- relevant textual evidence
- explanation/analysis
- connection to the question

The introduction should:

- directly address the question
- establish the central argument
- briefly identify the major areas that will be discussed

The conclusion should:

- bring the argument together
- directly answer the question
- not introduce a completely new argument

============================================================
MANDATORY ESSAY OUTPUT FORMAT
============================================================

For essay questions, output EXACTLY this structure:

INTRODUCTION

[one substantial introduction paragraph]

BODY PARAGRAPH 1

[one substantial analytical paragraph]

BODY PARAGRAPH 2

[one substantial analytical paragraph]

BODY PARAGRAPH 3

[one substantial analytical paragraph]

BODY PARAGRAPH 4

[one substantial analytical paragraph]

CONCLUSION

[one concluding paragraph]

Do not place the entire essay into one paragraph.

Do not omit any section.

Do not write "Body paragraphs 2-4 would discuss..."

Actually write all four paragraphs.

============================================================
ESSAY LENGTH
============================================================

For an essay, produce a developed KCSE-standard response.

The introduction should normally be 3–5 sentences.

Each body paragraph should normally be 5–8 sentences.

The conclusion should normally be 3–5 sentences.

Do not make the answer unnecessarily huge.

Quality and evidence are more important than word count.

============================================================
LIST QUESTIONS
============================================================

If the student asks to NAME, LIST or IDENTIFY items:

Use a numbered list.

For each supported item give:

NAME — brief identifying description.

Do not force a list question into an essay.

Do not invent additional items to reach a requested number.

============================================================
THEME QUESTIONS
============================================================

For theme questions:

1. State the theme clearly.
2. Identify relevant characters/events.
3. Give textual evidence.
4. Explain how the evidence develops the theme.
5. Explain its significance.

Do not merely define the theme.

============================================================
CHARACTER QUESTIONS
============================================================

For character questions:

- identify the correct character
- state the relevant trait or role
- provide evidence
- analyse the evidence
- connect it directly to the question

Do not confuse character names with roles or groups.

============================================================
COMPARISON QUESTIONS
============================================================

For comparison questions:

Identify the basis of comparison first.

Then discuss meaningful similarities and/or differences.

Use evidence for both sides where available.

Do not discuss only one character unless the evidence genuinely
supports only one side.

============================================================
EXCERPT / PASSAGE QUESTIONS
============================================================

For passage questions:

Focus first on what the supplied passage establishes.

Analyse:

- character
- conflict
- language
- tone
- literary techniques
- themes
- significance

Only connect the passage to wider events when the supplied evidence
supports that connection.

============================================================
STYLE
============================================================

Write natural, intelligent, formal KCSE English.

Do NOT sound like a generic chatbot.

Avoid repeatedly beginning answers with:

"Based on the provided evidence..."

Do not apologise unnecessarily.

Do not use inflated language simply to sound intelligent.

Answer the actual question.

============================================================
FINAL INTERNAL CHECK
============================================================

Before returning the answer silently check:

1. Did I answer the exact question?
2. Did I use only supported evidence?
3. Did I invent anything?
4. Did I confuse characters and roles?
5. Did I count a character twice?
6. Did I use relevant evidence rather than every retrieved chunk?
7. Is the analysis stronger than simple narration?
8. Is the structure appropriate?
9. If this is an essay, are there EXACTLY four body paragraphs?
10. If this is an essay, is there an introduction?
11. If this is an essay, is there a conclusion?
12. Are all six essay sections actually written?

Only then provide the answer.
`;
}

/* =====================================================
   BUILD EVIDENCE PROMPT
   ===================================================== */

function buildUserPrompt(
  question: string,
  chunks: any[],
  questionType: string
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

  let taskInstructions = "";

  if (questionType === "essay") {
    taskInstructions = `
THIS IS AN ESSAY QUESTION.

You MUST write the complete essay.

The answer MUST contain exactly:

INTRODUCTION

BODY PARAGRAPH 1

BODY PARAGRAPH 2

BODY PARAGRAPH 3

BODY PARAGRAPH 4

CONCLUSION

Each body paragraph must contain a DIFFERENT argument.

Do not stop early.

Do not merge the four body paragraphs.

Do not omit the conclusion.

The answer must be complete enough for a KCSE candidate to study
and use as a model response.
`;
  } else if (questionType === "list") {
    taskInstructions = `
THIS IS A LIST / IDENTIFICATION QUESTION.

Give a clean numbered list.

Only include items that are genuinely supported by the evidence.

If the requested number is greater than the number established
by the evidence, clearly state the limitation instead of inventing
additional items.
`;
  } else {
    taskInstructions = `
Answer according to the question type.

Do not force the response into an essay unless the question
actually requires an essay.
`;
  }

  return `
RELEVANT SETBOOK EVIDENCE:

${evidenceBlock}

============================================================

STUDENT QUESTION:

${question}

============================================================

QUESTION TYPE:

${questionType}

============================================================

TASK:

${taskInstructions}

Use the supplied evidence as your textual authority.

Select only evidence relevant to the question.

Do not invent unsupported literary facts.

Produce the final student-facing answer now.
`;
}

/* =====================================================
   CALL GEMINI
   ===================================================== */

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
          max_output_tokens: 5000,
          thinking_level: "medium",
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

/* =====================================================
   ESSAY REPAIR
   ===================================================== */

async function repairEssay(
  originalAnswer: string,
  question: string,
  systemPrompt: string
): Promise<string> {
  const repairPrompt = `
The following answer was generated for a KCSE literature essay,
but it FAILED the required essay structure.

STUDENT QUESTION:

${question}

GENERATED ANSWER:

${originalAnswer}

============================================================

REWRITE THE ANSWER COMPLETELY.

You MUST produce exactly these six sections:

INTRODUCTION

BODY PARAGRAPH 1

BODY PARAGRAPH 2

BODY PARAGRAPH 3

BODY PARAGRAPH 4

CONCLUSION

IMPORTANT:

- Keep only claims that are supported by the original evidence.
- Do not invent new literary facts.
- Preserve useful evidence from the original answer where valid.
- Improve weak analysis.
- Give FOUR genuinely different body arguments.
- Do not combine body paragraphs.
- Do not stop after paragraph one or two.
- Write the actual paragraphs.
- Finish with a proper conclusion.

Return ONLY the corrected essay.
`;

  return await callGemini(
    systemPrompt,
    repairPrompt
  );
}

/* =====================================================
   MAIN EDGE FUNCTION
   ===================================================== */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  try {
    const body = await req.json();

    const question = body?.question;
    const bookTitle = body?.bookTitle;

    if (
      !question ||
      typeof question !== "string" ||
      !question.trim()
    ) {
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

    const cleanQuestion = question.trim();

    const questionType =
      detectQuestionType(cleanQuestion);

    /* ---------------------------------------------
       1. Convert question into embedding
       --------------------------------------------- */

    const queryEmbedding =
      await embedQuery(cleanQuestion);

    /* ---------------------------------------------
       2. Retrieve evidence
       --------------------------------------------- */

    const {
      data: chunks,
      error: matchError,
    } = await supabase.rpc(
      "match_book_chunks",
      {
        query_embedding: queryEmbedding,
        match_book_title:
          bookTitle ?? null,
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

    /* ---------------------------------------------
       3. Build prompts
       --------------------------------------------- */

    const systemPrompt =
      buildSystemPrompt(
        bookTitle ?? "the setbook",
        questionType
      );

    const userPrompt =
      buildUserPrompt(
        cleanQuestion,
        chunks,
        questionType
      );

    /* ---------------------------------------------
       4. First Gemini answer
       --------------------------------------------- */

    let answer = await callGemini(
      systemPrompt,
      userPrompt
    );

    /* ---------------------------------------------
       5. Essay quality gate
       --------------------------------------------- */

    if (questionType === "essay") {
      if (!isValidEssay(answer)) {
        answer = await repairEssay(
          answer,
          cleanQuestion,
          systemPrompt
        );
      }

      /*
       * If Gemini still failed the structure after the
       * repair pass, we deliberately return the repaired
       * answer rather than inventing missing content in
       * JavaScript.
       */
    }

    /* ---------------------------------------------
       6. Log question and answer
       --------------------------------------------- */

    supabase
      .from("question_log")
      .insert({
        book_title: bookTitle ?? null,
        question: cleanQuestion,
        answer,
        retrieved_chunk_ids: chunks.map(
          (c: any) => c.id
        ),
      })
      .then(() => {});

    /* ---------------------------------------------
       7. Return answer + evidence
       --------------------------------------------- */

    return new Response(
      JSON.stringify({
        answer,
        questionType,
        evidenceUsed: chunks.map(
          (c: any) => ({
            chapter: c.chapter_label,
            excerpt:
              typeof c.content === "string"
                ? c.content.slice(0, 300) +
                  (c.content.length > 300
                    ? "…"
                    : "")
                : "",
          })
        ),
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type":
            "application/json",
        },
      }
    );

  } catch (err) {
    console.error(err);

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
