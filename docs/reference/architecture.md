# Architecture

Current runtime architecture for youdaonote-sync (TypeScript).  
User setup: [Configuration guide](../guides/configuration.md) · [README](../../README.md).

## Component overview

```mermaid
flowchart TB
  subgraph cli [CLI / GUI]
    Bin["bin.ts"]
    Cmds["sync / watch / login / diagnose / gui / migrate"]
    ConfigCli["config path / doctor"]
  end

  subgraph sot [Config SOT — one directory]
    Cfg["config.json"]
    Cookies["cookies.json"]
    MetaDb["sync_metadata.db"]
  end

  subgraph engine [SyncEngine]
    Lock["SyncLock"]
    Scan["scan cloud + local"]
    Classify["classify + moves + refine"]
    Guard["guardrails"]
    Exec["execute upload/download/move"]
    Post["dedup / GC / git"]
  end

  Cloud["Youdao Note API"]
  Notes["local_dir Markdown tree"]

  Bin --> Cmds
  Bin --> ConfigCli
  Cmds --> sot
  ConfigCli --> sot
  Cmds --> engine
  Scan --> Cloud
  Scan --> Notes
  Exec --> Cloud
  Exec --> Notes
  Exec --> MetaDb
  Guard --> Cfg
```

## End-to-end sync sequence

```mermaid
sequenceDiagram
  participant U as User
  participant CLI as CLI
  participant SOT as Config SOT
  participant E as SyncEngine
  participant API as Youdao API
  participant FS as local_dir

  U->>CLI: sync [--dry-run]
  CLI->>SOT: assertConfigSot + load config.json
  CLI->>E: sync()
  E->>SOT: loginByCookies
  E->>E: acquire SyncLock
  E->>API: scan cloud (or cache)
  E->>FS: scan local + hashes
  alt empty cloud + non-empty local
    E-->>CLI: aborted empty_cloud_response
  end
  E->>E: classify / moves / refine
  alt deletes > maxDeletesPerSync
    E->>FS: write .local-reports dry-run
    E-->>CLI: suspended delete_threshold
  end
  alt dry-run
    E->>FS: write .local-reports
    E-->>CLI: ok + preview stats
  else execute
    E->>API: upload / download / move / delete
    E->>FS: write files / trash
    E->>SOT: update sync_metadata.db + sync_log
    E->>E: dedup / GC / optional git
    E-->>CLI: ok + stats
  end
```

## Pipeline stages (happy path)

```mermaid
flowchart LR
  A[Login + Lock] --> B[Heal]
  B --> C[Scan]
  C --> D[Calibrate]
  D --> E[Classify]
  E --> F[Moves]
  F --> G[Refine conflicts]
  G --> H[Guardrails]
  H --> I{dry-run?}
  I -->|yes| J[Preview + report]
  I -->|no| K[Execute]
  K --> L[Cleanup + Dedup + Git]
```

## Config SOT resolution

```mermaid
flowchart TD
  Start([CLI start]) --> Env{YOUDAONOTE_CONFIG_DIR set?}
  Env -->|yes| SOT[Use that directory]
  Env -->|no| Plat[Windows APPDATA / Unix ~/.config/youdaonote-sync]
  Plat --> SOT
  SOT --> Dual{repo config/ also has config.json?}
  Dual -->|yes| Fail[Fail: conflict]
  Dual -->|no| OnlyLegacy{only legacy exists?}
  OnlyLegacy -->|yes| Mig[Migrate then retire legacy]
  Mig --> OK[Use SOT]
  OnlyLegacy -->|no| OK
```

## Key modules

| Area | Path |
|------|------|
| Config SOT | [`ts-src/src/util/config-dir.ts`](../../ts-src/src/util/config-dir.ts) |
| CLI | [`ts-src/src/cli/cli.ts`](../../ts-src/src/cli/cli.ts) |
| Engine | [`ts-src/src/engine/engine.ts`](../../ts-src/src/engine/engine.ts) |
| Classify | [`ts-src/src/classify/`](../../ts-src/src/classify/) |
| Execute | [`ts-src/src/execute/`](../../ts-src/src/execute/) |
| Guardrails RFC | [`RFC-007`](../design/rfc-007-deterministic-guardrails.md) |

