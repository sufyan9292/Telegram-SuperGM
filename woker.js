// Cloudflare Worker 入口（Turnstile + 相册聚合：最多 10 张，2 秒超时 flush）
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/verify") {
      if (request.method === "GET") return renderVerifyPage(url, env);
      if (request.method === "POST") return handleVerifySubmit(request, env);
    }

    if (request.method !== "POST") return new Response("OK");

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    // 先尝试 flush 超时的媒体组（>2 秒未追加）
    await flushExpiredMediaGroups(env, Date.now());

    if (msg.chat && msg.chat.type === "private") {
      await handlePrivateMessage(msg, env);
      return new Response("OK");
    }

    const supergroupId = Number(env.SUPERGROUP_ID);
    if (msg.chat && Number(msg.chat.id) === supergroupId) {
      if (msg.forum_topic_closed && msg.message_thread_id) {
        await markThreadClosed(msg.message_thread_id, env);
        return new Response("OK");
      }
      if (msg.forum_topic_reopened && msg.message_thread_id) {
        await markThreadReopened(msg.message_thread_id, env);
        return new Response("OK");
      }
      if (msg.message_thread_id) {
        await handleTopicMessage(msg, env);
        return new Response("OK");
      }
    }

    return new Response("OK");
  },
};

// 私聊 -> 话题
async function handlePrivateMessage(msg, env) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  if (msg.text && msg.text.trim().toLowerCase().startsWith("/start")) return;

  // Turnstile 验证
  if (env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY) {
    const verified = await isVerified(userId, env);
    if (!verified) {
      const token = crypto.randomUUID();
      await env.TOPIC_MAP.put(`verify:${token}`, JSON.stringify({ uid: userId }), { expirationTtl: 900 });
      const base = env.PUBLIC_BASE;
      if (base) {
        const link = `${base.replace(/\/$/, "")}/verify?token=${token}`;
        await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: [
            "⚠️ 检测到这是你第一次使用，请先完成人机验证：",
            `🔗 ${link}`,
            "",
            "请在网页中看到“验证成功，请回到 Telegram 继续对话”提示后，",
            "再回到这里继续发消息，否则会一直重复要求验证。"
          ].join("\n"),
        });
      }
      return;
    }
  }

  let rec = await env.TOPIC_MAP.get(key, { type: "json" });
  if (rec && rec.closed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "当前话题已被管理员关闭，如需继续对话请联系管理员或等待重新开启。",
    });
    return;
  }
  if (!rec) rec = await createAndStoreTopic(msg.from, key, env);

  // 相册聚合：用户 -> 话题
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, { direction: "p2t", targetChat: env.SUPERGROUP_ID, threadId: rec.thread_id });
    return;
  }

  const res = await tgCall(env, "forwardMessage", {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: rec.thread_id,
  });

  if (!res.ok && isThreadMissingError(res)) {
    const newRec = await createAndStoreTopic(msg.from, key, env);
    await tgCall(env, "forwardMessage", {
      chat_id: env.SUPERGROUP_ID,
      from_chat_id: userId,
      message_id: msg.message_id,
      message_thread_id: newRec.thread_id,
    });
  }
}

// 话题 -> 私聊
async function handleTopicMessage(msg, env) {
  const threadId = msg.message_thread_id;
  const botId = Number(env.BOT_ID || 0);
  if (msg.from && Number(msg.from.id) === botId) return;

  const userId = await findUserByThread(threadId, env);
  if (!userId) return;

  // 相册聚合：话题 -> 用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, { direction: "t2p", targetChat: userId, threadId: null });
    return;
  }

  const res = await tgCall(env, "copyMessage", {
    chat_id: userId,
    from_chat_id: env.SUPERGROUP_ID,
    message_id: msg.message_id,
  });
  if (!res.ok) {
    const res2 = await tgCall(env, "forwardMessage", {
      chat_id: userId,
      from_chat_id: env.SUPERGROUP_ID,
      message_id: msg.message_id,
    });
    console.log("forwardMessage fallback result", { ok: res2.ok, error_code: res2.error_code, description: res2.description });
  }
}

// 创建话题
async function createAndStoreTopic(from, key, env) {
  const title = buildTopicTitle(from);
  const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error("createForumTopic failed: " + res.description);
  const rec = { thread_id: res.result.message_thread_id, title, closed: false };
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  return rec;
}

// 话题标题：昵称 + @username
function buildTopicTitle(from) {
  const first = from.first_name || "";
  const last = from.last_name || "";
  const nick = `${first} ${last}`.trim();
  if (from.username) {
    const at = "@" + from.username;
    return (nick ? `${nick} ${at}` : at).slice(0, 128);
  }
  return (nick || "User").slice(0, 128);
}

// Telegram API
async function tgCall(env, method, body) {
  const base = env.API_BASE || "https://api.telegram.org";
  const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return await resp.json();
  } catch {
    return { ok: false, description: "invalid json from telegram" };
  }
}

function isThreadMissingError(res) {
  if (!res || res.ok) return false;
  const desc = (res.description || "").toUpperCase();
  return (
    desc.includes("MESSAGE THREAD NOT FOUND") ||
    desc.includes("MESSAGE_THREAD_NOT_FOUND") ||
    desc.includes("THREAD_NOT_FOUND") ||
    desc.includes("TOPIC_NOT_FOUND") ||
    desc.includes("FORUM_TOPIC_NOT_FOUND")
  );
}

