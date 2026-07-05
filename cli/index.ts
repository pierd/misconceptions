import { Command } from "commander";
import { writeFile, readFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { fal } from "@fal-ai/client";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getDateRangeIndices } from "../shared/daily-selection";

const program = new Command();

program
  .name("misconception-cli")
  .description("CLI utilities for Misconception of the Day")
  .version("0.0.1");

program
  .command("hello")
  .description("A simple hello command")
  .argument("[name]", "name to greet", "world")
  .action((name: string) => {
    console.log(`Hello, ${name}!`);
  });

// Wikipedia pages to fetch misconceptions from
const WIKIPEDIA_PAGES = [
  {
    title: "List_of_common_misconceptions_about_arts_and_culture",
    category: "Arts & Culture",
  },
  {
    title: "List_of_common_misconceptions_about_history",
    category: "History",
  },
  {
    title: "List_of_common_misconceptions_about_science,_technology,_and_mathematics",
    category: "Science, Technology & Mathematics",
  },
];

interface WikiSection {
  toclevel: number;
  level: string;
  line: string;
  number: string;
  index: string;
  fromtitle: string;
  byteoffset: number;
  anchor: string;
}

interface WikiParseResponse {
  parse: {
    title: string;
    pageid: number;
    sections: WikiSection[];
    text: {
      "*": string;
    };
  };
}

interface Misconception {
  id: string;
  text: string;
  section: string;
  subsection?: string;
  category: string;
  source: string;
}

interface MisconceptionsOutput {
  generatedAt: string;
  totalCount: number;
  misconceptions: Misconception[];
}

interface FirestoreOptions {
  projectId?: string;
}

