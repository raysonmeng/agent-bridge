/**
 * `abg broker start` local admin dashboard.
 *
 * A LOOPBACK-ONLY (127.0.0.1) Bun.serve on its OWN port (default 4701), separate
 * from the WS broker port. It lets the person running the broker SEE rooms /
 * members / whiteboards and CREATE a room from a browser.
 *
 * Security: it is deliberately NOT exposed on the broker's 0.0.0.0 / Tailscale
 * interface — that would be an UNAUTHENTICATED admin console reachable by anyone
 * who can reach the broker (it would re-open the very access hole §11.2 closed).
 * For remote viewing, SSH-forward this port or put it behind `tailscale serve`
 * (which adds tailnet identity). A Host-header allowlist additionally defeats
 * DNS-rebinding (a browser visiting evil.com→127.0.0.1 sends a non-loopback Host).
 * Room creation reuses the same closed-by-default membership rules as the CLI.
 */

import type { Store, WhiteboardRecord } from "./backbone/store";
import { RoomService, slugify } from "./room-service";

export const DEFAULT_DASHBOARD_PORT = 4701;

// The dashboard is loopback-only by design (unauthenticated admin console); any other
// bind host is refused at startBrokerWeb and forced back to 127.0.0.1.
const LOOPBACK_BIND = new Set(["127.0.0.1", "::1", "localhost"]);

export interface BrokerWebOptions {
  store: Store;
  /** Bind host — loopback only. Do NOT change to a public interface without auth. */
  host?: string;
  /** Bind port (default 4701; 0 = random, for tests). */
  port?: number;
  /** Logged-in identity that owns rooms created from the UI; null = not logged in (create disabled). */
  createdBy: string | null;
  log?: (m: string) => void;
}

export interface BrokerWebHandle {
  host: string;
  port: number;
  url: string;
  stop(): void;
}

interface RoomState {
  roomId: string;
  name: string;
  createdBy: string;
  members: string[];
  whiteboard: WhiteboardRecord | null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Only accept requests whose Host header is loopback:port. Bun already binds to
 * 127.0.0.1, but this blocks DNS-rebinding (a malicious page resolving its own
 * hostname to 127.0.0.1 would carry a non-loopback Host). Pure (takes the header
 * string) so it is unit-testable without a live socket.
 */
export function hostAllowed(hostHeader: string | null, port: number): boolean {
  if (!hostHeader) return false;
  return (
    hostHeader === `127.0.0.1:${port}` ||
    hostHeader === `localhost:${port}` ||
    hostHeader === `[::1]:${port}`
  );
}

async function collectState(store: Store): Promise<{ rooms: RoomState[]; generatedAt: number }> {
  const svc = new RoomService(store);
  const rooms = await svc.listRooms();
  const out: RoomState[] = [];
  for (const r of rooms) {
    out.push({
      roomId: r.roomId,
      name: r.name,
      createdBy: r.createdBy,
      members: await store.getMembers(r.roomId),
      whiteboard: await store.getWhiteboard(r.roomId),
    });
  }
  return { rooms: out, generatedAt: Date.now() };
}

/**
 * Strip control + format chars (ANSI/newline/CR/zero-width) so an attacker-supplied room NAME can't
 * inject sequences into the broker operator's terminal log (CWE-117). The web face is loopback-only,
 * but the docs invite SSH / `tailscale serve` forwarding, so a forwarded POST body is untrusted.
 * roomId is already slug-safe (slugify strips these); createdBy is the operator's own authenticated id.
 */
function safeForLog(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}]/gu, "");
}

/** Create a room owned by the logged-in identity, mirroring the CLI's closed-by-default rules (§11.2). */
async function createRoom(store: Store, createdBy: string | null, body: unknown, log: (m: string) => void): Promise<Response> {
  if (!createdBy) return json({ error: "未登录：请在 broker 机上先运行 abg auth login" }, 401);
  const name = typeof (body as { name?: unknown })?.name === "string" ? (body as { name: string }).name.trim() : "";
  if (!name) return json({ error: "缺少房间名称" }, 400);
  let roomId: string;
  try {
    roomId = slugify(name);
  } catch (e) {
    return json({ error: errMsg(e) }, 400);
  }
  const svc = new RoomService(store);
  const existed = (await svc.getRoom(roomId)) !== null;
  if (!existed) {
    await svc.createRoom(roomId, name, createdBy);
    await svc.join(roomId, createdBy); // creator of a NEW room is its first member
    log(`已创建房间 ${roomId}（${safeForLog(name)}）by ${createdBy} — 加入：abg join ${roomId}`);
  } else if (!(await svc.isMember(roomId, createdBy))) {
    // Closed-by-default: creating an EXISTING room must not self-grant membership.
    return json({ error: `房间 ${roomId} 已存在且你（${createdBy}）不是成员；请让成员用 abg room add 加你` }, 409);
  }
  return json({ roomId, created: !existed });
}

