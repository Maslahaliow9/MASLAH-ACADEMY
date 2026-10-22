import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ------------------------------------------------------------------
// Image preparation (camera / upload)
// Turns a File, Blob, data URL or raw base64 string into a full
// "data:image/jpeg;base64,..." URL, corrected for phone-camera rotation,
// resized to a readable size (long side <= 2000px) and compressed to stay
// under the request size limit WITHOUT shrinking text into mush.
// ------------------------------------------------------------------
const MAX_SIDE = 2000;
const MAX_BYTES = 3_500_000; // approx. encoded size we allow per image

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read the image file."));
    r.readAsDataURL(blob);
  });
}

async function loadBitmap(blob) {
  // imageOrientation applies the EXIF rotation so sideways phone photos
  // are upright before the vision model sees them.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode the image."));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function prepareImage(input) {
  let blob;
  if (typeof input === "string") {
    const full = input.startsWith("data:") ? input : `data:image/jpeg;base64,${input}`;
    blob = dataUrlToBlob(full);
  } else {
    blob = input;
  }

  const bmp = await loadBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // avoids black backgrounds on transparent PNGs
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(bmp, 0, 0, cw, ch);
  if (bmp.close) bmp.close();

  let quality = 0.92;
  let out = canvas.toDataURL("image/jpeg", quality);
  while (out.length > MAX_BYTES && quality > 0.6) {
    quality -= 0.08;
    out = canvas.toDataURL("image/jpeg", quality);
  }
  return out;
}

// Pulls the real error text out of a failed edge-function call.
async function unwrapInvokeError(error) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error || body?.message) {
      return new Error(String(body.error || body.message));
    }
  } catch {
    /* ignore */
  }
  return error;
}

// images: array of File | Blob | data URL | base64 string (optional)
// options: { files, fileText, debug } (optional, passed straight through)
export async function askQuestion(question, bookTitle, history = [], images = [], options = {}) {
  const list = Array.isArray(images) ? images : images ? [images] : [];
  const prepared = [];
  for (const img of list) {
    if (!img) continue;
    prepared.push(await prepareImage(img));
  }

  const body = { question, bookTitle, history, ...options };
  if (prepared.length) {
    body.images = prepared; // full data URLs, prefix kept
    body.image = prepared[0]; // legacy single-image field
  }

  const { data, error } = await supabase.functions.invoke("ask-question", { body });
  if (error) throw await unwrapInvokeError(error);
  return data;
}

export async function readImage(base64Image, mimeType) {
  const { data, error } = await supabase.functions.invoke("read-image", {
    body: { image: base64Image, mimeType },
  });
  if (error) throw await unwrapInvokeError(error);
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
