// The process analyst as an agent the STORY-001 orchestrator can run (capability
// "process"). The task input is { user, dataset, thresholds? }; the analysis id is
// the orchestrator's idempotency key, so re-running the operation replays it.
//
// A refused or incomplete REQUEST is a result, not an agent failure: permission
// denied, missing data and bad requests come back as the task's output. Throwing
// them would make the orchestrator take a healthy agent out of rotation and retry
// the same doomed request on another one. Only real failures (an audit write that
// failed, a bug) are thrown.

import { defineAgent } from '../orchestration/agents.js';
import { PermissionDeniedError, AnalysisRequestError } from './service.js';

export function createProcessAnalystAgent({ service, id = 'process-analyst' }) {
  return defineAgent({
    id,
    capabilities: ['process'],
    run: async (task, { signal }) => {
      const { user, dataset, thresholds } = task.input ?? {};
      const analysisId = task.idempotencyKey;
      try {
        return await service.runAnalysis({ analysisId, user, dataset, thresholds, signal });
      } catch (err) {
        if (err instanceof PermissionDeniedError) return { status: 'permission_denied', analysisId, message: err.message };
        if (err instanceof AnalysisRequestError) return { status: 'rejected', analysisId, message: err.message };
        throw err;
      }
    },
  });
}
