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

module.exports = { send, hasToken: !!TOKEN };
