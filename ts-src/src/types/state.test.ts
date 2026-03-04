import { describe, expect, it } from 'vitest';
import { stateToAction } from './state.js';
import type { FileState, SyncAction } from './state.js';

describe('stateToAction', () => {
  const cases: [FileState['kind'], SyncAction][] = [
    ['synced', 'skip'],
    ['cloudModifiedMtimeOnly', 'skip'],
    ['bothModifiedConverged', 'skip'],
    ['localDeleted', 'skip'],
    ['cloudDeleted', 'skip'],
    ['gone', 'skip'],
    ['localNew', 'upload'],
    ['localModified', 'upload'],
    ['cloudDeletedLocalModified', 'upload'],
    ['cloudNew', 'download'],
    ['cloudModifiedContent', 'download'],
    ['localDeletedCloudModified', 'download'],
    ['conflict', 'conflict'],
    ['moved', 'move'],
  ];

  for (const [kind, expected] of cases) {
    it(`${kind} → ${expected}`, () => {
      const raw = kind === 'moved' ? { kind: 'moved' as const, oldPath: '/old' } : { kind };
      const state = raw as FileState;
      expect(stateToAction(state)).toBe(expected);
    });
  }
});
