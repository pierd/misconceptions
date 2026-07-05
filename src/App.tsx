import { useCallback, useEffect, useState } from "react";
import { InlineMath } from "react-katex";
import "katex/dist/katex.min.css";
import {
  GoogleAuthProvider,
  User,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import {
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  collection,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { addDays, formatDate, isSameDay, toDateKey } from "./date";
import { auth, db, functions, missingFirebaseConfig } from "./firebase";
import type {
  DailyMisconception,
  DailyMisconceptionStatus,
  Misconception,
} from "../shared/types";

type DailyView = {
  daily: DailyMisconception;
  misconception: Misconception;
};

type SubscribeResult = {
  status: "subscribed" | "already-subscribed";
};

type UpcomingItem = {
  daily: DailyMisconception;
  misconception?: Misconception;
};

type MisconceptionDraft = Pick<
  Misconception,
  "text" | "section" | "category" | "source" | "active" | "reviewed"
> & {
  subsection: string;
};

type DailyDraft = Pick<DailyMisconception, "misconceptionId" | "order" | "status">;

const provider = new GoogleAuthProvider();

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

function toMisconception(id: string, data: Record<string, unknown>): Misconception {
  return {
    id,
    text: String(data.text ?? ""),
    section: String(data.section ?? ""),
    subsection:
      typeof data.subsection === "string" && data.subsection.length > 0
        ? data.subsection
        : undefined,
    category: String(data.category ?? ""),
    source: String(data.source ?? ""),
    order: Number(data.order ?? 0),
    active: data.active === true,
    reviewed: data.reviewed === true,
  };
}

function toDailyMisconception(id: string, data: Record<string, unknown>): DailyMisconception {
  return {
    date: String(data.date ?? id),
    misconceptionId: String(data.misconceptionId ?? ""),
    order: Number(data.order ?? 0),
    status: String(data.status ?? "draft") as DailyMisconceptionStatus,
  };
}

function misconceptionToDraft(misconception: Misconception): MisconceptionDraft {
  return {
    text: misconception.text,
    section: misconception.section,
    subsection: misconception.subsection ?? "",
    category: misconception.category,
    source: misconception.source,
    active: misconception.active,
    reviewed: misconception.reviewed,
  };
}

function dailyToDraft(daily: DailyMisconception): DailyDraft {
  return {
    misconceptionId: daily.misconceptionId,
    order: daily.order,
    status: daily.status,
  };
}

function App() {
  const [route, setRoute] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setRoute(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  if (route === "/admin") {
    return <AdminApp />;
  }

  return <PublicApp />;
}

function PublicApp() {
  const today = new Date();
  const [viewDate, setViewDate] = useState(today);
  const [dailyView, setDailyView] = useState<DailyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [submittingEmail, setSubmittingEmail] = useState(false);
  const isToday = isSameDay(viewDate, today);

  useEffect(() => {
    let cancelled = false;

    async function loadDailyMisconception() {
      setLoading(true);
      setLoadError(null);

      try {
        const dateKey = toDateKey(viewDate);
        const dailySnapshot = await getDoc(doc(db, "dailyMisconceptions", dateKey));

        if (!dailySnapshot.exists()) {
          throw new Error("No misconception has been scheduled for this day yet.");
        }

        const daily = toDailyMisconception(dateKey, dailySnapshot.data());
        const misconceptionSnapshot = await getDoc(
          doc(db, "misconceptions", daily.misconceptionId)
        );

        if (!misconceptionSnapshot.exists()) {
          throw new Error("The scheduled misconception could not be found.");
        }

        const misconception = toMisconception(
          misconceptionSnapshot.id,
          misconceptionSnapshot.data()
        );

        if (!misconception.active) {
          throw new Error("The scheduled misconception is not active.");
        }

        if (!cancelled) {
          setDailyView({ daily, misconception });
        }
      } catch (error) {
        if (!cancelled) {
          setDailyView(null);
          setLoadError(error instanceof Error ? error.message : "Could not load misconception.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadDailyMisconception();

    return () => {
      cancelled = true;
    };
  }, [viewDate]);

  const goToPreviousDay = () => {
    setViewDate(addDays(viewDate, -1));
  };

  const goToNextDay = () => {
    if (!isToday) {
      setViewDate(addDays(viewDate, 1));
    }
  };

  const goToToday = () => {
    setViewDate(today);
  };

  const subscribeToNewsletter = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubscriptionStatus(null);
    setSubscriptionError(null);
    setSubmittingEmail(true);

    try {
      const subscribe = httpsCallable<{ email: string }, SubscribeResult>(
        functions,
        "subscribeToNewsletter"
      );
      const result = await subscribe({ email });
      setSubscriptionStatus(
        result.data.status === "already-subscribed"
          ? "You're already on the list."
          : "You're on the list. Thanks for subscribing."
      );
      setEmail("");
    } catch (error) {
      setSubscriptionError(
        error instanceof Error ? error.message : "Could not subscribe right now."
      );
    } finally {
      setSubmittingEmail(false);
    }
  };

  const misconception = dailyView?.misconception;

  return (
    <main className="container">
      <header className="header">
        <h1>Misconception of the Day</h1>
        <div className="date-nav">
          <button
            className="nav-arrow nav-arrow-prev"
            onClick={goToPreviousDay}
            aria-label="Previous day"
          >
            ←
          </button>
          <time className="date">{formatDate(viewDate)}</time>
          <button
            className="nav-arrow nav-arrow-next"
            onClick={goToNextDay}
            disabled={isToday}
            aria-label="Next day"
          >
            →
          </button>
          <button
            className="nav-arrow nav-arrow-today"
            onClick={goToToday}
            disabled={isToday}
            aria-label="Go to today"
          >
            ⇥
          </button>
        </div>
      </header>

      <article className="misconception-card">
        {loading ? <p className="status-copy">Loading today's misconception...</p> : null}
        {loadError ? <p className="status-copy">{loadError}</p> : null}
        {misconception ? (
          <>
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
          </>
        ) : null}
      </article>

      <section className="newsletter-card" aria-labelledby="newsletter-heading">
        <h2 id="newsletter-heading">Get the daily misconception by email</h2>
        <form className="newsletter-form" onSubmit={subscribeToNewsletter}>
          <label className="sr-only" htmlFor="newsletter-email">
            Email address
          </label>
          <input
            id="newsletter-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
          />
          <button type="submit" disabled={submittingEmail}>
            {submittingEmail ? "Subscribing..." : "Subscribe"}
          </button>
        </form>
        {subscriptionStatus ? <p className="form-status">{subscriptionStatus}</p> : null}
        {subscriptionError ? <p className="form-error">{subscriptionError}</p> : null}
      </section>

      <p className="footnote">
        Misconceptions are now reviewed and scheduled from Firebase.
        {isToday
          ? " Come back tomorrow for another!"
          : " Use the arrows to navigate through past misconceptions."}
      </p>
    </main>
  );
}

function AdminApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [misconceptionDrafts, setMisconceptionDrafts] = useState<
    Record<string, MisconceptionDraft>
  >({});
  const [dailyDrafts, setDailyDrafts] = useState<Record<string, DailyDraft>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadAdminStatus() {
      setIsAdmin(false);

      if (!user) {
        return;
      }

      try {
        const adminSnapshot = await getDoc(doc(db, "admins", user.uid));
        if (!cancelled) {
          setIsAdmin(adminSnapshot.exists());
        }
      } catch (adminError) {
        if (!cancelled) {
          setError(
            adminError instanceof Error
              ? adminError.message
              : "Could not check admin access."
          );
        }
      }
    }

    void loadAdminStatus();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const loadUpcoming = useCallback(async () => {
    if (!isAdmin) {
      return;
    }

    setError(null);
    setStatus("Loading upcoming misconceptions...");

    try {
      const scheduleQuery = query(
        collection(db, "dailyMisconceptions"),
        where("date", ">=", toDateKey(new Date())),
        orderBy("date", "asc"),
        limit(14)
      );
      const scheduleSnapshot = await getDocs(scheduleQuery);
      const dailyItems = scheduleSnapshot.docs.map((snapshot) =>
        toDailyMisconception(snapshot.id, snapshot.data())
      );
      const items = await Promise.all(
        dailyItems.map(async (daily) => {
          const misconceptionSnapshot = await getDoc(
            doc(db, "misconceptions", daily.misconceptionId)
          );
          return {
            daily,
            misconception: misconceptionSnapshot.exists()
              ? toMisconception(misconceptionSnapshot.id, misconceptionSnapshot.data())
              : undefined,
          };
        })
      );

      setUpcoming(items);
      setDailyDrafts(
        Object.fromEntries(items.map((item) => [item.daily.date, dailyToDraft(item.daily)]))
      );
      setMisconceptionDrafts(
        Object.fromEntries(
          items
            .filter((item): item is UpcomingItem & { misconception: Misconception } =>
              Boolean(item.misconception)
            )
            .map((item) => [
              item.misconception.id,
              misconceptionToDraft(item.misconception),
            ])
        )
      );
      setStatus(items.length === 0 ? "No upcoming daily schedule docs found." : null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load schedule.");
      setStatus(null);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadUpcoming();
  }, [loadUpcoming]);

  const signIn = async () => {
    setError(null);
    await signInWithPopup(auth, provider);
  };

  const updateMisconceptionDraft = (
    id: string,
    field: keyof MisconceptionDraft,
    value: string | boolean
  ) => {
    setMisconceptionDrafts((drafts) => ({
      ...drafts,
      [id]: {
        ...drafts[id],
        [field]: value,
      },
    }));
  };

  const updateDailyDraft = (
    date: string,
    field: keyof DailyDraft,
    value: string | number
  ) => {
    setDailyDrafts((drafts) => ({
      ...drafts,
      [date]: {
        ...drafts[date],
        [field]: value,
      },
    }));
  };

  const saveMisconception = async (misconceptionId: string) => {
    const draft = misconceptionDrafts[misconceptionId];
    if (!draft) {
      return;
    }

    setStatus("Saving misconception...");
    setError(null);

    try {
      await updateDoc(doc(db, "misconceptions", misconceptionId), {
        text: draft.text,
        section: draft.section,
        subsection: draft.subsection.trim() ? draft.subsection.trim() : deleteField(),
        category: draft.category,
        source: draft.source,
        active: draft.active,
        reviewed: draft.reviewed,
        updatedAt: serverTimestamp(),
      });
      setStatus("Misconception saved.");
      await loadUpcoming();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save.");
      setStatus(null);
    }
  };

  const saveDaily = async (date: string) => {
    const draft = dailyDrafts[date];
    if (!draft) {
      return;
    }

    setStatus("Saving daily schedule...");
    setError(null);

    try {
      await updateDoc(doc(db, "dailyMisconceptions", date), {
        misconceptionId: draft.misconceptionId.trim(),
        order: Number(draft.order),
        status: draft.status,
        updatedAt: serverTimestamp(),
      });
      setStatus("Daily schedule saved.");
      await loadUpcoming();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save.");
      setStatus(null);
    }
  };

  return (
    <main className="container admin-container">
      <header className="header">
        <h1>Misconception Admin</h1>
        <p className="date">Review upcoming misconceptions before they publish.</p>
      </header>

      {missingFirebaseConfig.length > 0 ? (
        <section className="admin-card">
          <p className="form-error">
            Missing Firebase env values: {missingFirebaseConfig.join(", ")}.
          </p>
        </section>
      ) : null}

      <section className="admin-card">
        {!authReady ? <p className="status-copy">Checking sign-in state...</p> : null}
        {authReady && !user ? (
          <button className="primary-button" type="button" onClick={signIn}>
            Sign in with Google
          </button>
        ) : null}
        {user ? (
          <div className="admin-toolbar">
            <span>{user.email}</span>
            <button type="button" onClick={() => void signOut(auth)}>
              Sign out
            </button>
          </div>
        ) : null}
        {user && !isAdmin ? (
          <p className="form-error">
            This Google account is signed in, but it is not listed in `admins`.
          </p>
        ) : null}
      </section>

      {status ? <p className="form-status">{status}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      {isAdmin ? (
        <section className="admin-list" aria-label="Upcoming misconceptions">
          {upcoming.map((item) => {
            const misconception = item.misconception;
            const misconceptionDraft = misconception
              ? misconceptionDrafts[misconception.id]
              : undefined;
            const dailyDraft = dailyDrafts[item.daily.date];

            return (
              <article className="admin-card" key={item.daily.date}>
                <div className="admin-card-header">
                  <h2>{item.daily.date}</h2>
                  <span className="category-badge">{item.daily.status}</span>
                </div>

                {dailyDraft ? (
                  <div className="admin-grid">
                    <label>
                      Misconception ID
                      <input
                        value={dailyDraft.misconceptionId}
                        onChange={(event) =>
                          updateDailyDraft(
                            item.daily.date,
                            "misconceptionId",
                            event.target.value
                          )
                        }
                      />
                    </label>
                    <label>
                      Schedule order
                      <input
                        type="number"
                        value={dailyDraft.order}
                        onChange={(event) =>
                          updateDailyDraft(
                            item.daily.date,
                            "order",
                            Number(event.target.value)
                          )
                        }
                      />
                    </label>
                    <label>
                      Status
                      <select
                        value={dailyDraft.status}
                        onChange={(event) =>
                          updateDailyDraft(
                            item.daily.date,
                            "status",
                            event.target.value as DailyMisconceptionStatus
                          )
                        }
                      >
                        <option value="draft">draft</option>
                        <option value="published">published</option>
                        <option value="sent">sent</option>
                      </select>
                    </label>
                    <button type="button" onClick={() => void saveDaily(item.daily.date)}>
                      Save schedule
                    </button>
                  </div>
                ) : null}

                {misconception && misconceptionDraft ? (
                  <div className="admin-editor">
                    <label>
                      Text
                      <textarea
                        rows={6}
                        value={misconceptionDraft.text}
                        onChange={(event) =>
                          updateMisconceptionDraft(
                            misconception.id,
                            "text",
                            event.target.value
                          )
                        }
                      />
                    </label>
                    <div className="admin-grid">
                      <label>
                        Category
                        <input
                          value={misconceptionDraft.category}
                          onChange={(event) =>
                            updateMisconceptionDraft(
                              misconception.id,
                              "category",
                              event.target.value
                            )
                          }
                        />
                      </label>
                      <label>
                        Section
                        <input
                          value={misconceptionDraft.section}
                          onChange={(event) =>
                            updateMisconceptionDraft(
                              misconception.id,
                              "section",
                              event.target.value
                            )
                          }
                        />
                      </label>
                      <label>
                        Subsection
                        <input
                          value={misconceptionDraft.subsection}
                          onChange={(event) =>
                            updateMisconceptionDraft(
                              misconception.id,
                              "subsection",
                              event.target.value
                            )
                          }
                        />
                      </label>
                    </div>
                    <label>
                      Source
                      <input
                        value={misconceptionDraft.source}
                        onChange={(event) =>
                          updateMisconceptionDraft(
                            misconception.id,
                            "source",
                            event.target.value
                          )
                        }
                      />
                    </label>
                    <div className="admin-checks">
                      <label>
                        <input
                          type="checkbox"
                          checked={misconceptionDraft.active}
                          onChange={(event) =>
                            updateMisconceptionDraft(
                              misconception.id,
                              "active",
                              event.target.checked
                            )
                          }
                        />
                        Active
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={misconceptionDraft.reviewed}
                          onChange={(event) =>
                            updateMisconceptionDraft(
                              misconception.id,
                              "reviewed",
                              event.target.checked
                            )
                          }
                        />
                        Reviewed
                      </label>
                    </div>
                    <button type="button" onClick={() => void saveMisconception(misconception.id)}>
                      Save typo edits
                    </button>
                  </div>
                ) : (
                  <p className="form-error">The referenced misconception was not found.</p>
                )}
              </article>
            );
          })}
        </section>
      ) : null}
    </main>
  );
}

export default App;
