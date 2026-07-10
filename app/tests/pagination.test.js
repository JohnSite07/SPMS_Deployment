const {
  parseLimit,
  encodeCursor,
  decodeCursor,
  cursorFor,
  readPage,
  PaginationError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} = require('../src/routes/pagination');

describe('parseLimit', () => {
  it('defaults when absent', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('accepts an in-range integer', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('25')).toBe(25);
    expect(parseLimit(String(MAX_PAGE_SIZE))).toBe(MAX_PAGE_SIZE);
  });

  // An unbounded limit loads an arbitrarily long log into memory to serialise.
  it('refuses a limit above the cap', () => {
    expect(() => parseLimit(String(MAX_PAGE_SIZE + 1))).toThrow(PaginationError);
    expect(() => parseLimit('10000000')).toThrow(PaginationError);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['a float', '1.5'],
    ['a word', 'all'],
    ['empty', ''],
    ['whitespace', ' 5'],
    ['hex', '0x10'],
    ['scientific notation', '1e3'],
    // Express turns `?limit=1&limit=2` into an array. Number(['5']) is 5, so a
    // bare numeric coercion would have accepted this.
    ['a repeated query param', ['1', '2']],
    ['a single-element array', ['5']],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseLimit(raw)).toThrow(PaginationError);
  });
});

describe('cursors', () => {
  const position = { timestampMillis: 1_700_000_000_123, entryId: 'e1e2e3' };

  it('round-trips a position', () => {
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('is opaque rather than readable', () => {
    expect(encodeCursor(position)).not.toContain('e1e2e3');
  });

  // It carries no userId, which is why it needs no signature: the identity
  // always comes from req.auth, so an edited cursor can only move a reader
  // around inside their own log.
  it('carries no identity', () => {
    const decoded = Buffer.from(encodeCursor(position), 'base64url').toString('utf8');
    expect(decoded).toBe('1700000000123.e1e2e3');
    expect(Object.keys(decodeCursor(encodeCursor(position)))).toEqual([
      'timestampMillis',
      'entryId',
    ]);
  });

  it('preserves an entryId containing a dot', () => {
    const dotted = { timestampMillis: 5, entryId: 'a.b.c' };
    expect(decodeCursor(encodeCursor(dotted))).toEqual(dotted);
  });

  it.each([
    ['a non-string', 42],
    ['undefined', undefined],
    ['empty', ''],
    ['garbage base64', 'zzzz$$$$'],
    ['no separator', Buffer.from('1700000000123', 'utf8').toString('base64url')],
    ['a leading separator', Buffer.from('.abc', 'utf8').toString('base64url')],
    ['a non-numeric timestamp', Buffer.from('later.abc', 'utf8').toString('base64url')],
    ['an empty entryId', Buffer.from('123.', 'utf8').toString('base64url')],
    ['an unsafe integer', Buffer.from('99999999999999999999.abc', 'utf8').toString('base64url')],
  ])('rejects %s', (_name, raw) => {
    expect(() => decodeCursor(raw)).toThrow(PaginationError);
  });

  // Splitting at the *first* dot means a fractional timestamp cannot be
  // expressed at all: `1.5` is the position (1, "5"), not the instant 1.5ms.
  // The alternative — splitting at the last dot — would make an entryId
  // containing a dot ambiguous instead. Neither is lossy, but only one of
  // them keeps the timestamp an integer by construction.
  it('cannot express a fractional timestamp', () => {
    const raw = Buffer.from('1.5', 'utf8').toString('base64url');
    expect(decodeCursor(raw)).toEqual({ timestampMillis: 1, entryId: '5' });
  });
});

describe('readPage', () => {
  const entry = (millis, id) => ({
    entryId: id,
    timestamp: new Date(millis),
  });

  const pageOf = (rows) =>
    readPage({
      limit: 2,
      after: null,
      fetch: async (take) => rows.slice(0, take),
      restore: (r) => r,
    });

  it('returns a cursor onto the next page when more rows exist', async () => {
    const rows = [entry(3, 'c'), entry(2, 'b'), entry(1, 'a')];
    const page = await pageOf(rows);

    expect(page.entries.map((e) => e.entryId)).toEqual(['c', 'b']);
    expect(decodeCursor(page.nextCursor)).toEqual({ timestampMillis: 2, entryId: 'b' });
  });

  // Otherwise nextCursor === null would mean "probably done" rather than
  // "done", and the client would fetch one guaranteed-empty page.
  it('returns no cursor when the page is exactly the last one', async () => {
    const page = await pageOf([entry(2, 'b'), entry(1, 'a')]);

    expect(page.entries).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('returns no cursor for an empty log', async () => {
    const page = await pageOf([]);
    expect(page).toEqual({ entries: [], nextCursor: null });
  });

  it('asks the store for one row more than the page size', async () => {
    const fetch = jest.fn(async () => []);
    await readPage({ limit: 50, after: null, fetch, restore: (r) => r });
    expect(fetch).toHaveBeenCalledWith(51, null);
  });

  it('cursorFor names the entry it was given', () => {
    expect(decodeCursor(cursorFor(entry(9, 'z')))).toEqual({ timestampMillis: 9, entryId: 'z' });
  });
});
