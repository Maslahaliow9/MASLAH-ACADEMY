import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase.js";

export default function PendingApproval({ code: initialCode, onApproved, onLogout }) {
  const [checking, setChecking] = useState(false);
  const [code, setCode] = useState(initialCode || null);

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

  useEffect(() => {
    checkStatus();
    // Recheck automatically every 15 seconds so an approved
    // student doesn't have to remember to tap the button.
    const interval = setInterval(checkStatus, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="access-screen">
      <div className="access-card">
        <div className="access-mark">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
            <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1>Waiting for approval</h1>
        <p className="access-sub">
          Your account has been created. Send this code to the founder to get approved:
        </p>

        <div className="approval-code">{code || "…"}</div>

        <p className="access-sub" style={{ marginTop: "0.9rem" }}>
          Once approved, this screen will update automatically — no need to log in again.
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
