import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Scope } from '../shared/model.js';

// An agent's hub key (ecosystem plan, package M2): an agent may call
// TaskIndex with its agency hub key instead of a TaskIndex key.
//
// 1. The agent sends its hub key as the bearer (`agency_hub_agent_…`).
// 2. TaskIndex sends the hub ONLY the key's sha256 (lowercase hex) to
//    `POST /api/v1/agent/keys/introspect`, as the bearer of its OWN hub key
//    holding `introspect:agent_keys` — never the agent's key.
// 3. The hub answers the agent's code, or «inactive». The owner's table
//    `HUB_AGENTS` maps the code to an existing TaskIndex agent and the scope
//    that agent works with; a code not in the table gets nothing.
// 4. An answer holds 60 s. While the hub cannot be reached (network,
//    timeout, 5xx) the last ACTIVE answer holds up to an hour after it was
//    fetched, never past the key's expiry; an inactive one is never
//    extended. A 4xx or a malformed answer is an answer: refused, nothing is
//    held after it.
//
// The key and its digest are never logged or stored: the digest lives only
// as the cache key. Checking a key writes nothing to the database.

export const HUB_AGENT_KEY_PREFIX = 'agency_hub_agent_';
/** The hub's person code (`PERSON_CODE_PATTERN` of its contracts). */
export const HUB_AGENT_CODE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const HUB_KEY_FRESH_MS = 60_000;
export const HUB_KEY_HOLD_MS = 60 * 60_000;
const RETRY_MS = 15_000;
const HUB_TIMEOUT_MS = 5_000;
const MAX_ENTRIES = 1024;
/** Questions to the hub per minute, whoever asks: made-up keys must not
 *  spend the key's allowance at the hub. */
const ASKS_PER_MINUTE = 120;

export type HubAgentLink = { agentId: string; scope: Scope };
export type HubAgentKeysConfig = {
  /** Where this server asks (any name of the hub). */
  url: string;
  /** TaskIndex's own hub key, holding `introspect:agent_keys`. */
  key: string;
  /** The owner's table: hub agent code → the TaskIndex agent and its scope. */
  agents: Record<string, HubAgentLink>;
};

export type HubKeyVerdict =
  | { kind: 'active'; code: string; held: boolean }
  /** Unknown, revoked, expired, not an agent's: the hub does not say which. */
  | { kind: 'inactive' }
  /** The hub cannot be reached and no active answer is held. */
  | { kind: 'unreachable' }
  /** The hub refused TaskIndex's key or the question. */
  | { kind: 'refused' };

export type HubAgentKeys = {
  readonly agents: Readonly<Record<string, HubAgentLink>>;
  who(token: string): Promise<HubKeyVerdict>;
};

const scopes = ['read', 'propose', 'tasks', 'write'] as const;
const linkPattern = /^([^=\s]+)=([^:\s]+):([a-z]+)$/;
const agentIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** `gengar=openclaw:tasks,os-machine=claude-mac:write` → the table; any
 *  other shape is an error naming the entry. */
export function parseHubAgents(raw: string): Record<string, HubAgentLink> {
  const agents: Record<string, HubAgentLink> = {};
  for (const entry of raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const match = linkPattern.exec(entry);
    const [, code, agentId, scope] = match ?? [];
    if (
      !code ||
      !agentId ||
      !HUB_AGENT_CODE.test(code) ||
      !agentIdPattern.test(agentId) ||
      !(scopes as readonly string[]).includes(scope ?? '')
    )
      throw new Error(
        `«${entry}»: ожидается код_агента_хаба=id_агента:${scopes.join('|')}`,
      );
    if (agents[code]) throw new Error(`«${code}» указан дважды`);
    agents[code] = { agentId, scope: scope as Scope };
  }
  return agents;
}

const answerSchema = z.discriminatedUnion('active', [
  z.object({
    active: z.literal(true),
    agent: z.object({ code: z.string().regex(HUB_AGENT_CODE) }),
    expiresAt: z.iso.datetime({ offset: true }),
    cacheSeconds: z.number().optional(),
    staleSeconds: z.number().optional(),
  }),
  z.object({
    active: z.literal(false),
    cacheSeconds: z.number().optional(),
    staleSeconds: z.number().optional(),
  }),
]);

type Entry = {
  active: boolean;
  code: string;
  expiresAt: number;
  fetchedAt: number;
  freshMs: number;
  holdMs: number;
  /** The last failed refresh while holding. */
  triedAt: number | null;
};

