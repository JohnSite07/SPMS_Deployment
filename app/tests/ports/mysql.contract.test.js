// The real-adapter half of the port contract, guarded behind DB_HOST so
// `npm test` passes locally and in CI with NO database reachable — this file
// must never connect anywhere unless a caller explicitly opted in by setting
// the DB_* env vars documented in src/db/pool.js.
//
// To run it for real: point DB_* at the `securevault_test` database (or any
// database already migrated to the 0014 reconciled schema) and run
// `DB_HOST=... DB_PORT=... DB_NAME=... DB_USER=... DB_PASSWORD=... npm test`.
const { runPortContractSuite } = require('./contract-suite');

if (process.env.DB_HOST) {
   
  const { buildMysqlFixture } = require('./helpers/mysql-fixture');
  runPortContractSuite('real MySQL (DB_HOST set)', buildMysqlFixture);
} else {
  describe('port contract: real MySQL', () => {
    it.skip('DB_HOST is not set — skipping the real-adapter contract suite', () => {});
  });
}
