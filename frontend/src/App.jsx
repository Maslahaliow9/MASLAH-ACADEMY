import { useState, useRef, useEffect } from "react";
import { askQuestion, readImage, supabase } from "./lib/supabase.js";
import Auth from "./Auth.jsx";
import History from "./History.jsx";
import About from "./About.jsx";
import AccessGate, { hasAccess } from "./AccessGate.jsx";
import PendingApproval from "./PendingApproval.jsx";

const BOOKS = ["The Samaritan", "Fathers of Nations", "A Silent Song and Other Stories"];

// General-knowledge subjects — answered from the AI's own knowledge,
// not from an ingested book. Kept as a separate list from BOOKS so
// the UI can group and label them honestly as not evidence-based.
const SUBJECTS = [
  "Chemistry", "Biology", "Physics", "Mathematics", "History",
  "Geography", "Business", "English", "Kiswahili", "Arabic",
  "IRE", "CRE", "HRE",
];

const HIGHER_RISK_SUBJECTS = ["Kiswahili", "Arabic", "IRE", "CRE", "HRE"];

const STARTER_PROMPTS = [
  "Discuss the theme of betrayal.",
  "Analyze the character of the protagonist.",
  "Explain the significance of the title.",
  "Comment on the writer's use of irony.",
];

const GENERAL_STARTER_PROMPTS = [
  "Explain a key concept from this topic.",
  "Give a worked example.",
  "What are the most commonly examined points here?",
  "Summarize this for quick revision.",
];

const LOADING_MESSAGES = [
  "Reading the evidence…",
  "Working through it…",
  "Drafting the answer…",
];

const THEME_KEY = "maslah_theme";
const STREAK_KEY = "maslah_streak";
const STREAK_MILESTONE_KEY = "maslah_streak_milestone_seen";
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];
const BOOKMARKS_KEY = "maslah_bookmarks";
const ONBOARDED_KEY = "maslah_onboarded";
const CHAT_SESSION_KEY = "maslah_chat_session";
const MAX_PERSISTED_MESSAGES = 30;

// A fixed, non-exam-answer prompt used only to populate the "About this
// book" panel — grounded in the same setbook evidence as every other
// answer, never facts invented client-side.
const BOOK_INFO_PROMPT =
  "Give a brief, spoiler-light overview of the main characters and central themes of this setbook, in about 120 words, as plain flowing text with no headings.";

