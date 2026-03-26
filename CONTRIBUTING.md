# Contributing

Thanks for contributing to AgentBridge.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.80+
- [Codex CLI](https://github.com/openai/codex)

## Setup

```bash
bun install
bun link    # Makes the 'agentbridge' command available globally
```

### For local development

Use the `dev` command to register a local plugin marketplace and sync plugin files to the Claude Code cache:

```bash
agentbridge dev     # Register local marketplace + sync plugin
agentbridge claude  # Start Claude Code with plugin auto-loaded
```

After changing plugin or runtime code, run `agentbridge dev` again and restart Claude Code (or `/reload-plugins` in an active session).

## Development Workflow

1. Create a focused branch for one change (`feat/xxx`, `fix/xxx`, `docs/xxx`).
2. Make the smallest coherent change that solves the problem.
3. Update documentation when behavior, setup, or limitations change.
4. Run validation locally before opening a pull request.
5. All PRs target `master` and use squash merge.

## Validation

Run these commands before submitting a PR:

```bash
bun run typecheck    # TypeScript type checking
bun test src/        # Unit + E2E tests
```

Both must pass. If your change affects the local bridge flow, add manual reproduction steps in the PR description.

## Testing

- **Unit tests**: Co-located with source files (`*.test.ts`)
- **E2E tests**: `src/e2e-cli.test.ts` (CLI surface), `src/e2e-reconnect.test.ts` (daemon reconnect)
- E2E tests use isolated harnesses with temporary directories, reserved ports, and shim binaries
- All tests run with `bun test src/`

## Pull Requests

- Keep PRs small and scoped to one problem.
- Never push directly to `master` -- always use feature/fix branches + PR.
- Explain the user-visible change and the reason for it.
- Include validation results from `bun run typecheck` and `bun test src/`.
- Link related issues when applicable.
- Update `README.md` and `README.zh-CN.md` together when setup or usage changes.

## Code Style

- Use TypeScript with strict typing.
- Prefer small, explicit functions over broad refactors.
- Preserve the current architecture unless the PR is intentionally structural.
- Avoid committing local machine config, secrets, logs, or generated noise.
- Keep comments short and only where they add real context.
- Use `execFileSync` (array form) instead of `execSync` (string form) to avoid shell injection.
