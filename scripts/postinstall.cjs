#!/usr/bin/env node

/**
 * postinstall check: verify that Bun is available.
 * This runs after `npm install -g agentbridge` to warn users early
 * rather than letting them hit a cryptic "bun: No such file or directory".
 */

const { execFileSync } = require("child_process");

try {
  const version = execFileSync("bun", ["--version"], { encoding: "utf-8" }).trim();
  console.log(`\x1b[32m✔\x1b[0m AgentBridge: Bun ${version} detected.`);
} catch {
  console.warn(`
\x1b[33m⚠ AgentBridge requires Bun (v1.0+) as its runtime.\x1b[0m

The CLI was installed, but it won't work without Bun.
Install Bun with:

  curl -fsSL https://bun.sh/install | bash

Then restart your terminal and run:

  abg --help
`);
}
