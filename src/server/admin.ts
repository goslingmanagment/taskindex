// Barrel of the taskindex-admin surface: the owner, the agents, backup and
// restore, and the deployment write gate. Split by responsibility (plan 06,
// step 11); importers keep one module path.
export { migrate } from './db.js';
export { initialize, createOwner, resetOwnerPassword } from './owner.js';
export {
  createAgent,
  listAgents,
  renameAgent,
  disableAgent,
  createAgentKey,
} from './agents.js';
export { listAgentKeys, revokeAgentKey } from './agent-keys.js';
export {
  exportWorkspace,
  validateExport,
  importWorkspace,
  markRestored,
} from './backup.js';
export { upgradeExport } from './export-upgrade.js';
export { openWrites, writesAreOpen } from './deployment.js';
