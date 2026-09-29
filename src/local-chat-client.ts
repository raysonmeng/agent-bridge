import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readControlToken, resolveControlTokenPath } from "./control-token";
import { BUILD_INFO } from "./build-info";
import type { PairResolution } from "./pair-resolver";
import { isLocalChatSource, isLocalMessageId, type NativeReply, type LocalAgentProfile } from "./local-chat";

type LocalChatResult = { success: boolean; info: string; members?: string[]; agents?: LocalAgentProfile[]; replies?: NativeReply[] };

export function localChatIdentity(pair: PairResolution, cwd = process.cwd()) {
  const controlToken = readControlToken(resolveControlTokenPath(pair.stateDir.dir));
  if (!controlToken) throw new Error("Pair control token is unavailable; start this pair first");
  return {
    pairId: pair.manual ? null : pair.pairId, cwd: realpathSync(cwd),
    stateDir: pair.stateDir.dir, clientPid: process.pid,
    contractVersion: BUILD_INFO.contractVersion, controlToken,
  };
}

export function localChatUrl(pair: PairResolution): string {
  const port = pair.ports.controlPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid pair control port");
  return `ws://127.0.0.1:${port}/ws`;
}

export async function requestLocalChat(pair: PairResolution, request: {
  type: "local_chat_members" | "local_chat_send" | "local_chat_inbox" | "local_chat_reply";
  from?: string; to?: string; text?: string; inReplyTo?: string;
}, options: { timeoutMs?: number; cwd?: string } = {}): Promise<LocalChatResult> {
  if (request.type === "local_chat_send" || request.type === "local_chat_reply") {
    if (!isLocalChatSource(request.from) || !isLocalChatSource(request.to) || request.to === "user" ||
      typeof request.text !== "string" || !request.text.trim() || request.text.length > 4000 ||
      (request.type === "local_chat_reply" && !isLocalMessageId(request.inReplyTo))) {
      throw new Error("Explicit recipient and valid reply metadata required; nothing submitted to daemon");
    }
  }
  const identity = localChatIdentity(pair, options.cwd);
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(localChatUrl(pair));
    let finished = false;
    const finish = (error?: Error, result?: LocalChatResult) => {
      if (finished) return;
      finished = true; clearTimeout(timer); ws.close();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("Local chat timed out; delivery unconfirmed (not retried)")), options.timeoutMs ?? 25000);
    ws.onopen = () => ws.send(JSON.stringify({ ...request, identity, requestId }));
    ws.onerror = () => finish(new Error("Could not connect to this pair's local chat"));
    ws.onclose = () => finish(new Error("Pair disconnected before confirming the message"));
    ws.onmessage = event => {
      try {
        const m = JSON.parse(String(event.data));
        if (m?.type === "local_chat_result" && m.requestId === requestId &&
          typeof m.success === "boolean" && typeof m.info === "string") finish(undefined, m);
      } catch { finish(new Error("Invalid local chat response")); }
    };
  });
}
