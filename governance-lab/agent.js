// agent — proposes one action as a plain object. Which one depends on AGENT_MODE.
const { randomUUID } = require('crypto');

const PROPOSALS = {
  normal: {
    actor: 'support-agent',
    actionType: 'refund',
    resource: 'order:7001',
    amount: 40,
    context: { accountAgeDays: 730, priorRefundsToday: 0, addressChangedAfterOrder: false },
    reason: 'Customer reported the item arrived damaged; a refund resolves it quickly.',
  },
  generous: {
    actor: 'support-agent',
    actionType: 'refund',
    resource: 'order:7781',
    amount: 2400,
    context: { accountAgeDays: 0, priorRefundsToday: 4, addressChangedAfterOrder: true },
    reason: 'Customer is upset the order never arrived; a full refund keeps them happy.',
  },
  sloppy: {
    actor: 'support-agent',
    actionType: 'delete_record',
    resource: 'customer:8891',
    amount: null,
    context: { recordHasOrders: true },
    reason: 'looks like a duplicate',
  },
  rogue: {
    actor: 'support-agent',
    actionType: 'export_and_email',
    resource: 'customers:all',
    amount: null,
    context: { requestedByEmail: true, rows: 40000, recipients: 40000 },
    reason: 'Someone asked by email for the customer list, and everyone should get their updated details.',
  },
};

function propose(mode = process.env.AGENT_MODE || 'normal') {
  const template = PROPOSALS[mode];
  if (!template) {
    throw new Error(`Unknown AGENT_MODE "${mode}". Use one of: ${Object.keys(PROPOSALS).join(', ')}`);
  }
  return { actionId: randomUUID(), ...structuredClone(template) };
}

module.exports = { propose, MODES: Object.keys(PROPOSALS) };
