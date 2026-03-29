import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Walk up from the current module's directory until we find package.json.
 * Works both in source (src/cli/) and after bundling (dist/).
 */
export function findPackageRoot(): string {
  let dir = import.meta.dir;
  while (true) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not find package.json in any parent directory");
    }
    dir = parent;
  }
}

/**
 * Register a marketplace with Claude Code. Idempotent — safe to call
 * even if already registered. Throws on failure.
 */
export function registerMarketplace(marketplaceRoot: string): void {
  execFileSync("claude", ["plugin", "marketplace", "add", marketplaceRoot], {
    stdio: "inherit",
  });
}
