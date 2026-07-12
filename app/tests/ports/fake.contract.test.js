const { runPortContractSuite } = require('./contract-suite');
const { buildFakeFixture } = require('./helpers/fake-fixture');

// Always runs — no DB, no network, no env var. This is the baseline the real
// adapters (mysql.contract.test.js) are held to.
runPortContractSuite('fake (in-memory)', buildFakeFixture);
