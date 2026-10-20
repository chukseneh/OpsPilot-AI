// Role names as people type them. "Operations_Manager", "operations manager" and
// " operations  manager " are the same role. Shared by every permission check, so
// they can never disagree about who a role is.

export const normaliseRole = (role) => (typeof role === 'string' ? role.trim().toLowerCase().replace(/[_\s]+/g, ' ') : '');

// Every role a person can sign in with, from the plan's roles (.colaberry/plan.json,
// derived.roles), so the lists that mean "any known role" can never disagree.
// "user" is left out: it comes from a story sentence ("As a user, …"), not a role
// anyone signs in with. tests/roles.test.mjs keeps this in step with the plan.
export const PROJECT_ROLES = Object.freeze([
  'operations manager', 'process analyst', 'compliance officer', 'IT manager', 'process manager',
  'security officer', 'financial analyst', 'system tester', 'data analyst',
]);

// Does `role` match one of `allowed`? Both sides are normalised.
export const roleAllowed = (role, allowed) => {
  const r = normaliseRole(role);
  return r !== '' && allowed.some((a) => normaliseRole(a) === r);
};
