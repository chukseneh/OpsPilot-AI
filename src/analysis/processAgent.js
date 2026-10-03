// The process analyst as an agent the STORY-001 orchestrator can run (capability
// "process"). The task input is { user, dataset, thresholds? }; the analysis id is
// the orchestrator's idempotency key, so re-running the operation replays it.
//
// A refused or incomplete REQUEST is a result, not an agent failure: permission
// denied, missing data and bad requests come back as the task's output (and, like
// any completed task, are replayed for the same operation — same request, same
// answer). Throwing them would make the orchestrator take a healthy agent out of
// rotation and retry the same doomed request on another one.
//
// An INTERRUPTED analysis is different: nothing was decided, so it must not be
// saved as done. It is raised as TaskFailedError — the task fails, the agent stays
// in rotation, and re-running the operation re-runs the analysis.
//
// Timeouts: give the analysis service a SHORTER time limit than the orchestrator.
// Then a slow analysis stops itself and reports "interrupted"; if the
// orchestrator's limit fired first, it would blame the agent and take it out of
// rotation for its cooldown.
//
// Real failures (an audit write that failed, a bug) are thrown as they are.

import { defineAgent } from '../orchestration/agents.js';
import { TaskFailedError } from '../orchestration/errors.js';
import { PermissionDeniedError, AnalysisRequestError } from './service.js';

export function createProcessAnalystAgent({ service, id = 'process-analyst' }) {
  return defineAgent({
    id,
    capabilities: ['process'],
    run: async (task, { signal }) => {
      const { user, dataset, thresholds } = task.input ?? {};
      const analysisId = task.idempotencyKey;
      let result;
      try {
        result = await service.runAnalysis({ analysisId, user, dataset, thresholds, signal });
      } catch (err) {
        if (err instanceof PermissionDeniedError) return { status: 'permission_denied', analysisId, message: err.message };
        if (err instanceof AnalysisRequestError) return { status: 'rejected', analysisId, message: err.message };
        throw err;
      }
      if (result.status === 'interrupted') throw new TaskFailedError(result.message);
      return result;
    },
  });
}
