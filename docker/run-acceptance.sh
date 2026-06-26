#!/usr/bin/env bash
#
# §13 端到端验收 runner：build + up 整套场景 → 等各 agent 容器自检退出 → 收集
# 退出码/日志 → 生成 docs/test-plans/13-acceptance-results.md → 拆除。
#
# 通过 = 每个 agent 容器 exit 0（其全部 ASSERT PASS）。bash 3.2 兼容（不用关联数组）。

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

COMPOSE="docker compose -f docker/docker-compose.scenario.yml"
RESULTS="docs/test-plans/13-acceptance-results.md"
AGENTS="alice bob bob2 carol dave intruder"

echo "[run] 清理上一次..."; $COMPOSE down -v >/dev/null 2>&1
echo "[run] build + 启动 (broker + provision + agents)..."
$COMPOSE up -d --build || { echo "[run] compose up 失败"; exit 1; }

echo "[run] 等待各 agent 自检退出..."
codes=""
for a in $AGENTS; do
  # -aq 含已停止容器：快剧本的 agent 在我们 wait 到它之前可能已退出，`ps -q`(仅运行中)会漏。
  cid=$($COMPOSE ps -aq "$a" 2>/dev/null)
  if [ -z "$cid" ]; then c="NO_CONTAINER"; else c=$(docker wait "$cid" 2>/dev/null || echo WAIT_ERR); fi
  echo "  $a → exit $c"
  codes="${codes}${a} ${c}"$'\n'
done

LOGS=$($COMPOSE logs --no-color --timestamps 2>&1)
nbad=$(printf '%s' "$codes" | awk 'NF>=2 && $2!="0"{n++} END{print n+0}')
if [ "$nbad" -eq 0 ]; then overall="PASS ✅"; else overall="FAIL ❌"; fi

mkdir -p docs/test-plans
{
  echo "# §13 端到端验收 — Docker 实跑记录"
  echo
  echo "- 运行时间：$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "- 分支：$(git branch --show-current 2>/dev/null)  ·  HEAD：$(git rev-parse --short HEAD 2>/dev/null)"
  echo "- 拓扑：1 broker（服务器机）+ 6 agent 容器（多机/多人/多异构 agent）+ provision"
  echo
  echo "## 总判据：**${overall}**"
  echo
  echo "## 各 agent 容器退出码（exit 0 = 该机所有 §13 断言 PASS）"
  echo
  echo "| agent（类型） | 退出码 |"
  echo "|---|---|"
  printf '%s' "$codes" | while read -r a c; do [ -n "$a" ] && echo "| $a | $c |"; done
  echo
  echo "## 全部 §13 断言（ASSERT，去重排序）"
  echo '```'
  printf '%s' "$LOGS" | grep -aE 'ASSERT ' | sed -E 's/^[^ ]+ +//' | sort -u
  echo '```'
  echo
  echo "## provision（身份/房间/会话连续性 §13#5）"
  echo '```'
  printf '%s' "$LOGS" | grep -aE 'provision' | sed -E 's/^[^ ]+ +//'
  echo '```'
  echo
  echo "## 关键事件流（RECV — 谁收到什么）"
  echo '```'
  printf '%s' "$LOGS" | grep -aE 'RECV ' | sed -E 's/^[^ ]+ +//'
  echo '```'
  echo
  echo "## broker 日志（节选）"
  echo '```'
  printf '%s' "$LOGS" | grep -aE '\[broker\]' | sed -E 's/^[^ ]+ +//' | head -40
  echo '```'
  echo
  echo "## 覆盖边界（诚实标注）"
  echo "- 本 harness 证：控制面协议跨「机」（容器/网络）正确——完成事件扇出 / DM 定向 / 新成员白板 / 离线补投 / 身份消歧 / PSK 拒绝 / 无文件传输。"
  echo "- **不**在 Docker 内跑：真实 Claude/Codex 交互式会话注入（需 API key + 交互 CLI，由 bun \`room-bridge.test.ts\` 覆盖）；Tailscale 网络层 ACL（由 docs/10 真机 runbook 验）；v1 单机流不受影响（由 daemon 集成测试覆盖）。"
} > "$RESULTS"

echo "[run] 拆除..."; $COMPOSE down -v >/dev/null 2>&1
echo
echo "==================== §13 验收：${overall} ===================="
echo "完整报告：$RESULTS"
[ "$nbad" -eq 0 ]
