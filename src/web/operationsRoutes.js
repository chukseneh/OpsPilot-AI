// /api/v1/inventory/*, /api/v1/risk/* and /api/v1/roi/* (web access, step 4c).
// The services make every check and decision; these routes pass the signed-in user.
//
//   GET  /api/v1/inventory                              the registered AI systems
//   POST /api/v1/inventory/systems                      { system, reason } — register (same details again: unchanged)
//   POST /api/v1/inventory/systems/:systemId/status     { status, expectedVersion, reason }
//
//   POST /api/v1/risk/assessments                       { assessmentId, systems } — assess the systems given
//   POST /api/v1/risk/assessments/inventory             { assessmentId } — assess what is registered,
//        then record each rating back into the inventory. Safe to repeat with the same
//        id: the saved assessment is reused and ratings already recorded are unchanged.
//        The reply's assessment.status says how it went (completed, partial,
//        missing_data, …); only a completed one is recorded (recorded is null otherwise).
//
//   POST /api/v1/roi/scenarios                          { scenarioId, assumptions }
//   GET  /api/v1/roi/scenarios                          every estimate
//   GET  /api/v1/roi/scenarios/:scenarioId              one estimate

export function operationsRoutes({ inventory, risk, roi }) {
  return [
    {
      method: 'GET', path: '/api/v1/inventory', auth: 'session',
      handle: async ({ user, requestId }) => ({ body: await inventory.listSystems({ user, requestId: `api-${requestId}` }) }),
    },
    {
      method: 'POST', path: '/api/v1/inventory/systems', auth: 'session',
      handle: async ({ user, body }) => {
        const { system, created } = await inventory.registerSystem({ user, system: body.system, reason: body.reason ?? null });
        return { status: created ? 201 : 200, body: { system, created } };
      },
    },
    {
      method: 'POST', path: '/api/v1/inventory/systems/:systemId/status', auth: 'session',
      handle: async ({ user, params, body }) => ({
        body: await inventory.updateStatus({ user, systemId: params.systemId, status: body.status, expectedVersion: body.expectedVersion, reason: body.reason ?? null }),
      }),
    },

    {
      method: 'POST', path: '/api/v1/risk/assessments', auth: 'session',
      handle: async ({ user, body }) => ({ body: { assessment: await risk.runAssessment({ assessmentId: body.assessmentId, user, systems: body.systems }) } }),
    },
    {
      method: 'POST', path: '/api/v1/risk/assessments/inventory', auth: 'session',
      handle: async ({ user, body, requestId }) => {
        const systems = await inventory.systemsForAssessment({ user, requestId: `api-${requestId}` });
        const assessment = await risk.runAssessment({ assessmentId: body.assessmentId, user, systems });
        const recorded = assessment.status === 'completed' ? await inventory.recordRiskAssessment({ user, result: assessment }) : null;
        return { body: { assessment, recorded } };
      },
    },

    {
      method: 'POST', path: '/api/v1/roi/scenarios', auth: 'session',
      handle: async ({ user, body }) => ({ body: { scenario: await roi.calculateRoiScenario({ user, scenarioId: body.scenarioId, assumptions: body.assumptions }) } }),
    },
    {
      method: 'GET', path: '/api/v1/roi/scenarios', auth: 'session',
      handle: async ({ user }) => ({ body: { scenarios: await roi.listRoiScenarios({ user }) } }),
    },
    {
      method: 'GET', path: '/api/v1/roi/scenarios/:scenarioId', auth: 'session',
      handle: async ({ user, params }) => ({ body: { scenario: await roi.getRoiScenario({ user, scenarioId: params.scenarioId }) } }),
    },
  ];
}
