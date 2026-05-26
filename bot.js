const { Telegraf, Markup, session } = require("telegraf");
const { message } = require("telegraf/filters");
const db = require("./database");
const { formatPrice, genId, nowStr } = require("./utils");

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session({ defaultSession: () => ({}) }));

const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(Number);
const WEBAPP_URL = process.env.WEBAPP_URL || "";
const isAdmin = ctx => ADMIN_IDS.includes(ctx.from.id);

// ── /start ──
bot.start(async ctx => {
  const worker = await db.getWorkerByTelegramId(ctx.from.id);
  if (worker) {
    ctx.session = { workerId: worker.id, workerName: worker.name };
    return showWorkerMenu(ctx);
  }
  if (isAdmin(ctx)) {
    ctx.session = { isAdmin: true };
    return showAdminMenu(ctx);
  }
  ctx.session = { step: "login" };
  return ctx.reply("👋 Salom! Parolingizni kiriting:");
});

// ── Matn ──
bot.on(message("text"), async ctx => {
  const text = ctx.message.text.trim();
  const s = ctx.session || {};

  if (s.step === "login") {
    const worker = await db.getWorkerByPassword(text);
    if (worker) {
      await db.setWorkerTelegramId(worker.id, ctx.from.id);
      ctx.session = { workerId: worker.id, workerName: worker.name };
      await ctx.reply(`✅ Xush kelibsiz, ${worker.name}!`);
      return showWorkerMenu(ctx);
    }
    if (text === process.env.ADMIN_PASS) {
      ctx.session = { isAdmin: true };
      await ctx.reply("🔐 Admin sifatida kirdingiz!");
      return showAdminMenu(ctx);
    }
    return ctx.reply("❌ Parol noto'g'ri! Qayta kiriting:");
  }

  // Buyurtma jarayoni
  if (s.step === "o_name") { s.ord = { clientName: text }; s.step = "o_phone"; return ctx.reply("📱 Telefon:", Markup.forceReply()); }
  if (s.step === "o_phone") { s.ord.clientPhone = text; s.step = "o_topic"; return ctx.reply("📌 Mavzu (Do'kon fasadi, To'y banneri...):", Markup.forceReply()); }
  if (s.step === "o_topic") { s.ord.topic = text; s.ord.items = []; s.step = "o_item"; return showItemMenu(ctx); }

  if (s.step === "o_size") {
    const parts = text.split(/[\sx×,]+/);
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return ctx.reply("❌ Format: `300 500` yoki `300x500`", { parse_mode: "Markdown" });
    const w = parseFloat(parts[0]), l = parseFloat(parts[1]), qty = parts[2] ? parseInt(parts[2]) : 1;
    const mat = s.curMat;
    const rolls = { banner:[110,130,160,210,320], arakal:[100,120,150], setka:[100,120,150] };
    let bW = null;
    for (const r of rolls[mat]) { if (r >= w) { bW = r; break; } }
    if (!bW) return ctx.reply(`❌ ${w}sm uchun material yo'q! Mavjud: ${rolls[mat].join(", ")}sm`);
    const area = (bW * l) / 10000;
    const wp = await db.getWorkerPrices(s.workerId);
    const prices = await db.getPrices();
    const price = wp[mat] || prices[mat];
    const total = area * price * qty;
    const matNames = { banner:"Banner", arakal:"Arakal", setka:"Setka" };
    s.ord.items.push({ material: matNames[mat], custWidth:w, custLength:l, billedWidth:bW, billedAreaM2:area, qty, total, pricePerM2:price });
    s.step = "o_item";
    await ctx.reply(`✅ Qo'shildi: ${w}×${l}sm → ${area.toFixed(3)}m² × ${qty} = *${formatPrice(total)}*`, { parse_mode:"Markdown" });
    return showItemMenu(ctx);
  }

  if (s.step === "o_h3p") { const p = parseInt(text); if (!p) return ctx.reply("❌ Narx noto'g'ri!"); s.h3p = p; s.step = "o_h3d"; return ctx.reply("📝 Tavsif:", Markup.forceReply()); }
  if (s.step === "o_h3d") {
    s.ord.items.push({ material:"3D Harf", custWidth:0, custLength:0, billedAreaM2:0, qty:1, total:s.h3p, harf3dDesc:text });
    s.step = "o_item";
    await ctx.reply(`✅ 3D Harf: ${formatPrice(s.h3p)}`);
    return showItemMenu(ctx);
  }

  if (s.step === "o_pay") {
    const parts = text.split(/\s+/);
    const amount = parseInt(parts[0]);
    const method = parts[1]?.toLowerCase() === "click" ? "click" : "naqd";
    if (!amount || amount < 100) return ctx.reply("❌ Format: `500000` yoki `500000 click`", { parse_mode:"Markdown" });
    if (!s.ord.payments) s.ord.payments = [];
    s.ord.payments.push({ method, amount });
    const total = s.ord.items.reduce((a,i) => a+i.total, 0);
    const paid = s.ord.payments.reduce((a,p) => a+p.amount, 0);
    await ctx.reply(`💰 Qo'shildi: *${formatPrice(amount)}* (${method})\n✅ To'langan: *${formatPrice(paid)}*\n${total-paid>0?"💸 Qoldi: *"+formatPrice(total-paid)+"*":"✅ To'liq to'landi"}`, { parse_mode:"Markdown" });
    return showPayMenu(ctx, total, paid);
  }

  // Narx o'zgartirish
  if (s.step === "w_price") {
    const price = parseInt(text);
    if (!price) return ctx.reply("❌ Noto'g'ri!");
    await db.setWorkerPrice(s.workerId, s.priceMat, price);
    s.step = null;
    const n = { banner:"Banner", arakal:"Arakal", setka:"Setka" };
    await ctx.reply(`✅ ${n[s.priceMat]} narxi: *${formatPrice(price)}*`, { parse_mode:"Markdown" });
    return showWorkerMenu(ctx);
  }

  // Kirim/chiqim
  if (s.step === "add_income") {
    const parts = text.split("\n");
    const amount = parseInt(parts[0]);
    const note = parts[1] || "Qo'shimcha kirim";
    if (!amount) return ctx.reply("❌ Format:\n`500000\nIzoh`", { parse_mode:"Markdown" });
    await db.saveIncome({ id: genId("INC"), date: nowStr(), timestamp: Date.now(), amount, note });
    s.step = null;
    await ctx.reply(`✅ Kirim saqlandi: *${formatPrice(amount)}*\n📝 ${note}`, { parse_mode:"Markdown" });
    return showAdminMenu(ctx);
  }
  if (s.step === "add_expense") {
    const parts = text.split("\n");
    const amount = parseInt(parts[0]);
    const note = parts[1] || "Chiqim";
    if (!amount) return ctx.reply("❌ Format:\n`500000\nIzoh`", { parse_mode:"Markdown" });
    await db.saveExpense({ id: genId("EXP"), date: nowStr(), timestamp: Date.now(), amount, category: note, note });
    s.step = null;
    await ctx.reply(`✅ Chiqim saqlandi: *${formatPrice(amount)}*\n📝 ${note}`, { parse_mode:"Markdown" });
    return showAdminMenu(ctx);
  }

  // Admin: yangi ishchi
  if (s.step === "new_w_name") { s.newWName = text; s.step = "new_w_pass"; return ctx.reply("🔑 Parol:", Markup.forceReply()); }
  if (s.step === "new_w_pass") {
    await db.addWorker(s.newWName, text);
    s.step = null;
    await ctx.reply(`✅ ${s.newWName} ishchi qo'shildi!`);
    return showAdminMenu(ctx);
  }

  // Admin: narx
  if (s.step === "admin_price") {
    const price = parseInt(text);
    if (!price) return ctx.reply("❌ Noto'g'ri!");
    await db.setPrice(s.priceMat, price);
    s.step = null;
    await ctx.reply(`✅ Narx saqlandi: *${formatPrice(price)}*`, { parse_mode:"Markdown" });
    return showAdminMenu(ctx);
  }

  // Qarz to'lovi
  if (s.step === "debt_pay") {
    const amount = parseInt(text);
    if (!amount) return ctx.reply("❌ Noto'g'ri summa!");
    const order = await db.getOrder(s.debtId);
    if (!order) return ctx.reply("❌ Buyurtma topilmadi!");
    const newDebt = Math.max(0, (order.debtAmount||0) - amount);
    await db.updateOrder(s.debtId, { debtAmount: newDebt, paidAmount: order.paidAmount + amount, status: newDebt===0?"qabul":"qarz" });
    s.step = null;
    await ctx.reply(`✅ Qarz to'lovi: *${formatPrice(amount)}*\n${newDebt>0?"💸 Qolgan: *"+formatPrice(newDebt)+"*":"🎉 Qarz to'liq to'landi!"}`, { parse_mode:"Markdown" });
    return showAdminMenu(ctx);
  }
});

