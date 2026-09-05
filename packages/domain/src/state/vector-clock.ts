/**
 * Causal clock — a per-participant counter of observed events, and the
 * four-way comparison between two such observations. Measures causal
 * structure only; content judgment belongs to the acceptance chain.
 */

export type ClockVerdict = 'dominates' | 'dominated_by' | 'concurrent' | 'equal';

/** participant id -> count of that participant's events seen. */
export type ClockSnapshot = Readonly<Record<string, number>>;

export const compareClocks = (a: ClockSnapshot, b: ClockSnapshot): ClockVerdict => {
  let aAhead = false;
  let bAhead = false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key] ?? 0;
    const right = b[key] ?? 0;
    if (left > right) aAhead = true;
    else if (left < right) bAhead = true;
    if (aAhead && bAhead) return 'concurrent'; // diverged on both sides
  }
  return aAhead ? 'dominates' : bAhead ? 'dominated_by' : 'equal';
};

export const mergeClocks = (a: ClockSnapshot, b: ClockSnapshot): ClockSnapshot => {
  const merged: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return merged;
};

export const advanceClock = (clock: ClockSnapshot, participantId: string): ClockSnapshot => ({
  ...clock,
  [participantId]: (clock[participantId] ?? 0) + 1,
});
