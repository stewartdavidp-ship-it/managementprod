/**
 * Fuzzy matching utility for did_you_mean suggestions.
 *
 * Strategy:
 *  1. Substring match on id and optional label (fast, covers ~90%)
 *  2. Levenshtein distance fallback for typos
 *  3. Max 3 candidates; omit entirely if nothing is close
 */

export interface FuzzyEntry {
  id: string;
  label?: string; // human-readable name (e.g. app.name, idea.name, skill displayName)
}

export interface FuzzyCandidate {
  id: string;
  label?: string;
  matchType: "substring" | "levenshtein";
}

/**
 * Standard Levenshtein distance between two strings.
 * Returns the minimum edit distance (insertions, deletions, substitutions).
 */
function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Use single-row optimization (O(min(la,lb)) space)
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);

  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[lb];
}

/**
 * Find fuzzy-match candidates for a query against a list of entries.
 *
 * Phase 1: Substring match (case-insensitive) on id or label.
 * Phase 2: Levenshtein distance fallback — only if Phase 1 found < maxResults.
 *
 * Levenshtein threshold: distance ≤ max(2, floor(query.length * 0.4))
 * This allows ~40% character differences, capped reasonably for short strings.
 *
 * @returns Up to maxResults candidates, or empty array if nothing is close.
 */
export function findCandidates(
  query: string,
  entries: FuzzyEntry[],
  maxResults: number = 3
): FuzzyCandidate[] {
  if (!query || entries.length === 0) return [];

  const qLower = query.toLowerCase();
  const candidates: FuzzyCandidate[] = [];

  // Phase 1: Substring match
  for (const entry of entries) {
    const idLower = entry.id.toLowerCase();
    const labelLower = entry.label?.toLowerCase() || "";

    if (idLower.includes(qLower) || qLower.includes(idLower) ||
        (labelLower && (labelLower.includes(qLower) || qLower.includes(labelLower)))) {
      candidates.push({
        id: entry.id,
        label: entry.label,
        matchType: "substring",
      });
      if (candidates.length >= maxResults) break;
    }
  }

  if (candidates.length >= maxResults) return candidates;

  // Phase 2: Levenshtein fallback
  const threshold = Math.max(2, Math.floor(qLower.length * 0.4));
  const alreadyFound = new Set(candidates.map(c => c.id));

  const scored: { entry: FuzzyEntry; dist: number }[] = [];

  for (const entry of entries) {
    if (alreadyFound.has(entry.id)) continue;

    // Check distance against both id and label, take best
    const idDist = levenshtein(qLower, entry.id.toLowerCase());
    const labelDist = entry.label
      ? levenshtein(qLower, entry.label.toLowerCase())
      : Infinity;
    const bestDist = Math.min(idDist, labelDist);

    if (bestDist <= threshold) {
      scored.push({ entry, dist: bestDist });
    }
  }

  // Sort by distance, take remaining slots
  scored.sort((a, b) => a.dist - b.dist);
  const remaining = maxResults - candidates.length;

  for (let i = 0; i < Math.min(remaining, scored.length); i++) {
    candidates.push({
      id: scored[i].entry.id,
      label: scored[i].entry.label,
      matchType: "levenshtein",
    });
  }

  return candidates;
}

/**
 * Format did_you_mean for inclusion in an error response.
 * Returns the array if candidates exist, or undefined to omit the field.
 */
export function formatDidYouMean(
  candidates: FuzzyCandidate[]
): string[] | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.map(c => c.label ? `${c.id} (${c.label})` : c.id);
}
