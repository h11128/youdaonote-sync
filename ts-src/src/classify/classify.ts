import type { FileState } from '../types/state.js';
import type { ClassifyInput, Conditions } from './conditions.js';
import { extractConditions } from './conditions.js';
import { RULES } from './rules.js';

/**
 * Match a conditions object against a partial rule pattern.
 * Every field present in `when` must equal the corresponding field in `cond`.
 * Fields absent from `when` (undefined) are "don't care".
 */
export function matchesRule<T>(
  cond: T,
  when: Partial<T>,
): boolean {
  for (const key of Object.keys(when as object) as Array<keyof T>) {
    if (when[key] === undefined) continue;
    if (cond[key] !== when[key]) return false;
  }
  return true;
}

export function classify(input: ClassifyInput): FileState {
  if (input == null) throw new Error('classify input must not be null');
  const cond = extractConditions(input);
  for (const rule of RULES) {
    if (matchesRule(cond, rule.when)) {
      return { kind: rule.then } as FileState;
    }
  }
  throw new Error(`No rule matched: ${JSON.stringify(cond)}`);
}

/**
 * Bulk classify: given all paths from cloud + local + metadata,
 * produce a map of path → FileState.
 */
export function classifyAll(
  cloud: ReadonlyMap<string, ClassifyInput['cloud']>,
  local: ReadonlyMap<string, ClassifyInput['local']>,
  meta: ReadonlyMap<string, ClassifyInput['meta']>,
  localHashes: ReadonlyMap<string, ClassifyInput['localHash']>,
): Map<string, FileState> {
  if (cloud == null || local == null || meta == null || localHashes == null) {
    throw new Error('classifyAll: cloud, local, meta, localHashes must not be null');
  }
  const allPaths = new Set([...cloud.keys(), ...local.keys(), ...meta.keys()]);
  const result = new Map<string, FileState>();
  for (const path of allPaths) {
    const input: ClassifyInput = {
      cloud: cloud.get(path) ?? null,
      local: local.get(path) ?? null,
      meta: meta.get(path) ?? null,
      localHash: localHashes.get(path) ?? null,
    };
    result.set(path, classify(input));
  }
  return result;
}
