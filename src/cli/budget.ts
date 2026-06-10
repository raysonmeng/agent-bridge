/**
 * `abg budget` — show the budget coordination snapshot for a pair's daemon.
 *
 * Reads DaemonStatus.budget via the daemon's /healthz endpoint (same payload the
 * get_budget MCP tool renders, via the shared renderer — plan v2.2 requires the
 * two surfaces to stay consistent).
 */

import { fetchDaemonStatus } from "../daemon-status";
import { parsePairFlag, type ReadOnlyPairResolution, resolvePairReadOnly } from "../pair-resolver";
import { renderBudgetSnapshot, BUDGET_UNAVAILABLE_TEXT } from "../budget/render";

export async function runBudget(args: string[]) {
  const json = args.includes("--json");
  const { pairFlag } = parsePairFlag(args.filter((arg) => arg !== "--json"));
  let resolution: ReadOnlyPairResolution;
  try {
    resolution = resolvePairReadOnly(pairFlag);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      console.error(`[agentbridge] ${message}`);
    }
    process.exit(1);
    return;
  }
  const { pair } = resolution;

  if (!resolution.registered) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: "pair_not_registered" }));
    } else {
      console.error("该目录尚无 pair，先运行 abg claude");
    }
    process.exit(1);
    return;
  }

  const status = await fetchDaemonStatus(pair.ports.controlPort);
  if (!status) {
    if (json) {
      console.log(JSON.stringify({ ok: false, pairId: pair.pairId, error: "daemon_unreachable" }));
    } else {
      console.error(
        `AgentBridge daemon 未运行（pair ${pair.pairId}，控制端口 ${pair.ports.controlPort}）。` +
          "先运行 `abg claude` 启动会话。",
      );
    }
    process.exit(1);
  }

  if (json) {
    console.log(
      JSON.stringify(
        { ok: true, pairId: status.pairId ?? pair.pairId, budget: status.budget ?? null },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`pair: ${status.pairId ?? pair.pairId}`);
  console.log(status.budget ? renderBudgetSnapshot(status.budget) : BUDGET_UNAVAILABLE_TEXT);
}
