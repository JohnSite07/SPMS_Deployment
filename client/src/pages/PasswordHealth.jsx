import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Alert, Spinner, Card, ListGroup, Badge, Button } from 'react-bootstrap';
import { getHealthReport } from '../services/password-health-service';
import { WEAK_THRESHOLD, STRONG_THRESHOLD } from '../utils/password-strength';

// UC-05 Analyze Password Health & Notify (PRD 0022) — full build, replacing
// the placeholder. This screen only READS the latest persisted report; it
// never triggers analysis itself (that runs from Credentials.jsx, on mount
// and after any password-changing mutation — see vault-health-analyzer.js
// and Credentials.jsx's runHealthAnalysis). A vault that has never been
// analyzed is a legitimate state (`{ report: null }`), not an error.

const GENERIC_LOAD_ERROR = 'Unable to load your password health report. Please try again.';

const RADIUS = 54;
const STROKE_WIDTH = 12;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Reuses password-strength.js's exact thresholds so the ring's colour
// language matches the per-field strength meter on the Add/Edit form —
// one scale, not two.
function scoreVariant(score) {
  if (score >= STRONG_THRESHOLD) {
    return 'success';
  }
  if (score >= WEAK_THRESHOLD) {
    return 'warning';
  }
  return 'danger';
}

// A lightweight SVG ring — no chart library dependency (frontend rule:
// don't add a second UI/heavyweight dependency casually). Colour comes from
// Bootstrap's CSS custom properties (`var(--bs-*)`), never a hardcoded hex,
// so the ring always tracks theme.scss's tokens.
function ScoreRing({ score }) {
  const variant = scoreVariant(score);
  const clamped = Math.max(0, Math.min(100, score));
  const offset = CIRCUMFERENCE - (clamped / 100) * CIRCUMFERENCE;
  return (
    <svg
      width="140"
      height="140"
      viewBox="0 0 140 140"
      role="img"
      aria-label={`Overall password health score: ${score} out of 100`}
    >
      <circle cx="70" cy="70" r={RADIUS} fill="none" stroke="var(--bs-secondary-bg)" strokeWidth={STROKE_WIDTH} />
      <circle
        cx="70"
        cy="70"
        r={RADIUS}
        fill="none"
        stroke={`var(--bs-${variant})`}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        transform="rotate(-90 70 70)"
      />
      <text x="70" y="78" textAnchor="middle" fontSize="28" fontWeight="700" fill="currentColor">
        {score}
      </text>
    </svg>
  );
}

export default function PasswordHealth() {
  const navigate = useNavigate();
  // undefined = still loading; null = loaded, no report yet; object = report.
  const [report, setReport] = useState(undefined);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { report: fetched } = await getHealthReport();
        if (!cancelled) {
          setReport(fetched ?? null);
        }
      } catch {
        if (!cancelled) {
          setError(GENERIC_LOAD_ERROR);
          setReport(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Deep-links back to the vault list for one specific credential. Reuses
  // React Router state — the same mechanism Credentials.jsx already reads on
  // mount — rather than inventing a new deep-linking scheme.
  function handleFixNow(itemId) {
    navigate('/', { state: { openItemId: itemId } });
  }

  if (report === undefined) {
    return (
      <Container className="py-4 d-flex justify-content-center">
        <Spinner animation="border" role="status" />
      </Container>
    );
  }

  if (error) {
    return (
      <Container className="py-4">
        <h2 className="h4 mb-3">Password health</h2>
        <Alert variant="danger" role="alert">
          {error}
        </Alert>
      </Container>
    );
  }

  if (!report) {
    return (
      <Container className="py-4">
        <h2 className="h4 mb-3">Password health</h2>
        <Alert variant="info" role="status">
          No health report yet. Add some credentials to your vault to see your password health score here.
        </Alert>
      </Container>
    );
  }

  const findings = Array.isArray(report.findings) ? report.findings : [];
  const okCount = findings.filter((finding) => finding.status === 'OK').length;
  const weakCount = findings.filter((finding) => finding.status === 'WEAK').length;
  const reusedCount = findings.filter((finding) => finding.status === 'REUSED').length;
  const attentionItems = findings.filter((finding) => finding.status === 'WEAK' || finding.status === 'REUSED');
  const alerts = Array.isArray(report.alerts) ? report.alerts : [];

  return (
    <Container className="py-4">
      <h2 className="h4 mb-4">Password health</h2>

      <Card className="mb-4 border-0 shadow-sm">
        <Card.Body className="d-flex flex-column flex-sm-row align-items-center gap-4">
          <ScoreRing score={report.overallScore} />
          <div className="d-flex gap-4">
            <div className="text-center">
              <div className="fs-4 fw-bold text-success">{okCount}</div>
              <div className="text-muted small">Strong</div>
            </div>
            <div className="text-center">
              <div className="fs-4 fw-bold text-warning">{weakCount}</div>
              <div className="text-muted small">Weak</div>
            </div>
            <div className="text-center">
              <div className="fs-4 fw-bold text-danger">{reusedCount}</div>
              <div className="text-muted small">Reused</div>
            </div>
          </div>
        </Card.Body>
      </Card>

      <h3 className="h5 mb-3">Items needing attention</h3>
      {attentionItems.length === 0 ? (
        <p className="text-muted">Every saved password is strong and unique. Nice work.</p>
      ) : (
        <ListGroup className="mb-4">
          {attentionItems.map((finding) => (
            <ListGroup.Item
              key={finding.itemId}
              className="d-flex justify-content-between align-items-center"
            >
              <div>
                <Badge bg={finding.status === 'REUSED' ? 'danger' : 'warning'} className="me-2">
                  {finding.status}
                </Badge>
                Credential #{finding.itemId}
              </div>
              <Button variant="outline-primary" size="sm" onClick={() => handleFixNow(finding.itemId)}>
                Fix now
              </Button>
            </ListGroup.Item>
          ))}
        </ListGroup>
      )}

      <h3 className="h5 mb-3">Alerts</h3>
      {alerts.length === 0 ? (
        <p className="text-muted">No open alerts.</p>
      ) : (
        <ListGroup>
          {alerts.map((alert) => (
            <ListGroup.Item key={alert.alertId}>
              <Badge bg={alert.type === 'REUSED' ? 'danger' : 'warning'} className="me-2">
                {alert.type}
              </Badge>
              {alert.message}
            </ListGroup.Item>
          ))}
        </ListGroup>
      )}
    </Container>
  );
}
