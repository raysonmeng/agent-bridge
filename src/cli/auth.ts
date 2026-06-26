/**
 * `abg auth issue / login` — the cross-network onboarding primitives (§2.2, §6).
 *
 * The broker verifies a presented token against ITS OWN Store (StorePskIdentityProvider),
 * so a token only works if it was issued by the broker's Store. Two roles:
 *
 * - `auth issue --id --name` (run ON the broker): register + issueToken in the broker's
 *   collab.db and PRINT the token for the operator to carry out-of-band. Does NOT write a
 *   local auth-token (the token is for someone else).
 * - `auth login --token <PSK>` (run on the EDGE): install the broker-issued token into
 *   `<state>/auth-token` (0600). No register / no issue — the binding already lives in the
 *   broker's Store.
 * - `auth login --id --name` (legacy self-sign): register + issue + install locally, for the
 *   single-machine case where the same Store is both issuer and verifier.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteText } from "../atomic-json";
import { IdentityService } from "../backbone/identity-service";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { StateDirResolver } from "../state-dir";

export interface AuthLoginOptions {
  id: string;
  name: string;
  dbPath?: string;
}

export interface AuthLoginResult {
  token: string;
  identity: { id: string; displayName: string };
  tokenFile: string;
}

export interface AuthIssueResult {
  token: string;
  identity: { id: string; displayName: string };
}

/** Resolve the collab DB path: explicit > env override > `<state>/collab.db`. */
function resolveDbPath(dbPath?: string): string {
  if (dbPath) return dbPath;
  const env = process.env.AGENTBRIDGE_COLLAB_DB;
  if (env && env.length > 0) return env;
  return join(new StateDirResolver().dir, "collab.db");
}

/**
 * Lock the collab dir to 0700. The collab DB holds RAW PSK tokens (auth_tokens) + identity
 * emails/PII (identities). bun:sqlite creates the DB file 0644, and its WAL/SHM sidecars are
 * recreated 0644 on every reopen, so file-level chmod is not durable — lock the CONTAINING
 * directory instead (matches codex-transport.ts), blocking any other local user from
 * traversing in to read the secrets (CWE-732). chmodSync covers a pre-existing looser dir.
 */
function lockCollabDir(dbPath: string): string {
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Lock the dir, register the identity, and issue a token in this Store. Shared by login + issue. */
async function registerAndIssue(
  dbPath: string,
  id: string,
  name: string,
): Promise<{ token: string; identity: { id: string; displayName: string }; dir: string }> {
  const dir = lockCollabDir(dbPath);
  const store = new SqliteStore(dbPath);
  try {
    const svc = new IdentityService(store);
    const identity = await svc.registerIdentity(id, name);
    const token = await svc.issueToken(identity.id);
    return { token, identity, dir };
  } finally {
    await store.close();
  }
}

/**
 * Self-sign: register the identity, issue a token, and persist it next to the collab DB.
 * Single-machine path — the same Store both issues and (as the broker) verifies. Directly
 * unit-testable: pass an explicit `dbPath` to a temp dir.
 */
export async function authLogin(opts: AuthLoginOptions): Promise<AuthLoginResult> {
  const dbPath = resolveDbPath(opts.dbPath);
  const { token, identity, dir } = await registerAndIssue(dbPath, opts.id, opts.name);
  const tokenFile = join(dir, "auth-token");
  // 0600 from creation (CWE-732): the token is a local secret.
  atomicWriteText(tokenFile, token, { mode: 0o600 });
  return { token, identity, tokenFile };
}

/**
 * Issue a token FROM the broker's Store for someone else to install (`abg auth issue`).
 * Register + issue into this machine's collab.db, then return the token to PRINT. Deliberately
 * does NOT write a local auth-token — this token belongs to the invitee, not the operator.
 */
export async function authIssue(opts: AuthLoginOptions): Promise<AuthIssueResult> {
  const dbPath = resolveDbPath(opts.dbPath);
  const { token, identity } = await registerAndIssue(dbPath, opts.id, opts.name);
  return { token, identity };
}

/**
 * Install a broker-issued token on the edge (`abg auth login --token <PSK>`). Writes the
 * out-of-band token to `<state>/auth-token` (0600) and locks the dir — NO register / NO issue,
 * because the (token → identity) binding already lives in the broker's Store. An empty token is
 * rejected (it would silently disable auth).
 */
export async function installToken(opts: { token: string; dbPath?: string }): Promise<{ tokenFile: string }> {
  const token = opts.token.trim();
  if (token === "") throw new Error("令牌为空：abg auth login --token <PSK> 需要 broker 签发的非空令牌");
  const dbPath = resolveDbPath(opts.dbPath);
  const dir = lockCollabDir(dbPath);
  const tokenFile = join(dir, "auth-token");
  atomicWriteText(tokenFile, token, { mode: 0o600 });
  return { tokenFile };
}

const LOGIN_USAGE =
  "用法：abg auth login --token <PSK>（边机安装 broker 签发的令牌）｜abg auth login --id <email|github> --name <displayName>（本机自签）";
const ISSUE_USAGE = "用法：abg auth issue --id <email|github> --name <displayName>（在 broker 机上签发，把令牌带外发给对方）";

/** Parse `--id`/`--name`/`--token` (space- or `=`-separated). Empty values become "". */
function parseAuthArgs(argv: string[]): { id?: string; name?: string; token?: string } {
  let id: string | undefined;
  let name: string | undefined;
  let token: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--id") id = argv[++i] ?? "";
    else if (a.startsWith("--id=")) id = a.slice("--id=".length);
    else if (a === "--name") name = argv[++i] ?? "";
    else if (a.startsWith("--name=")) name = a.slice("--name=".length);
    else if (a === "--token") token = argv[++i] ?? "";
    else if (a.startsWith("--token=")) token = a.slice("--token=".length);
  }
  return { id, name, token };
}