// ── Callback ──
bot.on("callback_query", async ctx => {
  const d = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  const s = ctx.session || {};

  // Worker
  if (d === "new_order") { s.step = "o_name"; s.ord = {}; return ctx.reply("👤 Mijoz ismi:", Markup.forceReply()); }
  if (d === "my_orders") return showMyOrders(ctx);
  if (d === "worker_prices") return showWorkerPricesMenu(ctx);
  if (d.startsWith("wp_")) {
    s.step = "w_price"; s.priceMat = d.slice(3);
    const p = await db.getPrices(); const wp = await db.getWorkerPrices(s.workerId);
    const cur = wp[s.priceMat] || p[s.priceMat];
    const n = { banner:"Banner", arakal:"Arakal", setka:"Setka" };
    return ctx.reply(`💰 ${n[s.priceMat]} (joriy: *${formatPrice(cur)}*)\nYangi narx:`, { parse_mode:"Markdown" });
  }

  // Item type
  if (d.startsWith("it_")) {
    const mat = d.slice(3);
    if (mat === "harf3d") { s.step = "o_h3p"; return ctx.reply("💰 Kelishilgan narx (so'm):", Markup.forceReply()); }
    s.curMat = mat; s.step = "o_size";
    const p = await db.getPrices(); const wp = await db.getWorkerPrices(s.workerId);
    const price = wp[mat] || p[mat];
    const n = { banner:"Banner", arakal:"Arakal", setka:"Setka" };
    return ctx.reply(`📐 *${n[mat]}* — ${formatPrice(price)}/m²\n\nO'lcham: \`kenlik uzunlik [dona]\`\nMasalan: \`300 500\` yoki \`200 400 2\``, { parse_mode:"Markdown" });
  }
  if (d === "item_done") {
    if (!s.ord?.items?.length) return ctx.reply("❌ Hech narsa qo'shmadingiz!");
    s.ord.payments = []; s.step = "o_pay";
    const total = s.ord.items.reduce((a,i)=>a+i.total,0);
    return ctx.reply(`💳 Jami: *${formatPrice(total)}*\n\nSumma kiriting:\n\`500000\` — naqd\n\`500000 click\` — click`, { parse_mode:"Markdown" });
  }

  // Payment
  if (d === "pay_full") {
    const total = s.ord.items.reduce((a,i)=>a+i.total,0);
    s.ord.payments = [{ method:"naqd", amount:total }];
    return saveOrder(ctx, false);
  }
  if (d === "pay_debt") return saveOrder(ctx, true);
  if (d === "pay_more") {
    s.step = "o_pay";
    const total = s.ord.items.reduce((a,i)=>a+i.total,0);
    const paid = (s.ord.payments||[]).reduce((a,p)=>a+p.amount,0);
    return ctx.reply(`💸 Qolgan: *${formatPrice(total-paid)}*\nQo'shimcha tulov:`, { parse_mode:"Markdown" });
  }

  // Admin
  if (d === "admin_orders") return showAdminOrders(ctx);
  if (d === "admin_debts") return showAdminDebts(ctx);
  if (d === "admin_kassa") return showKassa(ctx);
  if (d === "admin_m2") return showM2(ctx);
  if (d === "admin_workers") return showWorkers(ctx);
  if (d === "admin_add_worker") { s.step = "new_w_name"; return ctx.reply("👤 Ism:", Markup.forceReply()); }
  if (d === "admin_prices") return showAdminPrices(ctx);
  if (d.startsWith("ap_")) {
    s.step = "admin_price"; s.priceMat = d.slice(3);
    const p = await db.getPrices();
    const n = { banner:"Banner", arakal:"Arakal", setka:"Setka" };
    return ctx.reply(`💰 ${n[s.priceMat]} yangi narx (joriy: *${formatPrice(p[s.priceMat])}*):`, { parse_mode:"Markdown" });
  }
  if (d === "add_income") { s.step = "add_income"; return ctx.reply("📥 Kirim:\n*1-qator:* summa\n*2-qator:* izoh\n\nMasalan:\n`500000\nMijozdan oldindan to'lov`", { parse_mode:"Markdown" }); }
  if (d === "add_expense") { s.step = "add_expense"; return ctx.reply("📤 Chiqim:\n*1-qator:* summa\n*2-qator:* izoh\n\nMasalan:\n`200000\nBanner material xarid`", { parse_mode:"Markdown" }); }
  if (d.startsWith("dp_")) { s.step = "debt_pay"; s.debtId = d.slice(3); const o = await db.getOrder(s.debtId); return ctx.reply(`💸 ${o.client.name} — Qarz: *${formatPrice(o.debtAmount)}*\nTo'lov miqdori:`, { parse_mode:"Markdown" }); }
  if (d.startsWith("pu_")) { await db.updateOrder(d.slice(3), { status:"arxiv", pickedUpAt:nowStr() }); return ctx.reply("✅ Arxivga o'tkazildi!"); }
  if (d.startsWith("cn_")) { await db.updateOrder(d.slice(3), { status:"bekor", canceledAt:nowStr() }); return ctx.reply("❌ Bekor qilindi."); }
  if (d.startsWith("st_")) {
    const parts = d.slice(3).split("_");
    const status = parts.pop(); const orderId = parts.join("_");
    await db.updateOrder(orderId, { status });
    return ctx.reply(`✅ Status: ${status}`);
  }
  if (d === "back_worker") return showWorkerMenu(ctx);
  if (d === "back_admin") return showAdminMenu(ctx);
});

