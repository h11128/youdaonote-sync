import { describe, expect, it } from 'vitest';
import { stateToAction } from './state.js';
import type { FileState, SyncAction } from './state.js';

describe('stateToAction', () => {
  const cases: Array<[FileState['kind'], SyncAction]> = [
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
      const state = kind === 'moved'
        ? { kind: 'moved' as const, oldPath: '/old' }
        : { kind } as FileState;
      expect(stateToAction(state)).toBe(expected);
    });
  }
});
