import type { FileState } from '../types/state.js';
import type { Conditions } from './conditions.js';

export interface Rule {
  readonly when: Partial<Conditions>;
  readonly then: FileState['kind'];
}

export const RULES: readonly Rule[] = [
  // Both sides gone (should not happen in practice, defensive)
  { when: { localExists: false, cloudExists: false },
    then: 'gone' },

  // Local only (cloud does not exist)
  { when: { localExists: true, cloudExists: false, previouslySynced: false },
    then: 'localNew' },
  { when: { localExists: true, cloudExists: false, previouslySynced: true, localMtimeChanged: true },
    then: 'cloudDeletedLocalModified' },
  { when: { localExists: true, cloudExists: false, previouslySynced: true, localMtimeChanged: false },
    then: 'cloudDeleted' },
  { when: { localExists: true, cloudExists: false, previouslySynced: true, localMtimeChanged: null },
    then: 'cloudDeleted' },

  // Cloud only (local does not exist)
  { when: { localExists: false, cloudExists: true, previouslySynced: false },
    then: 'cloudNew' },
  { when: { localExists: false, cloudExists: true, previouslySynced: true, cloudMtimeChanged: true },
    then: 'localDeletedCloudModified' },
  { when: { localExists: false, cloudExists: true, previouslySynced: true, cloudMtimeChanged: false },
    then: 'localDeleted' },
  { when: { localExists: false, cloudExists: true, previouslySynced: true, cloudMtimeChanged: null },
    then: 'localDeleted' },

  // Both exist, hash available
  { when: { localExists: true, cloudExists: true, localHashChanged: false, cloudMtimeChanged: false },
    then: 'synced' },
  { when: { localExists: true, cloudExists: true, localHashChanged: false, cloudMtimeChanged: true },
    then: 'cloudModifiedContent' },
  { when: { localExists: true, cloudExists: true, localHashChanged: true, cloudMtimeChanged: false },
    then: 'localModified' },
  { when: { localExists: true, cloudExists: true, localHashChanged: true, cloudMtimeChanged: true },
    then: 'conflict' },

  // Both exist, hash available but no cloud mtime (defensive)
  { when: { localExists: true, cloudExists: true, localHashChanged: false, cloudMtimeChanged: null },
    then: 'synced' },
  { when: { localExists: true, cloudExists: true, localHashChanged: true, cloudMtimeChanged: null },
    then: 'localModified' },

  // Both exist, no hash (first sync / fallback)
  { when: { localExists: true, cloudExists: true, localHashChanged: null, cloudMtimeChanged: false },
    then: 'synced' },
  { when: { localExists: true, cloudExists: true, localHashChanged: null, cloudMtimeChanged: true },
    then: 'cloudModifiedContent' },
  { when: { localExists: true, cloudExists: true, localHashChanged: null, cloudMtimeChanged: null },
    then: 'synced' },
];

export interface RefineConditions {
  readonly cloudHashEqualLocal: boolean;
  readonly localHashChanged: boolean;
  readonly cloudHashEqualMeta: boolean;
}

export const REFINE_RULES: readonly {
  when: Partial<RefineConditions>;
  then: FileState['kind'];
}[] = [
  { when: { cloudHashEqualLocal: true, localHashChanged: false },
    then: 'cloudModifiedMtimeOnly' },
  { when: { cloudHashEqualLocal: true, localHashChanged: true },
    then: 'bothModifiedConverged' },
  { when: { cloudHashEqualLocal: false, cloudHashEqualMeta: true },
    then: 'localModified' },
  { when: { cloudHashEqualLocal: false, cloudHashEqualMeta: false },
    then: 'conflict' },
];
