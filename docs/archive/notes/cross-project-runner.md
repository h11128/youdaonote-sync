# Cross-Project Runner Framework

> **Archived.** This describes a Cursor multi-project helper, not required to install or use youdaonote-sync.  
> For the product itself, see the root [README](../../../README.md).

A lightweight framework for invoking local project commands from any Cursor workspace via AI conversation.

## Architecture

```
~/.cursor/
├── project-index.json              # Registry: project paths + available commands
└── skills/
    ├── project-runner/SKILL.md     # Generic: run any registered project's command
    └── youdao-sync/SKILL.md        # Specialized: youdao sync with domain knowledge
```

### Data Flow

```
User (in any project): "帮我同步有道笔记"
  → AI matches skill description → loads youdao-sync/SKILL.md
  → Skill instructs: read ~/.cursor/project-index.json
  → Resolve: <absolute-path-to>/youdaonote-sync/ts-src
  → Shell: cd {path} && npx youdaonote-sync sync
  → Parse output, report stats
```

## Components

### 1. Project Registry (`~/.cursor/project-index.json`)

Central index of all callable projects. Each entry contains:

| Field | Purpose |
|---|---|
| `path` | Absolute path to project root |
| `working_dir` | Subdirectory to cd into before executing |
| `description` | Human-readable description (used for fuzzy matching) |
| `commands` | Map of command name → {cmd, description, variants} |
| `prerequisites` | check command + setup command for first-time use |

### 2. Global Skills (`~/.cursor/skills/`)

Two tiers:

- **`project-runner`**: Generic skill. Reads registry, resolves path, executes command. Works for any registered project without writing a dedicated skill.
- **`<project-name>`**: Specialized skill with domain knowledge (output parsing, error recovery, variant mapping). Write one when the project has complex interaction patterns.

### 3. Execution Model

All execution goes through the Shell tool with absolute paths. No special plugins or MCP servers needed.

## How to Register a New Project

1. Edit `~/.cursor/project-index.json`
2. Add an entry under `projects`:

```json
"my-project": {
  "path": "/absolute/path/to/my-project",
  "working_dir": ".",
  "description": "What this project does",
  "commands": {
    "default-action": {
      "cmd": "npm start",
      "description": "Run the main action"
    }
  },
  "prerequisites": {
    "check": "test -d /absolute/path/to/my-project/node_modules",
    "setup": "cd /absolute/path/to/my-project && npm install"
  }
}
```

3. (Optional) Create a dedicated skill at `~/.cursor/skills/my-project/SKILL.md` if the project needs specialized handling.


## Design Decisions

### Why Global Skills instead of MCP?

- MCP servers require a running process and configuration per workspace
- Global skills are just markdown files — zero runtime overhead, instant availability
- Shell execution with absolute paths already works cross-project

### Why a separate registry file instead of embedding paths in skills?

- Single source of truth for paths (change once if project moves)
- Skills stay portable and path-independent
- Registry can be programmatically updated

### When to write a dedicated skill vs. using project-runner?

| Scenario | Use |
|---|---|
| Simple "run this command" | `project-runner` is sufficient |
| Output needs parsing (stats, errors) | Dedicated skill |
| Multiple related commands with domain logic | Dedicated skill |
| Non-obvious error recovery | Dedicated skill |

## Limitations

- AI skill matching depends on description keywords — write comprehensive trigger terms
- Authentication/login cannot be automated from a remote workspace (browser popup needed)
- Long-running commands (>2min) need appropriate `block_until_ms` settings
- The project must already be set up locally (git clone + npm install + build)
