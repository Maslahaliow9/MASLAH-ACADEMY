import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase.js";

export default function PendingApproval({ code: initialCode, onApproved, onLogout }) {
  const [checking, setChecking] = useState(false);
  const [code, setCode] = useState(initialCode || null);
  const [copied, setCopied] = useState(false);

  async function checkStatus() {
    setChecking(true);
    try {
      const { data, error } = await supabase
        .from("approval_requests")
        .select("code, approved")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        if (!code) setCode(data.code);
        if (data.approved) {
          onApproved?.();
          return;
        }
      }
    } finally {
      setChecking(false);
    }
  }

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    checkStatus();
    // Recheck every 15 seconds so an approved student doesn't have
    // to remember to tap the button.
    const interval = setInterval(checkStatus, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="access-screen">
      <div className="access-card">
        <div className="access-mark">
          <img src="/logo-mark.png" alt="Maslah Academy AI" />
        </div>

        <h1>Almost there</h1>
        <p className="access-sub">
          Your account is created. Send this code to the founders and they'll approve you
          shortly.
        </p>

        <div className="approval-code">{code || "…"}</div>

        <button type="button" className="pending-logout" onClick={copyCode} disabled={!code}>
          {copied ? "Copied ✓" : "Copy code"}
        </button>

        <p className="access-sub" style={{ marginTop: "1rem" }}>
          This screen updates automatically once you're approved. No need to log in again.
        </p>

        <button type="button" className="access-form-btn" onClick={checkStatus} disabled={checking}>
          {checking ? "Checking…" : "Check status now"}
        </button>

        <button type="button" className="pending-logout" onClick={onLogout}>
          Log out
        </button>
      </div>
    </div>
  );
}
