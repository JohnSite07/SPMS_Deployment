import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Container, Card, Form, Button, Alert, Spinner, InputGroup } from 'react-bootstrap';
import { confirmReset } from '../services/password-reset';
import { MIN_LENGTH, passwordRuleFailures } from '../utils/password-rules';

// Business rule 2 (master password ≥12 chars, mixed character types), mirrored
// client-side so a weak/mismatched password never reaches the network — the
// server re-enforces the same rule (PRD 0015 success criteria), this is only
// a fast-fail for UX. The rule itself lives in utils/password-rules.js
// (shared with SignUp.jsx, PRD 0018) so both screens enforce identically.

// Generic invalid-link message used for EVERY server-side failure (unknown,
// expired, or already-used token) and for a missing token — per PRD 0015 the
// client must never distinguish these cases (same anti-enumeration posture as
// the login screen's single generic error).
const INVALID_LINK_MESSAGE = 'This reset link is invalid or has expired.';

// Reset Password — second half of PRD 0015's reset flow. The reset token
// travels as a URL query parameter from the emailed link; the screen never
// stores or re-displays it beyond passing it through to POST
// /api/password-reset/confirm.
export default function ResetPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(null);

  const ruleFailures = useMemo(() => passwordRuleFailures(newPassword), [newPassword]);

  if (!token) {
    return (
      <Container className="d-flex justify-content-center py-5">
        <Card className="shadow-sm border-0" style={{ maxWidth: '420px', width: '100%' }}>
          <Card.Body className="p-4">
            <div className="text-center mb-4">
              <div className="fw-bold text-primary mb-1">SecureVault</div>
              <h2 className="h4 mb-1">Reset your password</h2>
            </div>
            <Alert variant="danger" role="alert">
              {INVALID_LINK_MESSAGE}
            </Alert>
            <div className="text-center mt-4">
              <Link to="/forgot-password" className="small text-decoration-none">
                Request a new link
              </Link>
            </div>
          </Card.Body>
        </Card>
      </Container>
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setError(null);

    if (ruleFailures.length > 0) {
      setError('Password must be at least 12 characters and include uppercase, lowercase, a number, and a symbol.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await confirmReset({ token, newPassword });
      setSuccess(true);
      navigate('/login');
    } catch {
      // Deliberately generic: an expired, used, or unknown token all look the
      // same to the client, matching the backend's anti-enumeration answer.
      setError(INVALID_LINK_MESSAGE);
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
            <p className="text-muted small mb-0">Choose a new master password</p>
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
                <Form.Group className="mb-3" controlId="reset-password-new">
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
                    Must be at least {MIN_LENGTH} characters and include uppercase, lowercase, a number, and a symbol.
                  </Form.Text>
                </Form.Group>

                <Form.Group className="mb-4" controlId="reset-password-confirm">
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
