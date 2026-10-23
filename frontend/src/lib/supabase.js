import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Pull the real message out of a failed function call.
async function realError(error) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return new Error(body.error);
  } catch {
    /* fall through */
  }
  return error;
}

// Camera photo / uploaded picture -> clean JPEG data URL
// (fixes rotation, shrinks to 1800px, keeps the data:image/jpeg;base64, prefix)
export async function prepareImage(file, maxSide = 1800) {
  const MAX_CHARS = 5_500_000; // server limit is 6,000,000
  const readRaw = () =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("Could not read that image."));
      r.readAsDataURL(file);
    });

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const raw = await readRaw();
    if (raw.length > MAX_CHARS) {
      throw new Error("That photo is too large or in an unsupported format. Please take it again as JPG or PNG.");
    }
    return raw;
  }

  let scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  let quality = 0.88;
  for (let attempt = 0; attempt < 5; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= MAX_CHARS) {
      bitmap.close?.();
      return url;
    }
    scale *= 0.8;
    quality = Math.max(0.6, quality - 0.08);
  }
  bitmap.close?.();
  throw new Error("That photo is too large. Please move closer to the page and take it again.");
}

// .txt file -> string for the `fileText` field
export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Could not read that file."));
    r.readAsText(file);
  });
}

// PDF / Word file -> { name, type, data } for the `files` field
export function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, type: file.type, data: r.result });
    r.onerror = () => reject(new Error("Could not read that file."));
    r.readAsDataURL(file);
  });
}

// MAIN CALL. askQuestion(q, book, history) still works as before.
//   askQuestion(q, book, history, {
//     images: [dataUrl, ...],   // from prepareImage(), max 3
//     fileText: "...",          // from readTextFile()
//     files: [{...}],           // from fileToPayload()
//     debug: true,              // optional: adds data.diagnostics
//   })
// Reply may include data.transcribedQuestion and data.ocrWarnings.
export async function askQuestion(question, bookTitle, history = [], extras = {}) {
  const body = { question: question || "", bookTitle, history };
  if (extras.images?.length) body.images = extras.images;
  if (extras.fileText) body.fileText = extras.fileText;
  if (extras.files?.length) body.files = extras.files;
  if (extras.debug) body.debug = true;

  const { data, error } = await supabase.functions.invoke("ask-question", { body });
  if (error) throw await realError(error);
  if (data?.error) throw new Error(data.error);
  return data;
}

// DEPRECATED: ask-question now reads photos itself. Kept so old code doesn't crash.
export async function readImage(base64Image, mimeType) {
  const { data, error } = await supabase.functions.invoke("read-image", {
    body: { image: base64Image, mimeType },
  });
  if (error) throw await realError(error);
  return data;
}

export async function getHistory() {
  // Row-level security already restricts this to the logged-in
  // student's own rows — no user_id filter needed here.
  const { data, error } = await supabase
    .from("question_log")
    .select("id, book_title, question, answer, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}
