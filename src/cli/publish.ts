/**
 * `abg publish` / `abg announce` — emit a `task_completed` room event (§3.3).
 *
 * Two ways in:
 *  - `abg publish --from-hook` (wired into the agent Stop hook): the completion is
 *    derived from git — last commit subject = summary, repo/branch/commit = the
 *    data-plane POINTERS (never file contents, §2.6). A burst of Stop hooks
 *    collapses to one event via a cross-process throttle keyed on
 *    (agentId, repo, branch). It FAILS OPEN: a down broker, a non-git dir, or a
 *    cwd with no room never breaks the agent's turn (always exit 0).
 *  - `abg announce --summary "<text>"` (manual / MCP `announce`): an explicit
 *    one-liner, same envelope.
 *
 * The room is resolved from the cwd→room map (§2.4); no mapping ⇒ nothing to
 * announce. Auth + collab Store reuse the same 0700-locked dir as `abg auth login`.
 */

import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { BrokerClient } from "../broker-client";
import { buildTaskCompletedEnvelope } from "../task-completed";
import { PublishThrottle } from "../publish-throttle";
import { RoomService } from "../room-service";
import type { Store } from "../backbone/store";
import { openStore, readAuthToken, resolveBrokerUrl, resolveDbPath } from "../collab-store";

const DEFAULT_THROTTLE_MS = 8 * 60 * 60 * 1000; // 8h: a given commit announces ~once per session
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

export type PublishStatus =
  | "published"
  | "skipped-empty" // no summary to announce
  | "skipped-no-login" // not logged in (abg auth login)
  | "skipped-no-room" // cwd not mapped to a room
  | "skipped-throttled" // inside the dedup window
  | "skipped-offline"; // broker unreachable within the connect timeout

export interface PublishResult {
  status: PublishStatus;
  roomId?: string;
}

export interface PublishOptions {
  argv?: string[];
  cwd?: string;
  dbPath?: string;
  brokerUrl?: string;
  throttleWindowMs?: number;
  connectTimeoutMs?: number;
  /** Clock injection (throttle + envelope timestamp) for tests. */
  now?: () => number;
  /** Store injection for tests; defaults to a 0700-locked SqliteStore at dbPath. */
  store?: Store;
}

