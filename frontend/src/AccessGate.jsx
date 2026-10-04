import { useState } from "react";

// A shared access code gates the app before anything else loads.
// Only a SHA-256 fingerprint of the code is stored here, so the
// code itself can't be read out of the app's source.
// To change the code: printf '%s' 'newcode' | sha256sum
const ACCESS_CODE_HASH = "d23c8458dc6133eeab527d95e840fb8863fdaf3f31faed37fdd6b176764728aa";
const STORAGE_KEY = "maslah_access_granted";

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Lets App.jsx check on load whether access was already granted on
// this device. Reads the same storage key the component uses.
export function hasAccess() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export default function AccessGate({ children, onGranted }) {
  const [granted, setGranted] = useState(() => hasAccess());
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!code.trim() || checking) return;
    setChecking(true);
    try {
      const hash = await sha256Hex(code.trim());
      if (hash === ACCESS_CODE_HASH) {
        try {
          localStorage.setItem(STORAGE_KEY, "true");
        } catch {
          // Storage unavailable (e.g. private browsing) — access still
          // works for this session, it just won't be remembered.
        }
        setGranted(true);
        onGranted?.();
      } else {
        setError("That access code isn't correct. Please try again.");
        setCode("");
      }
    } catch {
      setError("Couldn't verify the code on this browser. Please try another browser.");
    } finally {
      setChecking(false);
    }
  }

  if (granted && children) return children;
  if (granted) return null;

  return (
    <div className="access-screen">
      <div className="access-card">
        <div className="access-mark">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="5" y="10.5" width="14" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.7" />
            <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <circle cx="12" cy="15.2" r="1.2" fill="currentColor" />
          </svg>
        </div>

        <h1>Maslah Academy AI</h1>
        <p className="access-sub">
          Private access for enrolled students. Enter your access code to continue.
        </p>

        <form onSubmit={handleSubmit} className="access-form">
          <input
            type="password"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError("");
            }}
            placeholder="Access code"
            autoComplete="off"
            autoFocus
            aria-label="Access code"
          />
          {error && <p className="access-error">{error}</p>}
          <button type="submit" disabled={!code.trim() || checking}>
            {checking ? "Checking…" : "Continue"}
          </button>
        </form>

        <p className="access-footnote">Don't have a code? Ask the founders.</p>
      </div>
    </div>
  );
}
