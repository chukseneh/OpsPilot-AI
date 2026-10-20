// /api/v1/workflows/* (web access, step 4a). The workflow engine makes every
// decision and check (who may start, approve, view; the two-person rule; deadlines);
// these routes only pass it the signed-in user.
//
//   POST /api/v1/workflows                                 { workflowId, name, actions } → the workflow
//        Safe to repeat: the same id with the same actions returns the existing run.
//   GET  /api/v1/workflows/:workflowId                     the workflow and its steps
//   POST /api/v1/workflows/:workflowId/resume              retry a failed workflow from its failed step
//   POST /api/v1/workflows/:workflowId/steps/:step/decision  { decision: 'approve' | 'reject', note }

import { ApiRequestError } from './errors.js';

const stepNumber = (text) => {
  if (!/^[1-9][0-9]{0,5}$/.test(text)) throw new ApiRequestError(400, 'The step must be a whole number from 1.');
  return Number(text);
};

export function workflowRoutes({ workflows }) {
  return [
    {
      method: 'POST', path: '/api/v1/workflows', auth: 'session',
      handle: async ({ user, body }) => ({
        body: { workflow: await workflows.startWorkflow({ user, workflowId: body.workflowId, name: body.name, actions: body.actions }) },
      }),
    },
    {
      method: 'GET', path: '/api/v1/workflows/:workflowId', auth: 'session',
      handle: async ({ user, params }) => ({ body: { workflow: await workflows.viewWorkflow({ user, workflowId: params.workflowId }) } }),
    },
    {
      method: 'POST', path: '/api/v1/workflows/:workflowId/resume', auth: 'session',
      handle: async ({ user, params }) => ({ body: { workflow: await workflows.resumeWorkflow({ user, workflowId: params.workflowId }) } }),
    },
    {
      method: 'POST', path: '/api/v1/workflows/:workflowId/steps/:step/decision', auth: 'session',
      handle: async ({ user, params, body }) => ({
        body: {
          workflow: await workflows.decide({
            user, workflowId: params.workflowId, step: stepNumber(params.step), decision: body.decision, note: body.note ?? null,
          }),
        },
      }),
    },
  ];
}
