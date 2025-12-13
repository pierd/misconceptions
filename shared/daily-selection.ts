/**
 * Seeded random number generator (LCG)
 */
function createSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = ((state * 1103515245 + 12345) >>> 0) % 2147483648;
    return state / 2147483648;
  };
}

/**
 * Generate a deterministically shuffled array of indices [0, 1, 2, ..., total-1]
 * using a seeded Fisher-Yates shuffle
 */
function getShuffledIndices(total: number, seed: number): number[] {
  const indices = Array.from({ length: total }, (_, i) => i);
  const random = createSeededRandom(seed);

  // Fisher-Yates shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  return indices;
}

/**
 * Get a deterministic index based on the current date
 * Uses a shuffled sequence that cycles through ALL misconceptions before repeating
 */
export function getDailyIndex(date: Date, total: number): number {
  // Calculate days since epoch (Jan 1, 2024)
  const epoch = new Date(2024, 0, 1);
  const daysSinceEpoch = Math.floor(
    (date.getTime() - epoch.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Determine which cycle we're in and position within cycle
  const cycleNumber = Math.floor(daysSinceEpoch / total);
  const positionInCycle = ((daysSinceEpoch % total) + total) % total; // Handle negative days

  // Generate a shuffled sequence for this cycle
  const shuffled = getShuffledIndices(total, cycleNumber);

  return shuffled[positionInCycle];
}

/**
 * Get the misconception indices for a date range starting from a given date
 * Positive days: go forward (next N days)
 * Negative days: go backward (past N days)
 * Results are always sorted chronologically (oldest first)
 */
export function getDateRangeIndices(
  startDate: Date,
  days: number,
  total: number
): { date: Date; index: number }[] {
  const results: { date: Date; index: number }[] = [];
  const count = Math.abs(days);
  const step = days >= 0 ? 1 : -1;

  for (let i = 0; i < count; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i * step);
    results.push({
      date: new Date(date),
      index: getDailyIndex(date, total),
    });
  }

  // Sort chronologically (oldest first) when going backwards
  if (days < 0) {
    results.reverse();
  }

  return results;
}

/**
 * @deprecated Use getDateRangeIndices instead
 * Get the misconception indices for the next N days starting from a given date
 */
export const getUpcomingIndices = getDateRangeIndices;
