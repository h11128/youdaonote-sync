/** Path helpers for Youdao voice-note sidecar clip directories (`foo.audio` → `foo.media/`). */

/** Directory next to `foo.audio` for clip binaries: `foo.media/`. */
export function audioMediaDir(audioPath: string): string {
  if (audioPath.toLowerCase().endsWith('.audio')) {
    return audioPath.slice(0, -'.audio'.length) + '.media';
  }
  return audioPath + '.media';
}

/** True for local scan skip: any directory name ending in `.media`. */
export function isAudioMediaDirName(name: string): boolean {
  return name.endsWith('.media');
}
