// Domain limits shared by the command schemas, the entity schemas, the server
// page sizes and the web forms. Transport budgets (body size, timeouts,
// retries) are not domain limits and stay where they are used.
export const LIMITS = {
  id: 80,
  taskTitle: 240,
  taskNote: 16000,
  waitingFor: 240,
  checklistText: 500,
  checklistItems: 100,
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
} as const;
export type LimitName = keyof typeof LIMITS;