const clampMs = (seconds: number | undefined, limitMs: number) => {
  const ms = (seconds ?? 0) * 1000;
  return ms > 0 && ms <= limitMs ? ms : limitMs;
};

const verdictOf = (entry: Entry, at: number, held: boolean): HubKeyVerdict =>
  entry.active && at < entry.expiresAt
    ? { kind: 'active', code: entry.code, held }
    : { kind: 'inactive' };
// An active answer still inside its hold window and the key's own life.
const holdable = (entry: Entry | undefined, at: number): entry is Entry =>
  entry?.active === true &&
  at - entry.fetchedAt < entry.holdMs &&
  at < entry.expiresAt;

export function createHubAgentKeys(
  config: HubAgentKeysConfig & {
    fetch?: typeof fetch;
    now?: () => number;
  },
): HubAgentKeys {
  const send = config.fetch ?? fetch;
  const clock = config.now ?? Date.now;
  const api = config.url.replace(/\/+$/, '');
  const entries = new Map<string, Entry>();
  const asking = new Map<string, Promise<HubKeyVerdict>>();
  let asks: number[] = [];

  // `null`: no answer (network, timeout, a redirect, 5xx); `refused`: a 4xx
  // or a body that is not an answer about the key.
  const introspect = async (
    digest: string,
  ): Promise<Omit<Entry, 'fetchedAt' | 'triedAt'> | 'refused' | null> => {
    let response: Response;
    try {
      response = await send(`${api}/api/v1/agent/keys/introspect`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.key}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ keyDigest: digest }),
        redirect: 'manual',
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (response.status >= 400 && response.status < 500) return 'refused';
    if (response.status !== 200) return null;
    const body = (await response.json().catch(() => undefined)) as unknown;
    const parsed = answerSchema.safeParse(body);
    if (!parsed.success) return 'refused';
    const answer = parsed.data;
    return {
      active: answer.active,
      code: answer.active ? answer.agent.code : '',
      expiresAt: answer.active ? Date.parse(answer.expiresAt) : 0,
      freshMs: clampMs(answer.cacheSeconds, HUB_KEY_FRESH_MS),
      holdMs: clampMs(answer.staleSeconds, HUB_KEY_HOLD_MS),
    };
  };

  const store = (digest: string, entry: Entry) => {
    if (!entries.has(digest) && entries.size >= MAX_ENTRIES) {
      const at = clock();
      for (const [key, old] of entries)
        if (at - old.fetchedAt >= old.freshMs && !holdable(old, at))
          entries.delete(key);
      for (const key of entries.keys()) {
        if (entries.size < MAX_ENTRIES) break;
        entries.delete(key);
      }
    }
    entries.set(digest, entry);
  };

  const refresh = async (digest: string): Promise<HubKeyVerdict> => {
    const fetchedAt = clock();
    const answer = await introspect(digest);
    const at = clock();
    const known = entries.get(digest);
    if (answer === 'refused') {
      entries.delete(digest);
      return { kind: 'refused' };
    }
    if (answer === null) {
      if (holdable(known, at)) {
        known.triedAt = at;
        return verdictOf(known, at, true);
      }
      entries.delete(digest);
      return { kind: 'unreachable' };
    }
    const entry: Entry = { ...answer, fetchedAt, triedAt: null };
    store(digest, entry);
    return verdictOf(entry, at, false);
  };

  return {
    agents: config.agents,
    who(token) {
      const digest = createHash('sha256').update(token).digest('hex');
      const at = clock();
      const known = entries.get(digest);
      if (known && at - known.fetchedAt < known.freshMs)
        return Promise.resolve(verdictOf(known, at, false));
      if (
        holdable(known, at) &&
        known.triedAt !== null &&
        at - known.triedAt < RETRY_MS
      )
        return Promise.resolve(verdictOf(known, at, true));
      const pending = asking.get(digest);
      if (pending) return pending;
      asks = asks.filter((time) => at - time < 60_000);
      if (asks.length >= ASKS_PER_MINUTE)
        return Promise.resolve(
          holdable(known, at)
            ? verdictOf(known, at, true)
            : { kind: 'unreachable' },
        );
      asks.push(at);
      const run = refresh(digest).finally(() => asking.delete(digest));
      asking.set(digest, run);
      return run;
    },
  };
}
