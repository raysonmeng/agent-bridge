# §13 端到端验收 — Docker 实跑记录

- 运行时间：2026-06-26 14:11:42 +0800
- 分支：feat/v3-tailscale-docs  ·  HEAD：80643a1
- 拓扑：1 broker（服务器机）+ 6 agent 容器（多机/多人/多异构 agent）+ provision

## 总判据：**PASS ✅**

## 各 agent 容器退出码（exit 0 = 该机所有 §13 断言 PASS）

| agent（类型） | 退出码 |
|---|---|
| alice | 0 |
| bob | 0 |
| bob2 | 0 |
| carol | 0 |
| dave | 0 |
| intruder | 0 |

## 全部 §13 断言（ASSERT，去重排序）
```
| 2026-06-26T06:11:27.254987975Z [provision] ASSERT s13-5-session-continuity PASS: first=new, second=resumed, prev=sess-1
| 2026-06-26T06:11:28.005137886Z [intruder:claude] ASSERT s13-7-psk PASS: bogus token rejected (Error: broker auth failed)
| 2026-06-26T06:11:29.002331351Z [bob:codex] ASSERT s13-1-completion PASS: got alice's completion (contract=auth/v1, summary=auth 契约就绪)
| 2026-06-26T06:11:29.025321008Z [bob2:codex] ASSERT s13-6-broadcast-all PASS: bob2 received the broadcast completion (broadcasts reach all members)
| 2026-06-26T06:11:30.431537413Z [alice:claude] ASSERT s13-1-from-skip PASS: alice never receives her own events (loop prevention)
| 2026-06-26T06:11:30.431581538Z [alice:claude] ASSERT s13-2-dm-roundtrip PASS: received bob's ack DM
| 2026-06-26T06:11:30.434684912Z [bob:codex] ASSERT s13-2-dm-recv PASS: received alice's DM addressed to bob@
| 2026-06-26T06:11:31.586796182Z [alice:claude] ASSERT s13-4-offline-trigger PASS: dave was offline when the 2nd event was published
| 2026-06-26T06:11:38.032402267Z [bob2:codex] ASSERT s13-6-dm-disambiguation PASS: bob2 correctly did NOT receive bob@'s DM — routed by id, not displayName
| 2026-06-26T06:11:38.600644135Z [dave:claude] ASSERT s13-4-offline-replay PASS: reconnect drained the offline event (summary=second-wave 离线补投)
| 2026-06-26T06:11:38.996625747Z [carol:gemini] ASSERT s13-3-whiteboard-on-join PASS: late-joiner got the whiteboard snapshot (contractsReady=auth/v1)
```

## provision（身份/房间/会话连续性 §13#5）
```
| 2026-06-26T06:11:27.224149906Z [provision] alice@team.dev ("Alice") token→token-alice, joined team-room
| 2026-06-26T06:11:27.233458151Z [provision] bob@team.dev ("Bob") token→token-bob, joined team-room
| 2026-06-26T06:11:27.238546691Z [provision] bob2@team.dev ("Bob") token→token-bob2, joined team-room
| 2026-06-26T06:11:27.245990021Z [provision] carol@team.dev ("Carol") token→token-carol, joined team-room
| 2026-06-26T06:11:27.250656144Z [provision] dave@team.dev ("Dave") token→token-dave, joined team-room
| 2026-06-26T06:11:27.254987975Z [provision] ASSERT s13-5-session-continuity PASS: first=new, second=resumed, prev=sess-1
| 2026-06-26T06:11:27.262744347Z [provision] done (room=team-room, 5 identities)
```

