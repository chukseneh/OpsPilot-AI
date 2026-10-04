// Role names as people type them. "Operations_Manager", "operations manager" and
// " operations  manager " are the same role. Shared by every permission check, so
// they can never disagree about who a role is.

export const normaliseRole = (role) => (typeof role === 'string' ? role.trim().toLowerCase().replace(/[_\s]+/g, ' ') : '');

// Does `role` match one of `allowed`? Both sides are normalised.
export const roleAllowed = (role, allowed) => {
  const r = normaliseRole(role);
  return r !== '' && allowed.some((a) => normaliseRole(a) === r);
};
