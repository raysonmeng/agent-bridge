import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKER_ID } from "../collaboration-content";
import { removeMarkedSection } from "../marker-section";

/**
 * `abg deinit` — remove the AgentBridge collaboration sections that older
 * versions (or `abg init --inject-docs`) wrote into a project's CLAUDE.md and
 * AGENTS.md.
 *
 * Deliberately narrow: it only strips the marker-delimited blocks. It does NOT
 * touch `.agentbridge/` (project config), the installed plugin, or any running
 * pair — collaboration guidance keeps arriving through the runtime channels
 * (plugin SessionStart hook / codex developer contract) whenever the bridge is
 * actually up.
 */

/**
 * Strip the AgentBridge marked section from CLAUDE.md and AGENTS.md under
 * projectRoot. Returns human-readable status lines (same shape as init's
 * writeCollaborationSections). Pure apart from fs, exported for unit tests.
 */
export function removeCollaborationSections(projectRoot: string): string[] {
  const results: string[] = [];

  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const path = join(projectRoot, name);

    let existing: string;
    try {
      existing = readFileSync(path, "utf-8");
    } catch {
      results.push(`${name}: not found — nothing to remove`);
      continue;
    }

    let outcome: { content: string; removed: boolean };
    try {
      outcome = removeMarkedSection(existing, MARKER_ID);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`${name}: skipped — ${msg}`);
      continue;
    }

    if (!outcome.removed) {
      results.push(`${name}: no AgentBridge section found`);
      continue;
    }

    writeFileSync(path, outcome.content, "utf-8");
    if (outcome.content.trim() === "") {
      results.push(`${name}: section removed (file is now empty — delete the file if you no longer need it)`);
    } else {
      results.push(`${name}: section removed`);
    }
  }

  return results;
}

export async function runDeinit() {
  console.log("AgentBridge Deinit\n");
  console.log("Removing collaboration sections...");
  for (const line of removeCollaborationSections(process.cwd())) {
    console.log(`  ${line}`);
  }
  console.log("");
  console.log("Done. Runtime delivery is unaffected: while a bridge is running,");
  console.log("collaboration guidance still reaches both agents automatically.");
}
