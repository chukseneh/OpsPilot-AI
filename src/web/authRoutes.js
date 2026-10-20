// /api/v1/auth/* and /api/v1/accounts/* (web access, step 3).
//
//   POST /api/v1/auth/sign-in        { username, password } → sets the session cookie; { user, csrfToken, expiresAt }
//   POST /api/v1/auth/sign-out       ends this session
//   GET  /api/v1/auth/me             who is signed in
//   POST /api/v1/auth/password       { currentPassword, newPassword } → ends this session too
//
//   Security officers only (the account service checks):
//   GET  /api/v1/accounts                              every account
//   POST /api/v1/accounts            { username, displayName, role, password, reason }
//   GET  /api/v1/accounts/:username
//   POST /api/v1/accounts/:username/role             { role, reason }
//   POST /api/v1/accounts/:username/disable          { reason }
//   POST /api/v1/accounts/:username/enable           { reason }
//   POST /api/v1/accounts/:username/password-reset   { newPassword, reason }
//
// The first security officer is not created here: see bootstrapFirstAdmin.

import { ApiRequestError } from './errors.js';
import { sessionCookie, clearedSessionCookie } from './sessions.js';

const me = (a) => ({ id: a.id, displayName: a.displayName, role: a.role });

export function authRoutes({ accounts, sessions, secureCookies = false }) {
  const cleared = { 'Set-Cookie': clearedSessionCookie({ secure: secureCookies }) };
  const accountRoute = (action, fields) => ({
    method: 'POST', path: `/api/v1/accounts/:username/${action}`, auth: 'session',
    handle: async ({ user, params, body }) => ({ body: { account: await fields(user, params.username, body) } }),
  });

  return [
    {
      method: 'POST', path: '/api/v1/auth/sign-in', auth: 'public', rateLimit: 'sign-in',
      handle: async ({ body }) => {
        const result = await sessions.signIn({ username: body.username, password: body.password });
        if (!result.ok) throw new ApiRequestError(401, 'Wrong username or password.');
        return {
          body: { user: me(result.account), csrfToken: result.csrfToken, expiresAt: result.expiresAt },
          headers: { 'Set-Cookie': sessionCookie(result.token, { secure: secureCookies }) },
        };
      },
    },
    {
      method: 'POST', path: '/api/v1/auth/sign-out', auth: 'session',
      handle: async ({ sessionToken }) => ({ body: await sessions.signOut({ token: sessionToken }), headers: cleared }),
    },
    {
      method: 'GET', path: '/api/v1/auth/me', auth: 'session',
      handle: async ({ user }) => ({ body: { user: me(await accounts.getAccount(user.id)) } }),
    },
    {
      method: 'POST', path: '/api/v1/auth/password', auth: 'session',
      handle: async ({ user, body }) => {
        await accounts.changeOwnPassword({ user, currentPassword: body.currentPassword, newPassword: body.newPassword });
        return { body: { changed: true, signedOut: true }, headers: cleared };
      },
    },

    {
      method: 'GET', path: '/api/v1/accounts', auth: 'session',
      handle: async ({ user }) => ({ body: { accounts: await accounts.listAccounts({ user }) } }),
    },
    {
      method: 'POST', path: '/api/v1/accounts', auth: 'session',
      handle: async ({ user, body }) => ({
        status: 201,
        body: { account: await accounts.createAccount({ user, username: body.username, displayName: body.displayName, role: body.role, password: body.password, reason: body.reason }) },
      }),
    },
    {
      method: 'GET', path: '/api/v1/accounts/:username', auth: 'session',
      handle: async ({ user, params }) => ({ body: { account: await accounts.viewAccount({ user, username: params.username }) } }),
    },
    accountRoute('role', (user, username, b) => accounts.changeRole({ user, username, role: b.role, reason: b.reason })),
    accountRoute('disable', (user, username, b) => accounts.disableAccount({ user, username, reason: b.reason })),
    accountRoute('enable', (user, username, b) => accounts.enableAccount({ user, username, reason: b.reason })),
    accountRoute('password-reset', (user, username, b) => accounts.resetPassword({ user, username, newPassword: b.newPassword, reason: b.reason })),
  ];
}
