// Business rule 2 (master password ≥12 chars, mixed character types), shared
// client-side fast-fail. Originally written inline in ResetPassword.jsx (PRD
// 0015); pulled out here so SignUp.jsx (PRD 0018) enforces the exact same
// check rather than a second, possibly-drifting copy — the server re-enforces
// the same rule regardless (services/password-policy.js's
// isStrongMasterPassword), this is purely a fast UX fail.
export const MIN_LENGTH = 12;
const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;
const HAS_NUMBER = /[0-9]/;
const HAS_SYMBOL = /[^A-Za-z0-9]/;

export function passwordRuleFailures(password) {
  const failures = [];
  if (password.length < MIN_LENGTH) {
    failures.push(`At least ${MIN_LENGTH} characters`);
  }
  if (!HAS_UPPER.test(password) || !HAS_LOWER.test(password) || !HAS_NUMBER.test(password) || !HAS_SYMBOL.test(password)) {
    failures.push('A mix of uppercase, lowercase, numbers, and symbols');
  }
  return failures;
}
