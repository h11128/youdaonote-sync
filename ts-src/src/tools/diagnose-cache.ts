/**
 * diagnose cache — metadata file_id health summary.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { MetadataStore } from '../metadata/store.js';
import type { DiagnoseConfig } from './diagnose.js';

export function cmdCache(cfg: DiagnoseConfig): void {
  const meta = new MetadataStore(cfg.metadataPath);
  const files = meta.getAllFiles();
  const dirs = meta.getAllDirs();

  let withFileId = 0;
  let withoutFileId = 0;
  let emptyFileIdButLocal = 0;
  let fileIdButCloudMtimeZero = 0;
  let fileIdButNotLocal = 0;

  for (const [path, rec] of files) {
    const hasId = rec.fileId !== '';
    const localExists = existsSync(join(cfg.localDir, path));
    if (hasId) {
      withFileId++;
      if (rec.cloudMtime === 0) fileIdButCloudMtimeZero++;
      if (!localExists) fileIdButNotLocal++;
    } else {
      withoutFileId++;
      if (localExists) emptyFileIdButLocal++;
    }
  }

  console.log('='.repeat(60));
  console.log('  Metadata cache summary');
  console.log('='.repeat(60));
  console.log(`  Total files:           ${files.size}`);
  console.log(`  With file_id:          ${withFileId}`);
  console.log(`  Without file_id:       ${withoutFileId}`);
  console.log(`  empty file_id but local: ${emptyFileIdButLocal}`);
  console.log(`  file_id but cloud_mtime=0: ${fileIdButCloudMtimeZero}`);
  console.log(`  file_id but not local: ${fileIdButNotLocal}`);
  console.log(`  Total directories:     ${dirs.size}`);
  if (emptyFileIdButLocal > 0) {
    console.log(
      `  WARNING: ${emptyFileIdButLocal} local file(s) lack file_id — expect perpetual localNew until calibrate/upload recovery.`,
    );
  }
  meta.close();
}
