import { Command } from "commander";
import { writeFile } from "fs/promises";
import { join } from "path";

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
  let text = extractLatex(html);

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

program.parse();
