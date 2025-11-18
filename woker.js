// Cloudflare Worker 入口（日志调试版）
export default {
  async fetch(request, env, ctx) {
    // Turnstile 验证页面/回调
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
      forum_topic_reopened: !!msg.forum_topic_reopened
    });

    if (msg.chat && msg.chat.type === 'private') {
      await handlePrivateMessage(msg, env);
      return new Response('OK');
    }

    const supergroupId = Number(env.SUPERGROUP_ID);
    if (msg.chat && Number(msg.chat.id) === supergroupId) {
      if (msg.forum_topic_closed && msg.message_thread_id) {
        console.log('forum_topic_closed', { thread_id: msg.message_thread_id });
        await markThreadClosed(msg.message_thread_id, env);
        return new Response('OK');
      }
      if (msg.forum_topic_reopened && msg.message_thread_id) {
        console.log('forum_topic_reopened', { thread_id: msg.message_thread_id });
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

async function handlePrivateMessage(msg, env) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;
  console.log('handlePrivateMessage', { userId, text: msg.text });

  if (msg.text && msg.text.trim().toLowerCase().startsWith('/start')) {
    console.log('ignore /start', { userId });
    return;
  }

  if (env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY) {
    const verified = await isVerified(userId, env);
    console.log('isVerified', { userId, verified });
    if (!verified) {
      const token = crypto.randomUUID();
      await env.TOPIC_MAP.put(`verify:${token}`, JSON.stringify({ uid: userId }), { expirationTtl: 900 });
      const base = env.PUBLIC_BASE;
      if (base) {
        const link = `${base.replace(/\/$/, '')}/verify?token=${token}`;
        console.log('send verify link', { userId, link });
        await tgCall(env, 'sendMessage', {
          chat_id: userId,
          text: `⚠️ 请先完成人机验证再继续：\n🔗 ${link}`
        });
      } else {
        console.log('PUBLIC_BASE not set, cannot send verify link');
      }
      return;
    }
  }

  let rec = await env.TOPIC_MAP.get(key, { type: 'json' });
  console.log('kv topic record', { key, rec });

  if (rec && rec.closed) {
    console.log('topic closed flag hit', { userId });
    await tgCall(env, 'sendMessage', {
      chat_id: userId,
      text: '当前话题已被管理员关闭，如需继续对话请联系管理员或等待重新开启。'
    });
    return;
  }

  if (!rec) {
    console.log('create topic for user', { userId });
    rec = await createAndStoreTopic(msg.from, key, env);
  }

  const res = await tgCall(env, 'forwardMessage', {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: rec.thread_id
  });

  if (!res.ok) {
    console.log('forwardMessage failed', {
      userId,
      thread_id: rec.thread_id,
      error_code: res.error_code,
      description: res.description
    });
    if (isThreadMissingError(res)) {
      console.log('thread missing → recreate topic', { userId });
      const newRec = await createAndStoreTopic(msg.from, key, env);
      await tgCall(env, 'forwardMessage', {
        chat_id: env.SUPERGROUP_ID,
        from_chat_id: userId,
        message_id: msg.message_id,
        message_thread_id: newRec.thread_id
      });
    }
  } else {
    console.log('forwardMessage ok', { userId, thread_id: rec.thread_id });
  }
}

async function handleTopicMessage(msg, env) {
  const threadId = msg.message_thread_id;
  console.log('handleTopicMessage', { threadId, text: msg.text });

  const botId = Number(env.BOT_ID || 0);
  if (msg.from && Number(msg.from.id) === botId) {
    console.log('ignore bot self message in topic');
    return;
  }

  const userId = await findUserByThread(threadId, env);
  console.log('topic->user mapping', { threadId, userId });
  if (!userId) return;

  const res = await tgCall(env, 'copyMessage', {
    chat_id: userId,
    from_chat_id: env.SUPERGROUP_ID,
    message_id: msg.message_id
  });
  console.log('copyMessage result', { ok: res.ok, error_code: res.error_code, description: res.description });
}

async function createAndStoreTopic(from, key, env) {
  const title = buildTopicTitle(from);
  console.log('createForumTopic', { key, title, from_id: from && from.id });

  const res = await tgCall(env, 'createForumTopic', {
    chat_id: env.SUPERGROUP_ID,
    name: title
  });

  if (!res.ok) {
    console.log('createForumTopic failed', { error_code: res.error_code, description: res.description });
    throw new Error('createForumTopic failed: ' + res.description);
  }

  const threadId = res.result.message_thread_id;
  const rec = { thread_id: threadId, title, closed: false };
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  console.log('topic stored', { key, rec });
  return rec;
}

async function findUserByThread(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: 'user:' });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: 'json' });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      console.log('findUserByThread hit', { threadId, name });
      return Number(name.slice('user:'.length));
    }
  }
  console.log('findUserByThread miss', { threadId });
  return null;
}

