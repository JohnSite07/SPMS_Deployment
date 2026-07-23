import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Container, Card, Form, Button, InputGroup } from 'react-bootstrap';
import { setPendingLogin, clearPendingLogin } from '../services/pending-login';

// UC-01 Log In, step 1 of 2 — wireframe Figure 9 (docs/architecture/
// ui-ux-guidelines.md, "Login & 2FA flow" §2.3: "a valid master password
// advances to the second factor").
//
// This screen collects email + master password only. Clicking Unlock parks
// them in pending-login.js (in memory — see that file for why not router
// state) and routes to /login/2fa, which collects the code and performs the
// single POST /api/session that verifies all three together.
//
// Note what Unlock deliberately does NOT do: it makes no network call, so it
// cannot and does not tell the user whether the email or password was right.
// Advancing unconditionally is the anti-enumeration rule (UC-01 exceptions)
// holding at the step boundary — a step 1 that could fail would be exactly the
// account-enumeration oracle the single generic 401 exists to close. Every
// failure surfaces once, generically, on step 2.
export default function Login() {
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Arriving at step 1 (fresh, via "Back to sign in", or after a failed
  // attempt) abandons any half-finished attempt — don't leave a master
  // password parked in module state behind us.
  useEffect(() => {
    clearPendingLogin();
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    setPendingLogin({ email, password });
    navigate('/login/2fa');
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

          <p className="text-uppercase text-muted small fw-semibold mb-3">
            Step 1 &middot; Master password
          </p>

          <Form onSubmit={handleSubmit} noValidate>
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

            <Form.Group className="mb-4" controlId="login-password">
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

            <Button variant="primary" type="submit" className="w-100">
              Unlock
            </Button>
          </Form>

          <p className="text-muted small text-center mt-4 mb-0">
            Next you&rsquo;ll enter the 6-digit code from your authenticator app.
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
