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

        <div className="about-section founder-section">
          <p className="eyebrow">Founder</p>
          <div className="founder-card">
            <span className="founder-mark">M</span>
            <div>
              <p className="founder-name">Maslah Aliow Abdow</p>
              <div className="founder-roles">
                <span className="founder-role">Founder</span>
                <span className="founder-role">Developer</span>
                <span className="founder-role">Creator of Maslah Academy AI</span>
              </div>
              <p className="about-text founder-bio">
                A student at <strong>Takaba Boys' Senior School</strong>, Kenya, who built
                Maslah Academy AI to give every KCSE Literature student the same
                confidence in their setbook answers, backed by evidence from the actual
                text.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
