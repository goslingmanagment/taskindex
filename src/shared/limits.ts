// Domain limits shared by the command schemas, the entity schemas, the server
// page sizes and the web forms. Transport budgets (body size, timeouts,
// retries) are not domain limits and stay where they are used.
export const LIMITS = {
  id: 80,
  taskTitle: 240,
  taskNote: 16000,
  taskLabels: 8,
  // The label catalogue (0007): a cap keeps it a set the owner can hold in
  // mind; archived labels do not count.
  labels: 24,
  labelName: 30,
  labelDescription: 200,
  closes: 80,
  waitingFor: 240,
  checklistText: 500,
  checklistItems: 100,
  // The outcome of a step (TI-095): what came out, a link to a PR or a file.
  stepResult: 1000,
  originSystem: 40,
  originRef: 200,
  originUrl: 2000,
  originVersion: 120,
  projectName: 60,
  projectDescription: 500,
  commentText: 4000,
  agentLabel: 100,
  batchCommands: 100,
  pageSize: 500,
  digestPage: 50,
  // The Focus desk (plan 13): tasks shown after the current one and tasks
  // that recently left the desk.
  deskNext: 2,
  deskRecent: 3,
  deskRecentDays: 14,
  // Agent proposals (spec 2026-09-25): a reason and quotes short enough for
  // one Telegram message, a card note shown whole, numbers the owner answers
  // by, at most five shown a day and three days to answer.
  proposalReason: 300,
  proposalEvidence: 3,
  proposalEvidenceRef: 200,
  proposalQuote: 200,
  proposalFingerprint: 200,
  proposalNote: 300,
  proposalNumbers: 15,
  proposalsPerDay: 5,
  proposalShownDays: 3,
} as const;
