import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Row, Col, Alert, Spinner, Card, ListGroup, Badge, Button } from 'react-bootstrap';
import { getHealthReport } from '../services/password-health-service';
import { WEAK_THRESHOLD, STRONG_THRESHOLD } from '../utils/password-strength';

// UC-05 Analyze Password Health & Notify (PRD 0022) — full build, replacing
// the placeholder. This screen only READS the latest persisted report; it
// never triggers analysis itself (that runs from Credentials.jsx, on mount
// and after any password-changing mutation — see vault-health-analyzer.js
// and Credentials.jsx's runHealthAnalysis). A vault that has never been
// analyzed is a legitimate state (`{ report: null }`), not an error.

const GENERIC_LOAD_ERROR = 'Unable to load your password health report. Please try again.';

const RADIUS = 66;
const STROKE_WIDTH = 12;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Reuses password-strength.js's exact thresholds so the ring's colour
// language matches the per-field strength meter on the Add/Edit form —
// one scale, not two. `label` is the overall verdict shown under the ring;
// the count tiles keep the Strong/Weak/Reused wording, so the ring uses a
// distinct phrasing ("Good"/"Fair"/"Needs attention") to read as a summary.
function scoreStatus(score) {
  if (score >= STRONG_THRESHOLD) {
    return { variant: 'success', label: 'Good' };
  }
  if (score >= WEAK_THRESHOLD) {
    return { variant: 'warning', label: 'Fair' };
  }
  return { variant: 'danger', label: 'Needs attention' };
}

// Status glyphs (Bootstrap Icons paths, inline so we add no icon-font
// dependency — same posture as the SVG ring: no heavyweight UI dependency).
// Status colours ship WITH an icon and a text label, never colour alone.
const ICONS = {
  success: 'M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zm-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z',
  warning: 'M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z',
  danger: 'M6.95.435c.58-.58 1.52-.58 2.1 0l6.515 6.516c.58.58.58 1.519 0 2.098L9.05 15.565c-.58.58-1.519.58-2.098 0L.435 9.05a1.48 1.48 0 0 1 0-2.098zM8 4a.905.905 0 0 0-.9.995l.35 3.507a.552.552 0 0 0 1.1 0l.35-3.507A.905.905 0 0 0 8 4zm.002 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
};

function StatusIcon({ variant, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={ICONS[variant]} />
    </svg>
  );
}

// A lightweight SVG ring — no chart library dependency (frontend rule:
// don't add a second UI/heavyweight dependency casually). Colour comes from
// Bootstrap's CSS custom properties (`var(--bs-*)`), never a hardcoded hex,
// so the ring always tracks theme.scss's tokens. Scales to its container via
// a viewBox rather than a fixed pixel size.
function ScoreRing({ score, variant }) {
  const clamped = Math.max(0, Math.min(100, score));
  const offset = CIRCUMFERENCE - (clamped / 100) * CIRCUMFERENCE;
  return (
    <svg
      viewBox="0 0 160 160"
      role="img"
      aria-label={`Overall password health score: ${score} out of 100`}
      style={{ width: 'clamp(140px, 40vw, 168px)', height: 'auto' }}
    >
      <circle cx="80" cy="80" r={RADIUS} fill="none" stroke="var(--bs-secondary-bg)" strokeWidth={STROKE_WIDTH} />
      <circle
        cx="80"
        cy="80"
        r={RADIUS}
        fill="none"
        stroke={`var(--bs-${variant})`}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        transform="rotate(-90 80 80)"
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
      <text x="80" y="76" textAnchor="middle" fontSize="38" fontWeight="700" fill="currentColor">
        {score}
      </text>
      <text x="80" y="98" textAnchor="middle" fontSize="13" fill="var(--bs-secondary-color)">
        out of 100
      </text>
    </svg>
  );
}

