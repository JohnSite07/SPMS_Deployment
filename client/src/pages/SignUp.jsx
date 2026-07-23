import { useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Container, Card, Form, Button, Alert, Spinner, InputGroup } from 'react-bootstrap';
import { registerAccount } from '../services/registration-service';
import { MIN_LENGTH, passwordRuleFailures } from '../utils/password-rules';

// Sign Up — self-service account creation (PRD 0018), the missing front door
// that let every account until now exist only because a developer hand-wrote
// a USERS row. POST /api/register (app/src/routes/register.js) mints no
// session token: a fresh account has no TWO_FACTOR_CONFIGS row yet, so this
// screen hands off straight to PRD 0017's TwoFactorSetup.jsx on success,
// carrying the just-registered email via router state so step 1 is
// pre-filled instead of asking the user to retype it.
//
// Unlike Login.jsx's deliberately generic single error, a taken email here
// gets its own honest message (409 email_already_registered) — a reasoned,
// explicitly-flagged exception documented in routes/register.js's header
// comment: signup is about claiming an identity, not testing credentials
// against one that may already exist.
const ALREADY_REGISTERED_MESSAGE = 'An account with this email already exists.';
const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

export default function SignUp() {
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);

  const ruleFailures = useMemo(() => passwordRuleFailures(password), [password]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setError(null);
    setAlreadyRegistered(false);

    if (ruleFailures.length > 0) {
      setError('Password must be at least 12 characters and include uppercase, lowercase, a number, and a symbol.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await registerAccount({ email, password });
      navigate('/2fa-setup', { state: { email } });
    } catch (err) {
      if (err && err.status === 409 && err.error === 'email_already_registered') {
        setAlreadyRegistered(true);
        setError(ALREADY_REGISTERED_MESSAGE);
      } else if (err && err.status === 400 && err.error === 'weak_password') {
        setError('Password must be at least 12 characters and include uppercase, lowercase, a number, and a symbol.');
      } else {
        // 400 invalid_request or anything else: never leak raw server text.
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
            <h2 className="h4 mb-1">Create your account</h2>
            <p className="text-muted small mb-0">Set up your encrypted vault</p>
          </div>

          {error && (
            <Alert variant="danger" role="alert">
              {error}
              {alreadyRegistered && (
                <>
                  {' '}
                  <Link to="/login">Sign in instead.</Link>
                </>
              )}
            </Alert>
          )}

          <Form onSubmit={handleSubmit} noValidate>
            <fieldset disabled={submitting}>
              <Form.Group className="mb-3" controlId="signup-email">
                <Form.Label>Email</Form.Label>
                <Form.Control
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </Form.Group>

              <Form.Group className="mb-3" controlId="signup-password">
                <Form.Label>Master password</Form.Label>
                <InputGroup>
                  <Form.Control
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
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
                <Form.Text className="text-muted">
                  Must be at least {MIN_LENGTH} characters and include uppercase, lowercase, a number, and a symbol.
                </Form.Text>
              </Form.Group>

              <Form.Group className="mb-4" controlId="signup-confirm-password">
                <Form.Label>Confirm master password</Form.Label>
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
                    Creating account…
                  </>
                ) : (
                  'Sign Up'
                )}
              </Button>
            </fieldset>
          </Form>

          <div className="text-center mt-4">
            <Link to="/login" className="small text-decoration-none">
              Already have an account? Sign in
            </Link>
          </div>
        </Card.Body>
      </Card>
    </Container>
  );
}
