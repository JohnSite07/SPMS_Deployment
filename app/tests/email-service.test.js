const { createEmailService } = require('../src/services/email-service');

// No real SMTP connection is ever opened here — the transport is always a
// fake with a jest.fn() sendMail, per this module's own "injected, never
// defaulted" contract.

function fakeTransport() {
  return { sendMail: jest.fn(async () => {}) };
}

describe('services/email-service', () => {
  it('throws without a transport', () => {
    expect(() => createEmailService({})).toThrow(/transport is required/);
  });

  it('sends a reset email containing the link and nothing else sensitive', async () => {
    const transport = fakeTransport();
    const email = createEmailService({ transport });

    await email.sendPasswordResetEmail({
      to: 'owner@example.com',
      resetUrl: 'https://securevault.test/reset-password?token=RAW_TOKEN_VALUE',
    });

    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    const [options] = transport.sendMail.mock.calls[0];
    expect(options.to).toBe('owner@example.com');
    expect(options.text).toContain('https://securevault.test/reset-password?token=RAW_TOKEN_VALUE');
    expect(options.subject).toMatch(/reset/i);
  });

  it('sets `from` when provided', async () => {
    const transport = fakeTransport();
    const email = createEmailService({ transport, from: 'no-reply@securevault.test' });

    await email.sendPasswordResetEmail({ to: 'owner@example.com', resetUrl: 'https://x/y' });

    expect(transport.sendMail.mock.calls[0][0].from).toBe('no-reply@securevault.test');
  });

  it('rejects a missing recipient or link', async () => {
    const email = createEmailService({ transport: fakeTransport() });

    await expect(email.sendPasswordResetEmail({ resetUrl: 'https://x/y' })).rejects.toThrow(
      /to is required/
    );
    await expect(email.sendPasswordResetEmail({ to: 'owner@example.com' })).rejects.toThrow(
      /resetUrl is required/
    );
  });
});
