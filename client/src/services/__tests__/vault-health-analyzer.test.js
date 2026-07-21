import { describe, it, expect } from 'vitest';
import { analyzeVault } from '../vault-health-analyzer.js';
import { WEAK_THRESHOLD } from '../../utils/password-strength.js';

describe('analyzeVault (PRD 0022)', () => {
  it('returns a null score and no findings for an empty vault, rather than a divide-by-zero or a misleading 100', () => {
    const result = analyzeVault([]);
    expect(result).toEqual({ overallScore: null, findings: [] });
  });

  it('flags a short, low-variety password as WEAK using password-strength.js\'s own threshold', () => {
    // 'aaaa' scores well under WEAK_THRESHOLD per password-strength.test.js.
    const { findings } = analyzeVault([{ itemId: 'i1', password: 'aaaa' }]);
    expect(findings).toEqual([{ itemId: 'i1', status: 'WEAK' }]);
  });

  it('flags two or more items sharing the exact same password as REUSED', () => {
    const strongUnique = 'Tr7$kL9!qWbZx2#Q';
    const { findings } = analyzeVault([
      { itemId: 'i1', password: 'shared-Pass1!' },
      { itemId: 'i2', password: 'shared-Pass1!' },
      { itemId: 'i3', password: strongUnique },
    ]);
    const byId = Object.fromEntries(findings.map((f) => [f.itemId, f.status]));
    expect(byId.i1).toBe('REUSED');
    expect(byId.i2).toBe('REUSED');
    expect(byId.i3).toBe('OK');
  });

  it('is case-sensitive when comparing passwords for reuse', () => {
    const { findings } = analyzeVault([
      { itemId: 'i1', password: 'Tr7$kL9!qWbZx2#Q' },
      { itemId: 'i2', password: 'tr7$kl9!qwbzx2#q' },
    ]);
    expect(findings.every((f) => f.status === 'OK')).toBe(true);
  });

  it('gives REUSED precedence over WEAK when a password is both short/weak and reused', () => {
    const { findings } = analyzeVault([
      { itemId: 'i1', password: 'weak' },
      { itemId: 'i2', password: 'weak' },
    ]);
    expect(findings).toEqual([
      { itemId: 'i1', status: 'REUSED' },
      { itemId: 'i2', status: 'REUSED' },
    ]);
  });

  it('computes overallScore as round(100 * okCount / totalCount)', () => {
    const strongUnique1 = 'Tr7$kL9!qWbZx2#Q';
    const strongUnique2 = 'Zx9#mQ4!vRk7$LpW';
    const { overallScore, findings } = analyzeVault([
      { itemId: 'i1', password: strongUnique1 }, // OK
      { itemId: 'i2', password: strongUnique2 }, // OK
      { itemId: 'i3', password: 'aaaa' }, // WEAK
    ]);
    expect(findings.filter((f) => f.status === 'OK')).toHaveLength(2);
    // round(100 * 2 / 3) = 67
    expect(overallScore).toBe(67);
  });

  it('scores a fully strong, fully unique vault as 100', () => {
    const { overallScore } = analyzeVault([
      { itemId: 'i1', password: 'Tr7$kL9!qWbZx2#Q' },
      { itemId: 'i2', password: 'Zx9#mQ4!vRk7$LpW' },
    ]);
    expect(overallScore).toBe(100);
  });

  it('scores a vault where every item is weak or reused as 0', () => {
    // 'ab'/'cd' each score well under WEAK_THRESHOLD (short, single class)
    // and are distinct from each other, so both are WEAK, not REUSED —
    // either way, okCount is 0.
    const { overallScore } = analyzeVault([
      { itemId: 'i1', password: 'ab' },
      { itemId: 'i2', password: 'cd' },
    ]);
    expect(overallScore).toBe(0);
  });

  it('never lets an item score below WEAK_THRESHOLD slip through as OK', () => {
    const { findings } = analyzeVault([{ itemId: 'i1', password: 'a'.repeat(3) }]);
    expect(findings[0].status).toBe('WEAK');
    // Sanity: confirms this test actually exercises the imported threshold,
    // not a re-invented one.
    expect(WEAK_THRESHOLD).toBe(40);
  });
});
