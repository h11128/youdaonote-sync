---
name: pre-commit-review
description: >-
  Self-review checklist to run after implementing a feature and before requesting
  code review. Catches common defects early: DRY violations, magic numbers,
  oversized tuples, dependency direction, data flow integrity, caller coverage,
  constant naming conflicts. Use when: implementation done, ready for review,
  pre-commit check, self-review, before requesting CR.
---

# Pre-Commit Self-Review

Run this checklist after finishing implementation, before asking for code review.
Goal: catch the defects that historically survive into review rounds.

## Step 1 — Determine Scope

```bash
git diff --name-only          # unstaged changes
git diff --cached --name-only # staged changes
```

Collect the union of both lists. These are the files to check.

## Step 2 — Run Checks

For each dimension below, scan ALL changed files. Report results using
✅ (pass) or ❌ (fail + details).

---

### 2.1 DRY — No Duplicated Logic

**What to check**: any block of ≥3 consecutive lines that appears more than once.

**How**:
1. Within each changed file, look for repeated blocks.
2. For each non-trivial new function, grep the project for similar logic:
   ```bash
   rg -n "key_expression_from_new_code" --type rust
   ```
3. If a match exists elsewhere, extract to a shared function.

**Output**: ✅ No duplication found / ❌ `file_a.rs:10-15` duplicates `file_b.rs:42-47`

---

### 2.2 Magic Numbers

**What to check**: numeric literals other than 0, 1, -1, 100 in logic
(array indices and test assertions are exempt).

**How**: scan changed lines for bare numbers. Each should be a named constant
with a comment explaining its meaning.

**Output**: ✅ No magic numbers / ❌ `file.rs:30` uses literal `86400` → extract as `SECONDS_PER_DAY`

---

### 2.3 Return Type Size

**What to check**: any function returning a tuple with >2 elements.

**How**: search changed files for `-> (` patterns with 3+ commas (Rust), or
`return` statements with 3+ values (Python).

**Output**: ✅ All returns ≤2 elements / ❌ `file.rs:50` returns 4-tuple → convert to struct

---

### 2.4 Dependency Direction

**What to check**: new functions should not reach across module boundaries to
call concrete implementations from unrelated modules.

**How**: for each new `use`/`import` statement, verify the imported module is
either:
- In the same module or a child module
- A shared/common module
- An explicit dependency passed as a parameter

**Output**: ✅ Dependencies follow direction / ❌ `engine.rs` imports from `ui::renderer` directly

---

### 2.5 Data Flow Integrity

**What to check**: values must flow from source-of-truth forward, never
reconstructed from derived/lossy intermediates.

**Red flags**:
- Converting float percentage back to integer count
- Parsing a formatted string to recover the original value
- Deriving a primary key from a display name

**How**: trace each new computation — where does its input come from? If it
comes from a formatted/derived value, flag it.

**Output**: ✅ Data flows from source / ❌ `stats.rs:22` reconstructs `correct_count` from `accuracy` float

---

### 2.6 Caller Completeness

**What to check**: every modified or deleted function signature must have ALL
callers updated.

**How**:
```bash
# For each changed function name:
rg -n "function_name" --type rust
```

Compare the caller list against the changes. Any caller NOT in the diff is
a potential breakage.

**Output**: ✅ All callers updated / ❌ `main.rs:88` still calls old signature of `calculate()`

---

### 2.7 Constant Naming Conflicts

**What to check**: before adding a new constant, verify no existing constant
has the same name or serves the same purpose.

**How**:
```bash
rg -n "const NEW_CONSTANT_NAME" --type rust
rg -n "NEW_CONSTANT_NAME" --type rust
```

**Output**: ✅ No conflicts / ❌ `constants.rs:5` already defines `MAX_RETRIES`

---

## Step 3 — Output Summary

```
## Pre-Commit Self-Review

Files checked: N

| #   | Dimension              | Status | Details          |
|-----|------------------------|--------|------------------|
| 2.1 | DRY                    | ✅/❌  |                  |
| 2.2 | Magic numbers          | ✅/❌  |                  |
| 2.3 | Return type size       | ✅/❌  |                  |
| 2.4 | Dependency direction   | ✅/❌  |                  |
| 2.5 | Data flow integrity    | ✅/❌  |                  |
| 2.6 | Caller completeness    | ✅/❌  |                  |
| 2.7 | Constant naming        | ✅/❌  |                  |

Issues found: N (fix before requesting review)
```

If all checks pass, the code is ready for formal review.
If any check fails, fix the issue and re-run the failed check before proceeding.
