# Telegram-SuperGM

本项目是部署在 **Cloudflare Workers** 上的 Telegram 机器人中间层，实现“私聊 ↔ 超级群话题”的隔离转发：

- **一人一话题**：每个用户在超级群都有独立话题，消息不串线、便于跟进。
- 私聊 → 话题：带引用转发，保留“来自谁”。
- 话题 → 私聊：无引用复制，隐藏群内身份。

核心代码：`woker.js`

## 目录
- `woker.js`：Worker 入口，处理 Telegram Webhook，读写 KV，调用 Bot API。
- `README.md`：使用说明。

## 相关频道/群
- 新站长仓库：https://t.me/zhanzhangck
- 站长群：https://t.me/vpsbbq

## KV 映射
- 绑定名：`TOPIC_MAP`
- key：`user:<uid>`
- value：`{ thread_id, title }`

## 可选增强
- **Turnstile 首次验证**：首条私聊先给验证链接，通过后才建话题并转发，防滥用。
- **过滤 /start**：私聊里的 `/start` 直接忽略/自定义回复，不转发到群。
- **话题关闭拦截**：若话题被关闭，转发报“topic closed/thread not found”时暂停该用户推送，重开或重建后再恢复。

## 必要环境变量（Settings → Variables）
- `BOT_TOKEN`：Telegram Bot Token。
- `BOT_ID`：机器人自身 user id（`getMe` 获取）。
- `SUPERGROUP_ID`：目标超级群 chat id，带 `-100` 前缀。
- `API_BASE`：可选，默认 `https://api.telegram.org`。
- `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET`：开启人机验证时必填。
- `PUBLIC_BASE`：Worker 公网地址，如 `https://tgbot.eve.ink`，用于生成验证链接。

## 部署流程（Dashboard）
1. BotFather 创建机器人，`/setprivacy` 关闭隐私模式。
2. 把 bot 拉进超级群，开启话题功能并授予“发消息、管理话题”权限。
3. Cloudflare 创建 Worker，使用 `woker.js` 代码。
4. 创建 KV 命名空间并绑定为 `TOPIC_MAP`。
5. 配置以上环境变量并部署。
6. **务必执行 setWebhook 告诉 Telegram 你的域名**：
   - 首次部署/换域名/换路径都要重设：
     ```bash
     curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tgbot.xxx.workers.dev"
     ```
   - 换自定义域名（如 `https://tgbot.xxxx.com`）也要重设：
     ```bash
     curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tgbot.xxxx.com"
     ```
   - 仅改代码、域名未变可不必重设。
7. 私聊 bot 测试是否自动建话题并能双向同步。

## 调试与日志
- 安装 `wrangler` 后实时 tail：
  ```bash
  npm install -g wrangler
  wrangler login
  wrangler tail <Worker名>   # 如 wrangler tail tgbot
  ```
- 若需看完整 update，可在代码里临时 `console.log(JSON.stringify(update, null, 2));` 后再 tail。

## 常见问题
1) `getWebhookInfo` 报 404 Wrong response
   - 通常是 Webhook URL 写错，确认与实际 Worker 域名/路径一致；或 Worker 仍是默认模板 `return fetch(request)`，请换成 `woker.js`。
2) `wrangler tail` 没日志
   - 本地 `curl -X POST https://tgbot.xxx.workers.dev -d "{}"` 测试；若仍无日志，说明请求未命中 Worker，检查域名或是否已 Deploy。
3) 话题被删/关闭后报错
   - `handlePrivateMessage` 内有重建逻辑；可在 `isThreadError` 补充错误关键词，或在 KV 标记关闭状态。

## 安全提示
- **不要泄露 Bot Token**。若泄露，立即在 @BotFather `/revoke` 并更新 Worker 的 `BOT_TOKEN`。
- KV 仅存“用户 id ↔ 话题 id”映射，不存聊天内容；聊天记录由 Telegram 保管。
