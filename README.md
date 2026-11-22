# handoffpack

Zero-dependency Node 24 ESM CLI to build structured Git repository handoff prompts across Codex, Antigravity, and Claude, and verify post-handoff repository state.

## Features

- **`handoffpack build`**: Inspects a Git repository (`branch`, `HEAD` SHA, recent commits, `git status --short`, `git diff --stat`, modified/untracked files, and `package.json` scripts) and generates a copy-paste Markdown or `--json` handoff prompt with Windows `.cmd` verification commands and workspace guardrails.
- **`handoffpack verify`**: Checks post-handoff working tree cleanliness (`--expect-clean`) and runs a verification command (`--cmd`) inside the repository.

## Requirements

- Node.js 24+
- Git on `PATH`

## Usage

```powershell
# Show CLI help or version
node ./bin/handoffpack.js --help
node ./bin/handoffpack.js --version

# Build a Markdown handoff prompt for Codex, Antigravity, or Claude
node ./bin/handoffpack.js build . --target antigravity --task "Add retry backoff to API client"

# Write handoff prompt to a file or emit JSON
node ./bin/handoffpack.js build "D:\Codex\Projects\my-app" --target claude --out handoff.md
node ./bin/handoffpack.js build . --json

# Verify clean working tree and test suite after handoff
node ./bin/handoffpack.js verify . --expect-clean --cmd "npm.cmd test" --json
```

## Development and Testing (Windows PowerShell)

Use `npm.cmd` in Windows PowerShell to avoid `.ps1` execution policy blocks:

```powershell
node --test
npm.cmd test
```

## License

MIT
