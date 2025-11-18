// Cloudflare Worker 入口（日志调试版 + 媒体组批量转发）
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/verify') {
      if (request.method === 'GET') return renderVerifyPage(url, env);
      if (request.method === 'POST') return handleVerifySubmit(request, env);
    }

    if (request.method !== 'POST') return new Response('OK');

    let update;
    try {
      update = await request.json();
    } catch (err) {
      console.log('parse update failed', String(err));
      return new Response('OK');
    }

    const msg = update.message;
    if (!msg) {
      console.log('update without message', JSON.stringify(update));
      return new Response('OK');
    }

    console.log('update summary', {
      from_id: msg.from && msg.from.id,
      from_name: msg.from && `${msg.from.first_name ?? ''} ${msg.from.last_name ?? ''}`.trim(),
      chat_id: msg.chat && msg.chat.id,
      chat_type: msg.chat && msg.chat.type,
      thread_id: msg.message_thread_id,
      forum_topic_closed: !!msg.forum_topic_closed,
      forum_topic_reopened: !!msg.forum_topic_reopened,
      media_group_id: msg.media_group_id
    });

    if (msg.chat && msg.chat.type === 'private') {
      await handlePrivateMessage(msg, env);
      return new Response('OK');
    }

    const supergroupId = Number(env.SUPERGROUP_ID);
    if (msg.chat && Number(msg.chat.id) === supergroupId) {
      if (msg.forum_topic_closed && msg.message_thread_id) {
        await markThreadClosed(msg.message_thread_id, env);
        return new Response('OK');
      }
      if (msg.forum_topic_reopened && msg.message_thread_id) {
        await markThreadReopened(msg.message_thread_id, env);
        return new Response('OK');
      }
      if (msg.message_thread_id) {
        await handleTopicMessage(msg, env);
        return new Response('OK');
      }
    }

    console.log('message ignored');
    return new Response('OK');
  }
};

// 私聊 -> 话题
async function handlePrivateMessage(msg, env) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;
  console.log('handlePrivateMessage', { userId, text: msg.text });

  if (msg.text && msg.text.trim().toLowerCase().startsWith('/start')) {
    return;
  }

  // Turnstile 验证
  if (env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY) {
    const verified = await isVerified(userId, env);
    console.log('isVerified', { userId, verified });
    if (!verified) {
      const token = crypto.randomUUID();
      await env.TOPIC_MAP.put(`verify:${token}`, JSON.stringify({ uid: userId }), { expirationTtl: 900 });
      const base = env.PUBLIC_BASE;
      if (base) {
        const link = `${base.replace(/\/$/, '')}/verify?token=${token}`;
        await tgCall(env, 'sendMessage', {
          chat_id: userId,
          text: [
            '⚠️ 检测到这是你第一次使用，请先完成人机验证：',
            `🔗 ${link}`,
            '',
            '请在网页中看到“验证成功，请回到 Telegram 继续对话”提示后，',
            '再回到这里继续发消息，否则会一直重复要求验证。'
          ].join('\n')
        });
      }
      return;
    }
  }

  let rec = await env.TOPIC_MAP.get(key, { type: 'json' });
  console.log('kv topic record', { key, rec });

  if (rec && rec.closed) {
    await tgCall(env, 'sendMessage', {
      chat_id: userId,
      text: '当前话题已被管理员关闭，如需继续对话请联系管理员或等待重新开启。'
    });
    return;
  }

  if (!rec) rec = await createAndStoreTopic(msg.from, key, env);

  // 相册批量：用户 -> 话题
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, { direction: 'p2t', targetChat: env.SUPERGROUP_ID, threadId: rec.thread_id });
    return;
  }

  const res = await tgCall(env, 'forwardMessage', {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: rec.thread_id
  });

  if (!res.ok) {
    console.log('forwardMessage failed', { userId, thread_id: rec.thread_id, error_code: res.error_code, description: res.description });
    if (isThreadMissingError(res)) {
      const newRec = await createAndStoreTopic(msg.from, key, env);
      await tgCall(env, 'forwardMessage', {
        chat_id: env.SUPERGROUP_ID,
        from_chat_id: userId,
        message_id: msg.message_id,
        message_thread_id: newRec.thread_id
      });
    }
  }
}

// 话题 -> 私聊
async function handleTopicMessage(msg, env) {
  const threadId = msg.message_thread_id;
  const botId = Number(env.BOT_ID || 0);
  if (msg.from && Number(msg.from.id) === botId) return;

  const userId = await findUserByThread(threadId, env);
  if (!userId) return;

  // 相册批量：话题 -> 用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, { direction: 't2p', targetChat: userId, threadId: null });
    return;
  }

  const res = await tgCall(env, 'copyMessage', {
    chat_id: userId,
    from_chat_id: env.SUPERGROUP_ID,
    message_id: msg.message_id
  });
  if (!res.ok) {
    console.log('copyMessage failed, fallback forward', { error_code: res.error_code, description: res.description });
    const res2 = await tgCall(env, 'forwardMessage', {
      chat_id: userId,
      from_chat_id: env.SUPERGROUP_ID,
      message_id: msg.message_id
    });
    console.log('forwardMessage fallback result', { ok: res2.ok, error_code: res2.error_code, description: res2.description });
  }
}

