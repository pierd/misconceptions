/**
 * Get a deterministic index based on the current date
 * Same date = same misconception
 */
export function getDailyIndex(date: Date, total: number): number {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  // Simple hash based on date components
  const seed = year * 10000 + month * 100 + day;

  // Use a simple LCG-style calculation for distribution
  const hash = ((seed * 1103515245 + 12345) >>> 0) % total;
  return hash;
}

/**
 * Get the misconception indices for the next N days starting from a given date
 */
export function getUpcomingIndices(
  startDate: Date,
  days: number,
  total: number
): { date: Date; index: number }[] {
  const results: { date: Date; index: number }[] = [];

  for (let i = 0; i < days; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    results.push({
      date: new Date(date),
      index: getDailyIndex(date, total),
    });
  }

  return results;
}