## 关键事件流（RECV — 谁收到什么）
```
| 2026-06-26T06:11:28.097371219Z [dave:claude] RECV event kind=member_joined from=bob@team.dev to=- summary=-
| 2026-06-26T06:11:36.082097399Z [carol:gemini] RECV event kind=task_completed from=alice@team.dev to=- summary=auth 契约就绪
| 2026-06-26T06:11:36.082117316Z [carol:gemini] RECV event kind=task_completed from=alice@team.dev to=- summary=second-wave 离线补投
| 2026-06-26T06:11:36.082683065Z [carol:gemini] RECV whiteboard room=team-room contractsReady=["auth/v1","checkout/v1"]
| 2026-06-26T06:11:38.495230057Z [carol:gemini] RECV event kind=member_joined from=dave@team.dev to=- summary=-
| 2026-06-26T06:11:38.537078372Z [carol:gemini] RECV event kind=member_left from=bob2@team.dev to=- summary=-
| 2026-06-26T06:11:38.601124968Z [carol:gemini] RECV event kind=member_left from=dave@team.dev to=- summary=-
| 2026-06-26T06:11:28.943862003Z [dave:claude] RECV event kind=task_completed from=alice@team.dev to=- summary=auth 契约就绪
| 2026-06-26T06:11:38.495557641Z [dave:claude] RECV event kind=task_completed from=alice@team.dev to=- summary=second-wave 离线补投
| 2026-06-26T06:11:38.495665724Z [dave:claude] RECV whiteboard room=team-room contractsReady=["auth/v1","checkout/v1"]
| 2026-06-26T06:11:38.536749455Z [dave:claude] RECV event kind=member_left from=bob2@team.dev to=- summary=-
| 2026-06-26T06:11:28.944173044Z [bob:codex] RECV event kind=task_completed from=alice@team.dev to=- summary=auth 契约就绪
| 2026-06-26T06:11:30.432039371Z [bob:codex] RECV event kind=dm from=alice@team.dev to=["bob@team.dev"] summary=请基于 auth/v1 继续 checkout
| 2026-06-26T06:11:31.484938895Z [bob:codex] RECV event kind=member_left from=dave@team.dev to=- summary=-
| 2026-06-26T06:11:31.593647013Z [bob:codex] RECV event kind=task_completed from=alice@team.dev to=- summary=second-wave 离线补投
| 2026-06-26T06:11:28.028633250Z [bob2:codex] RECV event kind=member_joined from=alice@team.dev to=- summary=-
| 2026-06-26T06:11:28.078342978Z [bob2:codex] RECV event kind=member_joined from=dave@team.dev to=- summary=-
| 2026-06-26T06:11:28.097015594Z [bob2:codex] RECV event kind=member_joined from=bob@team.dev to=- summary=-
| 2026-06-26T06:11:28.944009461Z [bob2:codex] RECV event kind=task_completed from=alice@team.dev to=- summary=auth 契约就绪
| 2026-06-26T06:11:31.485097853Z [bob2:codex] RECV event kind=member_left from=dave@team.dev to=- summary=-
| 2026-06-26T06:11:31.594074929Z [bob2:codex] RECV event kind=task_completed from=alice@team.dev to=- summary=second-wave 离线补投
| 2026-06-26T06:11:32.954315897Z [bob2:codex] RECV event kind=member_left from=bob@team.dev to=- summary=-
| 2026-06-26T06:11:35.093179096Z [bob2:codex] RECV event kind=member_left from=alice@team.dev to=- summary=-
| 2026-06-26T06:11:36.082301774Z [bob2:codex] RECV event kind=member_joined from=carol@team.dev to=- summary=-
| 2026-06-26T06:11:38.495219766Z [bob2:codex] RECV event kind=member_joined from=dave@team.dev to=- summary=-
| 2026-06-26T06:11:28.077372103Z [alice:claude] RECV event kind=member_joined from=dave@team.dev to=- summary=-
| 2026-06-26T06:11:28.097209969Z [alice:claude] RECV event kind=member_joined from=bob@team.dev to=- summary=-
| 2026-06-26T06:11:29.002980726Z [alice:claude] RECV event kind=dm from=bob@team.dev to=["alice@team.dev"] summary=收到，开始基于 auth/v1
| 2026-06-26T06:11:31.484842312Z [alice:claude] RECV event kind=member_left from=dave@team.dev to=- summary=-
| 2026-06-26T06:11:32.954356230Z [alice:claude] RECV event kind=member_left from=bob@team.dev to=- summary=-
```

## broker 日志（节选）
```
| 2026-06-26T06:11:27.782237070Z [broker] broker listening on 0.0.0.0:4700
| 2026-06-26T06:11:27.782348987Z [broker] up on 0.0.0.0:4700 (db /data/collab.db)
| 2026-06-26T06:11:27.910785387Z [broker] conn #1 authenticated as bob2@team.dev
| 2026-06-26T06:11:28.004739011Z [broker] conn #2 closed
| 2026-06-26T06:11:28.026754543Z [broker] conn #3 authenticated as alice@team.dev
| 2026-06-26T06:11:28.076697562Z [broker] conn #4 authenticated as dave@team.dev
| 2026-06-26T06:11:28.096285470Z [broker] conn #5 authenticated as bob@team.dev
| 2026-06-26T06:11:31.484913603Z [broker] conn #4 closed
| 2026-06-26T06:11:32.954178189Z [broker] conn #5 closed
| 2026-06-26T06:11:35.093377888Z [broker] conn #3 closed
| 2026-06-26T06:11:36.076202068Z [broker] conn #6 authenticated as carol@team.dev
| 2026-06-26T06:11:38.486933520Z [broker] conn #7 authenticated as dave@team.dev
| 2026-06-26T06:11:38.536844164Z [broker] conn #1 closed
| 2026-06-26T06:11:38.600673093Z [broker] conn #7 closed
| 2026-06-26T06:11:42.504540994Z [broker] conn #6 closed
```

## 覆盖边界（诚实标注）
- 本 harness 证：控制面协议跨「机」（容器/网络）正确——完成事件扇出 / DM 定向 / 新成员白板 / 离线补投 / 身份消歧 / PSK 拒绝 / 无文件传输。
- **不**在 Docker 内跑：真实 Claude/Codex 交互式会话注入（需 API key + 交互 CLI，由 bun `room-bridge.test.ts` 覆盖）；Tailscale 网络层 ACL（由 docs/10 真机 runbook 验）；v1 单机流不受影响（由 daemon 集成测试覆盖）。
