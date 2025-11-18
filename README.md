
# TG 双向机器人超级群组 Cloudflare Worker 版
=======
# Telegram-SuperGM


一个部署在 **Cloudflare Workers** 上的 Telegram 机器人中间层，实现“**私聊 ↔ 超级群话题**”的隔离转发，适合客服、中介、工单等场景。

```text
用户私聊  ──▶ Bot / Worker ──▶ 用户专属话题（Supergroup Topic）
    ▲                               │
    └─────────────◀─────────────────┘
           话题回复回流到用户私聊
```

## 功能亮点

- **一人一话题，不串线**：每个用户在超级群都有独立话题，所有记录集中在该话题里，管理员查阅、跟进更清晰。
- **方向可控的双向转发**：
  - 私聊 → 话题：使用 `forwardMessage`，带“来自谁”的引用，群里能看出是哪位用户。
  - 话题 → 私聊：使用 `copyMessage`，不带转发标记，隐藏群内身份。
- **Turnstile 首次人机验证（可选）**：首条私聊先做人机验证，通过后才真正创建话题并开始转发，降低滥用风险。
- **话题关闭 / 重新开启联动**：
  - 群里关闭话题后，对应用户的私聊消息不再推送到群，只在私聊提示“话题已关闭”。
  - 重新开启话题后，自动恢复转发。

---

## 项目结构

- `woker.js`：Cloudflare Worker 入口，处理 Webhook、读写 KV、调用 Telegram Bot API。
- `README.md`：项目说明文档（当前文件）。

### 相关频道 / 群

- 新站长仓库：<https://t.me/zhanzhangck>
- 站长群：<https://t.me/vpsbbq>

---

## KV 映射设计

使用 Cloudflare KV 记录“用户 ↔ 话题”关系：

| 项目   | 说明                                    |
|--------|-----------------------------------------|
| 绑定名 | `TOPIC_MAP`                             |
| key    | `user:<uid>`                            |
| value  | `{"thread_id", "title", "closed"}` |

- `thread_id`：超级群中话题的 `message_thread_id`。
- `title`：话题标题，使用用户昵称或 `@username`。
- `closed`：布尔值，话题被关闭时为 `true`，此用户的消息将不再推送到群里。

额外使用的 KV key：

- `verified:<uid>`：Turnstile 验证通过标记。
- `verify:<token>`：Turnstile 验证一次性 token 与用户的临时绑定。

---

## 环境变量（Settings → Variables）

| 变量名              | 必须 | 说明 / 示例                                  |
|---------------------|------|----------------------------------------------|
| `BOT_TOKEN`         | 是   | Telegram Bot Token                          |
| `BOT_ID`            | 是   | 机器人自身 user id（通过 `getMe` 获取）     |
| `SUPERGROUP_ID`     | 是   | 目标超级群 chat id，带 `-100` 前缀          |
| `API_BASE`          | 否   | 默认 `https://api.telegram.org`             |
| `TURNSTILE_SITEKEY` | 否   | Turnstile Site Key，启用人机验证时必填      |
| `TURNSTILE_SECRET`  | 否   | Turnstile Secret，启用人机验证时必填        |
| `PUBLIC_BASE`       | 否   | Worker 公网地址，如 `https://tgbot.eve.ink` |

---

## 部署指南（Dashboard）

### 1. Telegram 侧

1. 在 @BotFather 创建机器人，记录 `BOT_TOKEN`。
2. 使用 `/setprivacy` 关闭隐私模式（选择 Disable），保证能收到群内消息。
3. 将 bot 拉入目标超级群：
   - 群内启用话题（Topics）功能；
   - 给 bot 授权“发消息、管理话题”等权限。
4. 获取超级群 `chat_id`（形如 `-100xxxxxxxxxx`），配置为 `SUPERGROUP_ID`。

### 2. Cloudflare 侧

1. 在 Cloudflare Dashboard 创建 KV 命名空间，并在 Worker 中绑定为 `TOPIC_MAP`。
2. 新建 Worker（Modules 模式），拷贝 `woker.js` 代码。
3. 在 Settings → Variables 中配置上面的环境变量值。
4. 如需自定义域名，为 Worker 添加路由，例如 `https://tgbot.xxxx.com/*`。

### 3. 启用 Webhook（非常关键）

Telegram 通过 Webhook 推送消息到你的 Worker：

- 首次部署、换域名、换路径时，一定要重新 `setWebhook`；
- 仅修改代码、域名不变时可以不用重新设置。

示例：使用默认 `*.workers.dev` 域名：

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tgbot.xxx.workers.dev"
```

示例：使用自定义域名：

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tgbot.xxxx.com"
```

执行后可通过 `getWebhookInfo` 确认 `url` 是否已是最新地址。

### 4. 验证

1. 自己先私聊 bot，若启用 Turnstile，会先收到人机验证链接；验证通过后再继续。
2. 再发一条普通消息：
   - 超级群应自动创建一个以你昵称/`@username` 命名的话题；
   - 私聊消息会带引用转发到该话题中。
3. 在该话题中回复：
   - bot 会把消息复制回你的私聊，不带“转发自”标记。
4. 在话题菜单中关闭话题后，再次发消息应只收到“话题已关闭”的提示，不再推送到群；重新开启话题后又会恢复转发。

---

## 调试与日志

建议使用 `wrangler` 实时查看 Worker 日志：

```bash
npm install -g wrangler
wrangler login
wrangler tail <Worker名>   # 例如 wrangler tail tgbot
```

如果需要查看完整的 Telegram `update`，可以在 `fetch` 或处理函数中临时加上：

```js
console.log(JSON.stringify(update, null, 2));
```

再通过 `wrangler tail` 观察输出。

---

## 常见问题（FAQ）

1. `getWebhookInfo` 报 `Wrong response from the webhook: 404 Not Found`？  
   - 多数是 Webhook URL 写错，或 Worker 仍然是默认模板 `return fetch(request)`；
   - 请确认 URL 与实际 Worker 域名/路径一致，并已替换为本项目的 `woker.js`。

2. `wrangler tail` 看不到任何日志？  
   - 本地先手动打一个 POST：
     ```bash
     curl -X POST "https://tgbot.xxx.workers.dev" -H "content-type: application/json" -d "{}"
     ```
   - 若仍看不到调用，说明请求未命中 Worker：检查域名是否正确、是否成功 Deploy、Workers 路由是否配置。

3. 关闭话题后仍有消息推送进来？  
   - 确认 bot 账户在群里能看到 `forum_topic_closed` / `forum_topic_reopened` 事件（`wrangler tail` 中应有对应字段）；
   - 如果是直接删除话题（而不是关闭），Worker 会认为线程不存在并为该用户创建新的话题，这是当前的默认行为。

---

## 安全提示

- **不要泄露 Bot Token**。若不慎泄露，请立即在 @BotFather 中执行 `/revoke` 并更新 Worker 的 `BOT_TOKEN`。
- KV 中仅存“用户 id ↔ 话题 id / 状态”等元数据，不存聊天内容；聊天记录由 Telegram 自身保存。