// ── Menyular ──
async function showWorkerMenu(ctx) {
  const s = ctx.session;
  const prices = await db.getPrices();
  const wp = await db.getWorkerPrices(s.workerId);
  const btns = [
    [Markup.button.callback("📝 Yangi Buyurtma", "new_order")],
    [Markup.button.callback("📋 Buyurtmalarim", "my_orders"), Markup.button.callback("💰 Narxlar", "worker_prices")],
  ];
  if (WEBAPP_URL) btns.push([Markup.button.webApp("🌐 To'liq Panel", WEBAPP_URL)]);
  return ctx.reply(
    `👤 *${s.workerName}*\n\n💰 Narxlar:\n` +
    `  Banner: *${formatPrice(wp.banner||prices.banner)}*/m²\n` +
    `  Arakal: *${formatPrice(wp.arakal||prices.arakal)}*/m²\n` +
    `  Setka: *${formatPrice(wp.setka||prices.setka)}*/m²`,
    { parse_mode:"Markdown", ...Markup.inlineKeyboard(btns) }
  );
}

async function showAdminMenu(ctx) {
  const orders = await db.getAllOrders();
  const active = orders.filter(o=>o.status!=="bekor"&&o.status!=="arxiv");
  const debts = active.filter(o=>(o.debtAmount||0)>0);
  const totalDebt = debts.reduce((s,o)=>s+(o.debtAmount||0),0);
  const btns = [
    [Markup.button.callback("📋 Buyurtmalar", "admin_orders"), Markup.button.callback("💸 Qarzlar", "admin_debts")],
    [Markup.button.callback("💰 Kassa", "admin_kassa"), Markup.button.callback("📐 m² Hisobot", "admin_m2")],
    [Markup.button.callback("👷 Ishchilar", "admin_workers"), Markup.button.callback("⚙️ Narxlar", "admin_prices")],
    [Markup.button.callback("📥 Kirim qo'shish", "add_income"), Markup.button.callback("📤 Chiqim qo'shish", "add_expense")],
  ];
  if (WEBAPP_URL) btns.push([Markup.button.webApp("🌐 To'liq Panel", WEBAPP_URL)]);
  return ctx.reply(
    `🔐 *Admin Panel*\n\n📋 Faol: *${active.length}* ta\n💸 Qarz: *${formatPrice(totalDebt)}* (${debts.length} ta)`,
    { parse_mode:"Markdown", ...Markup.inlineKeyboard(btns) }
  );
}

