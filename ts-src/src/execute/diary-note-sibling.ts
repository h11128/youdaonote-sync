import { officialAppName } from '../scan/cloud-identity.js';

/** Local `.md` maps to official-app `.note` (Youdao hides extensions). */
export function noteSiblingName(localName: string): string | null {
  return officialAppName(localName);
}

/** @deprecated use noteSiblingName */
export function diaryNoteSiblingName(localName: string): string | null {
  return noteSiblingName(localName);
}

export function findNamedFileId(
  entries: readonly { name: string; id: string }[],
  name: string,
): string | undefined {
  return entries.find((e) => e.name === name)?.id;
}

export async function bindDiaryNoteTarget(opts: {
  listParent: () => Promise<readonly { name: string; id: string }[]>;
  name: string;
  fileId: string;
  isCreate: boolean;
  needsNote: boolean;
}): Promise<{ name: string; fileId: string; isCreate: boolean; needsNote: boolean }> {
  const unchanged = {
    name: opts.name,
    fileId: opts.fileId,
    isCreate: opts.isCreate,
    needsNote: opts.needsNote,
  };
  const noteName = noteSiblingName(opts.name);
  if (!noteName) return unchanged;
  if (!opts.isCreate && opts.needsNote) {
    return { ...unchanged, name: noteName, needsNote: true };
  }
  const sib = findNamedFileId(await opts.listParent(), noteName);
  if (!sib) return unchanged;
  return { name: noteName, fileId: sib, isCreate: false, needsNote: true };
}
