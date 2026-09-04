import { useState } from "react";

// A single shared access code gates the entire application before
// anything else loads (including the login screen). Once entered
// correctly, it's remembered on this device so returning students
// aren't asked again.
const ACCESS_CODE = "Maslahaliow1010101010";
const STORAGE_KEY = "maslah_access_granted";

export default function AccessGate({ children }) {
  const [granted, setGranted] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    if (code === ACCESS_CODE) {
      try {
        localStorage.setItem(STORAGE_KEY, "true");
      } catch {
        // Storage unavailable (e.g. private browsing) — access still
        // works for this session, it just won't be remembered.
      }
      setGranted(true);
    } else {
      setError("Incorrect access code. Please try again.");
      setCode("");
    }
  }

  if (granted) return children;

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div>
            <h1>Maslah Academy AI</h1>
            <p className="tagline">Private access</p>
          </div>
        </div>

        <p className="access-intro">
          This application is restricted to enrolled students. Enter your
          access code to continue.
        </p>

        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            Access code
            <input
              type="password"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setError("");
              }}
              placeholder="Enter access code"
              autoComplete="off"
              autoFocus
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="auth-submit" disabled={!code.trim()}>
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