async function showItemMenu(ctx) {
  const items = ctx.session.ord?.items || [];
  let text = "🛒 *Mahsulot qo'shish*";
  if (items.length) {
    text += `\n\nQo'shilganlar (${items.length}):\n`;
    items.forEach((it,i) => { text += `${i+1}. ${it.material} — *${formatPrice(it.total)}*\n`; });
    text += `\n💰 Jami: *${formatPrice(items.reduce((a,i)=>a+i.total,0))}*`;
  }
  return ctx.reply(text, {
    parse_mode:"Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🖼 Banner", "it_banner"), Markup.button.callback("🖼 Arakal", "it_arakal")],
      [Markup.button.callback("🕸 Setka", "it_setka"), Markup.button.callback("✏️ 3D Harf", "it_harf3d")],
      [Markup.button.callback("✅ Tulovga o'tish", "item_done")],
    ])
  });
}

async function showPayMenu(ctx, total, paid) {
  const debt = total - paid;
  return ctx.reply(
    `💳 Jami: *${formatPrice(total)}*\nTo'langan: *${formatPrice(paid)}*\n${debt>0?"Qoldi: *"+formatPrice(debt)+"*":"✅ To'liq"}`,
    {
      parse_mode:"Markdown",
      ...Markup.inlineKeyboard([
        debt>0?[Markup.button.callback("➕ Yana tulov", "pay_more")]:[],
        [Markup.button.callback("✅ Saqlash (to'liq)", "pay_full")],
        debt>0?[Markup.button.callback("💸 Qarz bilan saqlash", "pay_debt")]:[],
      ].filter(r=>r.length))
    }
  );
}

