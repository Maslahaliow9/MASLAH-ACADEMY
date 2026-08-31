import { useState, useRef, useEffect } from "react";
import { askQuestion, supabase } from "./lib/supabase.js";
import Auth from "./Auth.jsx";
import History from "./History.jsx";

const BOOKS = ["The Samaritan", "Fathers of Nations"];

const STARTER_PROMPTS = [
  "Discuss the theme of betrayal.",
  "Analyze the character of the protagonist.",
  "Explain the significance of the title.",
  "Comment on the writer's use of irony.",
];

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = logged out
  const [view, setView] = useState("chat"); // "chat" | "history"
  const [book, setBook] = useState(BOOKS[0]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function handleSubmit(question, questionBook) {
    const q = (question ?? input).trim();
    if (!q || loading) return;
    const targetBook = questionBook ?? book;
    if (questionBook && questionBook !== book) setBook(questionBook);
    setView("chat");
    setInput("");
    setMessages((m) => [...m, { role: "student", text: q, book: targetBook }]);
    setLoading(true);
    try {
      const data = await askQuestion(q, targetBook);
      setMessages((m) => [
        ...m,
        { role: "assistant", text: data.answer, evidence: data.evidenceUsed, book: targetBook },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "error", text: "Something went wrong retrieving that answer. Please try again.", book: targetBook },
      ]);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  // Still checking whether a session already exists (avoids a login-screen flash on reload)
  if (session === undefined) {
    return <div className="auth-screen" />;
  }

  // Not logged in — show the login/signup screen and gate everything else
  if (!session) {
    return <Auth onAuthed={() => {}} />;
  }

  if (view === "history") {
    return (
      <History
        onBack={() => setView("chat")}
        onReuse={(question, questionBook) => handleSubmit(question, questionBook)}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div>
            <h1>Maslah Academy AI</h1>
            <p className="tagline">Evidence-based KCSE setbook answers</p>
          </div>
          <button className="history-btn" onClick={() => setView("history")}>
            History
          </button>
          <button className="logout-btn" onClick={() => supabase.auth.signOut()}>
            Log out
          </button>
        </div>
        <div className="book-select">
          {BOOKS.map((b) => (
            <button
              key={b}
              className={`book-pill ${b === book ? "active" : ""}`}
              onClick={() => setBook(b)}
            >
              {b}
            </button>
          ))}
        </div>
      </header>

      <main className="chat" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            <p className="eyebrow">Currently studying</p>
            <h2>{book}</h2>
            <p className="hint">
              Ask an essay question, an excerpt-based question, or a question on character,
              theme, or style. Every answer is built from evidence in the actual text.
            </p>
            <div className="starters">
              {STARTER_PROMPTS.map((p) => (
                <button key={p} className="starter" onClick={() => handleSubmit(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`bubble-row ${m.role}`}>
            {m.role === "student" && <div className="bubble student">{m.text}</div>}
            {m.role === "error" && <div className="bubble error">{m.text}</div>}
            {m.role === "assistant" && (
              <div className="bubble assistant">
                <div className="answer-label">Maslah AI — {m.book}</div>
                <div className="answer-text">{m.text}</div>
                {m.evidence?.length > 0 && (
                  <details className="evidence">
                    <summary>Evidence used ({m.evidence.length})</summary>
                    <ul>
                      {m.evidence.map((e, j) => (
                        <li key={j}>
                          {e.chapter && <strong>{e.chapter}: </strong>}
                          {e.excerpt}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="bubble-row assistant">
            <div className="bubble assistant loading">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}
      </main>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Ask a question on ${book}...`}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}
