import { describe, expect, test } from "bun:test";
import {
  AGY_MAX_PERMISSION_SUPPRESSORS,
  CLAUDE_MAX_PERMISSION_SUPPRESSORS,
  CODEX_MAX_PERMISSION_SUPPRESSORS,
  planMaxPermissions,
} from "../cli/max-permissions";

describe("planMaxPermissions", () => {
  test("agy defaults to skip permissions, respects safe and native restrictions", () => {
    expect(planMaxPermissions([], AGY_MAX_PERMISSION_SUPPRESSORS, {}).inject).toBe(true);
    expect(planMaxPermissions(["--safe"], AGY_MAX_PERMISSION_SUPPRESSORS, {})).toEqual({ args: [], inject: false, safeMode: true });
    expect(planMaxPermissions([], AGY_MAX_PERMISSION_SUPPRESSORS, { AGENTBRIDGE_SAFE: "1" }).inject).toBe(false);
    for (const args of [["--dangerously-skip-permissions"], ["--dangerously-skip-permissions=false"], ["--mode", "plan"], ["--mode=accept-edits"], ["--sandbox"]]) {
      const plan = planMaxPermissions(args, AGY_MAX_PERMISSION_SUPPRESSORS, {});
      expect(plan.inject).toBe(false);
      expect(plan.args).toEqual(args);
    }
  });
  test("injects by default and passes args through", () => {
    const plan = planMaxPermissions(["--resume", "abc"], CLAUDE_MAX_PERMISSION_SUPPRESSORS, {});
    expect(plan.inject).toBe(true);
    expect(plan.safeMode).toBe(false);
    expect(plan.args).toEqual(["--resume", "abc"]);
  });

  test("--safe disables injection and is stripped from the forwarded args", () => {
    const plan = planMaxPermissions(["--safe", "--resume", "abc"], CLAUDE_MAX_PERMISSION_SUPPRESSORS, {});
    expect(plan.inject).toBe(false);
    expect(plan.safeMode).toBe(true);
    expect(plan.args).toEqual(["--resume", "abc"]);
  });

  test("AGENTBRIDGE_SAFE=1 disables injection", () => {
    const plan = planMaxPermissions([], CLAUDE_MAX_PERMISSION_SUPPRESSORS, { AGENTBRIDGE_SAFE: "1" });
    expect(plan.inject).toBe(false);
    expect(plan.safeMode).toBe(true);
  });

  test("an explicitly passed flag suppresses injection (no double-add) without safe mode", () => {
    const plan = planMaxPermissions(
      ["--dangerously-skip-permissions"],
      CLAUDE_MAX_PERMISSION_SUPPRESSORS,
      {},
    );
    expect(plan.inject).toBe(false);
    expect(plan.safeMode).toBe(false);
    expect(plan.args).toEqual(["--dangerously-skip-permissions"]);
  });

  test("codex aliases: both --yolo and the long form suppress injection", () => {
    for (const alias of ["--yolo", "--dangerously-bypass-approvals-and-sandbox"]) {
      const plan = planMaxPermissions([alias], CODEX_MAX_PERMISSION_SUPPRESSORS, {});
      expect(plan.inject).toBe(false);
    }
  });

  test("explicit codex approval/sandbox preferences suppress injection (clap conflict guard)", () => {
    // `codex -a never --yolo` is a hard clap conflict (verified on 0.139) —
    // any explicit approval/sandbox flag must suppress the default.
    for (const args of [
      ["-a", "never"],
      ["-a=never"],
      ["--ask-for-approval", "untrusted"],
      ["--ask-for-approval=never"],
      ["-s", "read-only"],
      ["--sandbox", "read-only"],
      ["--sandbox=workspace-write"],
    ]) {
      const plan = planMaxPermissions(args, CODEX_MAX_PERMISSION_SUPPRESSORS, {});
      expect(plan.inject).toBe(false);
      expect(plan.safeMode).toBe(false);
      expect(plan.args).toEqual(args);
    }
  });

  test("explicit claude permission preferences suppress injection", () => {
    for (const args of [
      ["--permission-mode", "plan"],
      ["--permission-mode=plan"],
      ["--allow-dangerously-skip-permissions"],
    ]) {
      const plan = planMaxPermissions(args, CLAUDE_MAX_PERMISSION_SUPPRESSORS, {});
      expect(plan.inject).toBe(false);
    }
  });

  test("clap ATTACHED short-value forms suppress injection (-anever / -sread-only)", () => {
    // clap parses `-anever` as `-a never` (verified on codex 0.139), so the
    // attached form must suppress exactly like the spaced/`=` forms — round-2
    // review caught `abg codex -anever` hard-conflicting with injected --yolo.
    for (const args of [["-anever"], ["-sread-only"], ["-a=never"]]) {
      const plan = planMaxPermissions(args, CODEX_MAX_PERMISSION_SUPPRESSORS, {});
      expect(plan.inject).toBe(false);
    }
  });

  test("long flags sharing a short suppressor's prefix do not suppress", () => {
    // "--ask" / "--sandboxy" are NOT --ask-for-approval/--sandbox (exact or
    // `=` only for long flags), and double-dash tokens never match the
    // attached-short rule.
    const plan = planMaxPermissions(["--ask", "--sandboxy"], CODEX_MAX_PERMISSION_SUPPRESSORS, {});
    expect(plan.inject).toBe(true);
  });

  test("AGENTBRIDGE_SAFE values other than '1' do not disable", () => {
    const plan = planMaxPermissions([], CODEX_MAX_PERMISSION_SUPPRESSORS, { AGENTBRIDGE_SAFE: "0" });
    expect(plan.inject).toBe(true);
  });
});
