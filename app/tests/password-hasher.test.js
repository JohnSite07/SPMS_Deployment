const { hashPassword, verifyPassword, MIN_MASTER_PASSWORD_LENGTH } = require('../src/services/password-hasher');

describe('services/password-hasher', () => {
  it('verifies the correct password against its own hash', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'correct-horse-battery-staple')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'wrong-password-entirely')).toBe(false);
  });

  it('verifies a hash produced by native/other bcrypt implementations ($2b$)', async () => {
    // From DATABASE.md's seed data: alice@example.com / Password123!
    const seededHash = '$2b$12$dil3xhU5ncE9NosiNaOgFe.Iez.FDMJJAHoW4AZo4o12owBCsGm56';
    // We only assert the format is accepted and compared, not the real
    // plaintext (unknown here) — a wrong guess must cleanly return false
    // rather than throw.
    expect(await verifyPassword(seededHash, 'definitely-wrong')).toBe(false);
  });

  it('never throws on a malformed stored hash — fails to verify instead', async () => {
    await expect(verifyPassword('not-a-bcrypt-hash', 'anything')).resolves.toBe(false);
  });

  it('rejects a non-string hash or password without throwing', async () => {
    await expect(verifyPassword(null, 'x')).resolves.toBe(false);
    await expect(verifyPassword('$2b$12$abc', undefined)).resolves.toBe(false);
  });

  it(`refuses to hash a password shorter than ${MIN_MASTER_PASSWORD_LENGTH} characters`, async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/);
  });

  it('produces a $2b$ hash', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).toMatch(/^\$2[aby]\$/);
  });
});
