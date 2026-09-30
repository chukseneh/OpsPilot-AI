// run — the agent proposes, the gate decides, and only the gate can act.
const { propose } = require('./agent');
const { submit } = require('./gate');

const action = propose();
console.log('PROPOSED:', JSON.stringify(action));
const { decision, ledgerEntry } = submit(action);
console.log('DECISION:', JSON.stringify(decision));
if (ledgerEntry) {
  console.log('LEDGER:  ', JSON.stringify(ledgerEntry));
} else {
  console.log(`REFUSED:  ${decision.reason}`);
}