function buildTopicTitle(from) {
  const first = from.first_name || '';
  const last = from.last_name || '';
  const nick = `${first} ${last}`.trim();

  if (from.username) {
    const at = '@' + from.username;
    const title = nick ? `${nick} ${at}` : at;
    const truncated = title.slice(0, 128);
    console.log('buildTopicTitle username', { nick, username: from.username, title: truncated });
    return truncated;
  }

  const fallback = (nick || 'User').slice(0, 128);
  console.log('buildTopicTitle fallback', { fallback });
  return fallback;
}

async function tgCall(env, method, body) {
  const base = env.API_BASE || 'https://api.telegram.org';
  const url = `${base}/bot${env.BOT_TOKEN}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data;
  try {
    data = await resp.json();
  } catch (err) {
    console.log('tgCall json parse failed', method, String(err));
    data = { ok: false, description: 'invalid json from telegram' };
  }
  return data;
}

function isThreadMissingError(res) {
  if (!res || res.ok) return false;
  const desc = (res.description || '').toUpperCase();
  const hit =
    desc.includes('MESSAGE THREAD NOT FOUND') ||
    desc.includes('MESSAGE_THREAD_NOT_FOUND') ||
    desc.includes('THREAD_NOT_FOUND') ||
    desc.includes('TOPIC_NOT_FOUND') ||
    desc.includes('FORUM_TOPIC_NOT_FOUND');
  console.log('isThreadMissingError', { desc, hit });
  return hit;
}

async function markThreadClosed(threadId, env) {
  console.log('markThreadClosed', { threadId });
  const list = await env.TOPIC_MAP.list({ prefix: 'user:' });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: 'json' });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      rec.closed = true;
      await env.TOPIC_MAP.put(name, JSON.stringify(rec));
      console.log('thread marked closed', { name });
      break;
    }
  }
}

async function markThreadReopened(threadId, env) {
  console.log('markThreadReopened', { threadId });
  const list = await env.TOPIC_MAP.list({ prefix: 'user:' });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: 'json' });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      rec.closed = false;
      await env.TOPIC_MAP.put(name, JSON.stringify(rec));
      console.log('thread reopen flag cleared', { name });
      break;
    }
  }
}

async function isVerified(uid, env) {
  const key = `verified:${uid}`;
  const flag = await env.TOPIC_MAP.get(key);
  console.log('isVerified KV', { key, exists: !!flag });
  return Boolean(flag);
}

function renderVerifyPage(url, env) {
  const token = url.searchParams.get('token') || '';
  const sitekey = env.TURNSTILE_SITEKEY;
  console.log('renderVerifyPage', { token_present: !!token, has_sitekey: !!sitekey });
  if (!sitekey || !token) return new Response('Missing token or sitekey', { status: 400 });
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>人机验证</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
  <h3>请完成人机验证</h3>
  <form method="POST" action="/verify">
    <div class="cf-turnstile" data-sitekey="${sitekey}"></div>
    <input type="hidden" name="token" value="${token}" />
    <button type="submit">提交</button>
  </form>
</body>
</html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function handleVerifySubmit(request, env) {
  const form = await request.formData();
  const respToken = form.get('cf-turnstile-response');
  const token = form.get('token');
  console.log('handleVerifySubmit', { has_resp: !!respToken, token });
  if (!respToken || !token) return new Response('缺少验证信息', { status: 400 });

  const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: respToken
    })
  });
  const data = await verifyRes.json();
  console.log('turnstile siteverify result', data);
  if (!data.success) {
    return new Response('验证失败，请返回重试', { status: 400 });
  }

  const record = await env.TOPIC_MAP.get(`verify:${token}`, { type: 'json' });
  console.log('verify token record', record);
  if (!record || !record.uid) return new Response('验证超时或记录不存在', { status: 400 });

  await env.TOPIC_MAP.put(`verified:${record.uid}`, '1');
  await env.TOPIC_MAP.delete(`verify:${token}`);
  console.log('verified-set', { uid: record.uid });

  return new Response('验证成功，请回到 Telegram 继续对话。', { status: 200 });
}
