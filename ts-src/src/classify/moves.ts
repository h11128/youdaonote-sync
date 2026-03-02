import type { ContentHash } from '../types/common.js';
import type { FileState } from '../types/state.js';

interface ClassifiedEntry {
  readonly state: FileState;
  readonly hash: ContentHash | null;
}

/**
 * Detect file moves by matching content hashes between "deleted on one side"
 * and "new on the other side" entries.
 *
 * A move is detected when:
 *   - One path is cloudDeleted (local exists) and another is cloudNew (local doesn't exist),
 *     with matching content hashes → the file was renamed/moved in the cloud
 *   - One path is localDeleted (cloud exists) and another is localNew (cloud doesn't exist),
 *     with matching content hashes → the file was renamed/moved locally
 *
 * Pure hash matching, no filename similarity heuristics.
 */
export function detectMoves(
  classified: ReadonlyMap<string, ClassifiedEntry>,
): Map<string, FileState> {
  const result = new Map<string, FileState>();

  const cloudDeletedByHash = new Map<ContentHash, string[]>();
  const cloudNewByHash = new Map<ContentHash, string[]>();
  const localDeletedByHash = new Map<ContentHash, string[]>();
  const localNewByHash = new Map<ContentHash, string[]>();

  for (const [path, entry] of classified) {
    if (!entry.hash) continue;
    switch (entry.state.kind) {
      case 'cloudDeleted':
        pushToMap(cloudDeletedByHash, entry.hash, path);
        break;
      case 'cloudNew':
        pushToMap(cloudNewByHash, entry.hash, path);
        break;
      case 'localDeleted':
        pushToMap(localDeletedByHash, entry.hash, path);
        break;
      case 'localNew':
        pushToMap(localNewByHash, entry.hash, path);
        break;
    }
  }

  matchPairs(cloudDeletedByHash, cloudNewByHash, result);
  matchPairs(localDeletedByHash, localNewByHash, result);

  return result;
}

function pushToMap(map: Map<ContentHash, string[]>, hash: ContentHash, path: string): void {
  const list = map.get(hash);
  if (list) {
    list.push(path);
  } else {
    map.set(hash, [path]);
  }
}

/**
 * For each hash that appears in both `deleted` and `newEntries`,
 * pair them 1:1 and emit 'moved' states.
 */
function matchPairs(
  deleted: Map<ContentHash, string[]>,
  newEntries: Map<ContentHash, string[]>,
  result: Map<string, FileState>,
): void {
  for (const [hash, deletedPaths] of deleted) {
    const newPaths = newEntries.get(hash);
    if (!newPaths) continue;

    const pairCount = Math.min(deletedPaths.length, newPaths.length);
    for (let i = 0; i < pairCount; i++) {
      const oldPath = deletedPaths[i]!;
      const newPath = newPaths[i]!;
      result.set(newPath, { kind: 'moved', oldPath });
      result.set(oldPath, { kind: 'gone' });
    }
  }
}
