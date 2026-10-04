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
            <p className="tagline">Why this app exists, and the people behind it</p>
          </div>
        </div>
      </header>

      <main className="chat">
        <div className="about-section">
          <p className="eyebrow">Our vision</p>
          <p className="about-text">
            A future where every student, wherever they are and whatever their school has,
            can get instant, accurate and affordable help with every subject they study.
          </p>
        </div>

        <div className="about-section">
          <p className="eyebrow">Our mission</p>
          <p className="about-text">
            To help every KCSE student study with confidence: answers grounded in the
            real text, explained clearly, and written the way the marking scheme rewards.
          </p>
        </div>

        <div className="about-section founder-section">
          <p className="eyebrow">The team behind the app</p>

          <div className="founder-card">
            <span className="founder-mark">M</span>
            <div>
              <p className="founder-name">Maslah Aliow Abdow</p>
              <div className="founder-roles">
                <span className="founder-role">Founder</span>
                <span className="founder-role">Developer</span>
              </div>
              <p className="about-text founder-bio">
                A student of <strong>Takaba Boys' Senior School</strong>, Kenya, who
                believed that no learner's location should limit how well they can study,
                and then built the app to prove it.
              </p>
            </div>
          </div>

          <div className="founder-card cofounder">
            <span className="founder-mark">F</span>
            <div>
              <p className="founder-name">Feisal Alio</p>
              <div className="founder-roles">
                <span className="founder-role">Co-Founder</span>
                <span className="founder-role">Partner in the vision</span>
              </div>
              <p className="about-text founder-bio">
                Standing right beside Maslah from the very beginning. His belief,
                encouragement and ideas are woven into everything this app is growing into.
                Every great dream needs a friend who says "let's do it together" — and
                Feisal is exactly that. 💚
              </p>
            </div>
          </div>

          <p className="about-thanks">
            Built with heart, for students who deserve the very best. Now go and make
            your marks count! 🌟
          </p>
        </div>
      </main>
    </div>
  );
}
