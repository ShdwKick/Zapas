// Общий дом и напоминания: приглашения, права, выход, кому и о чём
// напоминать. Без сети и без Auth.                    node test/home.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const createStore = require("../lib/store.js");

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};

const TZ = "Europe/Moscow";
const fresh = () => createStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "zapas-")) });
const home = (s, u) => s.ensureHousehold(u, TZ).household.id;
/** Месяц, который сегодня попадает в нужное состояние. */
function monthWithStatus(s, want) {
  const X = require("../assets/expiry.js");
  const today = s.dayIn(TZ);
  for (let n = -2; n <= 36; n++) {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    const m = d.toISOString().slice(0, 7);
    if (X.statusOf(X.diffDays(today, X.endOfMonth(m))) === want) return m;
  }
  throw new Error("нет месяца для " + want);
}

{ // приглашение и принятие
  const s = fresh();
  const h = home(s, "аня");
  s.me("аня", TZ, "Аня");
  const inv = s.invite("аня", h, { toUser: "боря", fromName: "Аня" });
  eq("приглашение создано", typeof inv.id, "string");
  eq("повторное — то же самое, а не второе", s.invite("аня", h, { toUser: "боря" }).repeated, true);
  eq("боря видит приглашение", s.incomingInvites("боря").map(i => i.fromName), ["Аня"]);
  eq("аня видит исходящее", s.outgoingInvites("аня", h).length, 1);

  const r = s.acceptInvite("боря", inv.id, "Боря");
  eq("боря принял", r.joined.name, "Мой дом");
  eq("и сразу оказался в общем доме", s.me("боря", TZ).household.id, h);
  eq("в доме двое", s.members("аня", h).map(m => m.name), ["Аня", "Боря"]);
  eq("приглашение закрыто", s.incomingInvites("боря").length, 0);
  eq("повторно принять нельзя", s.acceptInvite("боря", inv.id, "Боря"), null);
}

{ // аптечка действительно общая
  const s = fresh();
  const h = home(s, "аня");
  const inv = s.invite("аня", h, { toUser: "боря" });
  s.acceptInvite("боря", inv.id, "Боря");
  s.addPack("аня", h, { name: "Нурофен", unit: "таб", qty: 20 });
  eq("боря видит то, что добавила аня", s.packs("боря", h).map(p => p.item.name), ["Нурофен"]);
  const p = s.packs("боря", h)[0];
  s.patchPack("боря", h, p.id, { action: "take", qty: 2 });
  eq("и может брать", s.packs("аня", h)[0].qty, 18);
  eq("в журнале видно, кто брал", s.history("аня", h, p.id)[0].by, "боря");
}

{ // чужого не трогаем
  const s = fresh();
  const h = home(s, "аня");
  const other = home(s, "вася");
  eq("позвать в чужой дом нельзя", (() => { try { s.invite("аня", other, { toUser: "боря" }); return "пустили"; } catch (e) { return e.code; } })(), "not_member");
  eq("чужое приглашение не принять", s.acceptInvite("вася", s.invite("аня", h, { toUser: "боря" }).id, "Вася"), null);
  eq("отклонить чужое тоже нельзя", s.declineInvite("вася", s.incomingInvites("боря")[0].id), null);
}

{ // отказ и отмена
  const s = fresh();
  const h = home(s, "аня");
  const i1 = s.invite("аня", h, { toUser: "боря" });
  eq("боря отказался", s.declineInvite("боря", i1.id).declined, true);
  eq("у ани в исходящих пусто", s.outgoingInvites("аня", h).length, 0);
  const i2 = s.invite("аня", h, { toUser: "боря" });
  eq("после отказа можно позвать снова", typeof i2.id, "string");
  eq("аня передумала", s.cancelInvite("аня", h, i2.id).cancelled, true);
  eq("боря этого уже не видит", s.incomingInvites("боря").length, 0);
}

{ // выход и права
  const s = fresh();
  const h = home(s, "аня");
  s.me("аня", TZ, "Аня");
  s.acceptInvite("боря", s.invite("аня", h, { toUser: "боря" }).id, "Боря");

  eq("участник не может убирать других", s.removeMember("боря", h, "аня").error, "not_owner");
  eq("владелец не может убрать себя", s.removeMember("аня", h, "аня").error, "self");

  eq("боря вышел сам", s.leaveHousehold("боря", h).left, true);
  eq("в доме снова один", s.members("аня", h).length, 1);
  eq("и у бори появился свой дом", s.me("боря", TZ).household.name, "Мой дом");
  eq("последний участник выйти не может", s.leaveHousehold("аня", h).error, "last_member");
}

{ // владелец ушёл — дом не остаётся без хозяина
  const s = fresh();
  const h = home(s, "аня");
  s.acceptInvite("боря", s.invite("аня", h, { toUser: "боря" }).id, "Боря");
  s.leaveHousehold("аня", h);
  eq("владение перешло оставшемуся", s.members("боря", h).map(m => [m.userId, m.role]), [["боря", "owner"]]);
}

