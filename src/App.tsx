import { useState } from "react";
import { InlineMath } from "react-katex";
import "katex/dist/katex.min.css";
import misconceptionsData from "../misconceptions.json";

interface Misconception {
  id: string;
  text: string;
  section: string;
  subsection?: string;
  category: string;
  source: string;
}

/**
 * Get the image URL for a misconception
 */
function getImageUrl(id: string): string {
  return `/images/${id}.png`;
}

/**
 * Get a deterministic index based on the current date
 * Same date = same misconception
 */
function getDailyIndex(date: Date, total: number): number {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  // Simple hash based on date components
  const seed = year * 10000 + month * 100 + day;

  // Use a simple LCG-style calculation for distribution
  const hash = ((seed * 1103515245 + 12345) >>> 0) % total;
  return hash;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Render text with inline LaTeX math expressions
 * LaTeX is wrapped in $...$ delimiters
 */
function MathText({ text }: { text: string }) {
  // Split by $...$ patterns (non-greedy)
  const parts = text.split(/(\$[^$]+\$)/g);

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("$") && part.endsWith("$")) {
          // Extract LaTeX content (remove $ delimiters)
          const latex = part.slice(1, -1);
          try {
            return <InlineMath key={index} math={latex} />;
          } catch {
            // If KaTeX fails to render, show the raw text
            return <span key={index}>{latex}</span>;
          }
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

function App() {
  const today = new Date();
  const misconceptions = misconceptionsData.misconceptions as Misconception[];
  const dailyIndex = getDailyIndex(today, misconceptions.length);
  const misconception = misconceptions[dailyIndex];

  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  const imageUrl = getImageUrl(misconception.id);

  return (
    <main className="container">
      <header className="header">
        <h1>Misconception of the Day</h1>
        <time className="date">{formatDate(today)}</time>
      </header>

      <article className="misconception-card">
        {!imageError && (
          <div className={`misconception-image ${imageLoaded ? "loaded" : ""}`}>
            <img
              src={imageUrl}
              alt=""
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageError(true)}
            />
          </div>
        )}

        <blockquote className="misconception-text">
          <MathText text={misconception.text} />
        </blockquote>

        <footer className="misconception-meta">
          <span className="category-badge">{misconception.category}</span>
          {misconception.subsection ? (
            <span className="section">
              {misconception.section} › {misconception.subsection}
            </span>
          ) : (
            <span className="section">{misconception.section}</span>
          )}
          <a
            href={misconception.source}
            target="_blank"
            rel="noopener noreferrer"
            className="source-link"
          >
            Read more on Wikipedia ↗
          </a>
        </footer>
      </article>

      <p className="footnote">
        One of {misconceptions.length} common misconceptions. Come back tomorrow
        for another!
      </p>
    </main>
  );
}

export default App;
