import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Container, Card, Form, Button, Alert, Spinner, InputGroup } from 'react-bootstrap';
import { enrollTwoFactor, confirmTwoFactor } from '../services/two-factor-service';

// Two-Factor Setup — PRD 0017's self-service path to UC-01's "2FA set up"
// precondition. Not one of the six wireframe screens (same precedent as
// ForgotPassword.jsx/ResetPassword.jsx from PRD 0015): reached only via the
// "set up 2FA" link on Login.jsx, never inferred from a failed login attempt
// (see app/src/routes/two-factor.js — surfacing enrollment state from the
// login response would reopen the exact enumeration channel UC-01's
// anti-enumeration design closes).
//
// Two genuinely different backend calls (POST /api/2fa/enroll then POST
// /api/2fa/confirm), so — unlike Login.jsx's single-shot submit — this page
// is gated on real state: step 1 collects email + master password and asks
// the server to generate a pending secret; step 2 shows that secret and
// takes the live code that confirms it. Out of scope: QR rendering (PRD
// 0017) — the secret and its otpauth:// URI are shown as copyable text only.

const ALREADY_ENABLED_MESSAGE = 'Two-factor authentication is already set up for this account.';
const GENERIC_ENROLL_ERROR = 'Invalid email or password.';
const GENERIC_CONFIRM_ERROR = 'Invalid email, password, or code.';

// Secure-by-default (frontend rule 6): copy rather than display long-lived,
// and clear the clipboard automatically after a short window rather than
// leaving the secret sitting there indefinitely.
const CLIPBOARD_CLEAR_MS = 30000;

