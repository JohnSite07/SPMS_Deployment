import { useState } from 'react';
import { useNavigate, Navigate, Link } from 'react-router-dom';
import { Container, Card, Form, Button, Alert, Spinner } from 'react-bootstrap';
import { login } from '../services/auth-service';
import { getPendingLogin, clearPendingLogin } from '../services/pending-login';

// UC-01 Log In, step 2 of 2 — "Step 2 · Two-factor verification" from
// wireframe Figure 9, now its own screen at /login/2fa.
//
// Step 1 (Login.jsx) parked the email + master password in pending-login.js;
// this screen adds the 6-digit code and makes the ONE call the backend
// actually offers: POST /api/session verifies password and code together
// (app/src/routes/session.js / services/session-issuer.js) and answers every
// failure — unknown email, wrong password, wrong code, locked account — with
// the same generic 401. So every login failure lands here, on one generic
// message, regardless of which factor was actually wrong.
//
// Reached directly (deep link, refresh — the in-memory store does not survive
// either) there is nothing to verify, so it bounces back to step 1 rather
// than showing a code box that could never succeed.
export default function TwoFactorVerify() {
  const navigate = useNavigate();

  // Read once per render; the store is module state, not React state, so the
  // redirect below is the only thing that depends on it changing.
  const pending = getPendingLogin();

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (!pending) {
    return <Navigate to="/login" replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await login({ email: pending.email, password: pending.password, code });
      // Master password has served its purpose (auth-service already derived
      // the vault key from it); drop it before leaving the flow.
      clearPendingLogin();
      navigate('/');
    } catch {
      // Deliberately generic and independent of anything the server sent
      // back: the anti-enumeration rule (UC-01 exceptions) means the UI must
      // never reveal which of email / password / code was wrong, or that an
      // account is locked rather than merely mistyped. The user stays here and
      // can retry the code, or go back to step 1 to fix email/password.
      setError('Invalid email, password, or code.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleBack() {
    // Step 1's mount effect also clears, but do it here too so the password is
    // gone the instant the user backs out.
    clearPendingLogin();
    navigate('/login');
  }

  return (
    <Container className="d-flex justify-content-center py-5">
      <Card className="shadow-sm border-0" style={{ maxWidth: '420px', width: '100%' }}>
        <Card.Body className="p-4">
          <div className="text-center mb-4">
            <div className="fw-bold text-primary mb-1">SecureVault</div>
            <h2 className="h4 mb-1">Two-factor verification</h2>
            <p className="text-muted small mb-0">
              Enter the 6-digit code from your authenticator app
            </p>
          </div>

          <p className="text-uppercase text-muted small fw-semibold mb-3">
            Step 2 &middot; Two-factor verification
          </p>

          {error && (
            <Alert variant="danger" role="alert">
              {error}
            </Alert>
          )}

          <Form onSubmit={handleSubmit} noValidate>
            <fieldset disabled={submitting}>
              <Form.Group className="mb-4" controlId="login-code">
                <Form.Label>6-digit code</Form.Label>
                <Form.Control
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
                <Form.Text className="text-muted">
                  Signing in as {pending.email}
                </Form.Text>
              </Form.Group>

              <Button variant="primary" type="submit" className="w-100">
                {submitting ? (
                  <>
                    <Spinner as="span" animation="border" size="sm" role="status" className="me-2" />
                    Unlocking…
                  </>
                ) : (
                  'Verify code'
                )}
              </Button>
            </fieldset>
          </Form>

          <p className="text-muted small text-center mt-4 mb-0">
            For your security, an incorrect email, password, or code always shows the same message.
          </p>

          <div className="text-center mt-3">
            <Button variant="link" type="button" className="small text-decoration-none p-0" onClick={handleBack}>
              Back to sign in
            </Button>
          </div>

          <div className="text-center mt-2">
            <Link to="/2fa-setup" className="small text-decoration-none">
              Need to set up two-factor authentication?
            </Link>
          </div>
        </Card.Body>
      </Card>
    </Container>
  );
}
