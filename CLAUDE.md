# Repo Review MCP — Agent Protocol

**Product:** Repo Review MCP
**Direction:** A read-only MCP server designed specifically for AI code review workflows.

`AGENTS.md` is a symlink to this file. Edit only `CLAUDE.md`.

## Non-negotiable boundary

Production code must not modify tracked or untracked files, the Git index,
commits, branches, tags, refs, remotes, worktrees, stashes, or repository
configuration. Do not add dormant mutation code or hide it behind registration.

The exact public tool surface is:

- `review_status`
- `review_diff`
- `review_log`
- `review_changed_file`
- `review_file_at_revision`

No other tools, prompts, or resources may be exposed without an explicit product
decision. All tool annotations must identify these operations as read-only and
closed-world.

The production Git allowlist is defined in
`src/services/git/providers/cli/CliReviewProvider.ts` and may contain only typed,
local, read-only operations needed by the five tools. The provider interface
must never expose a generic command, subcommand, or arbitrary Git argument-array
method. The private runner must reject commands outside the allowlist before
spawning and must use structured argv with `shell: false`.

## Handler architecture

The logic throws; the handler catches.

- Tool logic in `src/mcp-server/tools/definitions/` is pure orchestration. Do
  not add `try/catch` blocks there.
- Failures use `McpError` with a suitable `JsonRpcErrorCode` and structured
  context.
- `createToolHandler` injects the typed `IReviewProvider`.
- `createMcpToolHandler` creates request context, measures execution, formats
  responses, and catches failures.
- OpenTelemetry instrumentation is framework-owned. Do not add spans in tool or
  provider logic.
- Use `logger` with `appContext` or `context.requestContext` on operational log
  calls.
- Authorization remains `withToolAuth(['tool:git:read'], ...)`; development
  without auth uses `appContext.tenantId || 'default-tenant'`.

## Repository selection

Every tool uses the same `repository` selector: a relative path beneath required
`REVIEW_BASE_DIR`.

- `REVIEW_BASE_DIR` must be absolute, exist, and resolve to a directory at
  startup.
- Reject absolute selectors, traversal, symlink escape, and non-repositories.
- Resolve the selected Git working-tree root and ensure its real path remains
  beneath the canonical base directory.
- Return only the relative repository identifier; do not expose sensitive parent
  directories.
- Do not add mutable cross-request working-directory state.

## Revisions, paths, and secrets

Accepted revisions are limited to `HEAD`, `HEAD^`, `HEAD~0..20`,
`origin/<safe-branch-name>`, and hexadecimal commit SHAs of 7–64 characters.
Reject leading options, free-form rev expressions, search/reflog selectors, tags,
and arbitrary flags.

File paths must be repository-relative and traversal-free. Current-file reads
must target the current changed-file set. Reject symlinks, real-path escape,
binary/non-UTF-8 content, `.git`, `.env` variants, key/certificate formats,
credential directories, credential stores, and known secret filenames. Apply
conservative credential-assignment and bearer-token redaction to returned text
and patches.

## Snapshots and limits

Snapshots are deterministic and stateless. Derive `snapshotId` from repository
identity, HEAD, porcelain status, staged and unstaged diffs, and untracked
metadata. If `expectedSnapshotId` differs, throw a structured conflict with
`reason: 'snapshot_changed'`. Recheck state after multi-command reads.

All output is bounded. Keep hard caps in MCP schemas and enforce them in the
provider. Return explicit truncation metadata. Never accept arbitrary Git pretty
formats, flags, or pathspec expressions.

## Directory map

| Directory                           | Purpose                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `src/mcp-server/tools/definitions/` | The five declarative review tools.                              |
| `src/mcp-server/tools/schemas/`     | Shared repository, revision, snapshot, and file-limit schemas.  |
| `src/mcp-server/tools/utils/`       | Handler factory and JSON response formatting.                   |
| `src/services/git/core/`            | `IReviewProvider`, the typed read-only contract.                |
| `src/services/git/providers/cli/`   | Native Git review provider and private allowlisted runner.      |
| `src/mcp-server/transports/`        | STDIO, Streamable HTTP, and auth infrastructure.                |
| `src/container/`                    | Dependency injection composition.                               |
| `src/config/`                       | Validated environment configuration.                            |
| `src/utils/`                        | Logging, context, errors, metrics, telemetry, and sanitization. |
| `tests/`                            | Unit, integration, architecture, and read-only invariant tests. |

## Tool definition checklist

- File name is `review-<operation>.tool.ts`.
- Export one `const` typed as `ToolDefinition`.
- Every input and output field has `.describe()`.
- Input objects are strict.
- Logic uses `createToolHandler` and `withToolAuth`.
- Tool logic contains no `try/catch`.
- Output uses `createJsonFormatter`.
- Tool is registered in `definitions/index.ts` without changing the exact
  five-name surface unless explicitly authorized.

## Validation checklist

Every security-relevant change must preserve or extend tests for:

- exact public tool names;
- fail-closed Git subcommand allowlist;
- absence of shell-interpolated execution;
- traversal, absolute escape, symlink escape, and non-repository rejection;
- secret-path blocking and content redaction;
- binary/non-UTF-8 rejection and byte/line/patch/log caps;
- all six diff scopes, including working-tree untracked content;
- accepted and rejected revisions;
- snapshot changes and expected-snapshot conflicts;
- before/after invariants for files, index, HEAD, refs, tags, remotes, and local
  Git configuration after every public operation.

Run:

```sh
REVIEW_BASE_DIR="$PWD" bun run devcheck --no-fix
REVIEW_BASE_DIR="$PWD" bun test
REVIEW_BASE_DIR="$PWD" bun rebuild
```

Inspect `git diff`, `git status`, the exact tool array, and all remaining
write-oriented terms before handoff. Historical changelog entries and negative
security statements may name removed operations; executable production paths
may not.

## License and attribution

Keep the Apache License 2.0 `LICENSE` file and upstream copyright notices. Do
not remove the README attribution to `cyanheads/git-mcp-server`. Preserve
historical changelog entries as provenance and do not make unsupported legal
claims.
