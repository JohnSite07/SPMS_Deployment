// Graduated strength *score* for vault-item passwords (PRD 0021), driving the
// live meter in the Add/Edit Credential form (Credentials.jsx). This is
// deliberately a separate concern from password-rules.js: that file is a hard
// pass/fail gate enforcing business rule 2 for the MASTER password (>=12
// chars, all four classes, required before signup/reset can proceed). This
// module scores ANY password (vault-item passwords have no hard minimum
// today — see the PRD) into a soft 0-100 score and a Weak/Fair/Strong label
// used purely as UI guidance, never to block save.
//
// Scoring (kept intentionally simple — this drives a progress bar, not a
// security decision):
// - Length contributes up to 40 points: `min(length, 10) * 4`. A 10+
//   character password gets the full 40; shorter passwords scale down
//   linearly (e.g. length 4 -> 16 points).
// - Character-class variety contributes up to 60 points: 15 points for each
//   of the four classes present (uppercase / lowercase / number / symbol)
//   that actually appears in the string.
// - Total score range: 0-100.
//
// Thresholds (exported as constants so PRD 0022's vault-wide weak/reused
// analysis reuses these exact numbers instead of inventing a second scale):
//   score <  WEAK_THRESHOLD (40)   -> 'Weak'
//   score <  STRONG_THRESHOLD (70) -> 'Fair'
//   score >= STRONG_THRESHOLD (70) -> 'Strong'
//
// Example: a 4-character, single-class password like "aaaa" scores
// 4*4 + 15 = 31 -> Weak. A 16-character password using all four classes
// scores min(16,10)*4 + 15*4 = 40 + 60 = 100 -> Strong.

export const WEAK_THRESHOLD = 40;
export const STRONG_THRESHOLD = 70;

const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;
const HAS_NUMBER = /[0-9]/;
const HAS_SYMBOL = /[^A-Za-z0-9]/;

const LENGTH_CAP = 10; // characters beyond this no longer add length points.
const POINTS_PER_LENGTH_CHAR = 4; // up to LENGTH_CAP * 4 = 40 points.
const POINTS_PER_CLASS = 15; // up to 4 classes * 15 = 60 points.

export function scorePasswordStrength(password) {
  const value = password ?? '';

  const lengthScore = Math.min(value.length, LENGTH_CAP) * POINTS_PER_LENGTH_CHAR;

  let classCount = 0;
  if (HAS_UPPER.test(value)) classCount += 1;
  if (HAS_LOWER.test(value)) classCount += 1;
  if (HAS_NUMBER.test(value)) classCount += 1;
  if (HAS_SYMBOL.test(value)) classCount += 1;
  const classScore = classCount * POINTS_PER_CLASS;

  const score = lengthScore + classScore;

  let label;
  if (score < WEAK_THRESHOLD) {
    label = 'Weak';
  } else if (score < STRONG_THRESHOLD) {
    label = 'Fair';
  } else {
    label = 'Strong';
  }

  return { score, label };
}
