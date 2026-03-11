/**
 * Types for directory listing API (DirBrowser / getDirInfoById).
 * Shared by api and scan so YoudaoNoteApi.getDirInfoById can be typed compatible with DirBrowser.
 */
export interface DirFileEntry {
  id: string;
  name: string;
  dir?: boolean;
  size?: number;
  modifyTimeForSort?: number;
  createTimeForSort?: number;
  domain?: number;
}

export interface DirInfoByIdResponse {
  entries?: { fileEntry: DirFileEntry }[];
  count?: number;
}