// 创建话题
async function createAndStoreTopic(from, key, env) {
  const title = buildTopicTitle(from);
  const res = await tgCall(env, 'createForumTopic', { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error('createForumTopic failed: ' + res.description);
  const rec = { thread_id: res.result.message_thread_id, title, closed: false };
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  return rec;
}

// 话题标题：昵称 + @username
function buildTopicTitle(from) {
  const first = from.first_name || '';
  const last = from.last_name || '';
  const nick = `${first} ${last}`.trim();
  if (from.username) {
    const at = '@' + from.username;
    return (nick ? `${nick} ${at}` : at).slice(0, 128);
  }
  return (nick || 'User').slice(0, 128);
}

// Telegram API
async function tgCall(env, method, body) {
  const base = env.API_BASE || 'https://api.telegram.org';
  const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  try { return await resp.json(); } catch { return { ok: false, description: 'invalid json from telegram' }; }
}

function isThreadMissingError(res) {
  if (!res || res.ok) return false;
  const desc = (res.description || '').toUpperCase();
  const hit = desc.includes('MESSAGE THREAD NOT FOUND') || desc.includes('MESSAGE_THREAD_NOT_FOUND') || desc.includes('THREAD_NOT_FOUND') || desc.includes('TOPIC_NOT_FOUND') || desc.includes('FORUM_TOPIC_NOT_FOUND');
  console.log('isThreadMissingError', { desc, hit });
  return hit;
}

async function markThreadClosed(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: 'user:' });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: 'json' });
    if (rec && Number(rec.thread_id) === Number(threadId)) { rec.closed = true; await env.TOPIC_MAP.put(name, JSON.stringify(rec)); break; }
  }
}
async function markThreadReopened(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: 'user:' });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: 'json' });
    if (rec && Number(rec.thread_id) === Number(threadId)) { rec.closed = false; await env.TOPIC_MAP.put(name, JSON.stringify(rec)); break; }
  }
}

// Turnstile 状态
async function isVerified(uid, env) {
  const flag = await env.TOPIC_MAP.get(`verified:${uid}`);
  return Boolean(flag);
}

// 按 thread_id 反查用户（遍历 KV 映射）
async function findUserByThread(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: 'user:' });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: 'json' });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      return Number(name.slice('user:'.length));
    }
  }
  return null;
}

// Turnstile 页面
function renderVerifyPage(url, env) {
  const token = url.searchParams.get('token') || '';
  const sitekey = env.TURNSTILE_SITEKEY;
  if (!sitekey || !token) return new Response('Missing token or sitekey', { status: 400 });
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
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// Turnstile 提交
async function handleVerifySubmit(request, env) {
  const form = await request.formData();
  const respToken = form.get('cf-turnstile-response');
  const token = form.get('token');
  if (!respToken || !token) return new Response('缺少验证信息', { status: 400 });

  const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: respToken })
  });
  const data = await verifyRes.json();
  if (!data.success) return new Response('验证失败，请返回重试', { status: 400 });

  const record = await env.TOPIC_MAP.get(`verify:${token}`, { type: 'json' });
  if (!record || !record.uid) return new Response('验证超时或记录不存在', { status: 400 });

  await env.TOPIC_MAP.put(`verified:${record.uid}`, '1');
  await env.TOPIC_MAP.delete(`verify:${token}`);
  console.log('verified-set', { uid: record.uid });

  try {
    await tgCall(env, 'sendMessage', { chat_id: record.uid, text: '✅ 人机验证成功，可以回到和机器人的私聊继续发送消息了。' });
  } catch {}

  return new Response('验证成功，请回到 Telegram 继续对话。', { status: 200 });
}

// ---------------- 媒体组批量发送 ----------------
async function handleMediaGroup(msg, env, { direction, targetChat, threadId }) {
  const groupId = msg.media_group_id;
  const key = `mg:${direction}:${groupId}`;
  const now = Date.now();

  const item = extractMedia(msg);
  if (!item) {
    console.log('media group item unsupported, fallback single', { groupId });
    return direction === 'p2t'
      ? tgCall(env, 'forwardMessage', {
          chat_id: targetChat,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
          message_thread_id: threadId
        })
      : tgCall(env, 'copyMessage', {
          chat_id: targetChat,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id
        });
  }

  let rec = await env.TOPIC_MAP.get(key, { type: 'json' });
  if (!rec) rec = { targetChat, threadId, items: [], first_ts: now };

  rec.items.push(item);
  await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: 60 });
  console.log('media group buffered', { key, count: rec.items.length });

  const shouldGroup = rec.items.length >= 2;
  const shouldSingle = rec.items.length === 1 && now - rec.first_ts > 1500;

  if (shouldGroup) {
    await flushMediaGroup(rec, env, key, direction);
  } else if (shouldSingle) {
    await flushSingleMedia(msg, env, direction, targetChat, threadId);
    await env.TOPIC_MAP.delete(key);
  }
}

function extractMedia(msg) {
  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    return { type: 'photo', file_id: best.file_id, caption: msg.caption || '' };
  }
  if (msg.video) return { type: 'video', file_id: msg.video.file_id, caption: msg.caption || '' };
  if (msg.document) return { type: 'document', file_id: msg.document.file_id, caption: msg.caption || '' };
  return null;
}

async function flushMediaGroup(rec, env, key, direction) {
  const media = rec.items.map((it, idx) => ({ type: it.type, media: it.file_id, caption: idx === 0 ? it.caption : undefined }));
  const payload = { chat_id: rec.targetChat, media };
  if (direction === 'p2t' && rec.threadId) payload.message_thread_id = rec.threadId;

  const res = await tgCall(env, 'sendMediaGroup', payload);
  console.log('sendMediaGroup result', { key, ok: res.ok, error_code: res.error_code, description: res.description });
  await env.TOPIC_MAP.delete(key);
}

async function flushSingleMedia(msg, env, direction, targetChat, threadId) {
  if (direction === 'p2t') {
    await tgCall(env, 'forwardMessage', {
      chat_id: targetChat,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
      message_thread_id: threadId
    });
  } else {
    await tgCall(env, 'copyMessage', {
      chat_id: targetChat,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  }
}

