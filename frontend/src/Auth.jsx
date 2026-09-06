import { useState } from "react";
import { supabase } from "./lib/supabase.js";

export default function Auth({ onAuthed, onPendingApproval }) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }
    setLoading(true);
    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.functions.invoke("signup", {
          body: { email: email.trim(), password },
        });
        if (signUpError) throw signUpError;
        if (data?.error) throw new Error(data.error);

        // Account created — now log them in, but the app will show
        // a "pending approval" screen until the founder approves
        // their code.
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
        onPendingApproval?.(data.code);
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
        onAuthed?.();
      }
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div>
            <h1>Maslah Academy AI</h1>
            <p className="tagline">Evidence-based KCSE setbook answers</p>
          </div>
        </div>

        <div className="auth-tabs">
          <button
            className={`auth-tab ${mode === "login" ? "active" : ""}`}
            onClick={() => {
              setMode("login");
              setError("");
              setNotice("");
            }}
            type="button"
          >
            Log in
          </button>
          <button
            className={`auth-tab ${mode === "signup" ? "active" : ""}`}
            onClick={() => {
              setMode("signup");
              setError("");
              setNotice("");
            }}
            type="button"
          >
            Create account
          </button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
          </label>

          {mode === "signup" && (
            <p className="auth-notice" style={{ marginTop: "-0.3rem" }}>
              After creating your account, you'll get a code to send to the founder for approval before you can start asking questions.
            </p>
          )}

          {error && <p className="auth-error">{error}</p>}
          {notice && <p className="auth-notice">{notice}</p>}

          <button type="submit" disabled={loading} className="auth-submit">
            {loading ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
          </button>
        </form>
      </div>
    </div>
  );
}
