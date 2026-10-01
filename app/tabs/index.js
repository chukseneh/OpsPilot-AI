import { renderOverview } from './overview.js';
import { renderOutcomes } from './outcomes.js';
import { renderUsers } from './users.js';
import { renderGuardrails } from './guardrails.js';
import { renderSystems } from './systems.js';
import { renderProject } from './project.js';
import { renderAgents } from './agents.js';
import { renderKnowledge, mountKnowledge } from './knowledge.js';
import { renderDataModel } from './datamodel.js';

// render(data, sub, ctx) → HTML; mount(root, data, ctx) wires up anything interactive.
export const TABS = [
  { id: 'overview', title: 'Overview', render: renderOverview },
  { id: 'outcomes', title: 'Outcomes', render: renderOutcomes },
  { id: 'users', title: 'Users', render: renderUsers },
  { id: 'guardrails', title: 'Guardrails', render: renderGuardrails },
  { id: 'systems', title: 'Systems', render: renderSystems },
  { id: 'project', title: 'Project', render: renderProject },
  { id: 'agents', title: 'AI agents', render: renderAgents },
  { id: 'knowledge', title: 'Knowledge base', render: renderKnowledge, mount: mountKnowledge },
  { id: 'data-model', title: 'Data model', render: renderDataModel },
];

export const findTab = (id) => TABS.find((t) => t.id === id);
