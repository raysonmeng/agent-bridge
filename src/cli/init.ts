import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliInvocationName } from "../cli-invocation";
import { ConfigService } from "../config-service";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { findPackageRoot, registerMarketplace } from "./pkg-root";
import { isInsideRepoCheckout, MARKETPLACE_STEPS } from "./plugin-cache";
import { upsertMarkedSection } from "../marker-section";
import { compareVersions } from "../version-utils";
import {
  MARKER_ID,
  CLAUDE_MD_SECTION,
  AGENTS_MD_SECTION,
} from "../collaboration-content";

const MIN_CLAUDE_VERSION = "2.1.80";

/**
 * Result of a single dependency probe. Mirrors doctor's DoctorCheck so the two
 * surfaces read the same way (check line + ↳ hint) for the first-run journey.
 *
 * - "ok"   → present and acceptable
 * - "warn" → absent but NOT fatal (the second agent can be installed later)
 * - "fail" → absent/too-old and fatal (a hard prerequisite for init to succeed)
 */
export interface DepCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** Actionable next step for a non-OK check (install URL / upgrade command). */
  hint?: string;
}

export async function runInit(args: string[] = []) {
  console.log("AgentBridge Init\n");
  const cli = cliInvocationName();
  const injectDocs = args.includes("--inject-docs");

  // Step 1: Check dependencies. Collect ALL results first, then report them
  // together — the old flow exited on the FIRST missing dep, so a user missing
  // both claude and codex only ever saw the claude error and fixed things one
  // round-trip at a time. We now check all three, print a doctor-style summary,
  // and only THEN decide whether to abort.
  console.log("Checking dependencies...");
  const depChecks = [checkBun(), checkClaude(), checkCodex()];
  for (const line of formatDepChecks(depChecks, cli)) {
    console.log(line);
  }
  // bun/claude are hard prerequisites (runtime + plugin host); a missing codex
  // is only a WARN — see checkCodex(). Abort only on a real FAIL, after the user
  // has seen the full picture.
  if (depChecks.some((check) => check.status === "fail")) {
    process.exit(1);
  }
  console.log("");

  // Step 2: Generate project config
  console.log("Generating project config...");
  const configService = new ConfigService();
  const created = configService.initDefaults();

  if (created.length > 0) {
    for (const file of created) {
      console.log(`  Created: ${file}`);
    }
  } else {
    console.log("  Project config already exists, skipping.");
  }
  console.log("");

  // Step 3: Collaboration guidance. Runtime delivery is the default — the
  // plugin SessionStart hook (Claude) and the codex proxy's developer contract
  // (Codex) inject guidance only while a bridge is actually running, so the
  // project keeps zero static footprint. --inject-docs preserves the legacy
  // behaviour of writing marker-delimited sections into CLAUDE.md / AGENTS.md
  // (e.g. for agents/tooling that never see the runtime channels); `deinit`
  // removes those sections again.
  if (injectDocs) {
    console.log("Writing collaboration sections (--inject-docs)...");
    const projectRoot = process.cwd();
    const collabResults = writeCollaborationSections(projectRoot);
    for (const result of collabResults) {
      console.log(`  ${result}`);
    }
  } else {
    console.log("Collaboration guidance: delivered at runtime while the bridge is up.");
    console.log(`  CLAUDE.md / AGENTS.md left untouched (use "${cli} init --inject-docs" for static sections,`);
    console.log(`  "${cli} deinit" to remove previously injected ones).`);
  }
  console.log("");

  // Step 4: Register marketplace + install plugin (best-effort)
  console.log("Installing AgentBridge plugin...");
  let pluginInstalled = false;
  try {
    const packageRoot = findPackageRoot();
    registerMarketplace(packageRoot);
    execFileSync("claude", ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], {
      stdio: "inherit",
    });
    console.log("  Plugin installed successfully.");
    pluginInstalled = true;
  } catch {
    // Context-aware fallback: a global npm install (no repo build scripts)
    // cannot use `abg dev`, so point those users at the documented marketplace
    // steps instead. Only inside a repo checkout is `abg dev` the right path.
    // Detect context independently here so a findPackageRoot() failure above
    // (no package.json) is still treated as "not a repo" → marketplace steps.
    console.log("  Plugin install skipped (marketplace registration or install failed).");
    for (const line of pluginInstallFallbackGuidance(detectRepoCheckout(), cli)) {
      console.log(line);
    }
  }
  console.log("");

  // Step 5: Done — be honest about a failed plugin install instead of faking
  // success, and surface it to the shell via a non-zero exit code.
  if (pluginInstalled) {
    console.log("Setup complete!\n");
  } else {
    console.log("Setup incomplete — plugin not installed.\n");
    process.exitCode = 1;
  }
  console.log("Next steps:");
  console.log("  1. If Claude Code is already running, execute /reload-plugins in your session");
  console.log(`  2. Start Claude Code:  ${cli} claude`);
  console.log(`  3. Start Codex TUI:    ${cli} codex`);
}

/**
 * Best-effort repo-vs-npm-global detection for the failure fallback. If the
 * package root cannot be resolved at all (no package.json), treat it as a
 * non-repo install so the user gets the recoverable marketplace steps.
 */
