const request = require('supertest');
const { ACTIONS } = require('../src/models/audit-entry');
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser, PASSWORD, TWO_FACTOR_CODE } = require('./helpers/test-app');

const OTHER = seedUser({ userId: 'user-99', email: 'other@example.com' });

function build(dbOptions = {}) {
  const db = createFakeDatabase({ users: [seedUser(), OTHER], ...dbOptions });
  return { ...testApp({ db }), db };
}

async function login(app, email = 'owner@example.com') {
  const res = await request(app)
    .post('/api/session')
    .send({ email, password: PASSWORD, code: TWO_FACTOR_CODE });
  expect(res.status).toBe(201);
  return res.body.token;
}

const NEW_CREDENTIAL = {
  title: 'Bank',
  url: 'https://bank.example.com',
  username: 'owner',
  encryptedPassword: 'AES256:8f3a...',
};

async function addCredential(app, token, body = NEW_CREDENTIAL) {
  return request(app).post('/api/credentials').set('Authorization', `Bearer ${token}`).send(body);
}

function postHealthReport(app, token, body) {
  return request(app)
    .post('/api/password-health')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function getHealthReport(app, token) {
  return request(app).get('/api/password-health').set('Authorization', `Bearer ${token}`);
}

// Routes that fail write a stack to the server log; keep the test output clean.
let errorSpy;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('POST /api/password-health (UC-05)', () => {
  it('persists the report, findings and alerts, and audits exactly once', async () => {
    const { app, db } = build();
    const token = await login(app);
    const weak = await addCredential(app, token, { ...NEW_CREDENTIAL, title: 'Weak one' });
    const reused = await addCredential(app, token, { ...NEW_CREDENTIAL, title: 'Reused one' });
    const ok = await addCredential(app, token, { ...NEW_CREDENTIAL, title: 'Strong one' });

    const res = await postHealthReport(app, token, {
      overallScore: 42,
      findings: [
        { itemId: weak.body.itemId, status: 'WEAK' },
        { itemId: reused.body.itemId, status: 'REUSED' },
        { itemId: ok.body.itemId, status: 'OK' },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ reportId: expect.any(String) });

    // Persisted, atomically.
    expect(db.state.healthReports.size).toBe(1);
    const [report] = db.state.healthReports.values();
    expect(report.overallScore).toBe(42);
    expect(report.findings).toHaveLength(3);

    // Alerts only for WEAK/REUSED, never OK.
    expect(db.state.securityAlerts).toHaveLength(2);
    expect(db.state.securityAlerts.map((a) => a.type).sort()).toEqual(['REUSED', 'WEAK']);
    expect(db.state.securityAlerts.every((a) => typeof a.message === 'string' && a.message.length > 0)).toBe(
      true
    );

    // Exactly one audit entry for this submission.
    expect(db.actions().filter((a) => a === ACTIONS.HEALTH_REPORT_GENERATED)).toHaveLength(1);
  });

  it('rejects an itemId that belongs to a different user\'s vault (business rule 6)', async () => {
    const { app, db } = build();
    const ownerToken = await login(app);
    const otherToken = await login(app, 'other@example.com');
    const otherItem = await addCredential(app, otherToken, {
      ...NEW_CREDENTIAL,
      title: "Other's item",
    });

    const res = await postHealthReport(app, ownerToken, {
      overallScore: 90,
      findings: [{ itemId: otherItem.body.itemId, status: 'WEAK' }],
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    expect(db.state.healthReports.size).toBe(0);
    expect(db.state.securityAlerts).toHaveLength(0);
    expect(db.actions()).not.toContain(ACTIONS.HEALTH_REPORT_GENERATED);
  });

  it.each([
    ['overallScore too high', { overallScore: 101, findings: [] }],
    ['overallScore negative', { overallScore: -1, findings: [] }],
    ['overallScore not a number', { overallScore: 'high', findings: [] }],
    ['missing overallScore', { findings: [] }],
    ['findings not an array', { overallScore: 50, findings: 'nope' }],
    ['finding with invalid status', { overallScore: 50, findings: [{ itemId: '1', status: 'BAD' }] }],
    ['finding missing itemId', { overallScore: 50, findings: [{ status: 'OK' }] }],
    // infra-reviewer follow-up: a duplicate itemId would otherwise reach
    // REPORT_FINDINGS' composite PK and fail as a 500 mid-transaction. Caught
    // here as a clean 400 before the transaction even opens.
    [
      'duplicate itemId across findings',
      {
        overallScore: 50,
        findings: [
          { itemId: '1', status: 'WEAK' },
          { itemId: '1', status: 'REUSED' },
        ],
      },
    ],
  ])('rejects %s with 400 and persists nothing', async (_name, body) => {
    const { app, db } = build();
    const token = await login(app);

    const res = await postHealthReport(app, token, body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    expect(db.state.healthReports.size).toBe(0);
    expect(db.actions()).not.toContain(ACTIONS.HEALTH_REPORT_GENERATED);
  });

  it('rolls back the report and findings when the audit entry cannot be written', async () => {
    const { app, db } = build({ failAppendOn: ACTIONS.HEALTH_REPORT_GENERATED });
    const token = await login(app);
    const item = await addCredential(app, token);

    const res = await postHealthReport(app, token, {
      overallScore: 10,
      findings: [{ itemId: item.body.itemId, status: 'WEAK' }],
    });

    expect(res.status).toBe(500);
    expect(db.state.healthReports.size).toBe(0);
    expect(db.state.securityAlerts).toHaveLength(0);
  });

  it('accepts an empty findings array (e.g. an empty vault)', async () => {
    const { app, db } = build();
    const token = await login(app);

    const res = await postHealthReport(app, token, { overallScore: 0, findings: [] });

    expect(res.status).toBe(201);
    expect(db.state.healthReports.size).toBe(1);
    expect(db.state.securityAlerts).toHaveLength(0);
  });

  it('requires authentication', async () => {
    const { app } = build();
    const res = await request(app)
      .post('/api/password-health')
      .send({ overallScore: 50, findings: [] });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/password-health (UC-05)', () => {
  it('returns { report: null } for a vault with no report yet', async () => {
    const { app } = build();
    const token = await login(app);

    const res = await getHealthReport(app, token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ report: null });
  });

  it('returns the full report shape after one exists', async () => {
    const { app, db } = build();
    const token = await login(app);
    const item = await addCredential(app, token);

    await postHealthReport(app, token, {
      overallScore: 77,
      findings: [{ itemId: item.body.itemId, status: 'REUSED' }],
    });

    const res = await getHealthReport(app, token);

    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({
      reportId: expect.any(String),
      overallScore: 77,
      findings: [{ itemId: item.body.itemId, status: 'REUSED' }],
    });
    expect(res.body.report.alerts).toHaveLength(1);
    expect(res.body.report.alerts[0]).toMatchObject({ type: 'REUSED' });

    // Reading a report is not a new event.
    expect(db.actions().filter((a) => a === ACTIONS.HEALTH_REPORT_GENERATED)).toHaveLength(1);
  });

  it("does not return another user's report", async () => {
    const { app } = build();
    const ownerToken = await login(app);
    const item = await addCredential(app, ownerToken);
    await postHealthReport(app, ownerToken, {
      overallScore: 50,
      findings: [{ itemId: item.body.itemId, status: 'OK' }],
    });

    const otherToken = await login(app, 'other@example.com');
    const res = await getHealthReport(app, otherToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ report: null });
  });

  it('requires authentication', async () => {
    const { app } = build();
    const res = await request(app).get('/api/password-health');
    expect(res.status).toBe(401);
  });
});
