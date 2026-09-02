import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function askQuestion(question, bookTitle, history = []) {
  const { data, error } = await supabase.functions.invoke("ask-question", {
    body: { question, bookTitle, history },
  });
  if (error) throw error;
  return data;
}

export async function readImage(base64Image, mimeType) {
  const { data, error } = await supabase.functions.invoke("read-image", {
    body: { image: base64Image, mimeType },
  });
  if (error) throw error;
  return data;
}
  // Row-level security already restricts this to the logged-in
  // student's own rows — no user_id filter needed here.
  const { data, error } = await supabase
    .from("question_log")
    .select("id, book_title, question, answer, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}
