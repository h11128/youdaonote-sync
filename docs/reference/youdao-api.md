# Youdao Note API Reference

Private API used by youdaonote-sync. Captured via Playwright (2026-02); URL templates live in [`ts-src/src/api/constants.ts`](../../ts-src/src/api/constants.ts).

## Authentication

Cookie + CSRF Token — no OAuth required:

- **Cookie**: captured from a logged-in browser session (`npx youdaonote-sync login`)
- **cstk**: CSRF token extracted from the `YNOTE_CSTK` cookie field

Mutating requests pass `cstk` as a URL param (and often also in the body).

## Endpoints

### Push (create / update)

```
POST https://note.youdao.com/yws/api/personal/sync?method=push&cstk={cstk}
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| fileId | string | Yes | `WEB` + 32-char hex for new notes |
| parentId | string | Yes | Parent directory ID |
| name | string | Yes | URL-encoded filename, e.g. `test.md` |
| domain | int | Yes | `0` = rich note (.note), `1` = Markdown (.md) |
| rootVersion | int | Yes | `-1` for new notes |
| dir | bool | No | `true` to create a directory |
| createTime | int | Yes | Unix seconds |
| modifyTime | int | Yes | Unix seconds |
| bodyString | string | Yes | Content (see below) |
| transactionId | string | Yes | Usually same as fileId |
| transactionTime | int | Yes | Unix seconds |
| cstk | string | Yes | CSRF token |

**bodyString** for Markdown (`domain=1`): raw Markdown text, URL-encoded.

**bodyString** for rich notes (`domain=0`): URL-encoded JSON with numbered keys representing document structure, paragraphs (`"5"`), and text blocks (`"7"`).

### Download

```
POST https://note.youdao.com/yws/api/personal/sync?method=download
```

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| fileId | string | Yes | Note ID **or** voice `recordID` (clip binary) |
| version | int | Yes | `-1` = latest |
| convert | bool | No | Format conversion flag; use `false` for `.audio` clip binaries |
| read | bool | No | Used for Markdown |
| cstk | string | Yes | CSRF token |

### Voice notes (`.audio`)

A `.audio` “note” is **JSON metadata** (`version`, `recordList[]` with `recordID` / ASR text / `recordSize`), not the waveform.

- Downloading the note id returns that JSON.
- Each clip is a separate download: same `method=download` with `fileId=<recordID>` and `convert=false` → AAC/ADTS (or ogg) bytes.
- Sync writes metadata to `*.audio` and clips to sibling `*.media/` (skipped by local scan like `attachments/`).

### Get file info

```
POST https://note.youdao.com/yws/api/personal/file/{fileId}?method=getById
```

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| entire | bool | Yes | Full info |
| purge | bool | Yes | Bypass cache |
| cstk | string | Yes | CSRF token |

### Resolve path (root / node)

```
GET/POST https://note.youdao.com/yws/api/personal/file?method=getByPath&keyfrom=web&cstk={cstk}
```

Used to resolve a path (typically `/`) to a file/dir ID — not for listing children. See `ROOT_ID_URL` in `constants.ts`.

### List directory

```
GET https://note.youdao.com/yws/api/personal/file/{dir_id}?method=listPageByParentId&len={page_size}&cstk={cstk}
```

Paged listing by parent ID (`DIR_MES_URL`). Optional `startIndex` for subsequent pages. Implementation: [`api/dir.ts`](../../ts-src/src/api/dir.ts).

### Delete

```
POST https://note.youdao.com/yws/api/personal/file/{file_id}?method=delete&keyfrom=web&cstk={cstk}
```

Used when `--propagate-deletes` is on (`DELETE_URL` → `deleteFile`).

### Directory listing size is not emptiness

`getDirInfoById` / folder list often reports `size=0` for rich `.note` files that still have full JSON bodies. The official Youdao app displays `.note`. **Never delete a `.note` because the listing size is 0.** Fetch with `getFileById` and check actual bytes (and JSON children) first. Incident: [2026-08-12-note-listing-size-zero](../postmortem/2026-08-12-note-listing-size-zero.md).

### Rename

Uses `method=push` with URL params including `name`, `fileId`, plus `domain` / `modifyTime` / `transactionId` / `editorVersion` / `keyfrom` as needed. Body still carries `cstk`. See [`file-api.ts`](../../ts-src/src/api/file-api.ts).

## File ID generation

New notes: `'WEB' + crypto.randomUUID().replace(/-/g, '')` → 35 chars total.

## Analytics / client params

Push, download, and related URL templates in `constants.ts` include fixed client/analytics query params (`_system`, `_appName=ynote`, `_platform=web`, `keyfrom=web`, etc.). Treat them as part of the captured request shape; do not assume they are optional for every endpoint.

## See also

- [Configuration guide](../guides/configuration.md) — setup cookies and config
- Historical analysis: [`2026-02-14-api-analysis.md`](../archive/postmortem/2026-02-14-api-analysis.md)
