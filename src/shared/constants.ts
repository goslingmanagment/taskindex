// The names the code compares against (plan 10, step 7): the two virtual
// project filters and the actor id prefix of agents. Literals of these live
// only here.
export const ALL_PROJECTS = 'all';
export const NO_PROJECT = 'none';
export const AGENT_ACTOR_PREFIX = 'agent:';
export const isAgentActor = (actorId: string) =>
  actorId.startsWith(AGENT_ACTOR_PREFIX);
// A project filter as a query names it: `all` means no filter (undefined),
// `none` the tasks without a project (null), anything else a project id.
export function projectFilterToId(filter: string): string | null | undefined {
  if (filter === ALL_PROJECTS) return undefined;
  if (filter === NO_PROJECT) return null;
  return filter;
}
