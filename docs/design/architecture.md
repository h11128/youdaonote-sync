# Architecture

Current runtime architecture for youdaonote-sync (TypeScript).  
User setup: [Configuration guide](../guides/configuration.md) · [README](../../README.md).

## Component overview

```mermaid
flowchart TB
  subgraph cli [CLI / GUI]
    Bin["bin.ts"]
    Cmds["sync / watch / login / diagnose / gui"]
    ConfigCli["config path / doctor / migrate"]
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
| Guardrails RFC | [`RFC-001`](../rfc/RFC-001-deterministic-guardrails.md) |

Historical design notes (may be stale): [`archive/design/typescript-rewrite-design.md`](../archive/design/typescript-rewrite-design.md) · [`archive/`](../archive/).
