import { useEffect, useState } from "react";
import { getHistory } from "./lib/supabase.js";

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function History({ onBack, onReuse }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    getHistory()
      .then(setEntries)
      .catch((err) => setError(err.message || "Could not load your history."));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <button className="back-btn" onClick={onBack} aria-label="Back">
            ←
          </button>
          <div>
            <h1>Your Question History</h1>
            <p className="tagline">Everything you've asked, saved privately to your account</p>
          </div>
        </div>
      </header>

      <main className="chat">
        {error && <div className="bubble error">{error}</div>}

        {entries === null && !error && (
          <p className="hint" style={{ textAlign: "center", marginTop: "2rem" }}>
            Loading your history…
          </p>
        )}

        {entries?.length === 0 && (
          <div className="empty-state">
            <h2>No questions yet</h2>
            <p className="hint">Anything you ask will show up here, saved just for you.</p>
          </div>
        )}

        {entries?.map((entry) => {
          const isOpen = openId === entry.id;
          return (
            <div key={entry.id} className="history-entry">
              <button
                className="history-entry-header"
                onClick={() => setOpenId(isOpen ? null : entry.id)}
              >
                <div>
                  <span className="history-book">{entry.book_title}</span>
                  <p className="history-question">{entry.question}</p>
                </div>
                <span className="history-date">{formatDate(entry.created_at)}</span>
              </button>

              {isOpen && (
                <div className="history-answer">
                  <div className="answer-text">{entry.answer}</div>
                  <button
                    className="starter"
                    style={{ marginTop: "0.8rem" }}
                    onClick={() => onReuse?.(entry.question, entry.book_title)}
                  >
                    Ask this again
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </main>
    </div>
  );
}
