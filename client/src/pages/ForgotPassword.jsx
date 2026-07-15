import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Container, Card, Form, Button, Alert, Spinner } from 'react-bootstrap';
import { requestReset } from '../services/password-reset';

// Forgot Password — first half of PRD 0015's reset flow, reached from
// Login.jsx's "Forgot password?" link. The backend's POST
// /api/password-reset/request ALWAYS answers the same generic 200 whether or
// not the email exists (no account enumeration, PRD 0015 success criteria).
// The UI mirrors that: submitting shows one generic confirmation regardless
// of outcome, and even a network failure does not tell the visitor anything
// more specific than "try again" — never that their email was or wasn't found.
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await requestReset({ email });
      setSubmitted(true);
    } catch {
      // Deliberately generic: never distinguish "unknown email" from a real
      // failure, so the response carries no enumeration signal.
      setError('Something went wrong. Please try again.');
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
            <h2 className="h4 mb-1">Forgot your password?</h2>
            <p className="text-muted small mb-0">We&apos;ll email you a link to reset it</p>
          </div>

          {error && (
            <Alert variant="danger" role="alert">
              {error}
            </Alert>
          )}

          {submitted ? (
            <Alert variant="success" role="status">
              If an account exists for that email, a reset link has been sent.
            </Alert>
          ) : (
            <Form onSubmit={handleSubmit} noValidate>
              <fieldset disabled={submitting}>
                <Form.Group className="mb-4" controlId="forgot-password-email">
                  <Form.Label>Email</Form.Label>
                  <Form.Control
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    required
                  />
                </Form.Group>

                <Button variant="primary" type="submit" className="w-100">
                  {submitting ? (
                    <>
                      <Spinner as="span" animation="border" size="sm" role="status" className="me-2" />
                      Sending…
                    </>
                  ) : (
                    'Send reset link'
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
