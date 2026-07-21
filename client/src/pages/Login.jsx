import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Container, Card, Form, Button, Alert, Spinner, InputGroup } from 'react-bootstrap';
import { login } from '../services/auth-service';

// UC-01 Log In — wireframe Figure 9 (docs/architecture/ui-ux-guidelines.md,
// "Login & 2FA flow" §2.3). The backend verifies the master password and the
// 2FA code together in a single POST /api/session (app/src/routes/
// session.js / services/session-issuer.js) and answers every failure —
// unknown email, wrong password, wrong code, locked account — with the same
// generic 401 so the client can never enumerate accounts or announce a
// lockout. This screen therefore collects all three fields and submits
// once: there is no password-first round trip. The wireframe's two visual
// sections ("Unlock" then "Step 2 · Two-factor verification" / "Verify
// code") are kept for layout, but both buttons trigger the same single
// submit handler.
export default function Login() {
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await login({ email, password, code });
      navigate('/');
    } catch {
      // Deliberately generic and independent of anything the server sent
      // back: the anti-enumeration rule (UC-01 exceptions) means the UI must
      // never reveal which of email / password / code was wrong, or that an
      // account is locked rather than merely mistyped.
      setError('Invalid email, password, or code.');
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
            <h2 className="h4 mb-1">Welcome back</h2>
            <p className="text-muted small mb-0">Unlock your encrypted vault</p>
          </div>

          {error && (
            <Alert variant="danger" role="alert">
              {error}
            </Alert>
          )}

          <Form onSubmit={handleSubmit} noValidate>
            <fieldset disabled={submitting}>
              <Form.Group className="mb-3" controlId="login-email">
                <Form.Label>Email</Form.Label>
                <Form.Control
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </Form.Group>

              <Form.Group className="mb-3" controlId="login-password">
                <Form.Label>Master password</Form.Label>
                <InputGroup>
                  <Form.Control
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <Button
                    variant="outline-secondary"
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? 'Hide master password' : 'Show master password'}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </Button>
                </InputGroup>
              </Form.Group>

              <Button variant="primary" type="submit" className="w-100 mb-4">
                {submitting ? (
                  <>
                    <Spinner as="span" animation="border" size="sm" role="status" className="me-2" />
                    Unlocking…
                  </>
                ) : (
                  'Unlock'
                )}
              </Button>

              <hr />

              <p className="text-uppercase text-muted small fw-semibold mb-3">
                Step 2 &middot; Two-factor verification
              </p>

              <Form.Group className="mb-3" controlId="login-code">
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
            <Link to="/forgot-password" className="small text-decoration-none">
              Forgot password?
            </Link>
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
