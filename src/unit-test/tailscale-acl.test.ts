import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_BROKER_PORT } from "../broker";

const ACL_PATH = fileURLToPath(new URL("../../examples/tailscale-acl.hujson", import.meta.url));

/** Minimal HuJSON (JWCC) → JSON: strip block/line comments + trailing commas, then JSON.parse. */
function parseHujson(src: string): any {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.replace(/\/\/.*$/gm, "");
  const noTrailingComma = noLine.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrailingComma);
}

// Anti-drift guard: the example ACL is what users paste into Tailscale. If its
// port ever diverges from the broker's real listen port again (it once said 4500
// while the broker bound 4700 → ACL silently failed), this fails loudly.
describe("examples/tailscale-acl.hujson — pinned to the broker port", () => {
  const acl = parseHujson(readFileSync(ACL_PATH, "utf-8"));

  test("is valid HuJSON and grants tag:agent → tag:broker on the real broker port", () => {
    expect(Array.isArray(acl.grants)).toBe(true);
    const grant = acl.grants[0];
    expect(grant.src).toEqual(["tag:agent"]);
    expect(grant.dst).toEqual(["tag:broker"]);
    expect(grant.ip).toContain(`tcp:${DEFAULT_BROKER_PORT}`); // pinned to code, not a literal
  });

  test("declares both tags in tagOwners", () => {
    expect(acl.tagOwners).toHaveProperty("tag:broker");
    expect(acl.tagOwners).toHaveProperty("tag:agent");
  });
});