function getAdminDb(options: FirestoreOptions) {
  if (getApps().length === 0) {
    initializeApp(options.projectId ? { projectId: options.projectId } : undefined);
  }

  return getFirestore();
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date "${dateKey}". Use yyyy-mm-dd.`);
  }

  return new Date(year, month - 1, day);
}

function addCalendarDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Fetch and parse a Wikipedia page using the MediaWiki API
 */
async function fetchWikipediaPage(pageTitle: string): Promise<WikiParseResponse> {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "parse");
  url.searchParams.set("page", pageTitle);
  url.searchParams.set("format", "json");
  url.searchParams.set("prop", "sections|text");
  url.searchParams.set("disabletoc", "1");
  url.searchParams.set("origin", "*");

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch ${pageTitle}: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Extract LaTeX from annotation tags and replace math elements with inline LaTeX
 */
function extractLatex(html: string): string {
  // Replace math elements with their LaTeX annotation content
  // Wikipedia puts LaTeX source in <annotation encoding="application/x-tex">
  return html.replace(
    /<math[^>]*>[\s\S]*?<annotation[^>]*encoding="application\/x-tex"[^>]*>([\s\S]*?)<\/annotation>[\s\S]*?<\/math>/gi,
    (_, latex) => {
      // Decode HTML entities in the LaTeX
      const decodedLatex = latex
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, (_: string, code: string) => String.fromCharCode(parseInt(code)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .trim();
      // Use $...$ for inline math (KaTeX format)
      return ` $${decodedLatex}$ `;
    }
  );
}

/**
 * Clean HTML and extract plain text from a string, preserving LaTeX
 */
function cleanHtmlText(html: string): string {
  // First, extract LaTeX from math elements
  const text = extractLatex(html);

  return text
    // Remove reference tags like [1], [2], etc.
    .replace(/<sup[^>]*class="reference"[^>]*>.*?<\/sup>/gi, "")
    // Remove citation needed tags
    .replace(/<sup[^>]*class="noprint"[^>]*>.*?<\/sup>/gi, "")
    // Remove any remaining math elements that didn't have annotation
    .replace(/<math[^>]*>[\s\S]*?<\/math>/gi, "")
    // Remove span elements containing texhtml but preserve simple ones
    .replace(/<span[^>]*class="[^"]*texhtml[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, "$1")
    // Remove img tags
    .replace(/<img[^>]*>/gi, "")
    // Remove all other HTML tags
    .replace(/<[^>]+>/g, "")
    // Decode HTML entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    // Clean up whitespace (but preserve single spaces around $...$)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract misconceptions from the HTML content
 */
function extractMisconceptions(
  html: string,
  sections: WikiSection[],
  category: string,
  pageTitle: string
): Misconception[] {
  const misconceptions: Misconception[] = [];
  const sourceUrl = `https://en.wikipedia.org/wiki/${pageTitle}`;

  // Parse HTML to extract bullet points from each section
  // Wikipedia's current HTML uses simple <h2 id="...">Title</h2> format
  const h2Regex = /<h2[^>]*\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gi;
  const h3Regex = /<h3[^>]*\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h3>/gi;

  // Find all section boundaries
  const sectionBoundaries: { id: string; title: string; level: number; start: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = h2Regex.exec(html)) !== null) {
    sectionBoundaries.push({
      id: match[1],
      title: cleanHtmlText(match[2]),
      level: 2,
      start: match.index,
    });
  }
  while ((match = h3Regex.exec(html)) !== null) {
    sectionBoundaries.push({
      id: match[1],
      title: cleanHtmlText(match[2]),
      level: 3,
      start: match.index,
    });
  }

  // Sort by position
  sectionBoundaries.sort((a, b) => a.start - b.start);

  // Skip References, See also, Notes, etc.
  const skipSections = new Set([
    "References",
    "See_also",
    "Notes",
    "External_links",
    "Further_reading",
    "Citations",
  ]);

  let currentSection = "";
  let currentSubsection: string | undefined;

  for (let i = 0; i < sectionBoundaries.length; i++) {
    const boundary = sectionBoundaries[i];
    const nextBoundary = sectionBoundaries[i + 1];

    if (skipSections.has(boundary.id)) {
      continue;
    }

    if (boundary.level === 2) {
      currentSection = boundary.title;
      currentSubsection = undefined;
    } else if (boundary.level === 3) {
      currentSubsection = boundary.title;
    }

    // Extract content between this section and the next
    const startIndex = boundary.start;
    const endIndex = nextBoundary ? nextBoundary.start : html.length;
    const sectionHtml = html.slice(startIndex, endIndex);

    // Extract list items (bullet points) - match complete li tags
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    while ((match = liRegex.exec(sectionHtml)) !== null) {
      let liContent = match[1];

      // Skip nested lists (sub-items that are usually examples or details)
      // Only take content before nested list
      if (liContent.includes("<ul>") || liContent.includes("<ol>")) {
        const nestedListIndex = Math.min(
          liContent.indexOf("<ul>") !== -1 ? liContent.indexOf("<ul>") : Infinity,
          liContent.indexOf("<ol>") !== -1 ? liContent.indexOf("<ol>") : Infinity
        );
        if (nestedListIndex !== Infinity) {
          liContent = liContent.slice(0, nestedListIndex);
        }
      }

      const text = cleanHtmlText(liContent);

      // Filter out very short entries or navigation items
      if (
        text.length > 20 &&
        !text.startsWith("Main article:") &&
        !text.startsWith("See also:") &&
        !text.match(/^[a-z]\.\s/i) // Skip list markers like "a. ", "b. "
      ) {
        misconceptions.push({
          id: generateId(text),
          text,
          section: currentSection || category,
          subsection: currentSubsection,
          category,
          source: sourceUrl,
        });
      }
    }
  }

  return misconceptions;
}

/**
 * Generate a unique ID from text
 */
function generateId(text: string): string {
  // Create a simple hash from the text
  const hash = text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 30);
  const checksum = text.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return `${hash}-${checksum.toString(16)}`;
}

program
  .command("pull")
  .description("Pull misconceptions from Wikipedia and save to JSON")
  .option("-o, --output <path>", "Output file path", "misconceptions.json")
  .action(async (options: { output: string }) => {
    console.log("🔍 Fetching misconceptions from Wikipedia...\n");

    const allMisconceptions: Misconception[] = [];

    for (const page of WIKIPEDIA_PAGES) {
      try {
        console.log(`📖 Fetching: ${page.category}...`);
        const data = await fetchWikipediaPage(page.title);

        const misconceptions = extractMisconceptions(
          data.parse.text["*"],
          data.parse.sections,
          page.category,
          page.title
        );

        console.log(`   ✓ Found ${misconceptions.length} misconceptions`);
        allMisconceptions.push(...misconceptions);
      } catch (error) {
        console.error(`   ✗ Error fetching ${page.category}:`, error);
      }
    }

    // Remove duplicates based on ID
    const uniqueMisconceptions = Array.from(
      new Map(allMisconceptions.map((m) => [m.id, m])).values()
    );

    const output: MisconceptionsOutput = {
      generatedAt: new Date().toISOString(),
      totalCount: uniqueMisconceptions.length,
      misconceptions: uniqueMisconceptions,
    };

    const outputPath = options.output.startsWith("/")
      ? options.output
      : join(process.cwd(), options.output);

    await writeFile(outputPath, JSON.stringify(output, null, 2));

    console.log(`\n✅ Saved ${uniqueMisconceptions.length} misconceptions to ${outputPath}`);
  });

