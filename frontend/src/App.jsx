import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { askQuestion, supabase } from "./lib/supabase.js";
import Auth from "./Auth.jsx";
import History from "./History.jsx";
import About from "./About.jsx";
import AccessGate, { hasAccess } from "./AccessGate.jsx";
import PendingApproval from "./PendingApproval.jsx";

const BOOKS = ["The Samaritan", "Fathers of Nations", "A Silent Song and Other Stories"];

// General-knowledge subjects — answered from the AI's own knowledge,
// not from an ingested book.
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
  "Reading the question…",
  "Working through it…",
  "Checking the facts…",
  "Writing the answer…",
];

const THEME_KEY = "maslah_theme";
const STREAK_KEY = "maslah_streak";
const STREAK_MILESTONE_KEY = "maslah_streak_milestone_seen";
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];
const BOOKMARKS_KEY = "maslah_bookmarks";
const ONBOARDED_KEY = "maslah_onboarded";
const CHAT_SESSION_KEY = "maslah_chat_session";
const MAX_PERSISTED_MESSAGES = 30;
const MAX_IMAGES = 3;

const BOOK_INFO_PROMPT =
  "Give a brief, spoiler-light overview of the main characters and central themes of this setbook, in about 120 words, as flowing text with no headings.";

// Removes markdown symbols so read-aloud doesn't say "asterisk".
const stripMd = (t) => String(t || "").replace(/[*_`#>]/g, "").replace(/\n{2,}/g, ". ");

function Markdown({ children }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children || ""}</ReactMarkdown>
    </div>
  );
}

const Icon = {
  plus: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  camera: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M4 8.5C4 7.7 4.7 7 5.5 7h2.3l.8-1.4c.3-.5.8-.8 1.3-.8h4.2c.5 0 1 .3 1.3.8l.8 1.4h2.3c.8 0 1.5.7 1.5 1.5v9c0 .8-.7 1.5-1.5 1.5h-13c-.8 0-1.5-.7-1.5-1.5v-9Z" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  ),
  image: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.4" />
      <path d="M4 16l4.5-4 4 3.5 2.5-2L20 17" />
    </svg>
  ),
  file: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7l-4-4Z" />
      <path d="M14 3v4h4" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M18 7l-.7 12.1a1.5 1.5 0 0 1-1.5 1.4H8.2a1.5 1.5 0 0 1-1.5-1.4L6 7" />
    </svg>
  ),
};

export default function App() {
  const [granted, setGranted] = useState(hasAccess());
  const [session, setSession] = useState(undefined); // undefined = checking, null = logged out
  const [approvalStatus, setApprovalStatus] = useState(undefined);
  const [pendingCode, setPendingCode] = useState(null);
  const [view, setView] = useState("chat"); // "chat" | "history" | "about"
  const [book, setBook] = useState(BOOKS[0]);
  const [messages, setMessages] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CHAT_SESSION_KEY) || "[]");
      return saved.map((m) => (m.images ? { ...m, images: null } : m));
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);
  const cameraInputRef = useRef(null);
  const uploadInputRef = useRef(null);
  const fileInputRef = useRef(null);
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
  const [showSidebar, setShowSidebar] = useState(false);
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

  // Attachments staged in the composer (sent together with the message)
  const [attachments, setAttachments] = useState([]); // [{ id, dataUrl, name }]
  const [fileAttachment, setFileAttachment] = useState(null); // { name, text }
  const [attachError, setAttachError] = useState("");
  const [showAttachMenu, setShowAttachMenu] = useState(false);

  useEffect(() => {
    if (!loading) {
      setLoadingStep(0);
      return;
    }
    const interval = setInterval(() => {
      setLoadingStep((s) => (s + 1) % LOADING_MESSAGES.length);
    }, 2200);
    return () => clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // Once logged in, check whether this account has been approved.
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
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
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
        if (!m.images) return m;
        const { images, ...rest } = m;
        return rest;
      });
      localStorage.setItem(CHAT_SESSION_KEY, JSON.stringify(toStore));
    } catch {
      // Storage unavailable or full — the live session still works.
    }
  }, [messages]);

  function clearConversation() {
    // Only clears the currently selected subject's messages.
    setMessages((prev) => prev.filter((m) => m.book !== book));
  }

  function confirmClear() {
    if (window.confirm(`Clear your ${book} conversation? Other subjects and saved answers won't be affected.`)) {
      clearConversation();
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
    const utterance = new SpeechSynthesisUtterance(stripMd(text));
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
    const p = message.retryPayload;
    if (!p) return;
    handleSubmit(p.typed, message.book, { images: p.images, fileText: p.fileText });
  }

  // override = { images, fileText } is used for retries.
  async function handleSubmit(question, questionBook, override) {
    const typed = (question ?? input).trim();
    const imgs = override?.images ?? attachments.map((a) => a.dataUrl);
    const fText = override?.fileText ?? fileAttachment?.text ?? "";
    const fileName = fileAttachment?.name;

    if ((!typed && imgs.length === 0 && !fText) || loading) return;

    const targetBook = questionBook ?? book;
    if (questionBook && questionBook !== book) setBook(questionBook);
    setView("chat");
    setInput("");
    setAttachments([]);
    setFileAttachment(null);
    setAttachError("");
    setShowAttachMenu(false);

    const shownText =
      typed ||
      (imgs.length
        ? "Please answer the question(s) in this photo."
        : `Please answer the questions in ${fileName || "this file"}.`);

    setMessages((m) => [...m, { role: "student", text: shownText, book: targetBook, images: imgs }]);
    setLoading(true);
    try {
      const recentHistory = messages
        .filter((m) => (m.role === "student" || m.role === "assistant") && m.book === targetBook)
        .slice(-6)
        .map((m) => ({ role: m.role === "student" ? "student" : "ai", text: m.text }));

      const data = await askQuestion(typed, targetBook, recentHistory, {
        images: imgs,
        fileText: fText,
      });
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: data.answer,
          evidence: data.evidenceUsed,
          book: targetBook,
          groundedInEvidence: data.groundedInEvidence,
          higherRiskSubject: data.higherRiskSubject,
          transcribed: data.transcribedQuestion,
        },
      ]);
    } catch (err) {
      console.error(err);
      setMessages((m) => [
        ...m,
        {
          role: "error",
          text:
            err?.message && err.message.length < 220
              ? err.message
              : "Something went wrong. Please try again.",
          book: targetBook,
          retryPayload: { typed, images: imgs, fileText: fText },
        },
      ]);
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

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read that file."));
      reader.readAsDataURL(blob);
    });
  }

  async function handleFiles(fileList) {
    setAttachError("");
    setShowAttachMenu(false);
    for (const file of Array.from(fileList || [])) {
      try {
        if (file.type.startsWith("image/")) {
          const blob = await resizeImage(file, 1600, 0.8);
          const dataUrl = await blobToDataUrl(blob);
          setAttachments((prev) =>
            prev.length >= MAX_IMAGES
              ? prev
              : [...prev, { id: `${Date.now()}-${Math.random()}`, dataUrl, name: file.name }]
          );
        } else if (file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt")) {
          const text = await file.text();
          setFileAttachment({ name: file.name, text: text.slice(0, 15000) });
        } else {
          setAttachError("Please attach a photo or a .txt file.");
        }
      } catch (err) {
        console.error(err);
        setAttachError("Couldn't load that file. Please try again.");
      }
    }
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

  const visibleMessages = messages.filter((m) => m.book === book);
  const hasMessagesHere = visibleMessages.length > 0;
  const canSend =
    !loading && !isOffline && (input.trim() || attachments.length > 0 || fileAttachment);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <button className="hamburger-btn" onClick={() => setShowSidebar(true)} title="Choose a setbook or subject">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <span className="brand-mark"><img src="/logo-mark.png" alt="" /></span>
          <div>
            <h1>Maslah Academy AI</h1>
            <p className="tagline current-subject" onClick={() => setShowSidebar(true)}>
              {book}
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </p>
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
            {hasMessagesHere && (
              <button
                className="icon-nav-btn hide-sm"
                title="Clear this subject's conversation"
                onClick={confirmClear}
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
              {Icon.camera}
              Snap a question and get it answered
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
        {visibleMessages.length === 0 && (
          <div className="empty-state hero">
            <div className="hero-mark"><img src="/logo-mark.png" alt="" /></div>
            <p className="eyebrow">Currently studying</p>
            <h2>{book}</h2>
            {BOOKS.includes(book) ? (
              <>
                <span className="grounding-badge evidence">Evidence-based</span>
                <p className="hint">
                  Ask an essay question, an excerpt-based question, or a question on character,
                  theme, or style. You can also snap a photo of the question. Every answer is built
                  from evidence in the actual text.
                </p>
              </>
            ) : (
              <>
                <span className="grounding-badge general">General knowledge</span>
                <p className="hint">
                  Ask any {book} question, or snap a photo of it. There's no ingested textbook for
                  this subject, so answers come from general AI knowledge rather than a cited source
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

        {visibleMessages.map((m, i) => (
          <div key={i} className={`bubble-row ${m.role}`}>
            {m.role === "student" && (
              <div className="bubble student">
                {m.images?.length > 0 && (
                  <div className="bubble-images">
                    {m.images.map((src, k) => (
                      <img key={k} src={src} alt="Attached question" className="bubble-image" />
                    ))}
                  </div>
                )}
                {m.text}
              </div>
            )}

            {m.role === "error" && (
              <div className="bubble error">
                <p className="error-text">{m.text}</p>
                {m.retryPayload && (
                  <button
                    type="button"
                    className="retry-btn"
                    disabled={loading || isOffline}
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

                <Markdown>{m.text}</Markdown>

                {m.transcribed && (
                  <details className="evidence">
                    <summary>What the AI read from your upload</summary>
                    <p style={{ whiteSpace: "pre-wrap" }}>{m.transcribed}</p>
                  </details>
                )}

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
        hidden
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        type="file"
        accept="image/*"
        multiple
        ref={uploadInputRef}
        hidden
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        type="file"
        accept=".txt,text/plain"
        ref={fileInputRef}
        hidden
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <div className="composer-box">
          {(attachments.length > 0 || fileAttachment) && (
            <div className="attach-row">
              {attachments.map((a) => (
                <div className="attach-chip image" key={a.id}>
                  <img src={a.dataUrl} alt="" />
                  <button
                    type="button"
                    title="Remove"
                    onClick={() => setAttachments((p) => p.filter((x) => x.id !== a.id))}
                  >
                    {Icon.close}
                  </button>
                </div>
              ))}
              {fileAttachment && (
                <div className="attach-chip file">
                  {Icon.file}
                  <span>{fileAttachment.name}</span>
                  <button type="button" title="Remove" onClick={() => setFileAttachment(null)}>
                    {Icon.close}
                  </button>
                </div>
              )}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message Maslah Academy AI about ${book}`}
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 700) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />

          <div className="composer-actions">
            <div className="attach-wrap">
              <button
                type="button"
                className="round-btn ghost"
                title="Add photo or file"
                disabled={isOffline}
                onClick={() => setShowAttachMenu((s) => !s)}
              >
                {Icon.plus}
              </button>
              {showAttachMenu && (
                <>
                  <div className="menu-backdrop" onClick={() => setShowAttachMenu(false)} />
                  <div className="attach-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setShowAttachMenu(false);
                        cameraInputRef.current?.click();
                      }}
                    >
                      {Icon.camera}Take a photo
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAttachMenu(false);
                        uploadInputRef.current?.click();
                      }}
                    >
                      {Icon.image}Upload photos
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAttachMenu(false);
                        fileInputRef.current?.click();
                      }}
                    >
                      {Icon.file}Upload text file
                    </button>
                  </div>
                </>
              )}
            </div>
            <button type="submit" className="round-btn send" title="Send" disabled={!canSend}>
              {Icon.send}
            </button>
          </div>
        </div>
        {attachError && <p className="image-error">{attachError}</p>}
      </form>

      {showSidebar && (
        <div className="sidebar-overlay" onClick={() => setShowSidebar(false)}>
          <div className="sidebar-panel" onClick={(e) => e.stopPropagation()}>
            <div className="sidebar-header">
              <div className="sidebar-brand">
                <span className="brand-mark"><img src="/logo-mark.png" alt="" /></span>
                <span>Maslah Academy AI</span>
              </div>
              <button className="overlay-close" onClick={() => setShowSidebar(false)}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className="sidebar-scroll">
              <p className="sidebar-section-label">Setbooks — evidence-based</p>
              {BOOKS.map((b) => (
                <button
                  key={b}
                  className={`sidebar-item ${b === book ? "active" : ""}`}
                  onClick={() => {
                    setBook(b);
                    setShowSidebar(false);
                  }}
                >
                  <span className="sidebar-item-icon">{b[0]}</span>
                  {b}
                  {b === book && (
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="sidebar-item-check">
                      <polyline points="5 12 10 17 19 6" />
                    </svg>
                  )}
                </button>
              ))}

              {BOOKS.includes(book) && (
                <button
                  className="sidebar-subaction"
                  onClick={() => {
                    openBookInfo();
                    setShowSidebar(false);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9.2" />
                    <path d="M12 11v5.5M12 8v.01" />
                  </svg>
                  About {book}
                </button>
              )}

              <p className="sidebar-section-label">Other subjects — general knowledge</p>
              {SUBJECTS.map((s) => (
                <button
                  key={s}
                  className={`sidebar-item ${s === book ? "active" : ""}`}
                  onClick={() => {
                    setBook(s);
                    setShowSidebar(false);
                  }}
                  title={
                    HIGHER_RISK_SUBJECTS.includes(s)
                      ? "No ingested textbook — double-check precise details"
                      : "No ingested textbook for this subject"
                  }
                >
                  {s}
                  {HIGHER_RISK_SUBJECTS.includes(s) && <span className="subject-risk-dot" />}
                  {s === book && (
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="sidebar-item-check">
                      <polyline points="5 12 10 17 19 6" />
                    </svg>
                  )}
                </button>
              ))}

              {hasMessagesHere && (
                <button
                  className="sidebar-clear"
                  onClick={() => {
                    setShowSidebar(false);
                    confirmClear();
                  }}
                >
                  {Icon.trash}
                  Clear this conversation
                </button>
              )}
            </div>
          </div>
        </div>
      )}

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
                          <div className="bookmark-text">
                            <Markdown>{b.text}</Markdown>
                          </div>
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
            {bookInfo[book]?.text && <Markdown>{bookInfo[book].text}</Markdown>}
          </div>
        </div>
      )}
    </div>
  );
}
