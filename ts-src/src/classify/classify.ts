import type { RelPath } from '../types/common.js';
import type { FileState, SyncLogMetadata } from '../types/state.js';
import type { ClassifyInput } from './conditions.js';
import { extractConditions } from './conditions.js';
import { RULES } from './rules.js';

/**
 * Match a conditions object against a partial rule pattern.
 * Every field present in `when` must equal the corresponding field in `cond`.
 * Fields absent from `when` (undefined) are "don't care".
 */
export function matchesRule<T>(cond: T, when: Partial<T>): boolean {
  for (const key of Object.keys(when as object) as (keyof T)[]) {
    if (when[key] === undefined) continue;
    if (cond[key] !== when[key]) return false;
  }
  return true;
}

const POLICY_VERSION = '1.0'; // TODO: get from config

export function classify(input: ClassifyInput | null): {
  state: FileState;
  metadata: SyncLogMetadata;
} {
  if (input == null) throw new Error('classify input must not be null');
  const cond = extractConditions(input);
  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[i];
    if (!rule) continue;
    if (matchesRule(cond, rule.when)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const state = { kind: rule.then } as FileState;
      const metadata: SyncLogMetadata = {
        decisionReason: `rule_${i}_${rule.then}`,
        policyVersion: POLICY_VERSION,
      };
      return { state, metadata };
    }
  }
  throw new Error(`No rule matched: ${JSON.stringify(cond)}`);
}

/**
 * Bulk classify: given all paths from cloud + local + metadata,
 * produce a map of path → FileState and path → SyncLogMetadata.
 */
type ClassifyInputMap = ReadonlyMap<RelPath, ClassifyInput['cloud']>;
type LocalMap = ReadonlyMap<RelPath, ClassifyInput['local']>;
type MetaMap = ReadonlyMap<RelPath, ClassifyInput['meta']>;
type LocalHashMap = ReadonlyMap<RelPath, ClassifyInput['localHash']>;

export function classifyAll(
  cloud: ClassifyInputMap | null,
  local: LocalMap | null,
  meta: MetaMap | null,
  localHashes: LocalHashMap | null,
): {
  classified: Map<RelPath, FileState>;
  metadata: Map<RelPath, SyncLogMetadata>;
} {
  if (cloud == null || local == null || meta == null || localHashes == null) {
    throw new Error('classifyAll: cloud, local, meta, localHashes must not be null');
  }
  const allPaths = new Set<RelPath>([...cloud.keys(), ...local.keys(), ...meta.keys()]);
  const classified = new Map<RelPath, FileState>();
  const metadata = new Map<RelPath, SyncLogMetadata>();
  for (const path of allPaths) {
    const input: ClassifyInput = {
      cloud: cloud.get(path) ?? null,
      local: local.get(path) ?? null,
      meta: meta.get(path) ?? null,
      localHash: localHashes.get(path) ?? null,
    };
    const result = classify(input);
    classified.set(path, result.state);
    metadata.set(path, result.metadata);
  }
  return { classified, metadata };
}
