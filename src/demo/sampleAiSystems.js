// SYNTHETIC registered AI systems for the STORY-003 demo. Invented for
// demonstration; no real organisation, person or system. Until the inventory
// (STORY-004) exists, this list stands in for "AI systems are registered".

export const SAMPLE_LABEL = 'SYNTHETIC sample AI systems (invented for demonstration)';

export function sampleAiSystems() {
  return [
    {
      id: 'ai-cv-screen', name: 'CV screener', department: 'HR', purpose: 'Ranks incoming job applications for recruiters',
      owner: 'hr-lead-1', status: 'active', dataCategories: ['personal'], decisionImpact: 'significant',
      humanOversight: 'none', userFacing: false,
    },
    {
      id: 'ai-claims-triage', name: 'Claims triage', department: 'Finance', purpose: 'Decides which expense claims are paid automatically',
      owner: 'fin-ops-2', status: 'active', dataCategories: ['financial', 'personal'], decisionImpact: 'critical',
      humanOversight: 'review', userFacing: false,
    },
    {
      id: 'ai-help-chat', name: 'Help-desk chatbot', department: 'Support', purpose: 'Answers staff IT questions',
      owner: 'it-support-1', status: 'active', dataCategories: ['internal'], decisionImpact: 'low',
      humanOversight: 'review', userFacing: true,
    },
    {
      id: 'ai-demand-forecast', name: 'Demand forecast', department: 'Operations', purpose: 'Forecasts weekly order volumes',
      owner: 'ops-planner-1', status: 'active', dataCategories: ['internal'], decisionImpact: 'low',
      humanOversight: 'approval', userFacing: false,
    },
    {
      // Planted gap: nobody recorded how people are involved, or whether it faces users.
      id: 'ai-sentiment', name: 'Call sentiment scorer', department: 'Support', purpose: 'Scores customer call recordings',
      owner: 'support-lead-1', status: 'active', dataCategories: ['personal'], decisionImpact: 'low',
    },
  ];
}
