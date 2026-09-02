// Cash-log Telegram-group integration.
//
// Owner writes free-form cash movements in a private Telegram group
// (the "Касса исола" chat). The bot (@isolashefbot, already in-repo) is
// invited to the group with privacy-mode OFF, so it sees every message.
// This module parses those free-form lines and — via the existing
// /api/telegram/webhook handler — creates PENDING tx rows in DB.txs with
// acc:'cash' and source:'tg-cash', then answers in the same group with a
// category-picker card. One tap categorizes the tx (same UX as bank SMS).
//
// The grammar is fluffy on purpose — owner has been writing these notes
// to himself for years and won't change his style. What we can rely on
// from the real screenshot of "Касса исола":
//   - There is always exactly ONE money amount per message (confirmed
//     with owner: even multi-part text with a period is one tx).
//   - Currency: "$" or "дол" / "долл" / "долар" / "долларов" ⇒ USD.
//     Everything else defaults to UZS — but the value must be reasonable;
//     if the raw number is small enough that it looks like the owner
//     "means k UZS" (e.g. bare "1200") we ask instead of guessing.
//   - Names of employees / objects are just words next to the number.
//   - "под отчёт <имя>" / "под отчет" is a distinct concept — goes to the
//     petty module rather than a regular cash tx.
//   - Forwarded messages ("Переслано от …") are NOT cash movements —
//     they are staff reports; we ignore them.
//
// Categorisation keyword table (best-effort auto-suggestion, owner can
// still override in the card):
//   аванс / зарплата                     → 1  "ЗП Фонд"
//   под отчёт / под отчет                → petty (module), no iid
//   питание / обед / ужин                → 19 "Питание объект" (or 11 office)
//   бензин / бензина / солярка / газ     → 12 "Бензин"
//   клеи / краска / бетек / фурнитура    → 16 "Материалы"
//   маляр / сборка / монтаж              → 22 "ЗП бригада прочее"
//   аренда                               → 9  "Аренда"
//   комм / коммуналк / свет / электро    → 10 "Коммунальные"

'use strict';

// ---------------------------------------------------------------- parse --

function normalize(text) {
  return String(text || '')
    .replace(/[   ]/g, ' ') // non-breaking spaces
    .replace(/\s+/g, ' ')
    .trim();
}

function isForwarded(msg) {
  return Boolean(
    msg && (msg.forward_from || msg.forward_from_chat ||
            msg.forward_sender_name || msg.forward_origin ||
            msg.forward_date)
  );
}

// Extract the FIRST money amount from a free-form line.
// Returns { raw: '400', value: 400, source: 'plain' | 'space-grouped' } or null.
function extractAmount(text) {
  const s = ' ' + text + ' ';
  // Space-grouped first: "1 200 000" or "1200 000" (owner uses both). We
  // accept 1-4 digits before the first space, then repeating 3-digit groups.
  // Kept without \b (kills Unicode neighbours in JS without u flag).
  const spg = s.match(/(?:[^\d.,])(\d{1,4}(?:[ ]\d{3})+)(?:[.,]\d{1,2})?(?:[^\d.,])/);
  if (spg) {
    return { raw: spg[1], value: parseInt(spg[1].replace(/ /g, ''), 10), source: 'space-grouped' };
  }
  // Plain digits: "400", "1200", "500000". Look for a run of digits with
  // non-digit neighbours (or start/end). No \b — Cyrillic-safe.
  const plain = s.match(/(?:[^\d.,])(\d{2,9})(?:[^\d.,])/);
  if (plain) {
    const v = parseInt(plain[1], 10);
    if (v >= 10) return { raw: plain[1], value: v, source: 'plain' };
  }
  return null;
}

