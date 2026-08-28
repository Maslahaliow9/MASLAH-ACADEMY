import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function askQuestion(question, bookTitle) {
  const { data, error } = await supabase.functions.invoke("ask-question", {
    body: { question, bookTitle },
  });
  if (error) throw error;
  return data;
}
