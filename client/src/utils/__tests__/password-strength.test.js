import { describe, it, expect } from 'vitest';
import { scorePasswordStrength, WEAK_THRESHOLD, STRONG_THRESHOLD } from '../password-strength.js';

describe('scorePasswordStrength', () => {
  it('scores an obviously weak, short, single-class password as Weak', () => {
    const { score, label } = scorePasswordStrength('aaaa');
    expect(label).toBe('Weak');
    expect(score).toBeLessThan(WEAK_THRESHOLD);
  });

  it('scores an empty password as Weak with a score of 0', () => {
    const { score, label } = scorePasswordStrength('');
    expect(score).toBe(0);
    expect(label).toBe('Weak');
  });

  it('scores an obviously strong, long, mixed-class password as Strong', () => {
    const { score, label } = scorePasswordStrength('Tr7$kL9!qWbZx2#Q');
    expect(label).toBe('Strong');
    expect(score).toBeGreaterThanOrEqual(STRONG_THRESHOLD);
  });

  it('scores a mid-range password (some length, some variety) as Fair', () => {
    const { label } = scorePasswordStrength('password1');
    expect(label).toBe('Fair');
  });

  it('treats null/undefined input as an empty string rather than throwing', () => {
    expect(() => scorePasswordStrength(undefined)).not.toThrow();
    expect(scorePasswordStrength(null).label).toBe('Weak');
  });
});