async function showWorkerPricesMenu(ctx) {
  const prices = await db.getPrices();
  const wp = await db.getWorkerPrices(ctx.session.workerId);
  return ctx.reply(
    `💰 *Narxlar (1 m²)*\nBanner: *${formatPrice(wp.banner||prices.banner)}*\nArakal: *${formatPrice(wp.arakal||prices.arakal)}*\nSetka: *${formatPrice(wp.setka||prices.setka)}*`,
    { parse_mode:"Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("Banner", "wp_banner")],
      [Markup.button.callback("Arakal", "wp_arakal")],
      [Markup.button.callback("Setka", "wp_setka")],
      [Markup.button.callback("◀️ Orqaga", "back_worker")],
    ])}
  );
}

async function showMyOrders(ctx) {
  const orders = await db.getWorkerOrders(ctx.session.workerId);
  if (!orders.length) return ctx.reply("Hali buyurtma yo'q.");
  const em = { qabul:"✅",qarz:"💸",dizayn:"🎨",pechat:"🖨",chiqdi:"📦",ishxona:"🏭",arxiv:"📁",bekor:"❌" };
  let text = `📋 *Oxirgi buyurtmalar:*\n\n`;
  orders.slice(0,10).forEach((o,i) => {
    text += `${i+1}. ${em[o.status]||"•"} *${o.client.name}*\n`;
    text += `   📌 ${o.client.topic} — ${formatPrice(o.totalPrice)}\n`;
    if ((o.debtAmount||0)>0) text += `   💸 Qarz: ${formatPrice(o.debtAmount)}\n`;
    text += `   📅 ${o.date}\n\n`;
  });
  return ctx.reply(text, { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Orqaga","back_worker")]]) });
}

async function showAdminOrders(ctx) {
  const orders = await db.getAllOrders();
  const active = orders.filter(o=>o.status!=="bekor"&&o.status!=="arxiv").slice(0,8);
  if (!active.length) return ctx.reply("Faol buyurtmalar yo'q.", Markup.inlineKeyboard([[Markup.button.callback("◀️","back_admin")]]));
  for (const o of active) {
    const em={kutilmoqda:"⏳",tulovsiz:"🚫",qarz:"💸",qabul:"✅",dizayn:"🎨",pechat:"🖨️",chiqdi:"📦",ishxona:"🏭"};
    const text=`${em[o.status]||"•"} *${o.client.name}* | ${o.client.phone}\n📌 ${o.client.topic}\n👤 ${o.worker} | 📅 ${o.date}\n💰 ${formatPrice(o.totalPrice)} | ✅ ${formatPrice(o.paidAmount)}${(o.debtAmount||0)>0?"\n💸 Qarz: *"+formatPrice(o.debtAmount)+"*":""}`;
    const btns = [
      [Markup.button.callback("🎉 Olib ketti",`pu_${o.id}`), Markup.button.callback("❌ Bekor",`cn_${o.id}`)],
      [Markup.button.callback("🎨 Dizayn",`st_${o.id}_dizayn`), Markup.button.callback("🖨 Pechat",`st_${o.id}_pechat`), Markup.button.callback("📦 Tayyor",`st_${o.id}_chiqdi`)],
    ];
    if ((o.debtAmount||0)>0) btns.push([Markup.button.callback("💰 Qarz to'lovi",`dp_${o.id}`)]);
    await ctx.reply(text, { parse_mode:"Markdown", ...Markup.inlineKeyboard(btns) });
  }
}

async function showAdminDebts(ctx) {
  const orders = await db.getAllOrders();
  const debts = orders.filter(o=>(o.debtAmount||0)>0&&o.status!=="bekor"&&o.status!=="arxiv");
  if (!debts.length) return ctx.reply("🎉 Qarz yo'q!", Markup.inlineKeyboard([[Markup.button.callback("◀️","back_admin")]]));
  const total = debts.reduce((s,o)=>s+(o.debtAmount||0),0);
  await ctx.reply(`💸 *Qarzlar: ${debts.length} ta*\nJami: *${formatPrice(total)}*`,{parse_mode:"Markdown"});
  for (const o of debts.slice(0,10)) {
    await ctx.reply(
      `👤 *${o.client.name}* | ${o.client.phone}\n📌 ${o.client.topic}\n💸 Qarz: *${formatPrice(o.debtAmount)}*\n✅ To'ldi: ${formatPrice(o.paidAmount)}\n📅 ${o.date} | ${o.worker}`,
      { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("💰 To'lov qabul",`dp_${o.id}`)]]) }
    );
  }
}

