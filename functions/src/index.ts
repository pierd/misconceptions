import {createHash} from "node:crypto";
import {initializeApp} from "firebase-admin/app";
import {FieldValue, getFirestore} from "firebase-admin/firestore";
import {defineSecret} from "firebase-functions/params";
import {setGlobalOptions} from "firebase-functions/v2";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

initializeApp();

const db = getFirestore();
const forwardEmailApiKey = defineSecret("FORWARD_EMAIL_API_KEY");
const newsletterAlertEmail = defineSecret("NEWSLETTER_ALERT_EMAIL");
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FORWARD_EMAIL_API_URL = "https://api.forwardemail.net/v1/emails";
const NEWSLETTER_FROM_EMAIL = "misconceptions@lessismore.studio";
const WARSAW_TIME_ZONE = "Europe/Warsaw";
const LOW_RUNWAY_DAYS = 14;
const CORS_ORIGINS = [
  /^https:\/\/misconceptions\.lessismore\.studio$/,
  /^https:\/\/misconceptions-lims\.web\.app$/,
  /^https:\/\/misconceptions-lims\.firebaseapp\.com$/,
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
];

setGlobalOptions({
  maxInstances: 10,
  region: "europe-west1",
});

function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") {
    throw new HttpsError("invalid-argument", "Email is required.");
  }

  const normalized = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(normalized)) {
    throw new HttpsError("invalid-argument", "Enter a valid email address.");
  }

  return normalized;
}

function emailDocumentId(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

function getStringField(
  data: FirebaseFirestore.DocumentData,
  field: string,
): string {
  const value = data[field];
  return typeof value === "string" ? value.trim() : "";
}

function buildMisconceptionEmail(misconception: FirebaseFirestore.DocumentData): {
  subject: string;
  text: string;
  html: string;
} {
  const text = getStringField(misconception, "text");
  const category = getStringField(misconception, "category");
  const section = getStringField(misconception, "section");
  const subsection = getStringField(misconception, "subsection");
  const source = getStringField(misconception, "source");
  const location = [category, section, subsection].filter(Boolean).join(" / ");
  const subject = category ?
    `Today's misconception: ${category}` :
    "Today's misconception";
  const metadata = location ? `\n\nCategory: ${location}` : "";
  const sourceLine = source ? `\nSource: ${source}` : "";
  const textBody = `${text}${metadata}${sourceLine}`;
  const htmlBody = [
    "<p>",
    escapeHtml(text).replace(/\n/g, "<br>"),
    "</p>",
    location ? `<p><strong>Category:</strong> ${escapeHtml(location)}</p>` : "",
    source ?
      `<p><a href="${escapeHtml(source)}">Read the source</a></p>` :
      "",
  ].join("");

  return {
    subject,
    text: textBody,
    html: htmlBody,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case "\"":
      return "&quot;";
    case "'":
      return "&#39;";
    default:
      return character;
    }
  });
}

function getWarsawDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WARSAW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

