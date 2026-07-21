import { useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Container, Card, Form, Button, Alert, Spinner, InputGroup } from 'react-bootstrap';
import { resetPassword } from '../services/password-reset';
import { MIN_LENGTH, passwordRuleFailures } from '../utils/password-rules';

// Forgot Password — sole reset screen (PRD 0020, replacing PRD 0015's
// emailed-token two-step flow entirely). There is no "request" round trip
// anymore: a TOTP code is always already available from the user's own
// authenticator app (set up via PRD 0017), so identity, the new password,
// and its confirmation are all collected in one form and submitted once —
// the same single-shot philosophy Login.jsx already uses ("no password-first
// round trip"). POST /api/password-reset (app/src/routes/password-reset.js)
// answers an unknown email, an account with no *enabled* 2FA, and a wrong
// code with the identical generic 401 `invalid_credentials` (anti-
// enumeration — never distinguished here either), while a weak new password
// is its own 400 `weak_password`, matching SignUp.jsx's own reasoning: that
// is input validation on a password the caller supplied, not a credential-
// guessing surface, so it is safe to name specifically.
const GENERIC_ERROR_MESSAGE = 'Invalid email, code, or account.';
const WEAK_PASSWORD_MESSAGE =
  'Password must be at least 12 characters and include uppercase, lowercase, a number, and a symbol.';

export default function ForgotPassword() {
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(null);

  const ruleFailures = useMemo(() => passwordRuleFailures(newPassword), [newPassword]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setError(null);

    // Business rule 2, mirrored client-side (utils/password-rules.js, shared
    // with SignUp.jsx/the old ResetPassword.jsx) so a weak/mismatched
    // password never reaches the network — the server re-enforces the same
    // rule regardless, this is only a fast-fail for UX.
    if (ruleFailures.length > 0) {
      setError(WEAK_PASSWORD_MESSAGE);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await resetPassword({ email, code, newPassword });
      setSuccess(true);
      navigate('/login');
    } catch (err) {
      if (err && err.status === 400 && err.error === 'weak_password') {
        // Safe to name specifically: this is input validation on a password
        // the caller supplied, not a credential-guessing surface (same
        // reasoning SignUp.jsx already uses for its own weak_password case).
        setError(WEAK_PASSWORD_MESSAGE);
      } else {
        // Every other failure — unknown email, no enabled 2FA, wrong code —
        // must be indistinguishable, matching the backend's single generic
        // 401 `invalid_credentials` (anti-enumeration, PRD 0020).
        setError(GENERIC_ERROR_MESSAGE);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Container className="d-flex justify-content-center py-5">
      <Card className="shadow-sm border-0" style={{ maxWidth: '420px', width: '100%' }}>
        <Card.Body className="p-4">
          <div className="text-center mb-4">
            <div className="fw-bold text-primary mb-1">SecureVault</div>
            <h2 className="h4 mb-1">Reset your password</h2>
            <p className="text-muted small mb-0">Verify with your authenticator app to set a new master password</p>
          </div>

          {error && (
            <Alert variant="danger" role="alert">
              {error}
            </Alert>
          )}

          {success ? (
            <Alert variant="success" role="status">
              Your password has been reset. You can now log in.
            </Alert>
          ) : (
            <Form onSubmit={handleSubmit} noValidate>
              <fieldset disabled={submitting}>
                <Form.Group className="mb-3" controlId="forgot-password-email">
                  <Form.Label>Email</Form.Label>
                  <Form.Control
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    required
                  />
                </Form.Group>

                <Form.Group className="mb-4" controlId="forgot-password-code">
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
                  <Form.Text className="text-muted">Enter the current code from your authenticator app.</Form.Text>
                </Form.Group>

                <hr />

                <Form.Group className="mb-3" controlId="forgot-password-new">
                  <Form.Label>New master password</Form.Label>
                  <InputGroup>
                    <Form.Control
                      type={showPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      autoComplete="new-password"
                      required
                    />
                    <Button
                      variant="outline-secondary"
                      type="button"
                      onClick={() => setShowPassword((visible) => !visible)}
                      aria-label={showPassword ? 'Hide new password' : 'Show new password'}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </Button>
                  </InputGroup>
                  <Form.Text className="text-muted">
                    Must be at least {MIN_LENGTH} characters and include uppercase, lowercase, a number, and a
                    symbol.
                  </Form.Text>
                </Form.Group>

                <Form.Group className="mb-4" controlId="forgot-password-confirm">
                  <Form.Label>Confirm new password</Form.Label>
                  <Form.Control
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Form.Group>

                <Button variant="primary" type="submit" className="w-100">
                  {submitting ? (
                    <>
                      <Spinner as="span" animation="border" size="sm" role="status" className="me-2" />
                      Resetting…
                    </>
                  ) : (
                    'Reset password'
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
