import crypto from 'node:crypto';

/**
 * Plates are read aloud and typed by hand, so the letter set drops the four
 * characters that get misread: I and L (look like 1), O (looks like 0) and U.
 * Letters and digits sit in fixed sections, so no position is ever ambiguous.
 */
export const PLATE_LETTERS = 'ABCDEFGHJKMNPQRSTVWXYZ';
export const PLATE_PATTERN = /^[ABCDEFGHJKMNPQRSTVWXYZ]{3}[0-9]{3}$/;
export const PLATE_SHAPE = 'ABC-123';

function pick(alphabet) {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % alphabet.length);
  for (;;) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < limit) return alphabet[byte % alphabet.length];
  }
}

export function formatPlate(compact) {
  return `${compact.slice(0, 3)}-${compact.slice(3)}`;
}

/** Strips separators and case so "krt 482", "krt-482" and "KRT482" all match. */
export function normalizePlate(input) {
  const compact = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!PLATE_PATTERN.test(compact)) return null;
  return formatPlate(compact);
}

/** 22^3 * 10^3 = 10,648,000 plates; isTaken guarantees we never hand out a duplicate. */
export function generatePlate(isTaken = () => false) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const letters = pick(PLATE_LETTERS) + pick(PLATE_LETTERS) + pick(PLATE_LETTERS);
    const digits = pick('0123456789') + pick('0123456789') + pick('0123456789');
    const plate = formatPlate(letters + digits);
    if (!isTaken(plate)) return plate;
  }
  throw new Error('Could not allocate a free plate');
}
