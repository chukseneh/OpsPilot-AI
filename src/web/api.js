// The whole web API (web access, step 5): every route group over the system's
// services, in one place, so startOpsPilot, the demo and the tests serve the same thing.
//
//   createWebApi({ services, audit, secureCookies }) → createApiServer(...) (listen / close)
//
// `services` is what startOpsPilot builds, plus `accounts` and `sessions`.

import { createApiServer } from './server.js';
import { authRoutes } from './authRoutes.js';
import { workflowRoutes } from './workflowRoutes.js';
import { documentRoutes } from './documentRoutes.js';
import { operationsRoutes } from './operationsRoutes.js';
import { oversightRoutes } from './oversightRoutes.js';

export function createWebApi({ services: s, audit, secureCookies = false, ...serverOptions }) {
  return createApiServer({
    audit,
    sessions: s.sessions,
    routes: [
      ...authRoutes({ accounts: s.accounts, sessions: s.sessions, secureCookies }),
      ...workflowRoutes({ workflows: s.workflows }),
      ...documentRoutes({ documents: s.documents }),
      ...operationsRoutes({ inventory: s.inventory, risk: s.risk, roi: s.roi }),
      ...oversightRoutes({ governance: s.governance, auditReader: s.auditReader, simulations: s.simulation, audit }),
    ],
    ...serverOptions,
  });
}
