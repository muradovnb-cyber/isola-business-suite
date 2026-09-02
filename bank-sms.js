// Asia Alliance Bank (AAB_UZ) SMS integration.
//
// Parses the 3 informational SMS formats the bank sends and turns them into
// draft transactions in the ISOLA `txs` collection. A Telegram message with
// inline-keyboard categories is then sent to the owner; one tap categorizes
// the transaction and edits the message in place.
//
// The 4th SMS type (Internet-bank OTP: "tasdiqlash kodi …") is intentionally
// ignored — it must never leave the phone.

const crypto = require('crypto');

// -------------------------------------------------------------- parsing --

// Test the 4th SMS type — an OTP code we must never process.
function isVerificationCode(sms) {
  return /tasdiqlash\s+kodi|podtverjdeniya|Vnimanie\s+nikomu/i.test(sms);
}

// Squash whitespace so multi-line SMS still matches single-line regexes.
function normalize(sms) {
  return String(sms || '').replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseAmount(s) {
  // "6 961 500.00" → 6961500 (integer UZS). Bank always uses two decimals.
  const m = String(s || '').replace(/\s/g, '').match(/(-?\d+)(?:\.(\d{1,2}))?/);
  if (!m) return null;
  const whole = parseInt(m[1], 10);
  return Number.isFinite(whole) ? whole : null;
}

// Returns null if not a bank tx we handle; { type, amount, balance, counterparty, purpose, opCode, hash, raw }
function parseAAB(smsText) {
  if (!smsText) return null;
  if (isVerificationCode(smsText)) return null;
  const s = normalize(smsText);

  let type = null;
  if (/^Rasxod\b/i.test(s)) type = 'expense';
  else if (/\bNac\s+hislennye\s+%%/i.test(s)) type = 'expense'; // interest charge
  else if (/^Postupil\b/i.test(s)) type = 'income';
  else return null;

  // amount: first "- <digits>[ digits].DD" after the direction marker.
  // Both Rasxod and Postupil write the amount as "- 6 961 500.00".
  const amtMatch = s.match(/-\s*([\d ]+\.\d{2})/);
  const amount = amtMatch ? parseAmount(amtMatch[1]) : null;

  // balance: "Ost: 8 772 598.25"
  const ostMatch = s.match(/Ost:\s*([\d ]+\.\d{2})/i);
  const balance = ostMatch ? parseAmount(ostMatch[1]) : null;

  // counterparty:
  //  Rasxod:            "-> <code>/<acct> .; <NAME>.;-  <amt>"
  //  Nac hislennye %%:  "Nac hislennye %% <NAME>.;-  <amt>"
  //  Postupil:          "<- <NAME>.; - <amt>"
  let counterparty = null;
  if (type === 'expense') {
    let m = s.match(/Nac\s+hislennye\s+%%\s*(.+?)\s*\.\s*;\s*-/i);
    if (!m) m = s.match(/->\s*[\d\/]+\s*\.\s*;\s*(.+?)\s*\.\s*;\s*-/);
    if (m) counterparty = m[1].trim();
  } else {
    const m = s.match(/<-\s*(.+?)\s*\.\s*;\s*-/);
    if (m) counterparty = m[1].trim();
  }

  // purpose: text inside the last "(...)" before "Ost:". First token is often
  // an internal operation code like 00111 or 41000; we strip it out.
  // Expense SMS from AAB often truncates: "(00111 oplata soglasno dogo.;"
  // — no closing paren before Ost. Try the strict variant first, then a
  // loose one that accepts an un-closed group.
  let opCode = null, purpose = null;
  let purposeMatch = s.match(/\(([^()]*?)\)\s*\.\s*;\s*Ost:/i);
  if (!purposeMatch) purposeMatch = s.match(/\(([^()]*?)\.\s*;\s*Ost:/i);
  if (purposeMatch) {
    const inside = purposeMatch[1].trim();
    const codeM = inside.match(/^(\d+)\s*(.*)$/);
    if (codeM) { opCode = codeM[1]; purpose = codeM[2].trim() || null; }
    else purpose = inside;
  }

  // Own-account id — the long 20-digit number that appears first.
  const acctMatch = s.match(/(\d{20,25})\s*\.\s*;/);
  const account = acctMatch ? acctMatch[1] : null;

  // Dedup hash: normalized text is stable enough. We also mix in balance so
  // two identical-looking payments made minutes apart don't collapse.
  const hash = crypto.createHash('sha1').update(s + '|' + (balance || 0)).digest('hex').slice(0, 16);

  // Contract ref hint: banks embed things like "DOGOVOR N 24/08" or
  // "Договор №24/08" in the purpose field. We just extract the token — the
  // caller does the actual matching against DB.orders.contract_number.
  let contractRef = null;
  if (purpose) {
    const cm = purpose.match(/(?:DOGOVOR|договор)\s*[N№#]?\s*([A-Za-z0-9\/\-]+)/i);
    if (cm) contractRef = cm[1];
  }

  return {
    type, amount, balance, counterparty, purpose, opCode, account,
    contractRef,
    hash, raw: smsText.slice(0, 800),
  };
}

// Match an SMS-extracted contract reference to an order by contract_number.
// Case-insensitive, exact and substring fallback.
function matchOrderByContract(contractRef, orders) {
  if (!contractRef) return null;
  const q = String(contractRef).toLowerCase().trim();
  const active = (orders || []).filter((o) => o.status !== 'closed' && o.status !== 'cancelled');
  const exact = active.find((o) => String(o.contract_number || '').toLowerCase() === q);
  if (exact) return exact;
  // partial: "24/08" hits "2024-24/08" too
  const partial = active.filter((o) => {
    const cn = String(o.contract_number || '').toLowerCase();
    return cn && (cn.indexOf(q) >= 0 || q.indexOf(cn) >= 0);
  });
  if (partial.length === 1) return partial[0];
  return null;  // multiple or none → caller prompts
}

// Order-picker keyboard for bank-SMS flow (income Postupil).
// callback_data: bs:ord:<txId>:<oid|none>
function buildBankOrderPromptCard(parsed, orders, isIncome) {
  const dir = isIncome ? '⬇️ Приход' : '⬆️ Расход';
  const cpLine = parsed.counterparty ? '\nКонтрагент: ' + parsed.counterparty : '';
  const purLine = parsed.purpose ? '\nНазначение: ' + parsed.purpose : '';
  const balLine = parsed.balance != null ? '\nОстаток: ' + fmtMoney(parsed.balance) : '';
  return dir + ' *' + fmtMoney(parsed.amount) + '*' + cpLine + purLine + balLine +
    '\n\n❓ *К какому заказу привязать?*';
}

function buildBankOrderKeyboard(txId, activeOrders, cps) {
  const rows = [];
  for (const o of (activeOrders || []).slice(0, 10)) {
    const cp = (cps || []).find((c) => c.id === o.cid);
    const cnPart = o.contract_number ? '№' + o.contract_number + ' · ' : '';
    const label = ('#' + o.id + ' ' + cnPart + (o.title || '')).slice(0, 40) + (cp ? ' · ' + (cp.n || '').slice(0, 18) : '');
    rows.push([{ text: label, callback_data: 'bs:ord:' + txId + ':' + o.id }]);
  }
  rows.push([
    { text: '⏭ Без заказа', callback_data: 'bs:ord:' + txId + ':none' },
  ]);
  return rows;
}

// ----------------------------------------------------- category buttons --

// The 10 default expense-category groups (parent-level items from ITEMS in
// index.html). Duplicated here so the backend doesn't need to parse the SPA.
// Keep IDs in sync with .github/… — actually with index.html ITEMS array.
//
// `cashout` is a VIRTUAL category: tapping it does not finalize the tx, it
// swaps the keyboard for a commission-% picker (see buildCashoutKeyboard).
const EXPENSE_CATS = [
  { id: 13, n: '% банка' },
  { id: 16, n: 'Материалы' },
  { id: 17, n: 'Готовая продукция' },
  { id:  1, n: 'ЗП' },
  { id:  9, n: 'Аренда' },
  { id: 10, n: 'Коммунальные' },
  { id: 11, n: 'Питание офис' },
  { id: 12, n: 'Бензин' },
  { id: 32, n: 'Прочие расходы заказ' },
  { id: 15, n: 'Прочие общие' },
  { id: 'cashout', n: '💵 Обнал' },
];

// Commission %-picker offered after user taps "Обнал". Numbers are stored as
// tenths of a percent (basis-points/10) so 15 == 1.5%. That gives a nice
// integer round-trip through Telegram's 64-byte callback_data limit.
const CASHOUT_PERCENTS = [
  { bp: 10, label: '1 %' },
  { bp: 15, label: '1.5 %' },
  { bp: 20, label: '2 %' },
  { bp: 25, label: '2.5 %' },
  { bp: 30, label: '3 %' },
  { bp: 40, label: '4 %' },
  { bp: 45, label: '4.5 %' },
  { bp: 50, label: '5 %' },
  { bp: 60, label: '6 %' },
];

// INCOME_CATS mirrors the one in index.html.
const INCOME_CATS = [
  { id: 'advance',  n: 'Аванс' },
  { id: 'prepay',   n: 'Предоплата' },
  { id: 'payment',  n: 'Доплата' },
  { id: 'final',    n: 'Финальный (100%)' },
  { id: 'refund',   n: 'Возврат' },
  { id: 'other_in', n: 'Прочие' },
];

// Builds a Telegram inline keyboard: rows of ≤2 buttons.
// callback_data: "bs:cat:<txid>:<catcode>"  (bank-sms / categorize / …)
// Callback data has a 64-byte cap — our longest option ("bs:cat:9999:other_in")
// is under that comfortably.
function buildKeyboard(txId, isIncome) {
  const cats = isIncome ? INCOME_CATS : EXPENSE_CATS;
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) {
    const pair = cats.slice(i, i + 2).map((c) => ({
      text: c.n,
      callback_data: `bs:cat:${txId}:${c.id}`,
    }));
    rows.push(pair);
  }
  rows.push([
    { text: '🔗 Открыть в системе',
      url: 'https://isola-suite-production.up.railway.app/#txs' },
  ]);
  return rows;
}

function catNameById(isIncome, catId) {
  if (!isIncome && catId === 'cashout') return '💵 Обнал';
  const src = isIncome ? INCOME_CATS : EXPENSE_CATS;
  // 'cashout' is a string — don't parseInt or we get NaN.
  const cid = isIncome ? String(catId) : (typeof catId === 'string' && /^\d+$/.test(catId) ? parseInt(catId, 10) : catId);
  const hit = src.find((c) => c.id === cid);
  return hit ? hit.n : String(catId);
}

// Commission-picker keyboard shown after user taps "💵 Обнал".
// callback_data: "bs:comm:<txId>:<bp>" where bp is tenths-of-percent (15=1.5%)
function buildCashoutKeyboard(txId) {
  const rows = [];
  for (let i = 0; i < CASHOUT_PERCENTS.length; i += 3) {
    rows.push(CASHOUT_PERCENTS.slice(i, i + 3).map((p) => ({
      text: p.label,
      callback_data: `bs:comm:${txId}:${p.bp}`,
    })));
  }
  rows.push([{ text: '← Отмена', callback_data: `bs:cancel-cashout:${txId}` }]);
  return rows;
}

// --------------------------------------------------------- formatting ---

function fmtMoney(n) {
  const abs = Math.abs(n || 0);
  return abs.toLocaleString('ru-RU').replace(/,/g, ' ') + ' UZS';
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function buildPendingCard(parsed, txId) {
  const arrow = parsed.type === 'income' ? '⬇️ Приход' : '⬆️ Расход';
  const lines = [
    `${arrow}  *${fmtMoney(parsed.amount)}*`,
    parsed.counterparty ? `Контрагент: ${parsed.counterparty}` : null,
    parsed.purpose ? `Назначение: ${parsed.purpose}` : null,
    parsed.balance != null ? `Остаток: ${fmtMoney(parsed.balance)}` : null,
    '',
    '_Выбери статью — я закреплю её за операцией:_',
    `\`tx:${txId}\``,
  ].filter(Boolean);
  return lines.join('\n');
}

function buildCategorizedCard(parsed, catName, byName) {
  const arrow = parsed.type === 'income' ? '⬇️ Приход' : '⬆️ Расход';
  const lines = [
    `✅ ${arrow}  *${fmtMoney(parsed.amount)}*`,
    parsed.counterparty ? `Контрагент: ${parsed.counterparty}` : null,
    parsed.purpose ? `Назначение: ${parsed.purpose}` : null,
    `Статья: *${catName}*`,
    byName ? `Категоризировано: ${byName}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

module.exports = {
  parseAAB,
  isVerificationCode,
  buildKeyboard,
  buildCashoutKeyboard,
  buildBankOrderPromptCard,
  buildBankOrderKeyboard,
  matchOrderByContract,
  catNameById,
  buildPendingCard,
  buildCategorizedCard,
  fmtMoney,
  today,
  EXPENSE_CATS,
  INCOME_CATS,
  CASHOUT_PERCENTS,
};
