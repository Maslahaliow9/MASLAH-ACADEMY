import { useState, useRef, useEffect } from "react";
import { askQuestion, readImage, supabase } from "./lib/supabase.js";
import Auth from "./Auth.jsx";
import History from "./History.jsx";
import About from "./About.jsx";
import AccessGate from "./AccessGate.jsx";

const BOOKS = ["The Samaritan", "Fathers of Nations", "A Silent Song and Other Stories"];

const STARTER_PROMPTS = [
  "Discuss the theme of betrayal.",
  "Analyze the character of the protagonist.",
  "Explain the significance of the title.",
  "Comment on the writer's use of irony.",
];

const LOADING_MESSAGES = [
  "Reading the evidence…",
  "Checking the setbook…",
  "Drafting the answer…",
];

export default function App() {
  return (
    <AccessGate>
      <MaslahApp />
    </AccessGate>
  );
}

function MaslahApp() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = logged out
  const [view, setView] = useState("chat"); // "chat" | "history" | "about"
  const [book, setBook] = useState(BOOKS[0]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingImage, setPendingImage] = useState(null); // { previewUrl, base64, mimeType, source }
  const [extracting, setExtracting] = useState(false);
  const [imageError, setImageError] = useState("");
  const scrollRef = useRef(null);
  const cameraInputRef = useRef(null);
  const uploadInputRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

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

  const [loadingStep, setLoadingStep] = useState(0);

  useEffect(() => {
    if (!loading) {
      setLoadingStep(0);
      return;
    }
    const interval = setInterval(() => {
      setLoadingStep((s) => (s + 1) % LOADING_MESSAGES.length);
    }, 1800);
    return () => clearInterval(interval);
  }, [loading]);

  async function handleSubmit(question, questionBook) {
    if (loading || extracting) return;

    const typed = (question ?? input).trim();
    if (!typed && !pendingImage) return;

    const targetBook = questionBook ?? book;
    if (questionBook && questionBook !== book) setBook(questionBook);
    setView("chat");

    const imageForBubble = pendingImage?.previewUrl ?? null;
    let finalQuestion = typed;

    // A photo is attached — transcribe it, then combine the extracted
    // text with whatever the student wrote underneath (if anything)
    // before sending the combined question onward as before.
    if (pendingImage) {
      setExtracting(true);
      try {
        const data = await readImage(pendingImage.base64, pendingImage.mimeType);
        const extracted = data?.text?.trim();
        finalQuestion = extracted
          ? typed
            ? `${extracted}\n\n${typed}`
            : extracted
          : typed;
      } catch (err) {
        console.error(err);
        setExtracting(false);
        setImageError("Couldn't read that photo — please try again, or remove it and type the question instead.");
        return;
      }
      setExtracting(false);
    }

    if (!finalQuestion.trim()) return;

    setInput("");
    setPendingImage(null);
    setImageError("");
    setMessages((m) => [
      ...m,
      { role: "student", text: typed, image: imageForBubble, book: targetBook },
    ]);
    setLoading(true);
    try {
      // Send recent conversation so the AI can resolve follow-up
      // questions about a passage pasted earlier without the
      // student needing to repaste it every time.
      const recentHistory = messages
        .filter((m) => m.role === "student" || m.role === "assistant")
        .slice(-6)
        .map((m) => ({ role: m.role, text: m.text }));

      const data = await askQuestion(finalQuestion, targetBook, recentHistory);
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

  // Loads a chosen/captured photo into the preview card — no OCR yet.
  // Transcription only happens once the student actually hits submit,
  // so they get a chance to review, retake, remove, or annotate first.
  async function handleImageFile(file, source) {
    if (!file) return;
    setImageError("");
    try {
      // Phone camera photos are often several MB, which can exceed
      // the edge function's request size limit once base64-encoded
      // (roughly +33% larger) — silently causing the request to be
      // dropped. Shrinking to a reasonable max dimension keeps the
      // upload small and fast without hurting text readability.
      const resizedBlob = await resizeImage(file, 1600, 0.75);
      const previewUrl = URL.createObjectURL(resizedBlob);

      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(resizedBlob);
      });

      setPendingImage((prev) => {
        if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
        return { previewUrl, base64, mimeType: "image/jpeg", source };
      });
    } catch (err) {
      console.error(err);
      setImageError("Couldn't load that photo — please try again.");
    }
  }

  function removeImage() {
    setPendingImage((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    setImageError("");
  }

  function retakeImage() {
    const source = pendingImage?.source;
    removeImage();
    if (source === "camera") cameraInputRef.current?.click();
    else uploadInputRef.current?.click();
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
              <span className="book-pill-icon">{b[0]}</span>
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
            {m.role === "student" && (
              <div className="bubble student">
                {m.image && <img className="bubble-image" src={m.image} alt="Submitted question material" />}
                {m.text && <div>{m.text}</div>}
              </div>
            )}
            {m.role === "error" && <div className="bubble error">{m.text}</div>}
            {m.role === "assistant" && (
              <div className="bubble assistant">
                <div className="answer-label">Maslah AI — {m.book}</div>
                <div className="answer-text">
                  {m.text
                    .split(/\n{2,}/)
                    .filter((p) => p.trim())
                    .map((paragraph, k) => (
                      <p key={k} className="answer-paragraph">
                        {paragraph}
                      </p>
                    ))}
                </div>
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
              <span className="loading-text">{LOADING_MESSAGES[loadingStep]}</span>
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
            handleImageFile(e.target.files?.[0], "camera");
            e.target.value = "";
          }}
        />
        <input
          type="file"
          accept="image/*"
          ref={uploadInputRef}
          style={{ display: "none" }}
          onChange={(e) => {
            handleImageFile(e.target.files?.[0], "upload");
            e.target.value = "";
          }}
        />

        {pendingImage && (
          <div className="image-preview-card">
            <img className="image-preview-thumb" src={pendingImage.previewUrl} alt="Selected question material" />
            <div className="image-preview-meta">
              <span className="image-preview-label">Photo attached</span>
              <div className="image-preview-actions">
                <button type="button" className="image-preview-action" onClick={retakeImage} disabled={extracting}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-3-6.7" />
                    <polyline points="21 3 21 9 15 9" />
                  </svg>
                  {pendingImage.source === "camera" ? "Retake" : "Replace"}
                </button>
                <button type="button" className="image-preview-action remove" onClick={removeImage} disabled={extracting}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                  Remove
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="composer-row">
          <button
            type="button"
            className="photo-btn"
            title="Take a photo of a question"
            disabled={extracting}
            onClick={() => cameraInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8h3l1.4-2.1a1 1 0 0 1 .83-.44h5.54a1 1 0 0 1 .83.44L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
              <circle cx="12" cy="13.2" r="3.3" />
            </svg>
          </button>
          <button
            type="button"
            className="photo-btn"
            title="Upload a photo"
            disabled={extracting}
            onClick={() => uploadInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
              <circle cx="8.7" cy="9.7" r="1.4" fill="currentColor" stroke="none" />
              <path d="M20 15.2l-4.3-4.3a1.4 1.4 0 0 0-2 0L7 17.5" />
            </svg>
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              extracting
                ? "Reading your photo…"
                : pendingImage
                ? "Add a note or instruction (optional)…"
                : `Ask a question on ${book}...`
            }
            rows={1}
            disabled={extracting}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <button type="submit" disabled={loading || extracting || (!input.trim() && !pendingImage)}>
            {extracting ? "Reading…" : "Ask"}
          </button>
        </div>
      </form>
      {imageError && <p className="image-error">{imageError}</p>}
    </div>
  );
}
