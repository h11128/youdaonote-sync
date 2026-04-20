import type { RelPath } from './common.js';

export type FileState =
  | { readonly kind: 'synced' }
  | { readonly kind: 'localNew' }
  | { readonly kind: 'cloudNew' }
  | { readonly kind: 'localDeleted' }
  | { readonly kind: 'localDeletedCloudModified' }
  | { readonly kind: 'cloudDeleted' }
  | { readonly kind: 'cloudDeletedLocalModified' }
  | { readonly kind: 'localModified' }
  | { readonly kind: 'cloudModifiedContent' }
  | { readonly kind: 'cloudModifiedMtimeOnly' }
  | { readonly kind: 'bothModifiedConverged' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'moved'; readonly oldPath: RelPath }
  | { readonly kind: 'gone' };

export interface SyncLogMetadata {
  readonly decisionReason?: string;
  readonly policyVersion?: string;
  readonly guardrailChecks?: string;
}

export type SyncAction =
  | 'skip'
  | 'upload'
  | 'download'
  | 'conflict'
  | 'move'
  | 'deleteCloud'
  | 'deleteLocal';

export function stateToAction(state: FileState): SyncAction {
  switch (state.kind) {
    case 'synced':
    case 'cloudModifiedMtimeOnly':
    case 'bothModifiedConverged':
    case 'localDeleted':
    case 'cloudDeleted':
    case 'gone':
      return 'skip';
    case 'localNew':
    case 'localModified':
    case 'cloudDeletedLocalModified':
      return 'upload';
    case 'cloudNew':
    case 'cloudModifiedContent':
    case 'localDeletedCloudModified':
      return 'download';
    case 'conflict':
      return 'conflict';
    case 'moved':
      return 'move';
    default: {
      const _: never = state;
      throw new Error(`Unhandled state: ${JSON.stringify(_)}`);
    }
  }
}