/**
 * Load misconceptions from the JSON file
 */
async function loadMisconceptions(): Promise<Misconception[]> {
  const filePath = join(process.cwd(), "misconceptions.json");
  const content = await readFile(filePath, "utf-8");
  const data = JSON.parse(content) as MisconceptionsOutput;
  return data.misconceptions;
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a prompt for the image based on the misconception
 */
function generatePrompt(misconception: Misconception): string {
  return `Educational illustration to accompany the following text: ${misconception.text.slice(0, 500)}. Style: modern, clean, minimal or no text, informative infographic style with subtle colors.`;
}

/**
 * Download an image from a URL and save it to disk
 */
async function downloadImage(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await writeFile(outputPath, Buffer.from(arrayBuffer));
}

interface FalImageResult {
  images: Array<{ url: string; content_type?: string }>;
}

program
  .command("generate-images")
  .description("Generate images for misconceptions using fal.ai")
  .option("-k, --api-key <key>", "fal.ai API key (or set FAL_KEY env variable)")
  .option(
    "-m, --model <model>",
    "fal.ai model to use",
    "fal-ai/flux/schnell"
  )
  .option("-i, --id <id>", "Generate image for a specific misconception ID")
  .option("--missing", "Only generate images for misconceptions without images")
  .option("-d, --days <n>", "Generate images for misconceptions shown in the next N days", parseInt)
  .option("-p, --past <n>", "Generate images for misconceptions shown in the past N days", parseInt)
  .option("-o, --output <dir>", "Output directory for images", "public/images")
  .option("--dry-run", "Show what would be generated without actually generating")
  .action(
    async (options: {
      apiKey?: string;
      model: string;
      id?: string;
      missing?: boolean;
      days?: number;
      past?: number;
      output: string;
      dryRun?: boolean;
    }) => {
      const apiKey = options.apiKey || process.env.FAL_KEY;
      if (!apiKey && !options.dryRun) {
        console.error(
          "❌ API key required. Provide --api-key or set FAL_KEY environment variable."
        );
        process.exit(1);
      }

      // Configure fal.ai client
      if (apiKey) {
        fal.config({ credentials: apiKey });
      }

      // Load misconceptions
      console.log("📖 Loading misconceptions...");
      const misconceptions = await loadMisconceptions();
      console.log(`   Found ${misconceptions.length} misconceptions\n`);

      // Ensure output directory exists
      const outputDir = options.output.startsWith("/")
        ? options.output
        : join(process.cwd(), options.output);

      await mkdir(outputDir, { recursive: true });

      // Filter misconceptions based on options
      let toGenerate: Misconception[] = [];

      if (options.id) {
        // Generate for specific ID
        const found = misconceptions.find((m) => m.id === options.id);
        if (!found) {
          console.error(`❌ Misconception with ID "${options.id}" not found.`);
          process.exit(1);
        }
        toGenerate = [found];
      } else if (options.days || options.past) {
        // Generate for misconceptions shown in the next/past N days
        const daysValue = options.days ?? -(options.past!);
        const direction = daysValue >= 0 ? "next" : "past";
        const count = Math.abs(daysValue);
        console.log(`📅 Finding misconceptions for the ${direction} ${count} days...`);
        const dateRange = getDateRangeIndices(new Date(), daysValue, misconceptions.length);
        const seenIndices = new Set<number>();

        for (const { date, index } of dateRange) {
          if (!seenIndices.has(index)) {
            seenIndices.add(index);
            const m = misconceptions[index];
            const imagePath = join(outputDir, `${m.id}.png`);
            const hasImage = await fileExists(imagePath);
            const dateStr = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
            console.log(`   ${dateStr}: ${m.text.slice(0, 50)}...${hasImage ? " (has image)" : ""}`);
            if (!hasImage) {
              toGenerate.push(m);
            }
          }
        }
        console.log(`   Found ${toGenerate.length} misconceptions needing images\n`);
      } else if (options.missing) {
        // Generate only missing images
        console.log("🔍 Checking for missing images...");
        for (const m of misconceptions) {
          const imagePath = join(outputDir, `${m.id}.png`);
          if (!(await fileExists(imagePath))) {
            toGenerate.push(m);
          }
        }
        console.log(`   Found ${toGenerate.length} misconceptions without images\n`);
      } else {
        // Generate for all
        toGenerate = misconceptions;
      }

      if (toGenerate.length === 0) {
        console.log("✅ No images to generate.");
        return;
      }

      if (options.dryRun) {
        console.log("🏃 Dry run - would generate images for:");
        for (const m of toGenerate.slice(0, 10)) {
          console.log(`   - ${m.id}: ${m.text.slice(0, 60)}...`);
        }
        if (toGenerate.length > 10) {
          console.log(`   ... and ${toGenerate.length - 10} more`);
        }
        return;
      }

      console.log(`🎨 Generating ${toGenerate.length} images using ${options.model}...\n`);

      let successCount = 0;
      let errorCount = 0;

      for (let i = 0; i < toGenerate.length; i++) {
        const m = toGenerate[i];
        const imagePath = join(outputDir, `${m.id}.png`);

        console.log(`[${i + 1}/${toGenerate.length}] Generating: ${m.id}`);
        console.log(`   Text: ${m.text.slice(0, 80)}...`);

        try {
          const prompt = generatePrompt(m);

          const result = await fal.subscribe(options.model, {
            input: {
              prompt,
              image_size: "landscape_16_9",
              num_images: 1,
            },
            logs: false,
          });

          const imageData = result.data as FalImageResult;
          if (imageData.images && imageData.images.length > 0) {
            const imageUrl = imageData.images[0].url;
            await downloadImage(imageUrl, imagePath);
            console.log(`   ✓ Saved to ${imagePath}\n`);
            successCount++;
          } else {
            console.error(`   ✗ No image returned\n`);
            errorCount++;
          }
        } catch (error) {
          console.error(`   ✗ Error: ${error}\n`);
          errorCount++;
        }
      }

      console.log(`\n✅ Done! Generated ${successCount} images, ${errorCount} errors.`);
    }
  );

program
  .command("seed-firestore")
  .description("Import misconceptions.json into Firestore")
  .option("-i, --input <path>", "Input JSON file path", "misconceptions.json")
  .option("-p, --project-id <id>", "Firebase project ID")
  .option("--dry-run", "Show what would be written without writing")
  .action(
    async (options: {
      input: string;
      projectId?: string;
      dryRun?: boolean;
    }) => {
      const inputPath = options.input.startsWith("/")
        ? options.input
        : join(process.cwd(), options.input);
      const content = await readFile(inputPath, "utf-8");
      const data = JSON.parse(content) as MisconceptionsOutput;

      if (options.dryRun) {
        console.log(`Would import ${data.misconceptions.length} misconceptions from ${inputPath}`);
        console.log("First entries:");
        for (const misconception of data.misconceptions.slice(0, 5)) {
          console.log(`- ${misconception.id}: ${misconception.text.slice(0, 80)}...`);
        }
        return;
      }

      const db = getAdminDb(options);
      let batch = db.batch();
      let operationCount = 0;
      let totalWrites = 0;

      const commitIfNeeded = async (force = false) => {
        if (operationCount === 0 || (!force && operationCount < 450)) {
          return;
        }

        await batch.commit();
        totalWrites += operationCount;
        batch = db.batch();
        operationCount = 0;
      };

      data.misconceptions.forEach((misconception, index) => {
        const ref = db.collection("misconceptions").doc(misconception.id);
        batch.set(
          ref,
          {
            ...misconception,
            order: index,
            active: true,
            reviewed: false,
            importedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        operationCount++;
      });

      batch.set(
        db.collection("metadata").doc("misconceptions"),
        {
          generatedAt: data.generatedAt,
          totalCount: data.totalCount,
          importedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      operationCount++;

      await commitIfNeeded(true);
      console.log(`Imported ${totalWrites} Firestore documents from ${inputPath}`);
    }
  );

program
  .command("schedule-firestore")
  .description("Create dailyMisconceptions schedule docs from ordered active misconceptions")
  .option("-p, --project-id <id>", "Firebase project ID")
  .option("-s, --start <date>", "Start date as yyyy-mm-dd", toDateKey(new Date()))
  .option("-d, --days <n>", "Number of days to schedule", (value) => parseInt(value, 10), 30)
  .option("-o, --offset <n>", "Offset into ordered misconceptions", (value) => parseInt(value, 10), 0)
  .option("--status <status>", "Status to write on schedule docs", "published")
  .option("--overwrite", "Overwrite existing daily schedule docs")
  .option("--dry-run", "Show what would be written without writing")
  .action(
    async (options: {
      projectId?: string;
      start: string;
      days: number;
      offset: number;
      status: string;
      overwrite?: boolean;
      dryRun?: boolean;
    }) => {
      const db = getAdminDb(options);
      const misconceptionsSnapshot = await db
        .collection("misconceptions")
        .where("active", "==", true)
        .orderBy("order", "asc")
        .get();
      const misconceptions = misconceptionsSnapshot.docs.map((docSnapshot) => ({
        id: docSnapshot.id,
        order: Number(docSnapshot.get("order") ?? 0),
        text: String(docSnapshot.get("text") ?? ""),
      }));

      if (misconceptions.length === 0) {
        throw new Error("No active misconceptions found in Firestore.");
      }

      const startDate = parseDateKey(options.start);
      const writes: Array<{
        date: string;
        misconceptionId: string;
        order: number;
        text: string;
      }> = [];

      for (let day = 0; day < options.days; day++) {
        const date = toDateKey(addCalendarDays(startDate, day));
        const misconception = misconceptions[(options.offset + day) % misconceptions.length];
        writes.push({
          date,
          misconceptionId: misconception.id,
          order: misconception.order,
          text: misconception.text,
        });
      }

      if (options.dryRun) {
        for (const write of writes) {
          console.log(`${write.date}: ${write.misconceptionId} - ${write.text.slice(0, 80)}...`);
        }
        return;
      }

      const batch = db.batch();
      let writeCount = 0;
      let skipCount = 0;

      for (const write of writes) {
        const ref = db.collection("dailyMisconceptions").doc(write.date);
        if (!options.overwrite && (await ref.get()).exists) {
          skipCount++;
          continue;
        }

        batch.set(
          ref,
          {
            date: write.date,
            misconceptionId: write.misconceptionId,
            order: write.order,
            status: options.status,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        writeCount++;
      }

      if (writeCount > 0) {
        await batch.commit();
      }

      console.log(`Scheduled ${writeCount} days, skipped ${skipCount} existing docs.`);
    }
  );

program
  .command("preview-schedule")
  .description("Preview scheduled misconceptions from Firestore")
  .option("-p, --project-id <id>", "Firebase project ID")
  .option("-s, --start <date>", "Start date as yyyy-mm-dd", toDateKey(new Date()))
  .option("-d, --days <n>", "Number of days to preview", (value) => parseInt(value, 10), 7)
  .action(
    async (options: {
      projectId?: string;
      start: string;
      days: number;
    }) => {
      const db = getAdminDb(options);
      const startDate = parseDateKey(options.start);

      for (let day = 0; day < options.days; day++) {
        const date = toDateKey(addCalendarDays(startDate, day));
        const dailySnapshot = await db.collection("dailyMisconceptions").doc(date).get();

        if (!dailySnapshot.exists) {
          console.log(`${date}: not scheduled`);
          continue;
        }

        const misconceptionId = String(dailySnapshot.get("misconceptionId") ?? "");
        const misconceptionSnapshot = await db
          .collection("misconceptions")
          .doc(misconceptionId)
          .get();
        const text = misconceptionSnapshot.exists
          ? String(misconceptionSnapshot.get("text") ?? "")
          : "missing misconception";
        console.log(
          `${date}: ${dailySnapshot.get("status")} ${misconceptionId} - ${text.slice(0, 80)}...`
        );
      }
    }
  );

program.parse();