// A single Strong/Weak/Reused count, as a tinted tile that fills its grid
// cell — this is what spreads the summary across the card's full width
// instead of huddling the numbers on the left.
function StatTile({ variant, count, label }) {
  return (
    <div
      className="h-100 rounded-3 p-3 text-center d-flex flex-column align-items-center justify-content-center"
      style={{
        backgroundColor: `var(--bs-${variant}-bg-subtle)`,
        border: `1px solid var(--bs-${variant}-border-subtle)`,
      }}
    >
      <span
        className="d-inline-flex align-items-center justify-content-center rounded-circle mb-2"
        style={{ width: 32, height: 32, color: `var(--bs-${variant})`, backgroundColor: 'var(--bs-body-bg)' }}
      >
        <StatusIcon variant={variant} />
      </span>
      <div className="fs-2 fw-bold lh-1" style={{ color: `var(--bs-${variant}-text-emphasis)` }}>
        {count}
      </div>
      <div className="text-muted small mt-1">{label}</div>
    </div>
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
      <Container className="py-5 d-flex justify-content-center">
        <Spinner animation="border" role="status" />
      </Container>
    );
  }

  if (error) {
    return (
      <Container className="py-4" style={{ maxWidth: '960px' }}>
        <h2 className="h4 mb-3">Password health</h2>
        <Alert variant="danger" role="alert">
          {error}
        </Alert>
      </Container>
    );
  }

  if (!report) {
    return (
      <Container className="py-4" style={{ maxWidth: '960px' }}>
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
  const status = scoreStatus(report.overallScore);

  return (
    <Container className="py-4" style={{ maxWidth: '960px' }}>
      <h2 className="h4 mb-4">Password health</h2>

      <Card className="mb-4 border-0 shadow-sm">
        <Card.Body className="p-4">
          <Row className="g-4 align-items-center">
            <Col
              xs={12}
              md="auto"
              className="d-flex flex-column align-items-center text-center mx-auto mx-md-0"
            >
              <ScoreRing score={report.overallScore} variant={status.variant} />
              <span
                className="mt-2 badge rounded-pill"
                style={{
                  color: `var(--bs-${status.variant}-text-emphasis)`,
                  backgroundColor: `var(--bs-${status.variant}-bg-subtle)`,
                }}
              >
                {status.label}
              </span>
            </Col>

            <Col xs={12} md>
              <Row className="g-3 text-center">
                <Col xs={4}>
                  <StatTile variant="success" count={okCount} label="Strong" />
                </Col>
                <Col xs={4}>
                  <StatTile variant="warning" count={weakCount} label="Weak" />
                </Col>
                <Col xs={4}>
                  <StatTile variant="danger" count={reusedCount} label="Reused" />
                </Col>
              </Row>
            </Col>
          </Row>
        </Card.Body>
      </Card>

      <Row className="g-4">
        <Col xs={12} lg={6}>
          <h3 className="h5 mb-3">Items needing attention</h3>
          {attentionItems.length === 0 ? (
            <Card className="border-0 shadow-sm">
              <Card.Body className="d-flex align-items-center gap-2 text-success">
                <StatusIcon variant="success" />
                <span className="text-body-secondary">Every saved password is strong and unique. Nice work.</span>
              </Card.Body>
            </Card>
          ) : (
            <Card className="border-0 shadow-sm">
              <ListGroup variant="flush">
                {attentionItems.map((finding) => (
                  <ListGroup.Item
                    key={finding.itemId}
                    className="d-flex justify-content-between align-items-center flex-wrap gap-2 py-3"
                  >
                    <div className="d-flex align-items-center gap-2">
                      <Badge bg={finding.status === 'REUSED' ? 'danger' : 'warning'} className="text-uppercase">
                        {finding.status}
                      </Badge>
                      <span>Credential #{finding.itemId}</span>
                    </div>
                    <Button variant="outline-primary" size="sm" onClick={() => handleFixNow(finding.itemId)}>
                      Fix now
                    </Button>
                  </ListGroup.Item>
                ))}
              </ListGroup>
            </Card>
          )}
        </Col>

        <Col xs={12} lg={6}>
          <h3 className="h5 mb-3">Alerts</h3>
          {alerts.length === 0 ? (
            <Card className="border-0 shadow-sm">
              <Card.Body className="text-body-secondary">No open alerts.</Card.Body>
            </Card>
          ) : (
            <Card className="border-0 shadow-sm">
              <ListGroup variant="flush">
                {alerts.map((alert) => (
                  <ListGroup.Item key={alert.alertId} className="d-flex align-items-start gap-2 py-3">
                    <Badge bg={alert.type === 'REUSED' ? 'danger' : 'warning'} className="text-uppercase">
                      {alert.type}
                    </Badge>
                    <span>{alert.message}</span>
                  </ListGroup.Item>
                ))}
              </ListGroup>
            </Card>
          )}
        </Col>
      </Row>
    </Container>
  );
}