async function showKassa(ctx) {
  const orders = await db.getAllOrders();
  const expenses = await db.getExpenses();
  const incomes = await db.getIncomes();
  const now = new Date();
  const thisMonth = o => { const d=new Date(o.timestamp); return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth(); };
  const mOrders = orders.filter(o=>thisMonth(o)&&o.status!=="bekor");
  const mExp = expenses.filter(thisMonth);
  const mInc = incomes.filter(thisMonth);
  const kirim = mOrders.reduce((s,o)=>s+o.paidAmount,0) + mInc.reduce((s,i)=>s+i.amount,0);
  const chiqim = mExp.reduce((s,e)=>s+e.amount,0);
  const months=["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];
  let text = `💰 *Kassa — ${months[now.getMonth()]} ${now.getFullYear()}*\n\n`;
  text += `📥 Kirim: *${formatPrice(kirim)}*\n`;
  text += `  └ Buyurtmalar: ${formatPrice(mOrders.reduce((s,o)=>s+o.paidAmount,0))}\n`;
  text += `  └ Qo'shimcha: ${formatPrice(mInc.reduce((s,i)=>s+i.amount,0))}\n\n`;
  text += `📤 Chiqim: *${formatPrice(chiqim)}*\n\n`;
  text += `💼 Qoldi: *${formatPrice(kirim-chiqim)}*\n\n`;
  text += `📊 Buyurtmalar: ${mOrders.length} ta`;
  if (mExp.length) {
    text += `\n\n📤 *Chiqimlar:*\n`;
    mExp.slice(0,5).forEach(e => { text += `• ${e.category}: ${formatPrice(e.amount)}\n`; });
  }
  return ctx.reply(text, {
    parse_mode:"Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("📥 Kirim qo'shish","add_income"), Markup.button.callback("📤 Chiqim qo'shish","add_expense")],
      [Markup.button.callback("◀️ Orqaga","back_admin")],
    ])
  });
}

