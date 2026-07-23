const { isStrongMasterPassword } = require('../src/services/password-policy');

// Business rule 2: >= 12 characters, mixing upper/lower/number/symbol.

describe('services/password-policy', () => {
  it('accepts a password meeting length + all four character classes', () => {
    expect(isStrongMasterPassword('Correct-Horse9')).toBe(true);
  });

  it('rejects a password under 12 characters even with every character class', () => {
    expect(isStrongMasterPassword('Abc123!@')).toBe(false); // 8 chars
  });

  it.each([
    ['no uppercase', 'correct-horse9-battery'],
    ['no lowercase', 'CORRECT-HORSE9-BATTERY'],
    ['no number', 'Correct-Horse-Battery!'],
    ['no symbol', 'Correct9Horse9Battery9'],
  ])('rejects a 12+ char password missing a character class (%s)', (_name, password) => {
    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(isStrongMasterPassword(password)).toBe(false);
  });

  it('rejects non-string input without throwing', () => {
    expect(isStrongMasterPassword(undefined)).toBe(false);
    expect(isStrongMasterPassword(null)).toBe(false);
    expect(isStrongMasterPassword(12345678901234)).toBe(false);
  });

  it('accepts exactly the 12-character floor', () => {
    expect(isStrongMasterPassword('Ab1!Ab1!Ab1!')).toBe(true);
  });
});