function detectRepoCheckout(): boolean {
  try {
    return isInsideRepoCheckout(findPackageRoot());
  } catch {
    return false;
  }
}

/**
 * Guidance lines printed when step-4 plugin install fails. Repo checkouts can
 * recover with `<cli> dev`; global npm installs cannot (the published package
 * ships no build scripts), so those users get the README marketplace steps.
 * Pure + exported for unit testing.
 *
 * @param cli the resolved invocation name; defaults to cliInvocationName().
 */
export function pluginInstallFallbackGuidance(
  insideRepo: boolean,
  cli: string = cliInvocationName(),
): string[] {
  if (insideRepo) {
    return [
      "  You can install it later with:",
      `    ${cli} dev   # registers marketplace and installs plugin`,
    ];
  }
  return [
    "  Install the plugin from Claude Code with these steps:",
    ...MARKETPLACE_STEPS.map((step) => `    ${step}`),
  ];
}

/**
 * Render dependency checks in doctor's "check line + ↳ hint" style, then a
 * closing line that links the first-run journey to diagnostics. Pure (no I/O)
 * so the exact shape is unit-testable.
 *
 * Format matches formatDoctorReport: `STATUS name: detail`, with a `     ↳ hint`
 * line under any non-OK check.
 */
export function formatDepChecks(checks: DepCheck[], cli: string): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`  ${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.detail}`);
    if ((check.status === "warn" || check.status === "fail") && check.hint) {
      lines.push(`       ↳ ${check.hint}`);
    }
  }
  // Tie the first-run journey to ongoing diagnostics: after install, `doctor`
  // is where the user verifies env/daemon/build health.
  lines.push(`  验证安装: ${cli} doctor`);
  return lines;
}

/** bun is the runtime — its absence is fatal. */
function checkBun(): DepCheck {
  try {
    const version = execSync("bun --version", { encoding: "utf-8" }).trim();
    return { name: "bun", status: "ok", detail: version };
  } catch {
    return {
      name: "bun",
      status: "fail",
      detail: "not found in PATH",
      hint: "Install Bun: https://bun.sh",
    };
  }
}

/** claude hosts the plugin and is the primary agent — absence/too-old is fatal. */
function checkClaude(): DepCheck {
  let versionOutput: string;
  try {
    versionOutput = execSync("claude --version", { encoding: "utf-8" }).trim();
  } catch {
    return {
      name: "claude",
      status: "fail",
      detail: "not found in PATH",
      hint: "Install Claude Code: npm install -g @anthropic-ai/claude-code",
    };
  }
  // Extract version number (may be in format "claude v2.1.80" or just "2.1.80").
  const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
  if (!match) {
    return { name: "claude", status: "ok", detail: `${versionOutput} (version check skipped)` };
  }
  const version = match[1]!;
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    return {
      name: "claude",
      status: "fail",
      detail: `${version} is too old (channels require >= ${MIN_CLAUDE_VERSION})`,
      hint: "Update: npm update -g @anthropic-ai/claude-code",
    };
  }
  return { name: "claude", status: "ok", detail: version };
}

/**
 * codex is the SECOND agent. A user may legitimately set up the Claude side
 * first and install/connect Codex later, so a missing codex is a non-fatal
 * WARN: init still installs the plugin, writes config, and completes. The old
 * flow hard-exited here, which blocked the entire setup over an optional-at-init
 * dependency — `agentbridge codex` will surface the same hint when actually used.
 */
function checkCodex(): DepCheck {
  try {
    const version = execSync("codex --version", { encoding: "utf-8" }).trim();
    return { name: "codex", status: "ok", detail: version };
  } catch {
    return {
      name: "codex",
      status: "warn",
      detail: "not found in PATH (the Codex side will be unavailable until installed)",
      hint: "Install Codex when you want to pair: https://github.com/openai/codex",
    };
  }
}

/**
 * Write or update AgentBridge collaboration sections in CLAUDE.md and AGENTS.md.
 * Returns human-readable status lines for each file.
 */
export function writeCollaborationSections(projectRoot: string): string[] {
  const results: string[] = [];

  const files: Array<{ name: string; path: string; section: string }> = [
    { name: "CLAUDE.md", path: join(projectRoot, "CLAUDE.md"), section: CLAUDE_MD_SECTION },
    { name: "AGENTS.md", path: join(projectRoot, "AGENTS.md"), section: AGENTS_MD_SECTION },
  ];

  for (const { name, path, section } of files) {
    let existing = "";
    try {
      existing = readFileSync(path, "utf-8");
    } catch {
      // File doesn't exist — will be created
    }

    let updated: string;
    try {
      updated = upsertMarkedSection(existing, MARKER_ID, section);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`${name}: skipped — ${msg}`);
      continue;
    }

    if (updated === existing) {
      results.push(`${name}: unchanged (section already up to date)`);
      continue;
    }

    writeFileSync(path, updated, "utf-8");
    if (existing === "") {
      results.push(`${name}: created with collaboration section`);
    } else if (existing.includes(`<!-- ${MARKER_ID}:start -->`)) {
      results.push(`${name}: updated collaboration section`);
    } else {
      results.push(`${name}: appended collaboration section`);
    }
  }

  return results;
}

export { compareVersions };