## Classify logic

The classify stage is a **pure function** (zero I/O). It reads two snapshots + metadata and outputs a `FileState` for each path.

### FileState (14 kinds)

| Kind | Meaning | Action |
|------|---------|--------|
| `synced` | Both sides match | skip |
| `localNew` | File exists locally, never synced | upload |
| `cloudNew` | File exists in cloud, never synced | download |
| `localModified` | Local hash changed, cloud unchanged | upload |
| `cloudModifiedContent` | Cloud mtime changed, local unchanged | download |
| `cloudModifiedMtimeOnly` | Cloud mtime changed but hash identical | skip |
| `bothModifiedConverged` | Both changed but hash converged | skip |
| `conflict` | Both changed, hashes differ | conflict |
| `localDeleted` | Local removed a previously-synced file | skip (or deleteCloud) |
| `cloudDeleted` | Cloud removed a previously-synced file | skip (or deleteLocal) |
| `localDeletedCloudModified` | Local deleted + cloud changed | download |
| `cloudDeletedLocalModified` | Cloud deleted + local changed | upload |
| `moved` | Path changed but hash same | move |
| `gone` | Neither side has it | skip |

### Decision Table (first-match)

Conditions extracted per path:

| Condition | Source |
|-----------|--------|
| `localExists` | local snapshot |
| `cloudExists` | cloud snapshot |
| `previouslySynced` | meta exists with `fileId` and `lastSyncAt > 0` |
| `localHashChanged` | `localHash !== meta.contentHash` (null if no hash) |
| `cloudMtimeChanged` | `cloud.mtime > meta.cloudMtime` when `meta.cloudMtime > 0`; `true` if `meta.cloudMtime === 0`; null if no meta |
| `localMtimeChanged` | `local.mtime > meta.localMtime` when `meta.localMtime > 0`; else true / null |

18 rules cover all input combinations including 2 defensive fallbacks. The engine iterates rules top-down; first match wins. Source: [`conditions.ts`](../../ts-src/src/classify/conditions.ts).

### Three-way hash comparison (Refine stage)

After classify, paths classified as `cloudModifiedContent` or `conflict` download the cloud content hash and re-match against `REFINE_RULES`:

| cloudHash == localHash | localHashChanged | cloudHash == metaHash | Result |
|------------------------|------------------|-----------------------|--------|
| true | false | - | `cloudModifiedMtimeOnly` |
| true | true | - | `bothModifiedConverged` |
| false | false | - | `cloudModifiedContent` |
| false | true | true | `localModified` |
| false | true | false | `conflict` |

Source: [`rules.ts`](../../ts-src/src/classify/rules.ts) `REFINE_RULES`.

### Move detection

Runs after classify, before execute. Four phases ([`moves.ts`](../../ts-src/src/classify/moves.ts)):

1. **fileId** — metadata `fileId` ↔ cloud ID
2. **Same-dir name** — sanitized filenames match in the same directory
3. **Cross-directory (same side)** — content hash + filename among `cloudDeleted`↔`cloudNew` and `localDeleted`↔`localNew`
4. **Cross-side** — `cloudNew`↔`localNew` hash/filename (simultaneous rename on both sides)

Hash source: local disk hash, with metadata `contentHash` as fallback when the local file is gone.

Source: [`ts-src/src/classify/`](../../ts-src/src/classify/) · Design details: [`RFC-006`](../design/rfc-006-typescript-rewrite-design.md)

---

Historical design notes (may be stale): [`RFC-006`](../design/rfc-006-typescript-rewrite-design.md) · [`archive/postmortem/`](../archive/postmortem/).
