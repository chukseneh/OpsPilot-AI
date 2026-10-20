// One shared list of the project's roles (consistency review F3). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PROJECT_ROLES, roleAllowed } from '../src/lib/roles.js';
import { KNOWN_ROLES } from '../src/governance/policy.js';
import { UPLOAD_ROLES } from '../src/documents/service.js';
import * as roleLists from './helpers/roleLists.mjs';

const plan = JSON.parse(readFileSync(new URL('../.colaberry/plan.json', import.meta.url), 'utf8'));

test('the project roles are exactly the plan\'s roles, minus the generic "user"', () => {
  const fromPlan = plan.derived.roles.filter((r) => r !== 'user').sort();
  assert.deepEqual([...PROJECT_ROLES].sort(), fromPlan);
  assert.ok(!PROJECT_ROLES.includes('user'));
});

test('"any known role" means the same list everywhere', () => {
  assert.equal(KNOWN_ROLES, PROJECT_ROLES, 'governance policies');
  assert.equal(UPLOAD_ROLES, PROJECT_ROLES, 'document uploads');
  assert.ok(roleAllowed('System_Tester', UPLOAD_ROLES) && roleAllowed('data analyst', UPLOAD_ROLES));
  assert.ok(!roleAllowed('user', UPLOAD_ROLES));
});

test('every role any service allows is a real project role (no typos, no strays)', () => {
  for (const [name, list] of Object.entries(roleLists)) {
    for (const role of list) assert.ok(PROJECT_ROLES.includes(role), `${name} allows "${role}", which is not a project role`);
  }
});
