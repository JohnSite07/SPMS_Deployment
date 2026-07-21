import { Link } from 'react-router-dom';
import { Container, Row, Col, Card, Button } from 'react-bootstrap';
import Logo from '../components/Logo.jsx';

// Welcome / landing page (PRD 0018) — the new public front door. Reached by
// anyone visiting the app without a live session (RequireAuth now redirects
// here instead of straight to /login), and directly at /welcome. Unlike the
// auth screens this is not a form: it's a short pitch plus the two entry
// points into the real flows (Login.jsx / SignUp.jsx).
//
// The feature list below is deliberately drawn only from real, already
// shipped/spec'd functionality (docs/requirements/functional-requirements.md's
// business rules) — no invented marketing claims.
const FEATURES = [
  {
    title: 'Encrypted vault',
    description: 'Every credential is encrypted at rest with AES-256 and protected in transit with TLS.',
  },
  {
    title: 'Two-factor authentication',
    description: 'Sign-in is verified with a time-based one-time code in addition to your master password.',
  },
  {
    title: 'Password generator & health checks',
    description: 'Generate strong passwords and get flagged when one is weak or reused within the last 30 days.',
  },
  {
    title: 'Secure document storage',
    description: 'Attach PDFs or images up to 10MB to any entry, encrypted the same way as your passwords.',
  },
  {
    title: '10-minute auto-lock',
    description: 'Your vault locks itself automatically after 10 minutes of inactivity.',
  },
  {
    title: 'Append-only audit log',
    description: 'Every action on your account is recorded in a log that can never be edited or deleted.',
  },
];

export default function Welcome() {
  return (
    <Container className="py-5">
      <div className="text-center mb-5">
        <Logo variant="full" size={72} />
      </div>

      <div className="text-center mb-5">
        <h1 className="h3 mb-3">Your passwords, encrypted end to end</h1>
        <p className="text-muted mb-4">
          SecureVault is a zero-knowledge password manager: only you can unlock your vault.
        </p>
        <div className="d-flex justify-content-center gap-3">
          <Button as={Link} to="/signup" variant="primary" size="lg">
            Sign Up
          </Button>
          <Button as={Link} to="/login" variant="outline-primary" size="lg">
            Sign In
          </Button>
        </div>
      </div>

      <Row xs={1} md={2} lg={3} className="g-4">
        {FEATURES.map((feature) => (
          <Col key={feature.title}>
            <Card className="h-100 border-0 shadow-sm">
              <Card.Body>
                <Card.Title className="h6">{feature.title}</Card.Title>
                <Card.Text className="text-muted small mb-0">{feature.description}</Card.Text>
              </Card.Body>
            </Card>
          </Col>
        ))}
      </Row>
    </Container>
  );
}