async function showM2(ctx) {
  const orders = await db.getAllOrders();
  const now = new Date();
  const mOrders = orders.filter(o => {
    const d=new Date(o.timestamp);
    return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&o.status!=="bekor";
  });
  const mats={banner:{n:"Banner",m2:0,rev:0},arakal:{n:"Arakal",m2:0,rev:0},setka:{n:"Setka",m2:0,rev:0}};
  mOrders.forEach(o=>o.items.forEach(it=>{
    const k=Object.keys(mats).find(k=>mats[k].n===it.material);
    if(k&&it.billedAreaM2){mats[k].m2+=it.billedAreaM2*(it.qty||1);mats[k].rev+=it.total||0;}
  }));
  const totalM2=Object.values(mats).reduce((s,v)=>s+v.m2,0);
  const totalRev=Object.values(mats).reduce((s,v)=>s+v.rev,0);
  const months=["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];
  let text=`📐 *m² Hisobot — ${months[now.getMonth()]} ${now.getFullYear()}*\n\n`;
  text+=`🖼 Banner: *${mats.banner.m2.toFixed(2)} m²* — ${formatPrice(mats.banner.rev)}\n`;
  text+=`🖼 Arakal: *${mats.arakal.m2.toFixed(2)} m²* — ${formatPrice(mats.arakal.rev)}\n`;
  text+=`🕸 Setka: *${mats.setka.m2.toFixed(2)} m²* — ${formatPrice(mats.setka.rev)}\n\n`;
  text+=`📊 Jami: *${totalM2.toFixed(2)} m²*\n💰 Daromad: *${formatPrice(totalRev)}*\n\n`;
  // Ishchi breakdown
  const wnames=[...new Set(mOrders.map(o=>o.worker))].filter(Boolean);
  if(wnames.length){
    text+=`*Ishchi bo'yicha:*\n`;
    wnames.forEach(wn=>{
      const wo=mOrders.filter(o=>o.worker===wn);
      const wm={banner:0,arakal:0,setka:0};
      wo.forEach(o=>o.items.forEach(it=>{const k=Object.keys(mats).find(k=>mats[k].n===it.material);if(k&&it.billedAreaM2)wm[k]+=it.billedAreaM2*(it.qty||1);}));
      text+=`👤 ${wn}: Banner ${wm.banner.toFixed(1)}m² | Arakal ${wm.arakal.toFixed(1)}m² | Setka ${wm.setka.toFixed(1)}m²\n`;
    });
  }
  return ctx.reply(text, { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Orqaga","back_admin")]]) });
}

async function showWorkers(ctx) {
  const workers = await db.getAllWorkers();
  let text = "👷 *Ishchilar:*\n\n";
  workers.forEach((w,i)=>{ text+=`${i+1}. *${w.name}*\n`; });
  return ctx.reply(text, { parse_mode:"Markdown", ...Markup.inlineKeyboard([
    [Markup.button.callback("➕ Yangi ishchi","admin_add_worker")],
    [Markup.button.callback("◀️ Orqaga","back_admin")],
  ])});
}

async function showAdminPrices(ctx) {
  const p = await db.getPrices();
  return ctx.reply(
    `⚙️ *Narxlar:*\nBanner: ${formatPrice(p.banner)}/m²\nArakal: ${formatPrice(p.arakal)}/m²\nSetka: ${formatPrice(p.setka)}/m²`,
    { parse_mode:"Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("Banner","ap_banner")],
      [Markup.button.callback("Arakal","ap_arakal")],
      [Markup.button.callback("Setka","ap_setka")],
      [Markup.button.callback("◀️ Orqaga","back_admin")],
    ])}
  );
}

async function saveOrder(ctx, isDebt) {
  const s = ctx.session;
  const o = s.ord;
  const tp = o.items.reduce((a,i)=>a+i.total,0);
  const pa = (o.payments||[]).reduce((a,p)=>a+p.amount,0);
  const da = isDebt ? Math.max(0,tp-pa) : 0;
  const order = {
    id: genId("ORD"), date: nowStr(), timestamp: Date.now(),
    worker: s.workerName, workerId: s.workerId,
    client: { name:o.clientName, phone:o.clientPhone, topic:o.topic },
    items: o.items, totalPrice:tp, paidAmount:isDebt?pa:tp,
    debtAmount:da, payments:o.payments||[], status:da>0?"qarz":"qabul"
  };
  await db.saveOrder(order);
  s.step = null; s.ord = {};

  // Chek xabari
  let chek = `🧾 *BUYURTMA CHEKI*\n${"─".repeat(25)}\n`;
  chek += `🆔 ${order.id}\n📅 ${order.date}\n👤 ${order.worker}\n\n`;
  chek += `*MIJOZ:*\n👤 ${order.client.name}\n📱 ${order.client.phone}\n📌 ${order.client.topic}\n\n`;
  chek += `*MAHSULOTLAR:*\n`;
  order.items.forEach((it,i) => {
    chek += `${i+1}. ${it.material}\n`;
    if (it.billedAreaM2>0) chek += `   ${it.custWidth}×${it.custLength}sm | ${it.billedAreaM2.toFixed(3)}m² | ${it.qty}ta\n`;
    if (it.harf3dDesc) chek += `   ${it.harf3dDesc}\n`;
    chek += `   💰 ${formatPrice(it.total)}\n`;
  });
  chek += `\n${"─".repeat(25)}\n`;
  chek += `💰 Jami: *${formatPrice(tp)}*\n`;
  (order.payments||[]).forEach(p => { chek += `  ${p.method==="naqd"?"💵":"💳"} ${p.method}: ${formatPrice(p.amount)}\n`; });
  chek += `✅ To'langan: *${formatPrice(order.paidAmount)}*\n`;
  if (da>0) chek += `💸 Qarz: *${formatPrice(da)}*\n`;
  chek += `\n📣 ZIYOdizayn | 88 111 37 36`;

  await ctx.reply(chek, { parse_mode:"Markdown" });

  // Admin ga xabar
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId,
        `🔔 *Yangi buyurtma!*\n👤 ${order.client.name}\n📌 ${order.client.topic}\n💰 ${formatPrice(tp)}\n👷 ${order.worker}`,
        { parse_mode:"Markdown" }
      );
    } catch(e) {}
  }
  return showWorkerMenu(ctx);
}

// Haftalik eslatma
function scheduleReminder() {
  setInterval(async () => {
    const now = new Date();
    if (now.getDay()===1 && now.getHours()===9 && now.getMinutes()===0) {
      const orders = await db.getAllOrders();
      const debts = orders.filter(o=>(o.debtAmount||0)>0&&o.status!=="bekor"&&o.status!=="arxiv");
      if (!debts.length) return;
      const total = debts.reduce((s,o)=>s+(o.debtAmount||0),0);
      let msg = `⚠️ *Haftalik Qarz Eslatmasi*\n${debts.length} ta qarz | Jami: *${formatPrice(total)}*\n\n`;
      debts.slice(0,8).forEach((o,i) => { msg += `${i+1}. ${o.client.name} — *${formatPrice(o.debtAmount)}*\n   📱 ${o.client.phone}\n`; });
      for (const adminId of ADMIN_IDS) {
        try { await bot.telegram.sendMessage(adminId, msg, { parse_mode:"Markdown" }); } catch(e) {}
      }
    }
  }, 60000);
}

scheduleReminder();
bot.launch();
console.log("✅ Bot ishga tushdi!");
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