{ // настройки напоминаний
  const s = fresh();
  home(s, "аня");
  eq("по умолчанию утро и все поводы", s.settingsOf("аня"), { remindAt: "10:00", kinds: { expiring: true, expired: true, openExpiring: true, low: true } });
  eq("время меняется", s.setNotify("аня", { remindAt: "21:30" }, TZ).remindAt, "21:30");
  eq("кривое время не принимается", s.setNotify("аня", { remindAt: "25:99" }, TZ).remindAt, "21:30");
  eq("повод можно выключить", s.setNotify("аня", { kinds: { low: false } }, TZ).kinds.low, false);
  eq("остальные не задеты", s.settingsOf("аня").kinds.expired, true);
}

{ // кому и о чём напоминать
  const s = fresh();
  const h = home(s, "аня");
  s.setNotify("аня", { remindAt: "00:00" }, TZ);   // «пора» прямо сейчас
  s.addPack("аня", h, { name: "Просрочка", qty: 1, expiresOn: monthWithStatus(s, "expired") });
  s.addPack("аня", h, { name: "Горит", qty: 1, expiresOn: monthWithStatus(s, "urgent") });
  s.addPack("аня", h, { name: "Запас", qty: 1, expiresOn: monthWithStatus(s, "ok") });
  s.addPack("аня", h, { name: "Мало", unit: "таб", qty: 2, lowAt: 3 });

  const due = s.dueReminders();
  eq("одна рассылка на человека", due.length, 1);
  const d = due[0];
  eq("истёкшее", d.items.expired.map(x => x.name), ["Просрочка"]);
  eq("истекающее", d.items.expiring.map(x => x.name), ["Горит"]);
  eq("заканчивающееся", d.items.low.map(x => x.name), ["Мало"]);
  eq("далёкий срок не беспокоит", d.items.expiring.concat(d.items.expired).some(x => x.name === "Запас"), false);

  s.markNotified("аня", d.day, d.items);
  eq("второй раз за день не напоминаем", s.dueReminders().length, 0);
}

{ // про одну и ту же упаковку не напоминаем дважды
  const s = fresh();
  const h = home(s, "аня");
  s.setNotify("аня", { remindAt: "00:00" }, TZ);
  s.addPack("аня", h, { name: "Просрочка", qty: 1, expiresOn: monthWithStatus(s, "expired") });
  const first = s.dueReminders()[0];
  s.markNotified("аня", first.day, first.items);
  // наступил следующий день: день рассылки сбрасываем руками
  s.db.prepare("UPDATE profiles SET notified_day = '2000-01-01' WHERE user_id = 'аня'").run();
  const second = s.dueReminders()[0];
  eq("повторно про ту же упаковку молчим", second.total, 0);
  s.addPack("аня", h, { name: "Новая просрочка", qty: 1, expiresOn: monthWithStatus(s, "expired") });
  s.db.prepare("UPDATE profiles SET notified_day = '2000-01-01' WHERE user_id = 'аня'").run();
  eq("а про новую — скажем", s.dueReminders()[0].items.expired.map(x => x.name), ["Новая просрочка"]);
}

{ // выключенный повод молчит, и время соблюдается
  const s = fresh();
  const h = home(s, "аня");
  s.setNotify("аня", { remindAt: "00:00", kinds: { expired: false } }, TZ);
  s.addPack("аня", h, { name: "Просрочка", qty: 1, expiresOn: monthWithStatus(s, "expired") });
  eq("выключенный повод не попадает в рассылку", s.dueReminders()[0].total, 0);

  const s2 = fresh();
  home(s2, "поздний");
  s2.setNotify("поздний", { remindAt: "23:59" }, TZ);
  const late = s2.dueReminders().length === 0 || s2.timeIn(TZ) >= "23:59";
  eq("до назначенного времени не беспокоим", late, true);
}

{ // напоминания приходят каждому участнику общего дома
  const s = fresh();
  const h = home(s, "аня");
  s.acceptInvite("боря", s.invite("аня", h, { toUser: "боря" }).id, "Боря");
  s.setNotify("аня", { remindAt: "00:00" }, TZ);
  s.setNotify("боря", { remindAt: "00:00" }, TZ);
  s.addPack("аня", h, { name: "Просрочка", qty: 1, expiresOn: monthWithStatus(s, "expired") });
  const due = s.dueReminders();
  eq("обоим", due.map(d => d.userId).sort(), ["аня", "боря"]);
  eq("каждому про ту же упаковку", due.every(d => d.items.expired.length === 1), true);
  // Аня прочитала — Боря всё равно должен узнать.
  const anya = due.find(d => d.userId === "аня");
  s.markNotified("аня", anya.day, anya.items);
  eq("отметка одного не гасит другого", s.dueReminders().map(d => d.userId), ["боря"]);
}

{ // подписки устройств
  const s = fresh();
  home(s, "аня");
  const sub = { endpoint: "https://push.example.com/" + "x".repeat(20), keys: { p256dh: "k".repeat(80), auth: "a".repeat(20) } };
  eq("подписка принята", s.addPushSub("аня", sub).subscribed, true);
  eq("она одна", s.pushSubs("аня").length, 1);
  eq("повторная подписка того же устройства не плодит", (s.addPushSub("аня", sub), s.pushSubs("аня").length), 1);
  eq("мусор не принимаем", s.addPushSub("аня", { endpoint: "ftp://нет" }), null);
  s.dropPushSub(sub.endpoint);
  eq("отписка", s.pushSubs("аня").length, 0);
}

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