export default function TwoFactorSetup() {
  const navigate = useNavigate();
  const location = useLocation();

  // PRD 0018: a fresh SignUp.jsx hands off here with the just-registered
  // email carried via router state, so step 1 doesn't make the new user
  // retype it. Purely a pre-fill — falls back to '' (the prior behaviour)
  // whenever there's no state, e.g. reached directly via Login.jsx's link.
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState(location.state?.email ?? '');
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState(null);
  const [otpauthUri, setOtpauthUri] = useState(null);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [copiedField, setCopiedField] = useState(null);
  const clipboardTimer = useRef(null);

  useEffect(
    () => () => {
      if (clipboardTimer.current) {
        clearTimeout(clipboardTimer.current);
      }
    },
    []
  );

  async function copyToClipboard(value, field) {
    if (!value) {
      return;
    }
    const clipboard = window.navigator?.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      // Clipboard API unavailable/denied — the value is still shown as
      // selectable read-only text, so the user can copy it manually.
      return;
    }
    try {
      await clipboard.writeText(value);
    } catch {
      return;
    }

    setCopiedField(field);
    if (clipboardTimer.current) {
      clearTimeout(clipboardTimer.current);
    }
    clipboardTimer.current = setTimeout(async () => {
      try {
        // Only clear the clipboard if it still holds the value we put there —
        // never clobber something the user copied elsewhere in the meantime.
        const current = await clipboard.readText();
        if (current === value) {
          await clipboard.writeText('');
        }
      } catch {
        // Reading the clipboard back can be denied/unavailable; nothing
        // further to do.
      }
      setCopiedField(null);
    }, CLIPBOARD_CLEAR_MS);
  }

  async function handleEnroll(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await enrollTwoFactor({ email, password });
      setSecret(result.secret);
      setOtpauthUri(result.otpauthUri);
      setStep(2);
    } catch (err) {
      // Safe to reveal only because the password was already proven correct
      // server-side (see routes/two-factor.js) — it adds no anonymous
      // enumeration channel, unlike every other failure here.
      if (err && err.status === 409 && err.error === 'two_factor_already_enabled') {
        setError(ALREADY_ENABLED_MESSAGE);
      } else {
        // Deliberately generic, matching Login.jsx's anti-enumeration
        // posture: never reveal whether the email or the password was wrong.
        setError(GENERIC_ENROLL_ERROR);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirm(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await confirmTwoFactor({ email, password, code });
      navigate('/');
    } catch {
      // Deliberately generic: never reveal whether the password or the code
      // was wrong. The user stays on step 2 and can just retry the code —
      // the backend supports re-confirming a pending row.
      setError(GENERIC_CONFIRM_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Container className="d-flex justify-content-center py-5">
      <Card className="shadow-sm border-0" style={{ maxWidth: '480px', width: '100%' }}>
        <Card.Body className="p-4">
          <div className="text-center mb-4">
            <div className="fw-bold text-primary mb-1">SecureVault</div>
            <h2 className="h4 mb-1">Set up two-factor authentication</h2>
            <p className="text-muted small mb-0">
              {step === 1
                ? 'Confirm your master password to generate a new authenticator secret'
                : 'Add the secret to your authenticator app, then enter the current code'}
            </p>
          </div>

          {error && (
            <Alert variant="danger" role="alert">
              {error}
            </Alert>
          )}

          {step === 1 ? (
            <Form onSubmit={handleEnroll} noValidate>
              <fieldset disabled={submitting}>
                <Form.Group className="mb-3" controlId="2fa-setup-email">
                  <Form.Label>Email</Form.Label>
                  <Form.Control
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    required
                  />
                </Form.Group>

                <Form.Group className="mb-4" controlId="2fa-setup-password">
                  <Form.Label>Master password</Form.Label>
                  <Form.Control
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </Form.Group>

                <Button variant="primary" type="submit" className="w-100">
                  {submitting ? (
                    <>
                      <Spinner as="span" animation="border" size="sm" role="status" className="me-2" />
                      Setting up…
                    </>
                  ) : (
                    'Set up two-factor authentication'
                  )}
                </Button>
              </fieldset>
            </Form>
          ) : (
            <Form onSubmit={handleConfirm} noValidate>
              <fieldset disabled={submitting}>
                <Form.Group className="mb-3" controlId="2fa-setup-secret">
                  <Form.Label>Secret key</Form.Label>
                  <InputGroup>
                    <Form.Control
                      type="text"
                      value={secret ?? ''}
                      readOnly
                      onFocus={(event) => event.target.select()}
                    />
                    <Button
                      variant="outline-secondary"
                      type="button"
                      onClick={() => copyToClipboard(secret, 'secret')}
                    >
                      {copiedField === 'secret' ? 'Copied' : 'Copy'}
                    </Button>
                  </InputGroup>
                  <Form.Text className="text-muted">
                    Enter this into your authenticator app instead of scanning a QR code.
                  </Form.Text>
                </Form.Group>

                <Form.Group className="mb-4" controlId="2fa-setup-uri">
                  <Form.Label>Setup URI</Form.Label>
                  <InputGroup>
                    <Form.Control
                      type="text"
                      value={otpauthUri ?? ''}
                      readOnly
                      onFocus={(event) => event.target.select()}
                    />
                    <Button
                      variant="outline-secondary"
                      type="button"
                      onClick={() => copyToClipboard(otpauthUri, 'uri')}
                    >
                      {copiedField === 'uri' ? 'Copied' : 'Copy'}
                    </Button>
                  </InputGroup>
                  <Form.Text className="text-muted">
                    Some authenticator apps can import this URI directly.
                  </Form.Text>
                </Form.Group>

                <Form.Group className="mb-4" controlId="2fa-setup-code">
                  <Form.Label>6-digit code</Form.Label>
                  <Form.Control
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    autoComplete="one-time-code"
                    required
                  />
                </Form.Group>

                <Button variant="primary" type="submit" className="w-100">
                  {submitting ? (
                    <>
                      <Spinner as="span" animation="border" size="sm" role="status" className="me-2" />
                      Confirming…
                    </>
                  ) : (
                    'Confirm and log in'
                  )}
                </Button>
              </fieldset>
            </Form>
          )}

          <div className="text-center mt-4">
            <Link to="/login" className="small text-decoration-none">
              Back to login
            </Link>
          </div>
        </Card.Body>
      </Card>
    </Container>
  );
}