// Detect explicit currency marker. Returns 'USD' | 'UZS' | null (unspecified).
// Cyrillic-safe (no \b — that word-boundary is ASCII-only in JS without u flag).
function detectCurrency(text) {
  const s = ' ' + String(text || '').toLowerCase().replace(/[ё]/g, 'е') + ' ';
  if (/\$/.test(s)) return 'USD';
  // Any word starting with "дол" (дол / долл / долар / доллар / долларов / долары / долах)
  if (/(?:^|[^а-я])дол[а-я]*(?:[^а-я]|$)/i.test(s)) return 'USD';
  // "сум" / "сумов" / "so'm" / "som"
  if (/(?:^|[^а-я])(сум[а-я]*|so'?m)(?:[^а-я]|$)/i.test(s)) return 'UZS';
  return null;
}

// Guess whether an unlabelled bare number was written in "thousands of UZS".
// The owner's dataset shows plain "1200 бетек" meaning 1 200 000 UZS but
// also "50 дол" = 50 USD. Since we already extract currency separately, the
// only ambiguity for UZS-side is: plain number without any currency marker.
//
//   value ≤ 9999      → looks like "thousands"          (needs owner confirm)
//   value >= 10000    → looks like a real UZS amount    (trust it)
//   space-grouped     → always literal ("1 200 000")
//
// We return the raw value here — the caller decides whether to ask for
// clarification when uncertain.
function isAmbiguousUZS(amountInfo) {
  if (!amountInfo) return false;
  if (amountInfo.source === 'space-grouped') return false;
  return amountInfo.value <= 9999;
}

// Cyrillic-safe patterns — DO NOT use \b, it's ASCII-only in JS without u flag.
const UNDER_REPORT_RE = /под\s*отч[ое]?т/i;
const IN_HINT_RE      = /(приход|поступил|получил|получено|пришло|вернули|возврат)/i;

// Keyword → item id (from index.html ITEMS array). Order matters — first match wins.
const ITEM_KEYWORDS = [
  { re: /(бензин|солярк|дизел)/i,                    iid: 12, n: 'Бензин' },
  { re: /аренд/i,                                     iid:  9, n: 'Аренда' },
  { re: /(коммунальн|свет|электр|вода)/i,             iid: 10, n: 'Коммунальные' },
  { re: /питание\s*офис/i,                            iid: 11, n: 'Питание офис' },
  { re: /(питание|обед|ужин|завтрак|еда)/i,           iid: 19, n: 'Питание объект' },
  { re: /(матер|клеи|клей|краск|бетек|фурнит|мдф|дсп|пленка|плёнка|плита|доска|мягк|поролон)/i, iid: 16, n: 'Материалы' },
  { re: /(сборк|монтаж|распил|кромлен|фрезер|лазер|покраск|маляр)/i, iid: 22, n: 'ЗП бригада прочее' },
  { re: /(зар?плат|аванс)/i,                          iid:  1, n: 'ЗП' },
  { re: /(транспорт|доставк|перевозк)/i,              iid: 18, n: 'Транспорт объект' },
  { re: /(комисс(ия)?\s*банк|%\s*банка)/i,            iid: 13, n: '% банка' },
];

function suggestItem(description) {
  const s = String(description || '');
  for (const k of ITEM_KEYWORDS) if (k.re.test(s)) return { iid: k.iid, n: k.n };
  return null;
}

// Fuzzy-match an employee by fragment of first/last name.
// Owner writes short forms: "килич" for Киличбек, "нуриддин" for Мурадов Нуриддин,
// "абдурауф" for Абдурауф Шарипов. We treat any 4+-char prefix of any first-
// or last-name token as a hit. Multiple hits (unlikely with our 10-user roster)
// → return the longest match to bias toward "нуриддин" over just "н".
function normalizeCyr(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е');
}

function matchEmployee(text, users) {
  if (!Array.isArray(users) || !users.length) return null;
  const t = normalizeCyr(text);
  let best = null;
  for (const u of users) {
    const full = normalizeCyr(u.n || u.name || '');
    if (!full) continue;
    // Split on whitespace/punctuation.
    for (const token of full.split(/[\s,.-]+/)) {
      if (token.length < 4) continue; // avoid "ака" (respectful ака ≠ name)
      // Progressive prefix match: 4..full length.
      for (let n = Math.min(token.length, 8); n >= 4; n--) {
        const prefix = token.slice(0, n);
        // Word-boundary-ish: text must have this prefix preceded by non-letter or start.
        const re = new RegExp('(?:^|[^а-яa-z])' + prefix + '[а-яa-z]*', 'i');
        if (re.test(t)) {
          const score = n;
          if (!best || score > best.score) best = { id: u.id, name: u.n || u.name, score, matched: prefix };
          break;
        }
      }
    }
  }
  return best;
}

// Master parser. Returns:
//   { ok, ignore, ignore_reason?, amount, amount_raw, currency, currency_source,
//     description, isUnderReport, suggestedItem, suggestedEmployee, ambiguousUZS, type }
function parseCashMessage(msg, users) {
  if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) {
    return { ok: false, ignore: true, ignore_reason: 'no text' };
  }
  if (isForwarded(msg)) {
    return { ok: false, ignore: true, ignore_reason: 'forwarded (staff report, not cash movement)' };
  }
  const text = normalize(msg.text);

  const amt = extractAmount(text);
  if (!amt) return { ok: false, ignore: true, ignore_reason: 'no amount' };

  const currency = detectCurrency(text);           // 'USD' | 'UZS' | null
  const isUnder = UNDER_REPORT_RE.test(text);
  const suggested = suggestItem(text);
  const isIn = IN_HINT_RE.test(text);
  const type = isIn ? 'income' : 'expense';

  // Description = the text with the amount digits removed, tidied up.
  const description = text.replace(amt.raw, '').replace(/\s+/g, ' ').trim();

  return {
    ok: true,
    ignore: false,
    amount: amt.value,
    amount_raw: amt.raw,
    currency,                              // may be null → ask user
    currency_source: currency ? 'explicit' : 'unspecified',
    ambiguousUZS: currency !== 'USD' && isAmbiguousUZS(amt),
    description,
    isUnderReport: isUnder,
    suggestedItem: suggested,              // { iid, n } | null
    suggestedEmployee: matchEmployee(text, users), // { id, name, matched } | null
    type,                                  // 'expense' | 'income'
  };
}

// ------------------------------------------------------ formatting -----

function fmtMoney(n, cur) {
  const abs = Math.abs(n || 0);
  const s = abs.toLocaleString('ru-RU').replace(/,/g, ' ');
  return s + ' ' + (cur || 'UZS');
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ------------------------------------------------ cards & keyboards ----

// Currency-clarification card. Shown when we can't tell UZS vs USD from the
// text, e.g. bare "1200 нуриддин бетек".
function buildCurrencyPromptCard(parsed, txId) {
  return [
    '❓ *' + parsed.amount + '* — это UZS или USD?',
    '',
    parsed.description ? '_' + parsed.description + '_' : null,
  ].filter(Boolean).join('\n');
}

function buildCurrencyPromptKeyboard(txId) {
  return [
    [
      { text: '🇺🇿 UZS (буквально ' + '' + ')', callback_data: `cash:cur:${txId}:UZS` },
      { text: '💵 USD',                          callback_data: `cash:cur:${txId}:USD` },
    ],
    [
      { text: '× 1000 UZS (тысячи)',             callback_data: `cash:cur:${txId}:UZS_K` },
    ],
    [
      { text: '❌ Отменить',                     callback_data: `cash:cancel:${txId}` },
    ],
  ];
}

// Category-picker card + keyboard, mirrors the bank-SMS one but for cash.
// Called after currency is resolved.
const CASH_EXPENSE_CATS = [
  { id:  1, n: 'ЗП' },
  { id: 16, n: 'Материалы' },
  { id: 19, n: 'Питание объект' },
  { id: 11, n: 'Питание офис' },
  { id: 12, n: 'Бензин' },
  { id: 18, n: 'Транспорт объект' },
  { id: 22, n: 'Бригада прочее' },
  { id:  9, n: 'Аренда' },
  { id: 10, n: 'Коммунальные' },
  { id: 15, n: 'Прочие общие' },
  { id: 32, n: 'Прочие расходы заказ' },
  { id: 'under_report', n: '📒 Под отчёт' },
];
const CASH_INCOME_CATS = [
  { id: 'advance',  n: 'Аванс' },
  { id: 'prepay',   n: 'Предоплата' },
  { id: 'payment',  n: 'Доплата' },
  { id: 'final',    n: 'Финал 100%' },
  { id: 'refund',   n: 'Возврат' },
  { id: 'other_in', n: 'Прочее' },
];

function buildCashCard(parsed, txId, uzsAmount, extra) {
  const dir = parsed.type === 'income' ? '⬇️ Приход' : '⬆️ Расход';
  const suggested = parsed.suggestedItem ? '\nПредположительно: *' + parsed.suggestedItem.n + '*' : '';
  const emp = parsed.suggestedEmployee ? '\n👤 Сотрудник: *' + parsed.suggestedEmployee.name + '*' : '';
  const currLabel = parsed.currency === 'USD'
    ? ` (${parsed.amount} USD)`
    : (extra && extra.wasThousands ? ' (введено «' + parsed.amount + '», ×1000)' : '');
  return [
    dir + ' *' + fmtMoney(uzsAmount, 'UZS') + '*' + currLabel,
    parsed.description ? '_' + parsed.description + '_' : null,
    emp + suggested,
    '',
    'Выбери статью:',
  ].filter(Boolean).join('\n');
}

function buildCashKeyboard(txId, isIncome, suggestedIid) {
  const cats = isIncome ? CASH_INCOME_CATS : CASH_EXPENSE_CATS;
  // Put the suggested item first (if any) with a star.
  const rows = [];
  const ordered = suggestedIid ? [
    ...cats.filter((c) => c.id === suggestedIid),
    ...cats.filter((c) => c.id !== suggestedIid),
  ] : cats;
  for (let i = 0; i < ordered.length; i += 2) {
    rows.push(ordered.slice(i, i + 2).map((c) => ({
      text: (c.id === suggestedIid ? '⭐ ' : '') + c.n,
      callback_data: `cash:cat:${txId}:${c.id}`,
    })));
  }
  rows.push([{ text: '❌ Отменить', callback_data: `cash:cancel:${txId}` }]);
  return rows;
}

function catNameById(isIncome, catId) {
  if (!isIncome && catId === 'under_report') return '📒 Под отчёт';
  const src = isIncome ? CASH_INCOME_CATS : CASH_EXPENSE_CATS;
  const cid = typeof catId === 'string' && /^\d+$/.test(catId) ? parseInt(catId, 10) : catId;
  const hit = src.find((c) => c.id === cid);
  return hit ? hit.n : String(catId);
}

function buildCategorizedCard(parsed, uzsAmount, catName, by, empName) {
  const dir = parsed.type === 'income' ? '⬇️ Приход' : '⬆️ Расход';
  return [
    '✅ ' + dir + ' *' + fmtMoney(uzsAmount, 'UZS') + '*',
    parsed.description ? '_' + parsed.description + '_' : null,
    empName ? '👤 ' + empName : null,
    'Статья: *' + catName + '*',
    by ? '_by ' + by + '_' : null,
  ].filter(Boolean).join('\n');
}

module.exports = {
  parseCashMessage,
  isForwarded,
  extractAmount,
  detectCurrency,
  suggestItem,
  matchEmployee,
  fmtMoney,
  today,
  buildCurrencyPromptCard,
  buildCurrencyPromptKeyboard,
  buildCashCard,
  buildCashKeyboard,
  buildCategorizedCard,
  catNameById,
  CASH_EXPENSE_CATS,
  CASH_INCOME_CATS,
};
