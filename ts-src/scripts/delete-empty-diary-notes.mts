/**
 * HARD REFUSE — do not delete Youdao `.note` files by directory listing size.
 *
 * The official app shows `.note`. The listing API reports size=0 for notes
 * that still have full content (2026-08-12 incident: Aug 7–11 diaries vanished
 * from the app after a size===0 delete).
 *
 * Inspect with: npx tsx scripts/inspect-diary-notes.mts
 * Restore with: npx tsx scripts/restore-diary-notes-from-md.mts YYYY-MM-DD
 */
console.error(
  'REFUSED: do not delete .note by listing size. Youdao reports 0 B for notes that have content.',
);
console.error('Inspect: npx tsx scripts/inspect-diary-notes.mts');
console.error('Restore: npx tsx scripts/restore-diary-notes-from-md.mts YYYY-MM-DD');
console.error('See docs/postmortem/2026-08-12-note-listing-size-zero.md');
process.exit(2);
