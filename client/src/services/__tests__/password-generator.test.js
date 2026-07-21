import { describe, it, expect, vi, afterEach } from 'vitest';
import { generatePassword } from '../password-generator.js';

// Plain Node environment (no jsdom needed) — Node >=20's global
// crypto.getRandomValues is real WebCrypto, matching vault-crypto.test.js's
// precedent of exercising real crypto rather than mocking it, except where a
// test specifically needs to assert *which* RNG was called.

const UPPER = /[A-Z]/;
const LOWER = /[a-z]/;
const DIGIT = /[0-9]/;
const SYMBOL = /[^A-Za-z0-9]/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generatePassword', () => {
  it('respects the requested length', () => {
    expect(generatePassword({ length: 24 })).toHaveLength(24);
    expect(generatePassword({ length: 8 })).toHaveLength(8);
  });

  it('defaults to length 16 when no options are given', () => {
    expect(generatePassword()).toHaveLength(16);
  });

  it('uses crypto.getRandomValues, never Math.random', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const mathRandomSpy = vi.spyOn(Math, 'random');

    generatePassword({ length: 20 });

    expect(spy).toHaveBeenCalled();
    expect(mathRandomSpy).not.toHaveBeenCalled();
  });

  it('guarantees at least one character from each selected class', () => {
    // Run many times: a flaky, chance-based guarantee would eventually show
    // a violation across enough iterations; the reserved-slot design should
    // never violate it even once.
    for (let i = 0; i < 200; i += 1) {
      const password = generatePassword({ length: 16 });
      expect(UPPER.test(password)).toBe(true);
      expect(LOWER.test(password)).toBe(true);
      expect(DIGIT.test(password)).toBe(true);
      expect(SYMBOL.test(password)).toBe(true);
    }
  });

  it('only draws from the selected classes when others are disabled', () => {
    for (let i = 0; i < 50; i += 1) {
      const password = generatePassword({
        length: 16,
        includeUppercase: false,
        includeSymbols: false,
      });
      expect(UPPER.test(password)).toBe(false);
      expect(SYMBOL.test(password)).toBe(false);
      expect(LOWER.test(password)).toBe(true);
      expect(DIGIT.test(password)).toBe(true);
    }
  });

  it('produces different output on successive calls', () => {
    const first = generatePassword();
    const second = generatePassword();
    expect(first).not.toBe(second);
  });

  it('clamps length up to the number of requested classes if it is smaller', () => {
    const password = generatePassword({ length: 1 });
    expect(password.length).toBeGreaterThanOrEqual(4); // all 4 classes on by default
  });

  it('throws when every character class is disabled', () => {
    expect(() =>
      generatePassword({
        includeUppercase: false,
        includeLowercase: false,
        includeNumbers: false,
        includeSymbols: false,
      })
    ).toThrow();
  });
});
