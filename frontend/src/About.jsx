export default function About({ onBack }) {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <button className="back-btn" onClick={onBack} aria-label="Back">
            ←
          </button>
          <div>
            <h1>About Maslah Academy AI</h1>
            <p className="tagline">Why this app exists, and who built it</p>
          </div>
        </div>
      </header>

      <main className="chat">
        <div className="about-section">
          <p className="eyebrow">Vision</p>
          <p className="about-text">
            A future where every student, regardless of their school's resources or
            location, has access to accurate, instant, and affordable help understanding
            their setbooks.
          </p>
        </div>

        <div className="about-section">
          <p className="eyebrow">Mission</p>
          <p className="about-text">
            To help students study their KCSE English setbooks with confidence, by
            grounding every answer in the actual text — not guesswork — so learners get
            genuinely accurate, exam-ready analysis.
          </p>
        </div>

        <div className="about-section">
          <p className="eyebrow">Founder</p>
          <p className="about-text">
            Maslah Academy AI was founded and built by <strong>Maslah Aliow Abdow</strong>,
            a student at <strong>Takaba Boys' Senior School</strong>, Kenya.
          </p>
        </div>
      </main>
    </div>
  );
}
