import { useState, useRef, useEffect } from "react";
import { askQuestion, readImage, supabase } from "./lib/supabase.js";
import Auth from "./Auth.jsx";
import History from "./History.jsx";
import About from "./About.jsx";

const BOOKS = ["The Samaritan", "Fathers of Nations", "A Silent Song and Other Stories"];

const STARTER_PROMPTS = [
  "Discuss the theme of betrayal.",
  "Analyze the character of the protagonist.",
  "Explain the significance of the title.",
  "Comment on the writer's use of irony.",
];

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = logged out
  const [view, setView] = useState("chat"); // "chat" | "history" | "about"
  const [book, setBook] = useState(BOOKS[0]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [readingImage, setReadingImage] = useState(false);
  const [imageError, setImageError] = useState("");
  const scrollRef = useRef(null);
  const cameraInputRef = useRef(null);
  const uploadInputRef = useRef(null);

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
      // Send recent conversation so the AI can resolve follow-up
      // questions about a passage pasted earlier without the
      // student needing to repaste it every time.
      const recentHistory = messages
        .filter((m) => m.role === "student" || m.role === "assistant")
        .slice(-6)
        .map((m) => ({ role: m.role, text: m.text }));

      const data = await askQuestion(q, targetBook, recentHistory);
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

  async function handleImageFile(file) {
    if (!file) return;
    setImageError("");
    setReadingImage(true);
    try {
      // Phone camera photos are often several MB, which can exceed
      // the edge function's request size limit once base64-encoded
      // (roughly +33% larger) — silently causing the request to be
      // dropped. Shrinking to a reasonable max dimension keeps the
      // upload small and fast without hurting text readability.
      const resizedBlob = await resizeImage(file, 1600, 0.75);

      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(resizedBlob);
      });
      const data = await readImage(base64, "image/jpeg");
      setInput((prev) => (prev ? `${prev}\n${data.text}` : data.text));
    } catch (err) {
      console.error(err);
      setImageError("Couldn't read that photo — please try again or type the question instead.");
    } finally {
      setReadingImage(false);
    }
  }

  // Resizes/compresses an image file down to a max dimension and
  // JPEG quality, returning a Blob — keeps photo uploads small.
  function resizeImage(file, maxDimension, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(objectUrl);

        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Could not process that image."))),
          "image/jpeg",
          quality,
        );
      };

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Could not load that image."));
      };

      img.src = objectUrl;
    });
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

  if (view === "about") {
    return <About onBack={() => setView("chat")} />;
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
          <button className="history-btn" onClick={() => setView("about")}>
            About
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
        <input
          type="file"
          accept="image/*"
          capture="environment"
          ref={cameraInputRef}
          style={{ display: "none" }}
          onChange={(e) => {
            handleImageFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <input
          type="file"
          accept="image/*"
          ref={uploadInputRef}
          style={{ display: "none" }}
          onChange={(e) => {
            handleImageFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="photo-btn"
          title="Take a photo of a question"
          disabled={readingImage}
          onClick={() => cameraInputRef.current?.click()}
        >
          📷
        </button>
        <button
          type="button"
          className="photo-btn"
          title="Upload a photo"
          disabled={readingImage}
          onClick={() => uploadInputRef.current?.click()}
        >
          🖼️
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={readingImage ? "Reading text from your photo…" : `Ask a question on ${book}...`}
          rows={1}
          disabled={readingImage}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <button type="submit" disabled={loading || readingImage || !input.trim()}>
          Ask
        </button>
      </form>
      {imageError && <p className="image-error">{imageError}</p>}
    </div>
  );
}
