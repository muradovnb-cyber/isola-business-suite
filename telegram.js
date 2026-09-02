// Telegram Bot API client — uses global fetch (Node 18+)
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DEFAULT_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

function splitMarkdown(s, n) {
  if (s.length <= n) return [s];
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + n, s.length);
    if (end < s.length) {
      const nl = s.lastIndexOf('\n', end);
      if (nl > i + n / 2) end = nl;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

async function send(chatId, text, opts = {}) {
  if (!API) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const cid = chatId || DEFAULT_CHAT;
  if (!cid) throw new Error('chat_id not provided and TELEGRAM_CHAT_ID not set');
  const chunks = splitMarkdown(text, 3800);
  const results = [];
  for (const chunk of chunks) {
    const r = await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cid, text: chunk, parse_mode: opts.parseMode || 'Markdown', disable_web_page_preview: true })
    });
    const j = await r.json();
    results.push(j);
    if (!j.ok) {
      const r2 = await fetch(`${API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cid, text: chunk, disable_web_page_preview: true })
      });
      results.push(await r2.json());
    }
  }
  return results;
}

// Send a single message (no chunking) with optional inline keyboard.
// Returns { ok, message_id, chat_id, error? } — needed so the bank-sms
// flow can later editMessageText once the user taps a category button.
async function sendWithButtons(chatId, text, buttons, opts = {}) {
  if (!API) return { ok: false, error: 'no_token' };
  const cid = chatId || DEFAULT_CHAT;
  if (!cid) return { ok: false, error: 'no_chat_id' };
  const body = {
    chat_id: cid,
    text: text.slice(0, 3900),
    parse_mode: opts.parseMode || 'Markdown',
    disable_web_page_preview: true,
  };
  if (buttons && buttons.length) body.reply_markup = { inline_keyboard: buttons };
  const r = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) return { ok: false, error: j.description || 'send_failed', raw: j };
  return { ok: true, message_id: j.result.message_id, chat_id: j.result.chat.id };
}

async function editMessageText(chatId, messageId, text, buttons, opts = {}) {
  if (!API) return { ok: false, error: 'no_token' };
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 3900),
    parse_mode: opts.parseMode || 'Markdown',
    disable_web_page_preview: true,
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const r = await fetch(`${API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return j;
}

async function answerCallbackQuery(callbackId, text) {
  if (!API) return { ok: false };
  const r = await fetch(`${API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text: (text || '').slice(0, 200) }),
  });
  return r.json();
}

module.exports = {
  send,
  sendWithButtons,
  editMessageText,
  answerCallbackQuery,
  hasToken: !!TOKEN,
  defaultChat: DEFAULT_CHAT,
};