/** Start the loopback admin dashboard. Returns a handle whose stop() shuts it down. */
export function startBrokerWeb(opts: BrokerWebOptions): BrokerWebHandle {
  const log = opts.log ?? (() => {});
  const requested = opts.host ?? "127.0.0.1";
  // The dashboard is an UNAUTHENTICATED admin console — it MUST bind loopback only.
  // A non-loopback bind would expose every room/member/whiteboard + room creation to
  // anyone who can reach it (HIGH). Enforce here regardless of the caller; fail SAFE
  // to 127.0.0.1 (loudly) rather than trust the call site or a doc-comment.
  const host = LOOPBACK_BIND.has(requested) ? requested : "127.0.0.1";
  if (host !== requested)
    log(`忽略非 loopback 地址 ${requested}：管理面板无鉴权，强制绑 127.0.0.1（远程访问用 SSH 转发或 tailscale serve）`);
  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? DEFAULT_DASHBOARD_PORT,
    async fetch(req, srv) {
      try {
        if (!hostAllowed(req.headers.get("host"), srv.port ?? 0)) return new Response("forbidden host", { status: 403 });
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/") {
          return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        if (req.method === "GET" && url.pathname === "/api/state") {
          return json(await collectState(opts.store));
        }
        if (req.method === "POST" && url.pathname === "/api/rooms") {
          let body: unknown = null;
          try {
            body = await req.json();
          } catch {
            body = null;
          }
          return await createRoom(opts.store, opts.createdBy, body, log);
        }
        return new Response("not found", { status: 404 });
      } catch (e) {
        log(`request failed: ${errMsg(e)}`);
        return json({ error: "内部错误" }, 500);
      }
    },
  });
  // Server.port is number|undefined (undefined only for a unix socket, never used here).
  const boundPort = server.port ?? opts.port ?? DEFAULT_DASHBOARD_PORT;
  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    stop: () => void server.stop(true), // fire-and-forget: the dashboard does no critical DB writes
  };
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentBridge 房间面板</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, "PingFang SC", sans-serif; padding: 24px; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 20px; }
  .bar { display:flex; gap:8px; margin: 16px 0; }
  input { flex:1; padding:8px 10px; font-size:15px; border:1px solid #8884; border-radius:8px; background:transparent; color:inherit; }
  button { padding:8px 16px; font-size:15px; border:0; border-radius:8px; background:#2563eb; color:#fff; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .room { border:1px solid #8883; border-radius:12px; padding:14px 16px; margin:12px 0; }
  .room h2 { font-size:16px; margin:0 0 6px; }
  .muted { color:#8889; font-size:13px; font-weight:400; }
  .members span { display:inline-block; background:#8882; border-radius:6px; padding:1px 8px; margin:2px 4px 2px 0; font-size:13px; }
  .wb { font-size:13px; margin-top:8px; }
  .join { font-size:13px; margin-top:6px; color:#8889; }
  .join code { user-select:all; background:#8882; padding:1px 6px; border-radius:5px; color:inherit; }
  .empty { color:#8889; padding:24px; text-align:center; }
  .msg { padding:8px 12px; border-radius:8px; margin:8px 0; font-size:14px; }
  .msg.err { background:#ef44441a; color:#dc2626; }
  .msg.ok { background:#22c55e1a; color:#16a34a; }
</style>
</head>
<body>
<h1>🏠 AgentBridge 房间面板 <span class="muted" id="ts"></span></h1>
<div class="bar">
  <input id="name" placeholder="新房间名称（如：结账重构）" autocomplete="off">
  <button id="create">创建房间</button>
</div>
<div id="msg"></div>
<div id="rooms"></div>
<script>
const $ = (s) => document.querySelector(s);
function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function showMsg(text, ok){ const m=$("#msg"); if(!text){m.innerHTML="";return;} m.innerHTML='<div class="msg '+(ok?"ok":"err")+'">'+esc(text)+'</div>'; }
function wbLine(wb){
  if(!wb) return '';
  const c=(a)=>Array.isArray(a)?a.length:0;
  const parts=[];
  if(c(wb.contractsReady)) parts.push('已就绪契约 '+c(wb.contractsReady));
  if(c(wb.inProgress)) parts.push('进行中 '+c(wb.inProgress));
  if(c(wb.blockers)) parts.push('阻塞 '+c(wb.blockers));
  if(c(wb.recentMilestones)) parts.push('最近里程碑 '+c(wb.recentMilestones));
  return parts.length? '<div class="wb">📋 '+parts.map(esc).join(' · ')+'</div>' : '';
}
function render(state){
  $("#ts").textContent = '更新于 '+new Date(state.generatedAt).toLocaleTimeString();
  const el=$("#rooms");
  if(!state.rooms.length){ el.innerHTML='<div class="empty">还没有房间。上面输入名称创建第一个。</div>'; return; }
  el.innerHTML = state.rooms.map(r=>
    '<div class="room"><h2>'+esc(r.name)+' <span class="muted">'+esc(r.roomId)+'</span></h2>'
    +'<div class="muted">创建者 '+esc(r.createdBy)+' · 成员 '+r.members.length+'</div>'
    +'<div class="members">'+r.members.map(m=>'<span>'+esc(m)+'</span>').join('')+'</div>'
    +'<div class="join">加入：<code>abg join '+esc(r.roomId)+'</code></div>'
    +wbLine(r.whiteboard)+'</div>'
  ).join('');
}
async function refresh(){
  try{ const r=await fetch('/api/state'); if(r.ok) render(await r.json()); }
  catch(e){ /* transient; keep last view */ }
}
$("#create").onclick = async ()=>{
  const name=$("#name").value.trim();
  if(!name){ showMsg("请输入房间名称", false); return; }
  $("#create").disabled=true;
  try{
    const r=await fetch('/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});
    const d=await r.json();
    if(!r.ok){ showMsg(d.error||('创建失败 ('+r.status+')'), false); }
    else { showMsg(d.created?('已创建房间 '+d.roomId):('房间 '+d.roomId+' 已存在，已确认你是成员'), true); $("#name").value=''; refresh(); }
  }catch(e){ showMsg('请求失败：'+e, false); }
  finally{ $("#create").disabled=false; }
};
$("#name").addEventListener('keydown', e=>{ if(e.key==='Enter') $("#create").click(); });
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>`;
