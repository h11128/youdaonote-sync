/** Same-stem diary `.md` + `.note` on Youdao: App hides extensions → two titles. */

export const DIARY_MD_RE = /^(\d{4}年\d{1,2}月\d{1,2}日)\.md$/;

export function diaryNoteSiblingName(localName: string): string | null {
  const m = DIARY_MD_RE.exec(localName);
  return m ? `${m[1]}.note` : null;
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
  const noteName = diaryNoteSiblingName(opts.name);
  if (!noteName) return unchanged;
  const sib = findNamedFileId(await opts.listParent(), noteName);
  if (!sib) return unchanged;
  return { name: noteName, fileId: sib, isCreate: false, needsNote: true };
}