async function sendEmail(email: string, message: EmailMessage): Promise<void> {
  const apiKey = forwardEmailApiKey.value();
  const body = new URLSearchParams({
    from: NEWSLETTER_FROM_EMAIL,
    to: email,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  const response = await fetch(FORWARD_EMAIL_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Forward Email API returned ${response.status}: ${responseBody}`,
    );
  }
}

/**
 * Emails the newsletter owner. Never throws, so alerting can't mask the
 * original error.
 */
async function sendAlert(subject: string, text: string): Promise<void> {
  try {
    await sendEmail(newsletterAlertEmail.value(), {
      subject: `[misconceptions] ${subject}`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (error) {
    logger.error("Failed to send newsletter alert.", {subject, error});
  }
}

async function getUsedMisconceptionIds(): Promise<Set<string>> {
  const snapshot = await db
    .collection("dailyMisconceptions")
    .select("misconceptionId")
    .get();
  return new Set(snapshot.docs.map((doc) => doc.get("misconceptionId")));
}

/**
 * Active, reviewed misconceptions that have never been scheduled, in order.
 */
async function getUnusedReviewedMisconceptionIds(): Promise<string[]> {
  const [used, reviewedSnapshot] = await Promise.all([
    getUsedMisconceptionIds(),
    db.collection("misconceptions").where("reviewed", "==", true).get(),
  ]);

  return reviewedSnapshot.docs
    .filter((doc) => doc.get("active") === true && !used.has(doc.id))
    .sort((a, b) => Number(a.get("order") ?? 0) - Number(b.get("order") ?? 0))
    .map((doc) => doc.id);
}

/**
 * Schedules the next unused reviewed misconception for a day that has no
 * schedule entry, so the newsletter keeps going when the schedule runs out.
 */
async function scheduleFallbackMisconception(dateKey: string): Promise<string> {
  const [misconceptionId] = await getUnusedReviewedMisconceptionIds();
  if (!misconceptionId) {
    throw new Error(
      `No daily misconception scheduled for ${dateKey} and no unused reviewed misconceptions left.`,
    );
  }

  await db.collection("dailyMisconceptions").doc(dateKey).set({
    date: dateKey,
    misconceptionId,
    status: "published",
    source: "fallback",
    updatedAt: FieldValue.serverTimestamp(),
  });
  logger.warn("No schedule entry; used fallback misconception.", {
    dateKey,
    misconceptionId,
  });

  return misconceptionId;
}

/**
 * Days of content left after dateKey: scheduled future days plus unused
 * reviewed misconceptions the fallback can still pick.
 */
async function getRunwayDays(dateKey: string): Promise<number> {
  const [scheduledSnapshot, unused] = await Promise.all([
    db.collection("dailyMisconceptions").where("date", ">", dateKey).count().get(),
    getUnusedReviewedMisconceptionIds(),
  ]);
  return scheduledSnapshot.data().count + unused.length;
}

export const subscribeToNewsletter = onCall(
  {
    cors: CORS_ORIGINS,
    invoker: "public",
  },
  async (request) => {
    const email = normalizeEmail(request.data?.email);
    const subscriberRef = db
      .collection("newsletterSubscribers")
      .doc(emailDocumentId(email));
    const now = FieldValue.serverTimestamp();

    const status = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(subscriberRef);

      if (snapshot.exists && snapshot.get("status") === "active") {
        transaction.update(subscriberRef, {
          updatedAt: now,
        });
        return "already-subscribed";
      }

      transaction.set(
        subscriberRef,
        {
          email,
          status: "active",
          source: "frontend",
          createdAt: snapshot.exists ? snapshot.get("createdAt") ?? now : now,
          updatedAt: now,
        },
        {merge: true},
      );

      return "subscribed";
    });

    return {status};
  },
);

export const sendDailyMisconception = onSchedule(
  {
    schedule: "every day 08:00",
    timeZone: WARSAW_TIME_ZONE,
    secrets: [forwardEmailApiKey, newsletterAlertEmail],
  },
  async () => {
    const dateKey = getWarsawDateKey();
    const sendRef = db.collection("newsletterSends").doc(dateKey);

    const shouldSend = await db.runTransaction(async (transaction) => {
      const sendSnapshot = await transaction.get(sendRef);
      const existingStatus = sendSnapshot.exists ? sendSnapshot.get("status") : undefined;

      if (
        existingStatus === "sending" ||
        existingStatus === "prepared" ||
        existingStatus === "sent"
      ) {
        return false;
      }

      transaction.set(
        sendRef,
        {
          date: dateKey,
          status: "sending",
          startedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true},
      );

      return true;
    });

    if (!shouldSend) {
      logger.info("Daily misconception newsletter already handled.", {dateKey});
      return;
    }

    try {
      const dailySnapshot = await db.collection("dailyMisconceptions").doc(dateKey).get();
      const misconceptionId = dailySnapshot.exists ?
        dailySnapshot.get("misconceptionId") :
        await scheduleFallbackMisconception(dateKey);
      if (typeof misconceptionId !== "string" || misconceptionId.length === 0) {
        throw new Error(`Daily schedule ${dateKey} is missing misconceptionId.`);
      }

      const misconceptionSnapshot = await db
        .collection("misconceptions")
        .doc(misconceptionId)
        .get();
      if (!misconceptionSnapshot.exists || misconceptionSnapshot.get("active") !== true) {
        throw new Error(`Misconception ${misconceptionId} is missing or inactive.`);
      }

      const subscribersSnapshot = await db
        .collection("newsletterSubscribers")
        .where("status", "==", "active")
        .get();
      const message = buildMisconceptionEmail(misconceptionSnapshot.data() ?? {});
      let sentCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (const subscriber of subscribersSnapshot.docs) {
        const email = subscriber.get("email");
        if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
          skippedCount++;
          continue;
        }

        try {
          await sendEmail(email, message);
          sentCount++;
        } catch (error) {
          failedCount++;
          logger.error("Failed to send daily misconception email.", {
            subscriberId: subscriber.id,
            error,
          });
        }
      }

      await sendRef.set(
        {
          status: failedCount > 0 ? "partial" : "sent",
          misconceptionId,
          recipientCount: subscribersSnapshot.size,
          preparedCount: sentCount,
          sentCount,
          failedCount,
          skippedCount,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true},
      );

      if (failedCount > 0) {
        await sendAlert(
          `Partial send on ${dateKey}`,
          `${failedCount} of ${subscribersSnapshot.size} emails failed to send for ${dateKey}. Check the function logs.`,
        );
      }

      // The send is already recorded, so a failed check must not mark it failed.
      try {
        const runwayDays = await getRunwayDays(dateKey);
        if (runwayDays <= LOW_RUNWAY_DAYS) {
          await sendAlert(
            `${runwayDays} days of misconceptions left`,
            `After ${dateKey} there are ${runwayDays} days of misconceptions left (scheduled plus unused reviewed). Review more misconceptions to keep the newsletter going.`,
          );
        }
      } catch (error) {
        logger.error("Failed to check misconception runway.", {dateKey, error});
      }
    } catch (error) {
      await sendRef.set(
        {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true},
      );
      await sendAlert(
        `Send failed on ${dateKey}`,
        `The daily misconception newsletter failed for ${dateKey}:\n\n${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  },
);
