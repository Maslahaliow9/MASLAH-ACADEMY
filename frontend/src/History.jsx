import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getHistory } from "./lib/supabase.js";

function formatDate(iso) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}

export default function History({ onBack, onReuse }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    getHistory()
      .then(setEntries)
      .catch((err) => setError(err.message || "Could not load your history."));
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = entries
    ? q
      ? entries.filter(
          (e) =>
            e.question.toLowerCase().includes(q) ||
            e.book_title.toLowerCase().includes(q) ||
            e.answer.toLowerCase().includes(q)
        )
      : entries
    : null;

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

        {entries?.length > 4 && (
          <input
            type="text"
            className="bookmark-search"
            placeholder="Search your questions and answers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}

        {filtered?.length === 0 && entries?.length > 0 && (
          <p className="overlay-empty" style={{ textAlign: "center" }}>
            Nothing matches "{query}".
          </p>
        )}

        {filtered?.map((entry) => {
          const isOpen = openId === entry.id;
          return (
            <div key={entry.id} className="history-entry">
              <button
                className="history-entry-header"
                onClick={() => setOpenId(isOpen ? null : entry.id)}
                aria-expanded={isOpen}
              >
                <div style={{ minWidth: 0 }}>
                  <span className="history-book">{entry.book_title}</span>
                  <p className={`history-question ${isOpen ? "" : "clamped"}`}>{entry.question}</p>
                </div>
                <span className="history-date">{formatDate(entry.created_at)}</span>
              </button>

              {isOpen && (
                <div className="history-answer">
                  <div className="markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.answer}</ReactMarkdown>
                  </div>
                  <button
                    className="starter"
                    style={{ marginTop: "0.8rem", opacity: 1, animation: "none" }}
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