export default function App() {
  const [granted, setGranted] = useState(hasAccess());
  const [session, setSession] = useState(undefined); // undefined = checking, null = logged out
  const [approvalStatus, setApprovalStatus] = useState(undefined); // undefined = checking, "pending" | "approved" | null (no request found)
  const [pendingCode, setPendingCode] = useState(null);
  const [view, setView] = useState("chat"); // "chat" | "history" | "about"
  const [book, setBook] = useState(BOOKS[0]);
  const [messages, setMessages] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CHAT_SESSION_KEY) || "[]");
      return saved.map((m) => (m.image ? { ...m, image: null } : m));
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);
  const cameraInputRef = useRef(null);
  const uploadInputRef = useRef(null);
  const textareaRef = useRef(null);

  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) || "light";
    } catch {
      return "light";
    }
  });
  const [streak, setStreak] = useState(0);
  const [streakToast, setStreakToast] = useState(null);
  const [bookmarks, setBookmarks] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]");
    } catch {
      return [];
    }
  });
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [bookmarkQuery, setBookmarkQuery] = useState("");
  const [bookInfo, setBookInfo] = useState({});
  const [showBookInfo, setShowBookInfo] = useState(false);
  const [speakingIndex, setSpeakingIndex] = useState(null);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try {
      return !localStorage.getItem(ONBOARDED_KEY);
    } catch {
      return false;
    }
  });
  const [isOffline, setIsOffline] = useState(() =>
    typeof navigator !== "undefined" ? !navigator.onLine : false
  );
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

  // Image capture/upload flow: a photo is staged for preview and
  // captioning before it's actually submitted, rather than firing
  // off the moment it's picked.
  const [pendingImage, setPendingImage] = useState(null); // { dataUrl, blob } | null
  const [extractedText, setExtractedText] = useState("");
  const [imageCaption, setImageCaption] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [imageError, setImageError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // Once logged in, check whether this account has been approved
  // by the founder yet.
  useEffect(() => {
    if (!session) {
      setApprovalStatus(session === null ? null : undefined);
      return;
    }
    let cancelled = false;
    supabase
      .from("approval_requests")
      .select("approved")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          // No approval request on file — treat as already fine
          // (covers accounts created before this system existed).
          setApprovalStatus("approved");
        } else {
          setApprovalStatus(data.approved ? "approved" : "pending");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage unavailable — theme still applies for this session.
    }
  }, [theme]);

  useEffect(() => {
    try {
      const today = new Date().toDateString();
      const saved = JSON.parse(localStorage.getItem(STREAK_KEY) || "null");

      const applyStreak = (count) => {
        setStreak(count);
        if (STREAK_MILESTONES.includes(count)) {
          const lastSeen = Number(localStorage.getItem(STREAK_MILESTONE_KEY) || 0);
          if (count > lastSeen) {
            localStorage.setItem(STREAK_MILESTONE_KEY, String(count));
            setStreakToast(count);
            setTimeout(() => setStreakToast(null), 4500);
          }
        }
      };

      if (!saved) {
        localStorage.setItem(STREAK_KEY, JSON.stringify({ lastDate: today, count: 1 }));
        applyStreak(1);
        return;
      }
      if (saved.lastDate === today) {
        applyStreak(saved.count);
        return;
      }
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const isConsecutive = saved.lastDate === yesterday.toDateString();
      const nextCount = isConsecutive ? saved.count + 1 : 1;
      localStorage.setItem(STREAK_KEY, JSON.stringify({ lastDate: today, count: nextCount }));
      applyStreak(nextCount);
    } catch {
      setStreak(0);
    }
  }, []);

  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => setIsOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  useEffect(() => {
    try {
      const toStore = messages.slice(-MAX_PERSISTED_MESSAGES).map((m) => {
        if (!m.image) return m;
        const { image, ...rest } = m;
        return rest;
      });
      localStorage.setItem(CHAT_SESSION_KEY, JSON.stringify(toStore));
    } catch {
      // Storage unavailable or full — the live session still works,
      // it just won't survive a reload.
    }
  }, [messages]);

  function clearConversation() {
    setMessages([]);
    try {
      localStorage.removeItem(CHAT_SESSION_KEY);
    } catch {
      // Storage unavailable — clearing in-memory state is still enough.
    }
  }

  function toggleBookmark(message) {
    setBookmarks((prev) => {
      const exists = prev.some((b) => b.text === message.text && b.book === message.book);
      const next = exists
        ? prev.filter((b) => !(b.text === message.text && b.book === message.book))
        : [...prev, { book: message.book, text: message.text, savedAt: Date.now() }];
      try {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable — bookmark still works for this session.
      }
      return next;
    });
  }

  function isBookmarked(message) {
    return bookmarks.some((b) => b.text === message.text && b.book === message.book);
  }

  function removeBookmark(bookmark) {
    setBookmarks((prev) => {
      const next = prev.filter((b) => !(b.text === bookmark.text && b.book === bookmark.book));
      try {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable — removal still works for this session.
      }
      return next;
    });
  }

  async function copyAnswer(text, index) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((i) => (i === index ? null : i)), 1800);
    } catch (err) {
      console.error(err);
    }
  }

  function toggleReadAloud(text, index) {
    if (!("speechSynthesis" in window)) return;
    if (speakingIndex === index) {
      window.speechSynthesis.cancel();
      setSpeakingIndex(null);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setSpeakingIndex(null);
    utterance.onerror = () => setSpeakingIndex(null);
    window.speechSynthesis.speak(utterance);
    setSpeakingIndex(index);
  }

  async function openBookInfo() {
    setShowBookInfo(true);
    if (bookInfo[book] && !bookInfo[book].error) return;
    setBookInfo((prev) => ({ ...prev, [book]: { text: "", loading: true, error: false } }));
    try {
      const data = await askQuestion(BOOK_INFO_PROMPT, book, []);
      setBookInfo((prev) => ({ ...prev, [book]: { text: data.answer, loading: false, error: false } }));
    } catch (err) {
      console.error(err);
      setBookInfo((prev) => ({ ...prev, [book]: { text: "", loading: false, error: true } }));
    }
  }

  function dismissOnboarding() {
    setShowOnboarding(false);
    try {
      localStorage.setItem(ONBOARDED_KEY, "true");
    } catch {
      // Storage unavailable — banner just won't be remembered as dismissed.
    }
  }

  function retryFailedMessage(message) {
    if (!message.retryQuestion) return;
    handleSubmit(message.retryQuestion, message.book);
  }

  async function handleSubmit(question, questionBook, attachedImage) {
    const q = (question ?? input).trim();
    if (!q || loading) return;
    const targetBook = questionBook ?? book;
    if (questionBook && questionBook !== book) setBook(questionBook);
    setView("chat");
    setInput("");
    setMessages((m) => [...m, { role: "student", text: q, book: targetBook, image: attachedImage }]);
    setLoading(true);
    try {
      const recentHistory = messages
        .filter((m) => m.role === "student" || m.role === "assistant")
        .slice(-6)
        .map((m) => ({ role: m.role, text: m.text }));

      const data = await askQuestion(q, targetBook, recentHistory);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: data.answer,
          evidence: data.evidenceUsed,
          book: targetBook,
          groundedInEvidence: data.groundedInEvidence,
          higherRiskSubject: data.higherRiskSubject,
        },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "error",
          text: "Something went wrong retrieving that answer. Please try again.",
          book: targetBook,
          retryQuestion: q,
        },
      ]);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

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

  async function handleImageFile(file) {
    if (!file) return;
    setImageError("");
    try {
      const resizedBlob = await resizeImage(file, 1600, 0.75);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(resizedBlob);
      });

      setPendingImage({ dataUrl, blob: resizedBlob });
      setExtractedText("");
      setImageCaption("");
      setExtracting(true);

      const base64 = dataUrl.split(",")[1];
      const data = await readImage(base64, "image/jpeg");
      setExtractedText(data.text);
    } catch (err) {
      console.error(err);
      setImageError("Couldn't read that photo — you can retake it, or remove it and type the question instead.");
    } finally {
      setExtracting(false);
    }
  }

  function clearPendingImage() {
    setPendingImage(null);
    setExtractedText("");
    setImageCaption("");
    setImageError("");
  }

  function retakePhoto() {
    clearPendingImage();
    cameraInputRef.current?.click();
  }

  function submitImageQuestion() {
    if (!extractedText.trim() || extracting) return;
    const combined = imageCaption.trim()
      ? `${extractedText.trim()}\n\nQuestion: ${imageCaption.trim()}`
      : `${extractedText.trim()}\n\nAnswer this using evidence from the excerpt above.`;
    const thumbnail = pendingImage?.dataUrl;
    clearPendingImage();
    handleSubmit(combined, undefined, thumbnail);
  }

  if (!granted) {
    return <AccessGate onGranted={() => setGranted(true)} />;
  }

  if (session === undefined) {
    return <div className="auth-screen" />;
  }

  if (!session) {
    return <Auth onAuthed={() => {}} onPendingApproval={(code) => setPendingCode(code)} />;
  }

  if (approvalStatus === "pending" || pendingCode) {
    return (
      <PendingApproval
        code={pendingCode}
        onApproved={() => {
          setPendingCode(null);
          setApprovalStatus("approved");
        }}
        onLogout={() => {
          setPendingCode(null);
          supabase.auth.signOut();
        }}
      />
    );
  }

  if (approvalStatus === undefined) {
    return <div className="auth-screen" />;
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
            <p className="tagline">Setbook analysis + full-subject KCSE support</p>
          </div>
          <div className="topbar-actions">
            {streak > 1 && (
              <span className="streak-badge" title={`${streak}-day study streak`}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                  <path d="M12 2c1 3-1 4.5-2 6-1.3 2-2 3.6-2 5.5A4.5 4.5 0 0 0 12 18a4.5 4.5 0 0 0 4-6.5c1 .8 1.5 2 1.5 3A5.5 5.5 0 0 1 12 20a6.5 6.5 0 0 1-6.5-6.5C5.5 9 8 6.5 9.5 4.5 10.3 3.5 11 2.8 12 2Z" />
                </svg>
                {streak}
              </span>
            )}
            <button
              className="icon-nav-btn"
              title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            >
              {theme === "light" ? (
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.55 1.55M18.25 18.25l1.55 1.55M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.55-1.55M18.25 5.75l1.55-1.55" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              )}
              <span>Theme</span>
            </button>
            <button className="icon-nav-btn" title="Saved answers" onClick={() => setShowBookmarks(true)}>
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill={bookmarks.length ? "currentColor" : "none"} />
              </svg>
              <span>Saved</span>
            </button>
            {messages.length > 0 && (
              <button
                className="icon-nav-btn"
                title="Clear this conversation"
                onClick={() => {
                  if (window.confirm("Clear this conversation? Saved bookmarks won't be affected.")) {
                    clearConversation();
                  }
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M18 7l-.7 12.1a1.5 1.5 0 0 1-1.5 1.4H8.2a1.5 1.5 0 0 1-1.5-1.4L6 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Clear</span>
              </button>
            )}
            <button className="icon-nav-btn" onClick={() => setView("history")} title="History">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 12a8 8 0 1 1 2.6 5.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <path d="M4 6v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 8v4.5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>History</span>
            </button>
            <button className="icon-nav-btn" onClick={() => setView("about")} title="About">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12 11v5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="12" cy="8" r="1" fill="currentColor" />
              </svg>
              <span>About</span>
            </button>
            <button className="icon-nav-btn logout" onClick={() => supabase.auth.signOut()} title="Log out">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 16l4-4-4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M18 12H9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <span>Log out</span>
            </button>
          </div>
        </div>
        <div className="book-select-row">
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
          {BOOKS.includes(book) && (
            <button className="book-info-btn" onClick={openBookInfo} title="About this setbook">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9.2" />
                <path d="M12 11v5.5M12 8v.01" />
              </svg>
            </button>
          )}
        </div>

        <div className="subject-select-row">
          <span className="subject-select-label">Other subjects</span>
          <div className="book-select subject-select">
            {SUBJECTS.map((s) => (
              <button
                key={s}
                className={`book-pill subject-pill ${s === book ? "active" : ""}`}
                onClick={() => setBook(s)}
                title={
                  HIGHER_RISK_SUBJECTS.includes(s)
                    ? "General knowledge — no ingested textbook, so double-check precise details"
                    : "General knowledge — no ingested textbook for this subject"
                }
              >
                {s}
                {HIGHER_RISK_SUBJECTS.includes(s) && <span className="subject-risk-dot" />}
              </button>
            ))}
          </div>
        </div>
      </header>

      {isOffline && (
        <div className="offline-banner">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8.5c5-4 13-4 18 0M6.5 12c3.3-2.7 7.7-2.7 11 0M10 15.5c1.3-1 2.7-1 4 0" />
            <path d="M12 19v.01" />
            <path d="M3 3l18 18" />
          </svg>
          You're offline — questions can't be sent until your connection is back.
        </div>
      )}

      {streakToast && (
        <div className="streak-toast">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <path d="M12 2c1 3-1 4.5-2 6-1.3 2-2 3.6-2 5.5A4.5 4.5 0 0 0 12 18a4.5 4.5 0 0 0 4-6.5c1 .8 1.5 2 1.5 3A5.5 5.5 0 0 1 12 20a6.5 6.5 0 0 1-6.5-6.5C5.5 9 8 6.5 9.5 4.5 10.3 3.5 11 2.8 12 2Z" />
          </svg>
          <span>{streakToast}-day streak — keep it going</span>
        </div>
      )}

      {showOnboarding && (
        <div className="onboarding-banner">
          <div className="onboarding-items">
            <span className="onboarding-item">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                <path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1Z" />
              </svg>
              Save answers for revision
            </span>
            <span className="onboarding-item">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9.2" />
                <path d="M12 11v5.5M12 8v.01" />
              </svg>
              Get a setbook overview
            </span>
            <span className="onboarding-item">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
              </svg>
              Switch to dark mode
            </span>
          </div>
          <button className="onboarding-dismiss" onClick={dismissOnboarding}>
            Got it
          </button>
        </div>
      )}

      <main className="chat" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty-state hero">
            <div className="hero-mark">M</div>
            <p className="eyebrow">Currently studying</p>
            <h2>{book}</h2>
            {BOOKS.includes(book) ? (
              <>
                <span className="grounding-badge evidence">Evidence-based</span>
                <p className="hint">
                  Ask an essay question, an excerpt-based question, or a question on character,
                  theme, or style. Every answer is built from evidence in the actual text.
                </p>
              </>
            ) : (
              <>
                <span className="grounding-badge general">General knowledge</span>
                <p className="hint">
                  Ask any {book} question. There's no ingested textbook for this subject, so
                  answers come from general AI knowledge rather than a cited source
                  {HIGHER_RISK_SUBJECTS.includes(book) ? " — worth double-checking precise details." : "."}
                </p>
              </>
            )}
            <div className="starters">
              {(BOOKS.includes(book) ? STARTER_PROMPTS : GENERAL_STARTER_PROMPTS).map((p, idx) => (
                <button
                  key={p}
                  className="starter"
                  style={{ animationDelay: `${idx * 0.08 + 0.15}s` }}
                  onClick={() => handleSubmit(p)}
                >
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
                {m.image && <img src={m.image} alt="Submitted question" className="bubble-image" />}
                {m.text}
              </div>
            )}
            {m.role === "error" && (
              <div className="bubble error">
                <p className="error-text">{m.text}</p>
                {m.retryQuestion && (
                  <button
                    type="button"
                    className="retry-btn"
                    disabled={loading || extracting || isOffline}
                    onClick={() => retryFailedMessage(m)}
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-3-6.7" />
                      <polyline points="21 3 21 9 15 9" />
                    </svg>
                    Retry
                  </button>
                )}
              </div>
            )}
            {m.role === "assistant" && (
              <div className="bubble assistant">
                <div className="answer-toolbar">
                  <div className="answer-label">
                    Maslah AI — {m.book}
                    {m.groundedInEvidence === false && (
                      <span className={`grounding-badge inline ${m.higherRiskSubject ? "risk" : "general"}`}>
                        {m.higherRiskSubject ? "General knowledge — verify specifics" : "General knowledge"}
                      </span>
                    )}
                    <span className="word-count">
                      {m.text.trim().split(/\s+/).filter(Boolean).length} words
                    </span>
                  </div>
                  <div className="answer-actions">
                    <button
                      type="button"
                      className={`answer-action ${isBookmarked(m) ? "active" : ""}`}
                      title={isBookmarked(m) ? "Remove bookmark" : "Save this answer"}
                      onClick={() => toggleBookmark(m)}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill={isBookmarked(m) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                        <path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1Z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="answer-action"
                      title="Copy answer"
                      onClick={() => copyAnswer(m.text, i)}
                    >
                      {copiedIndex === i ? (
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="5 12 10 17 19 6" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                          <rect x="8" y="8" width="12" height="12" rx="1.5" />
                          <path d="M5.5 16H4.5A1.5 1.5 0 0 1 3 14.5v-10A1.5 1.5 0 0 1 4.5 3h10A1.5 1.5 0 0 1 16 4.5v1" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      className={`answer-action ${speakingIndex === i ? "active" : ""}`}
                      title={speakingIndex === i ? "Stop reading" : "Read aloud"}
                      onClick={() => toggleReadAloud(m.text, i)}
                    >
                      {speakingIndex === i ? (
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                          <rect x="6" y="6" width="12" height="12" rx="1.5" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 9v6h3.5L12 19V5L7.5 9H4Z" />
                          <path d="M16 9a4 4 0 0 1 0 6" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
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
            <div className="bubble assistant loading-skeleton">
              <div className="skeleton-line" style={{ width: "88%" }} />
              <div className="skeleton-line" style={{ width: "95%" }} />
              <div className="skeleton-line" style={{ width: "70%" }} />
              <span className="loading-text">{LOADING_MESSAGES[loadingStep]}</span>
            </div>
          </div>
        )}
      </main>

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

      {pendingImage ? (
        <div className="image-preview-panel">
          <div className="image-preview-header">
            <span>Photo question</span>
            <button type="button" className="image-preview-close" onClick={clearPendingImage} title="Remove photo">
              ✕
            </button>
          </div>

          <div className="image-preview-body">
            <img src={pendingImage.dataUrl} alt="Selected question" className="image-preview-thumb" />

            <div className="image-preview-text">
              {extracting ? (
                <div className="extracting-row">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  <span className="extracting-label">Reading text from photo…</span>
                </div>
              ) : (
                <textarea
                  className="extracted-text"
                  value={extractedText}
                  onChange={(e) => setExtractedText(e.target.value)}
                  rows={4}
                  placeholder="Extracted text will appear here — check it, then edit anything that looks wrong."
                />
              )}
              <input
                className="image-caption-input"
                type="text"
                value={imageCaption}
                onChange={(e) => setImageCaption(e.target.value)}
                placeholder='Question (optional) — e.g. "Answer this using evidence from The Samaritan"'
              />
            </div>
          </div>

          <div className="image-preview-actions">
            <button type="button" className="image-action-btn" onClick={retakePhoto}>
              Retake
            </button>
            <button type="button" className="image-action-btn" onClick={clearPendingImage}>
              Remove
            </button>
            <button
              type="button"
              className="image-action-btn primary"
              disabled={extracting || !extractedText.trim() || loading || isOffline}
              onClick={submitImageQuestion}
            >
              Submit
            </button>
          </div>
        </div>
      ) : (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <button
            type="button"
            className="photo-btn"
            title="Take a photo of a question"
            disabled={isOffline}
            onClick={() => cameraInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M4 8.5C4 7.67 4.67 7 5.5 7H7.8L8.55 5.6C8.81 5.11 9.32 4.8 9.87 4.8H14.13C14.68 4.8 15.19 5.11 15.45 5.6L16.2 7H18.5C19.33 7 20 7.67 20 8.5V17.5C20 18.33 19.33 19 18.5 19H5.5C4.67 19 4 18.33 4 17.5V8.5Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span>Camera</span>
          </button>
          <button
            type="button"
            className="photo-btn"
            title="Upload a photo"
            disabled={isOffline}
            onClick={() => uploadInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="4" y="5" width="16" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M4 15.5L8.5 11.5C9.02 11.03 9.8 11.03 10.3 11.5L13 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12.5 14L14.7 12C15.22 11.53 16 11.53 16.5 12L20 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="8.3" cy="8.7" r="1.3" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span>Upload</span>
          </button>
          <textarea
            ref={textareaRef}
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
          <button type="submit" disabled={loading || isOffline || !input.trim()}>
            Ask
          </button>
        </form>
      )}
      {imageError && <p className="image-error">{imageError}</p>}

      {showBookmarks && (
        <div className="overlay" onClick={() => setShowBookmarks(false)}>
          <div className="overlay-panel" id="bookmark-print-area" onClick={(e) => e.stopPropagation()}>
            <div className="overlay-header">
              <h3>Saved answers</h3>
              <div className="overlay-header-actions">
                {bookmarks.length > 0 && (
                  <button className="overlay-close" title="Print for revision" onClick={() => window.print()}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 9V3.5h12V9M6 18h12v3.5H6V18Z" />
                      <path d="M6 14h12M4.5 9h15a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H18M6 16H4.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1" />
                    </svg>
                  </button>
                )}
                <button className="overlay-close" onClick={() => setShowBookmarks(false)}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            </div>
            {bookmarks.length === 0 ? (
              <p className="overlay-empty">No saved answers yet. Tap the bookmark icon on any answer to save it here for revision.</p>
            ) : (
              <>
                {bookmarks.length > 3 && (
                  <input
                    type="text"
                    className="bookmark-search"
                    placeholder="Search saved answers…"
                    value={bookmarkQuery}
                    onChange={(e) => setBookmarkQuery(e.target.value)}
                  />
                )}
                {(() => {
                  const q = bookmarkQuery.trim().toLowerCase();
                  const filtered = q
                    ? bookmarks.filter(
                        (b) => b.text.toLowerCase().includes(q) || b.book.toLowerCase().includes(q)
                      )
                    : bookmarks;
                  if (filtered.length === 0) {
                    return <p className="overlay-empty">No saved answers match "{bookmarkQuery}".</p>;
                  }
                  return (
                    <div className="bookmark-list">
                      {filtered.map((b, i) => (
                        <div className="bookmark-item" key={i}>
                          <div className="bookmark-item-header">
                            <span className="bookmark-book">{b.book}</span>
                            <button className="overlay-close small" onClick={() => removeBookmark(b)} title="Remove">
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                                <path d="M6 6l12 12M18 6L6 18" />
                              </svg>
                            </button>
                          </div>
                          <p className="bookmark-text">{b.text}</p>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      )}

      {showBookInfo && (
        <div className="overlay" onClick={() => setShowBookInfo(false)}>
          <div className="overlay-panel" onClick={(e) => e.stopPropagation()}>
            <div className="overlay-header">
              <h3>About {book}</h3>
              <button className="overlay-close" onClick={() => setShowBookInfo(false)}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            {bookInfo[book]?.loading && (
              <div className="loading-skeleton overlay-skeleton">
                <div className="skeleton-line" style={{ width: "90%" }} />
                <div className="skeleton-line" style={{ width: "96%" }} />
                <div className="skeleton-line" style={{ width: "60%" }} />
              </div>
            )}
            {bookInfo[book]?.error && (
              <p className="overlay-empty">Couldn't load an overview right now — please try again.</p>
            )}
            {bookInfo[book]?.text && (
              <div className="answer-text">
                {bookInfo[book].text
                  .split(/\n{2,}/)
                  .filter((p) => p.trim())
                  .map((paragraph, k) => (
                    <p key={k} className="answer-paragraph">
                      {paragraph}
                    </p>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