/** Run `abg auth login`: `--token` installs a broker token; `--id --name` self-signs. */
export async function runAuthLoginCli(argv: string[]): Promise<void> {
  const { id, name, token } = parseAuthArgs(argv);

  // --token mode: install the broker-issued token (an empty value is caught by installToken).
  if (token !== undefined) {
    const { tokenFile } = await installToken({ token });
    console.log(`已安装协作令牌（broker 签发）：${tokenFile}`);
    console.log("现在可以：abg join <roomId>");
    return;
  }

  if (!id || !name) {
    console.error("缺少必填参数：要么 --token <PSK>，要么 --id <…> --name <…>。");
    console.error(LOGIN_USAGE);
    process.exit(1);
    return;
  }

  const result = await authLogin({ id, name });
  console.log(
    `已为 ${result.identity.id}（${result.identity.displayName}）签发令牌：${result.token}`,
  );
  console.log(`令牌文件：${result.tokenFile}`);
}

/** Run `abg auth issue`: sign a token on the broker for an invitee to install out-of-band. */
export async function runAuthIssueCli(argv: string[]): Promise<void> {
  const { id, name } = parseAuthArgs(argv);
  if (!id || !name) {
    console.error("缺少必填参数 --id 或 --name。");
    console.error(ISSUE_USAGE);
    process.exit(1);
    return;
  }
  const result = await authIssue({ id, name });
  console.log(`已在本机（broker）store 为 ${result.identity.id}（${result.identity.displayName}）签发令牌。`);
  console.log("把下面这行通过安全渠道带外发给对方，让它在自己机器上运行：");
  console.log(`  abg auth login --token ${result.token}`);
  console.log("（注：对同一 --id 重复 issue 会另签新 token、旧 token 不会自动失效——令牌吊销 CLI 仍在 backlog。）");
}

/** Dispatch `abg auth <subcommand>`: `login` (install/self-sign) or `issue` (broker-side sign). */
export async function runAuth(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "login":
      await runAuthLoginCli(args.slice(1));
      break;
    case "issue":
      await runAuthIssueCli(args.slice(1));
      break;
    default:
      console.error(`未知的 auth 子命令：${sub ?? "(空)"}`);
      console.error(LOGIN_USAGE);
      console.error(ISSUE_USAGE);
      process.exit(1);
  }
}