async function markThreadClosed(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: "user:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      rec.closed = true;
      await env.TOPIC_MAP.put(name, JSON.stringify(rec));
      break;
    }
  }
}
async function markThreadReopened(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: "user:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      rec.closed = false;
      await env.TOPIC_MAP.put(name, JSON.stringify(rec));
      break;
    }
  }
}

// Turnstile 状态
async function isVerified(uid, env) {
  const flag = await env.TOPIC_MAP.get(`verified:${uid}`);
  return Boolean(flag);
}

// 按 thread_id 反查用户
async function findUserByThread(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: "user:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) return Number(name.slice("user:".length));
  }
  return null;
}

// Turnstile 页面
function renderVerifyPage(url, env) {
  const token = url.searchParams.get("token") || "";
  const sitekey = env.TURNSTILE_SITEKEY;
  if (!sitekey || !token) return new Response("Missing token or sitekey", { status: 400 });
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8" /><title>人机验证</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head>
<body>
  <h3>请完成人机验证</h3>
  <form method="POST" action="/verify">
    <div class="cf-turnstile" data-sitekey="${sitekey}"></div>
    <input type="hidden" name="token" value="${token}" />
    <button type="submit">提交</button>
  </form>
</body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

// Turnstile 提交
async function handleVerifySubmit(request, env) {
  const form = await request.formData();
  const respToken = form.get("cf-turnstile-response");
  const token = form.get("token");
  if (!respToken || !token) return new Response("缺少验证信息", { status: 400 });

  const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: respToken }),
  });
  const data = await verifyRes.json();
  if (!data.success) return new Response("验证失败，请返回重试", { status: 400 });

  const record = await env.TOPIC_MAP.get(`verify:${token}`, { type: "json" });
  if (!record || !record.uid) return new Response("验证超时或记录不存在", { status: 400 });

  await env.TOPIC_MAP.put(`verified:${record.uid}`, "1");
  await env.TOPIC_MAP.delete(`verify:${token}`);
  console.log("verified-set", { uid: record.uid });

  try {
    await tgCall(env, "sendMessage", { chat_id: record.uid, text: "✅ 人机验证成功，可以回到和机器人的私聊继续发送消息了。" });
  } catch {}

  return new Response("验证成功，请回到 Telegram 继续对话。", { status: 200 });
}

// ---------------- 媒体组批量发送：攒到 10 张，或 2 秒未追加则发送 ----------------
async function handleMediaGroup(msg, env, { direction, targetChat, threadId }) {
  const groupId = msg.media_group_id;
  const key = `mg:${direction}:${groupId}`;
  const now = Date.now();

  const item = extractMedia(msg, direction, msg.chat.id, msg.message_id);
  if (!item) {
    console.log("media group item unsupported, fallback single", { groupId });
    return direction === "p2t"
      ? tgCall(env, "forwardMessage", { chat_id: targetChat, from_chat_id: msg.chat.id, message_id: msg.message_id, message_thread_id: threadId })
      : tgCall(env, "copyMessage", { chat_id: targetChat, from_chat_id: msg.chat.id, message_id: msg.message_id });
  }

  let rec = await env.TOPIC_MAP.get(key, { type: "json" });
  if (!rec) rec = { direction, targetChat, threadId, items: [], last_ts: now };

  rec.items.push(item);
  rec.last_ts = now;
  await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: 60 });
  console.log("media group buffered", { key, count: rec.items.length });

  // 满 10 张立即发送
  if (rec.items.length >= 10) {
    await flushMediaGroup(rec, env, key);
    await env.TOPIC_MAP.delete(key);
  }
}

function extractMedia(msg, direction, fromChatId, messageId) {
  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    return { type: "photo", file_id: best.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  }
  if (msg.video) return { type: "video", file_id: msg.video.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  if (msg.document) return { type: "document", file_id: msg.document.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  return null;
}

// 遍历所有 mg:*，超过 2 秒未追加就发送
async function flushExpiredMediaGroups(env, now) {
  const list = await env.TOPIC_MAP.list({ prefix: "mg:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (!rec || !rec.items || !rec.items.length) {
      await env.TOPIC_MAP.delete(name);
      continue;
    }
    if (now - (rec.last_ts || 0) > 2000) { // 2秒未追加，认为该组结束
      await flushMediaGroup(rec, env, name);
      await env.TOPIC_MAP.delete(name);
    }
  }
}

async function flushMediaGroup(rec, env, key) {
  if (rec.items.length === 1) {
    // 单条，用普通 copy/forward
    const it = rec.items[0];
    if (rec.direction === "p2t") {
      await tgCall(env, "forwardMessage", {
        chat_id: rec.targetChat,
        from_chat_id: it.from_chat_id,
        message_id: it.message_id,
        message_thread_id: rec.threadId,
      });
    } else {
      await tgCall(env, "copyMessage", {
        chat_id: rec.targetChat,
        from_chat_id: it.from_chat_id,
        message_id: it.message_id,
      });
    }
    console.log("flushMediaGroup single", { key });
    return;
  }

  const media = rec.items.map((it, idx) => ({ type: it.type, media: it.file_id, caption: idx === 0 ? it.caption : undefined }));
  const payload = { chat_id: rec.targetChat, media };
  if (rec.direction === "p2t" && rec.threadId) payload.message_thread_id = rec.threadId;

  const res = await tgCall(env, "sendMediaGroup", payload);
  console.log("sendMediaGroup result", { key, ok: res.ok, error_code: res.error_code, description: res.description });
}
