# 本地复现「Reset 已确认」

本文复现 README 里的第二行结果：演示账号发一条「已发生」的帖子，页面从概率切换为「Reset 已确认」。全程在本机 Docker 里运行，不连接 X，不需要任何凭据。回到 [README](../README.md)。

前提：已按 README 的「快速开始」准备好 `.env`，终端是 bash 或 zsh（Windows 用 Git Bash），Node.js 24 可用。

## 为什么要换一份目标文件

仓库自带的 `config/target.json` 是演示模式，演示模式下 worker 只读内置的 3 条示例帖，不读推送收件箱。所以这里借用 live 示例文件的结构，把追踪账号换成演示账号 `demo-tibo`，并让它同时是权威账号。`DEMO_MODE` 保持 `true`，页面仍然标「演示数据」。

## 步骤

1. 生成演示目标文件。它放在 `config/` 里，随镜像一起构建，不需要挂载文件（Windows 的 Git Bash 会改写挂载路径，容易出错）：

   ```bash
   node -e '
   const fs = require("node:fs");
   const c = JSON.parse(fs.readFileSync("config/target.live.example.json", "utf8"));
   c.target = { userId: "demo-tibo", handle: "tibo_demo", displayName: "Tibo" };
   c.authoritativeUserIds = ["demo-tibo"];
   fs.writeFileSync("config/demo-confirm.target.json", JSON.stringify(c, null, 2));
   '
   ```

2. 构建镜像（镜像名是 `tibo-reset-radar-radar`），然后用推送收件箱模式启动一个容器，端口 8788，worker 每 5 秒跑一轮：

   ```bash
   docker compose build
   docker run -d --name radar-confirm -p 127.0.0.1:8788:8787 --env-file .env \
     -e RADAR_COLLECTOR_MODE=inbox -e RADAR_INGEST_TOKEN=local-demo-token -e POLL_INTERVAL_MS=5000 \
     -e TARGET_CONFIG_PATH=config/demo-confirm.target.json \
     tibo-reset-radar-radar
   curl -s http://127.0.0.1:8788/api/reset-status
   ```

   预期输出：`{"state":"forecasting","event":null}`。

3. 推送一条演示账号发的帖子：

   ```bash
   node -e '
   const { createHash } = require("node:crypto");
   const text = "Usage limits have been reset for all paid users. The reset is complete.";
   const now = new Date().toISOString();
   console.log(JSON.stringify({ posts: [{
     postId: "2001", authorId: "demo-tibo", authorDisplayName: "Tibo", authorHandle: "tibo_demo",
     authorAvatarUrl: null, sourceKind: "post", conversationId: "2001", referencedPostIds: [],
     language: "en", sourceUrl: "https://x.com/tibo_demo/status/2001", text,
     contentHash: createHash("sha256").update(text).digest("hex"),
     createdAt: now, observedAt: now, editedAt: null, deletedAt: null,
   }] }));
   ' | curl -s -X POST http://127.0.0.1:8788/api/ingest/posts \
     -H "authorization: Bearer local-demo-token" -H "content-type: application/json" --data @-
   ```

   预期输出：`{"received":1,"stored":1}`。

4. 等约 10 秒，再查状态，并打开 <http://127.0.0.1:8788>：

   ```bash
   curl -s http://127.0.0.1:8788/api/reset-status
   ```

   预期输出（`occurredAt` 是你推送的时间）：

   ```json
   {"state":"confirmed_reset","event":{"eventId":"reset-2001","status":"confirmed_reset","occurredAt":"2026-10-20T10:04:49.916Z","scope":"all","evidencePostIds":["2001"],"supersedesEventId":null}}
   ```

   页面显示「Reset 已确认」，未来 24 小时概率回落到冷却期基线 8%。

5. 清理：

   ```bash
   docker rm -f radar-confirm
   rm config/demo-confirm.target.json
   ```

## 对照：承诺不算确认

另起一个全新容器（把第 2 步的容器名和端口换掉，避免沿用已确认的状态），把第 3 步的 `text` 换成 `The next usage reset is planned for tomorrow if the rollout stays healthy.`，并把 `postId`、`conversationId`、`sourceUrl` 里的 `2001` 换成 `2002`。状态仍是 `forecasting`：对未来的承诺只当预测信号。
