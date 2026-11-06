/**
 * All money crosses the wire and the database as integer minor units.
 * Nothing in this codebase may hold a currency amount as a float.
 */

export function isMinorUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertMinorUnit(value: unknown, field = 'amount'): number {
  if (!isMinorUnit(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer in minor units`);
  }
  return value;
}

/**
 * Split a total across weights so the parts always add back to the total.
 * Largest-remainder: no satang is invented or lost.
 */
export function allocate(total: number, weights: number[]): number[] {
  assertMinorUnit(total, 'total');
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum <= 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (total * weight) / sum);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = total - floors.reduce((acc, value) => acc + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  const result = [...floors];
  for (const { index } of order) {
    if (remainder <= 0) break;
    result[index] = (result[index] ?? 0) + 1;
    remainder -= 1;
  }
  return result;
}
