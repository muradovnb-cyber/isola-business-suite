// ISOLA data audit — read-only analysis, returns markdown report
const ROLE_LBL = {
  constructor: 'Конструктор', production: 'Нач.произв', supply: 'Снабженец',
  manager: 'Менеджер', director: 'Директор', accountant: 'Бухгалтер', brigadier: 'Бригадир'
};

function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysBetween(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  return Math.floor((now - d) / 86400000);
}
function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(n || 0);
}

function buildAudit(db, mode) {
  const T = today();
  const users = Object.fromEntries((db.users || []).map(u => [u.id, u.n]));
  const name = uid => users[uid] || (uid ? `?id=${uid}` : '—');
  const orders = db.orders || [];
  const txs = db.txs || [];
  const sreqs = db.sreqs || [];
  const petty = db.petty || [];
  const cps = db.cps || [];
  const deals = db.deals || [];
  const userIds = new Set(Object.keys(users).map(Number));
  const orderIds = new Set(orders.map(o => o.id));

  const crit = [], warn = [], info = [];

  for (const o of orders) {
    if ((o.uzs || 0) <= 0 && (o.usd || 0) <= 0) warn.push(`Заказ #${o.id} «${(o.title || '').slice(0, 30)}» — нулевая сумма. Создал: ${name(o.mid)}`);
    if (!(o.title || '').trim()) warn.push(`Заказ #${o.id} — пустое название. Создал: ${name(o.mid)}`);
    if (o.status === 'active' && !o.mid) warn.push(`Заказ #${o.id} «${(o.title || '').slice(0, 30)}» — активен, но без менеджера`);
    if (o.status === 'active' && !o.cid) info.push(`Заказ #${o.id} «${(o.title || '').slice(0, 30)}» — без клиента`);
  }
  const titleCount = {};
  for (const o of orders) { const t = (o.title || '').trim(); if (t) titleCount[t] = (titleCount[t] || 0) + 1; }
  for (const [t, n] of Object.entries(titleCount)) if (n > 1) info.push(`Дубли заказов «${t.slice(0, 40)}» — ${n} шт`);

  for (const t of txs) {
    if ((t.sum_uzs || 0) === 0 && (t.sum_usd || 0) === 0) warn.push(`Транзакция #${t.id} от ${name(t.by)} (${t.date || '?'}) — нулевая сумма`);
    if (!(t.note || '').trim() && !t.iid) warn.push(`Транзакция #${t.id} от ${name(t.by)} (${t.date || '?'}) — нет ни статьи, ни комментария`);
    if (t.kind === 'expense' && (t.sum_uzs || 0) >= 5000000 && !(t.note || '').trim()) crit.push(`Крупный расход #${t.id} ${fmt(t.sum_uzs)} UZS от ${name(t.by)} БЕЗ комментария`);
    if (t.by && !userIds.has(t.by)) crit.push(`Транзакция #${t.id} — by=${t.by} ссылается на несуществующего user`);
    if (t.oid && !orderIds.has(t.oid)) warn.push(`Транзакция #${t.id} — oid=${t.oid} ссылается на несуществующий заказ`);
  }

  for (const s of sreqs) {
    if (s.status === 'pending') {
      const d = daysBetween(s.date);
      if (d !== null && d > 3) {
        const target = ROLE_LBL[s.toRole] || s.supplier || 'подрядчику';
        warn.push(`Заявка sreq #${s.id} «${(s.desc || '').slice(0, 30)}» от ${name(s.by)} → ${target}: висит ${d} дн.`);
      }
    }
    if (!(s.desc || '').trim() || (s.desc || '').trim().length < 5) info.push(`Заявка sreq #${s.id} от ${name(s.by)} — пустое/короткое описание`);
    if (!s.toRole && !s.supplier) info.push(`Заявка sreq #${s.id} от ${name(s.by)} — нет ни адресата, ни подрядчика`);
    if (s.oid && !orderIds.has(s.oid)) warn.push(`Заявка sreq #${s.id} — oid=${s.oid} ссылается на несуществующий заказ`);
    if (s.deadline && s.status !== 'done') {
      const dl = daysBetween(s.deadline);
      if (dl === null) continue;
      const target = ROLE_LBL[s.toRole] || s.supplier || 'подрядчику';
      const line = `sreq #${s.id} «${(s.desc || '').slice(0, 30)}» → ${target} (от ${name(s.by)})`;
      if (dl > 0) crit.push(`⏰ ПРОСРОЧЕНА ${line}: срок ${s.deadline} (${dl} дн. назад)`);
      else if (dl === 0) warn.push(`⏰ СРОК СЕГОДНЯ: ${line} — ${s.deadline}`);
      else if (dl >= -2) warn.push(`⏰ ЧЕРЕЗ ${-dl} дн.: ${line} — ${s.deadline}`);
    }
  }

  for (const p of petty) {
    if (p.status === 'open') {
      const d = daysBetween(p.date);
      if (d !== null && d > 7) warn.push(`Подотчёт #${p.id} от ${name(p.by)} ${fmt(p.sum_uzs)} UZS — открыт ${d} дн.`);
    }
    if ((p.sum_uzs || 0) > 1000000 && !(p.note || '').trim()) info.push(`Подотчёт #${p.id} от ${name(p.by)} ${fmt(p.sum_uzs)} UZS — без комментария`);
  }

  const cpsByName = {};
  for (const c of cps) { const k = ((c.n || '') + '').trim().toLowerCase(); if (!k) continue; (cpsByName[k] = cpsByName[k] || []).push(c.id); }
  for (const [k, ids] of Object.entries(cpsByName)) if (ids.length > 1) info.push(`Дубль контрагента «${k}» — id ${ids.join(', ')}`);

  const hdr = mode === 'eod' ? `# 🌙 ISOLA Итоги дня — ${T} 20:00` : `# 📊 ISOLA Аудит данных — ${T} 13:00`;
  let report = hdr + '\n\n';

  if (mode === 'eod') {
    const todays = arr => arr.filter(x => (x.date || x.created || '').startsWith(T));
    const tOrders = todays(orders), tTxs = todays(txs), tSreqs = todays(sreqs), tPetty = todays(petty);
    const sumIncome = tTxs.filter(t => t.kind === 'income').reduce((a, t) => a + (t.sum_uzs || 0), 0);
    const sumExp = tTxs.filter(t => t.kind === 'expense').reduce((a, t) => a + (t.sum_uzs || 0), 0);
    const orderSum = tOrders.reduce((a, o) => a + (o.uzs || 0), 0);
    report += `## 📊 Цифры за день\n- Заказов: ${tOrders.length} (${fmt(orderSum)} UZS)\n- Транзакций: ${tTxs.length} (доход +${fmt(sumIncome)}, расход −${fmt(sumExp)})\n`;
    const srPending = tSreqs.filter(s => s.status === 'pending').length;
    const srTaken = tSreqs.filter(s => s.status === 'taken').length;
    const srDone = tSreqs.filter(s => s.status === 'done').length;
    report += `- Заявок: создано ${tSreqs.length} (ожидает ${srPending} | принято ${srTaken} | выполнено ${srDone})\n`;
    const pOpen = tPetty.filter(p => p.status === 'open').length;
    const pClosed = tPetty.filter(p => p.status === 'closed').length;
    report += `- Подотчёт: выдано ${tPetty.length} (открыто ${pOpen}, закрыто ${pClosed})\n\n`;
    report += `## 👥 Активность сотрудников\n`;
    for (const u of (db.users || [])) {
      if (u.role === 'director' || u.role === 'brigadier') continue;
      const cnt = todays(orders).filter(o => o.mid === u.id).length + todays(txs).filter(t => t.by === u.id).length + todays(sreqs).filter(s => s.by === u.id).length + todays(petty).filter(p => p.by === u.id).length;
      report += `- ${u.n} (${ROLE_LBL[u.role] || u.role}): ${cnt} записей${cnt === 0 ? ' (нет активности)' : ''}\n`;
    }
    report += '\n';
  }

  report += `## 🟢 Сводка\n- orders: ${orders.length} | txs: ${txs.length} | sreqs: ${sreqs.length} | petty: ${petty.length} | cps: ${cps.length} | deals: ${deals.length}\n`;
  report += `- Проблем найдено: 🔴 ${crit.length} | 🟡 ${warn.length} | 🟢 ${info.length}\n\n`;
  report += `## 🔴 Критичные\n` + (crit.length ? crit.map(x => '- ' + x).join('\n') : '- нет') + '\n\n';
  report += `## 🟡 Внимание\n` + (warn.length ? warn.slice(0, 20).map(x => '- ' + x).join('\n') + (warn.length > 20 ? `\n- ...ещё ${warn.length - 20}` : '') : '- нет') + '\n\n';
  report += `## 🟢 Замечания\n` + (info.length ? info.slice(0, 15).map(x => '- ' + x).join('\n') + (info.length > 15 ? `\n- ...ещё ${info.length - 15}` : '') : '- нет') + '\n';
  if (crit.length === 0 && warn.length === 0) report += `\n## ✅ Сегодня всё чисто.\n`;
  return report;
}

module.exports = { buildAudit };