interface ParsedArgs {
  fromHook: boolean;
  summary?: string;
  repo?: string;
  branch?: string;
  commit?: string;
  contract?: string;
  unblocks?: string[];
  agentType: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { fromHook: false, agentType: "claude" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eat = (): string | undefined => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a === "--from-hook") out.fromHook = true;
    else if (a === "--summary" || a.startsWith("--summary=")) out.summary = eat();
    else if (a === "--repo" || a.startsWith("--repo=")) out.repo = eat();
    else if (a === "--branch" || a.startsWith("--branch=")) out.branch = eat();
    else if (a === "--commit" || a.startsWith("--commit=")) out.commit = eat();
    else if (a === "--contract" || a.startsWith("--contract=")) out.contract = eat();
    else if (a === "--agent-type" || a.startsWith("--agent-type=")) out.agentType = eat() ?? out.agentType;
    else if (a === "--unblocks" || a.startsWith("--unblocks=")) {
      out.unblocks = (eat() ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }
  return out;
}

/** Run a git command in `cwd`, returning trimmed stdout or null (not a repo / no commits / git missing). */
function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/** Fill repo/branch/commit (and, in --from-hook, summary) from git — the data-plane pointers (§2.6). */
function gitContext(cwd: string): { repo?: string; branch?: string; commit?: string; subject?: string } {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  return {
    repo: top ? basename(top) : undefined,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? undefined,
    commit: git(["rev-parse", "--short", "HEAD"], cwd) ?? undefined,
    subject: git(["log", "-1", "--format=%s"], cwd) ?? undefined,
  };
}

/** connect() reconnects forever against a down broker — race it against a timeout so the hook never hangs. */
async function connectWithTimeout(client: BrokerClient, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("broker connect timeout")), ms);
  });
  try {
    await Promise.race([client.connect(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build + publish a task_completed envelope. Fully in-process testable: inject a
 * test broker URL, a temp dbPath/store, and a clock. Returns a PublishStatus for
 * every EXPECTED outcome (skip reasons + published) rather than throwing. An
 * unexpected I/O error (e.g. opening the collab Store) still propagates — the
 * Stop-hook entrypoint {@link runPublish} is the fail-open boundary that turns
 * any escape into exit 0 so the agent's turn never fails.
 */
export async function publishCompletion(opts: PublishOptions = {}): Promise<PublishResult> {
  const cwd = opts.cwd ?? process.cwd();
  const dbPath = resolveDbPath(opts.dbPath);
  const args = parseArgs(opts.argv ?? []);

  // Gate on the login token BEFORE opening the Store. The Stop hook fires for
  // EVERY plugin user (incl. v1-only / never-logged-in), so opening the Store
  // here would create collab.db + chmod the shared state dir to 0700 for users
  // who never opted into v3 collab. Reading the token file touches nothing.
  const token = readAuthToken(dbPath);
  if (!token) return { status: "skipped-no-login" };

  const ownStore = !opts.store;
  const store = opts.store ?? openStore(dbPath);
  try {
    const identityId = await store.resolveToken(token);
    if (!identityId) return { status: "skipped-no-login" };

    const roomId = await new RoomService(store).resolveRoomForCwd(cwd);
    if (!roomId) return { status: "skipped-no-room" };

    const ctx = gitContext(cwd);
    const summary = (args.summary ?? (args.fromHook ? ctx.subject : undefined))?.trim();
    if (!summary) return { status: "skipped-empty" };

    const repo = args.repo ?? ctx.repo;
    const branch = args.branch ?? ctx.branch;
    const commit = args.commit ?? ctx.commit;

    // Dedup ONLY the automatic Stop-hook path (a manual `announce` is explicit
    // intent — always goes through). Keyed on the commit so each completion is
    // announced ~once: re-fires for the same commit are suppressed within the
    // window, while a NEW commit (new hash) is a new key and goes straight out.
    // Peek now, record ONLY after a confirmed publish — a broker-offline attempt
    // must not burn the window (else a transient outage suppresses the commit for
    // the whole window, even after the broker recovers).
    let throttle: PublishThrottle | undefined;
    let throttleKey: string | undefined;
    if (args.fromHook) {
      throttle = new PublishThrottle({
        filePath: join(dirname(dbPath), "publish-throttle.json"),
        windowMs: opts.throttleWindowMs ?? DEFAULT_THROTTLE_MS,
        now: opts.now,
      });
      throttleKey = `${identityId}|${repo ?? ""}|${branch ?? ""}|${commit ?? ""}`;
      if (!throttle.peek(throttleKey)) return { status: "skipped-throttled", roomId };
    }

    const envelope = buildTaskCompletedEnvelope({
      roomId,
      from: { agentId: identityId, agentType: args.agentType },
      summary,
      repo,
      branch,
      commit,
      contract: args.contract,
      unblocks: args.unblocks,
      now: opts.now,
    });

    const client = new BrokerClient({ url: resolveBrokerUrl(opts.brokerUrl), token });
    try {
      if (!(await connectWithTimeout(client, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS))) {
        return { status: "skipped-offline", roomId };
      }
      client.publish(roomId, envelope); // topic = roomId; broker stamps from.agentId + handles store_if_offline
      // Let the frame flush before close() tears the socket down — publish()
      // is fire-and-forget, so without this the close handshake can race the
      // data frame and drop it. ponytail: fixed 100ms; switch to a bufferedAmount
      // poll if a slow link ever needs longer.
      await new Promise((r) => setTimeout(r, 100));
      // Consume the dedup window only now that the publish actually went out.
      if (throttle && throttleKey) throttle.record(throttleKey);
      return { status: "published", roomId };
    } finally {
      client.close();
    }
  } finally {
    if (ownStore) await store.close();
  }
}

const STATUS_MESSAGE: Record<PublishStatus, string> = {
  published: "已广播完成事件",
  "skipped-empty": "无摘要可广播（跳过）",
  "skipped-no-login": "未登录，跳过（abg auth login 后生效）",
  "skipped-no-room": "当前目录未关联协作房间，跳过（abg join / abg room create）",
  "skipped-throttled": "在去重窗口内，跳过",
  "skipped-offline": "broker 不可达，跳过",
};

/** Dispatch `abg publish` / `abg announce`. Always exits 0 — a completion notice must never fail the caller. */
export async function runPublish(argv: string[]): Promise<void> {
  try {
    const result = await publishCompletion({ argv });
    const suffix = result.roomId ? `（房间 ${result.roomId}）` : "";
    console.log(`${STATUS_MESSAGE[result.status]}${result.status === "published" ? suffix : ""}`);
  } catch (e) {
    // Fail open: never let a publish error break the agent's turn / hook.
    console.error(`[publish] 跳过：${String(e)}`);
  }
}
