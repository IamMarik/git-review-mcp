# Repo Review MCP

> A read-only MCP server designed specifically for AI code review workflows.

Repo Review MCP gives an MCP client bounded, local access to repository status,
diffs, history, and selected text files. It intentionally has no tools or
service methods for changing files, the index, commits, refs, remotes,
worktrees, stashes, or repository configuration.

## Public tools

The complete public tool surface is:

| Tool                      | Purpose                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `review_status`           | Report HEAD, branch/upstream state, staged, unstaged, untracked, and conflicted paths plus a snapshot ID.   |
| `review_diff`             | Return a bounded patch for `working`, `staged`, `unstaged`, `last_commit`, `commit`, or `range`.            |
| `review_log`              | Return bounded structured commit summaries.                                                                 |
| `review_changed_file`     | Read one current changed or untracked text file after path, secret, symlink, binary, byte, and line checks. |
| `review_file_at_revision` | Read one text blob from a strictly validated local revision.                                                |

There are no public prompts or resources that direct write workflows.

## What read-only means

Production Git execution is limited to an explicit allowlist:

`status`, `diff`, `log`, `show`, `rev-parse`, `symbolic-ref`, `for-each-ref`,
and `cat-file`.

The provider exposes typed review methods rather than a generic Git command or
argument-array API. Git is spawned with structured argv, `shell: false`,
`GIT_OPTIONAL_LOCKS=0`, and no network-changing command. The production source
contains no implementation for staging, committing, fetching, pushing,
branch/tag/ref mutation, checkout, reset, clean, stash, worktree changes,
initialization, cloning, or Git configuration mutation.

External diff, textconv, filesystem-monitor, and untracked-cache extension
points are disabled for review commands so repository Git configuration cannot
introduce executable helpers or optional index writes.

Structured logs are emitted to process streams only. The production server has
no filesystem-backed log destination or other file-writing API.

This guarantee covers actions initiated by Repo Review MCP. It cannot prevent a
different process or user from changing a repository concurrently, and it does
not make arbitrary source code secret-safe. Users remain responsible for not
placing credentials in reviewable source files.

## Repository selection

`REVIEW_BASE_DIR` is required, must be absolute, and must exist when the server
starts. Every tool accepts the same `repository` selector: a relative path
beneath that base directory. The server resolves real paths, rejects traversal
and symlink escape, and verifies that the selection belongs to a Git working
tree. It does not store or mutate a cross-request working directory.

For example, with:

```text
REVIEW_BASE_DIR=/srv/reviewable
/srv/reviewable/team/api/.git
/srv/reviewable/team/web/.git
```

use `team/api` or `team/web` as the `repository` value. Use `.` when the base
directory itself is the repository.

## Installation and runtime

Node.js 20+ and Bun 1.2+ are supported. This fork is not published as the
upstream npm package; build it from the checked-out repository:

```sh
bun install
bun run build
REVIEW_BASE_DIR=/absolute/path/to/repositories bun run start:stdio
```

The package identity is `@iammarik/repo-review-mcp` and the binary name is
`repo-review-mcp`. No publishing is performed by this repository transformation.

Example MCP client configuration for a local checkout:

```json
{
  "mcpServers": {
    "repo-review-mcp": {
      "command": "bun",
      "args": ["/absolute/path/to/git-review-mcp/dist/index.js"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "REVIEW_BASE_DIR": "/absolute/path/to/repositories",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

For Streamable HTTP, set `MCP_TRANSPORT_TYPE=http`; the default bind address is
`127.0.0.1:3015` with endpoint `/mcp`.

## Safe revisions

Only these forms are accepted:

- `HEAD`
- `HEAD^`
- `HEAD~N`, where `N` is from 0 through 20
- `origin/<safe-branch-name>`
- hexadecimal commit SHAs with at least 7 characters

Leading options, tags, free-form ref expressions, search selectors, reflog
selectors, and arbitrary Git flags are rejected.

## Snapshots and consistency

`review_status` and `review_diff` return a deterministic `snapshotId` derived
from repository identity, HEAD, porcelain status, staged and unstaged diffs,
and untracked path metadata. Tools that accept `expectedSnapshotId` fail with a
structured `snapshot_changed` conflict if the working state drifted. Snapshot
state is recomputed and never persisted.

## Secret, binary, and path protection

Current file reads must target the exact changed-file set. Historical reads use
a validated revision and path. Both readers block `.env` variants, `.git`,
common credential directories, private-key/certificate formats, credential
stores, and known secret filenames. Current-file reads reject symlinks and
real-path escape. Text containing obvious credential assignments or bearer
tokens is redacted conservatively. Binary content is rejected.

Diff output omits content for blocked secret paths and redacts obvious
credential assignments in the remaining patch. This is defense in depth, not a
complete secret scanner.

## Limits and truncation

- Status returns at most 500 paths in each category and reports the total
  unique changed-file count.
- Log defaults to 20 commits and has a hard maximum of 100.
- Patch output defaults to 200,000 bytes and has a hard maximum of 500,000.
- File output defaults to 100,000 bytes and 2,000 lines, with hard maxima of
  500,000 bytes and 10,000 lines.
- Responses include explicit truncation metadata; included arrays are not
  silently shortened except for the documented status/path hard boundary.

## Configuration

| Variable                        | Purpose                                                    | Default     |
| ------------------------------- | ---------------------------------------------------------- | ----------- |
| `REVIEW_BASE_DIR`               | Required absolute base containing reviewable repositories. | none        |
| `REVIEW_MAX_COMMAND_TIMEOUT_MS` | Local read-only Git command timeout.                       | `30000`     |
| `REVIEW_MAX_BUFFER_SIZE_MB`     | Internal Git output buffer ceiling.                        | `10`        |
| `MCP_TRANSPORT_TYPE`            | `stdio` or `http`.                                         | `stdio`     |
| `MCP_HTTP_HOST`                 | HTTP bind host.                                            | `127.0.0.1` |
| `MCP_HTTP_PORT`                 | HTTP bind port.                                            | `3015`      |
| `MCP_AUTH_MODE`                 | `none`, `jwt`, or `oauth`.                                 | `none`      |
| `MCP_LOG_LEVEL`                 | Structured log level.                                      | `debug`     |

The upstream transport, lifecycle, structured error, response formatting,
logging, authentication, rate limiting, telemetry, and test
infrastructure remain available where they do not broaden repository access.

## Development

```sh
REVIEW_BASE_DIR="$PWD" bun run devcheck
REVIEW_BASE_DIR="$PWD" bun test
REVIEW_BASE_DIR="$PWD" bun rebuild
```

See [AGENTS.md](AGENTS.md) for contribution rules.

## Attribution and license

Repo Review MCP was originally forked from
[`cyanheads/git-mcp-server`](https://github.com/cyanheads/git-mcp-server) and
has been substantially narrowed into a read-only repository review product.
Upstream copyright notices and file headers are retained where applicable.

Licensed under the Apache License 2.0. See [LICENSE](LICENSE). The repository did
not contain a separate `NOTICE` file at the time of this fork transformation.
