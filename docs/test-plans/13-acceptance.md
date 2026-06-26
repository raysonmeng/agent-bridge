# §13 MVP 端到端验收 — Docker 多机/多人/多(异构)agent 模拟

把 docs/09 §13 的验收标准做成**可一键重复**的 Docker 场景：多个容器 = 多台机器 / 多个人 / 多个**异构 agent**（claude / codex / gemini 标签），连同一个常开 broker，按真实业务时间线协作，每台机自检并打 `ASSERT ... PASS|FAIL`。

> 这是**控制面协议**的端到端验收。真实 Claude/Codex 交互式会话注入不在 Docker 内（需 API key + 交互 CLI，由 bun `room-bridge.test.ts` 等覆盖）；Tailscale 网络层 ACL 由 [docs/10](../10-跨网部署与运维.md) 真机 runbook 验。

## 如何跑

```bash
bash docker/run-acceptance.sh
```

它会 build + 起整套、等各 agent 容器自检退出、收集退出码/日志、写 `docs/test-plans/13-acceptance-results.md`、再拆除。**通过 = 每个 agent 容器 exit 0**（其全部 ASSERT PASS）。

实时看日志（可选）：

```bash
docker compose -f docker/docker-compose.scenario.yml logs -f
```

## 拓扑与剧本

| 容器 | 类型标签 | 身份 | 剧本 |
|------|---------|------|------|
| `broker` | — | — | 常开控制面 broker（一台服务器机） |
| `provision` | — | — | 注册 5 身份 + 建房间加成员 + §13#5 会话连续性断言 |
| `alice` | claude | alice@ | 发 task_completed(auth/v1) → 收 bob ack → DM bob@ → 见 dave 离线后发 store_if_offline 事件 |
| `bob` | codex | bob@ | 等 alice 完成事件(断言 contract) → ack DM → 等 alice DM |
| `bob2` | codex | bob2@（显示名也叫 "Bob"） | 收广播但**不**收发给 bob@ 的 DM（身份消歧） |
| `carol` | gemini | carol@ | **晚 8s** 加入 → 断言收到白板快照(auth/v1) |
| `dave` | claude | dave@ | 断开 → alice 发离线事件 → 重连断言 drain 到 |
| `intruder` | — | — | 伪造 token → 断言被 PSK 拒(4401) |

## §13 → 断言映射

| §13 | 断言 id | 由谁断言 |
|-----|--------|---------|
| 1 完成事件自动获知(摘要/仓/契约) | `s13-1-completion` / `s13-1-from-skip` | bob / alice |
| 2 DM 定向不打扰 | `s13-2-dm-roundtrip` / `s13-2-dm-recv` | alice / bob |
| 3 新成员白板注入 | `s13-3-whiteboard-on-join` | carol |
| 4 离线补投 | `s13-4-offline-replay` / `s13-4-offline-trigger` | dave / alice |
| 5 会话连续性(new/resumed) | `s13-5-session-continuity` | provision |
| 6 身份消歧(同名不同 id) | `s13-6-broadcast-all` / `s13-6-dm-disambiguation` | bob2 |
| 7 PSK 拒绝(应用层) | `s13-7-psk` | intruder |
| 8 无文件传输 | broker 容器不挂 repo + payload 仅 git 指针 | 结构性（报告展示 payload） |
| 9 v1 单机流不受影响 | room-bridge fail-inert + daemon 集成测试 | bun 测试套（非本 harness） |

## 文件

- `docker/provision-scenario.ts` — 身份/房间/会话连续性。
- `docker/scenario-agent.ts` — 角色驱动的替身 agent（基于真实 `src/broker-client.ts`）。
- `docker/docker-compose.scenario.yml` — 编排。
- `docker/run-acceptance.sh` — 一键跑 + 生成报告。
- 基础 smoke 仍在 `docker/docker-compose.yml`（PR3 的跨容器扇出 `SIM_OK`）。

## 真·三机（后续）

家里机 + 公司 MacBook + Mac mini 的真实跨机测试：先在各机装 v3 build（建议合并后 `abg install:global`）、各机 `abg auth login` + 同房间、一台 `abg broker start --host 100.x`、起真实 Claude 会话。步骤见 [docs/10](../10-跨网部署与运维.md)。
