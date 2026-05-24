const { Telegraf, Markup, session } = require("telegraf");
const { message } = require("telegraf/filters");
const db = require("./database");
const { formatPrice, genId, nowStr } = require("./utils");

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// ── Rollar ──
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(Number);
const isAdmin = (ctx) => ADMIN_IDS.includes(ctx.from.id);

// ── Start ──
bot.start(async (ctx) => {
  const worker = await db.getWorkerByTelegramId(ctx.from.id);
  if (worker) {
    ctx.session = { step: null, workerId: worker.id, workerName: worker.name };
    return showWorkerMenu(ctx);
  }
  if (isAdmin(ctx)) {
    ctx.session = { step: null };
    return showAdminMenu(ctx);
  }
  ctx.reply(
    "Salom! Reklama Studio tizimiga xush kelibsiz.\n\nKirish uchun parol kiriting:",
    Markup.forceReply()
  );
  ctx.session = { step: "login_password" };
});

// ── Matn xabarlari ──
bot.on(message("text"), async (ctx) => {
  const text = ctx.message.text;
  const step = ctx.session?.step;

  // ── LOGIN ──
  if (step === "login_password") {
    const worker = await db.getWorkerByPassword(text.trim());
    if (worker) {
      await db.setWorkerTelegramId(worker.id, ctx.from.id);
      ctx.session = { step: null, workerId: worker.id, workerName: worker.name };
      await ctx.reply(`Xush kelibsiz, ${worker.name}! ✅`);
      return showWorkerMenu(ctx);
    }
    if (text.trim() === process.env.ADMIN_PASS) {
      ctx.session = { step: null, isAdmin: true };
      await ctx.reply("Admin sifatida kirdingiz! 🔐");
      return showAdminMenu(ctx);
    }
    return ctx.reply("❌ Parol noto'g'ri! Qayta kiriting:", Markup.forceReply());
  }

  // ── BUYURTMA JARAYONI ──
  if (step === "order_client_name") {
    ctx.session.order = { clientName: text };
    ctx.session.step = "order_client_phone";
    return ctx.reply("📱 Telefon raqamini kiriting:", Markup.forceReply());
  }
  if (step === "order_client_phone") {
    ctx.session.order.clientPhone = text;
    ctx.session.step = "order_topic";
    return ctx.reply("📌 Buyurtma mavzusini kiriting:\n(masalan: Do'kon fasadi, To'y banneri)", Markup.forceReply());
  }
  if (step === "order_topic") {
    ctx.session.order.topic = text;
    ctx.session.order.items = [];
    ctx.session.step = "order_add_item";
    return showAddItemMenu(ctx);
  }
  if (step === "order_item_size") {
    // Format: kenlik uzunlik (masalan: 300 500)
    const parts = text.trim().split(/[\s,x×]+/);
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
      return ctx.reply("❌ Format xato! Masalan: `300 500` yoki `300x500`", { parse_mode: "Markdown" });
    }
    const w = parseFloat(parts[0]);
    const l = parseFloat(parts[1]);
    const qty = parts[2] ? parseInt(parts[2]) : 1;
    const mat = ctx.session.currentMat;
    const prices = await db.getPrices();
    const rolls = { banner: [110,130,160,210,320], arakal: [100,120,150], setka: [100,120,150] };
    const matRolls = rolls[mat];
    let bW = null;
    for (const r of matRolls) { if (r >= w) { bW = r; break; } }
    if (!bW) {
      return ctx.reply(`❌ ${w}sm kenglik uchun material yo'q!\nMavjud: ${matRolls.join(", ")} sm`);
    }
    const area = (bW * l) / 10000;
    const workerPrices = await db.getWorkerPrices(ctx.session.workerId);
    const price = workerPrices[mat] || prices[mat];
    const total = area * price * qty;
    const matNames = { banner: "Banner", arakal: "Arakal", setka: "Setka" };
    ctx.session.order.items.push({
      material: matNames[mat], custWidth: w, custLength: l,
      billedWidth: bW, billedAreaM2: area, qty, total, pricePerM2: price
    });
    ctx.session.step = "order_add_item";
    await ctx.reply(
      `✅ Qo'shildi:\n` +
      `📐 ${w}×${l}sm → ${area.toFixed(3)}m²\n` +
      `🔢 ${qty} dona\n` +
      `💰 ${formatPrice(total)}`
    );
    return showAddItemMenu(ctx);
  }
  if (step === "order_harf3d_price") {
    const price = parseInt(text);
    if (!price || price < 1000) return ctx.reply("❌ Narx noto'g'ri! Qayta kiriting:");
    ctx.session.harf3dPrice = price;
    ctx.session.step = "order_harf3d_desc";
    return ctx.reply("📝 Zakaz tavsifini kiriting:\n(harf turi, o'lcham, rang...)", Markup.forceReply());
  }
  if (step === "order_harf3d_desc") {
    ctx.session.order.items.push({
      material: "3D Harf", custWidth: 0, custLength: 0,
      billedAreaM2: 0, qty: 1, total: ctx.session.harf3dPrice, harf3dDesc: text
    });
    ctx.session.step = "order_add_item";
    await ctx.reply(`✅ 3D Harf qo'shildi: ${formatPrice(ctx.session.harf3dPrice)}`);
    return showAddItemMenu(ctx);
  }
  if (step === "order_payment") {
    const parts = text.trim().split(/[\s]+/);
    const amount = parseInt(parts[0]);
    const method = parts[1]?.toLowerCase() === "click" ? "click" : "naqd";
    if (!amount || amount < 100) return ctx.reply("❌ Summa noto'g'ri! Masalan: `500000` yoki `500000 click`", { parse_mode: "Markdown" });
    if (!ctx.session.order.payments) ctx.session.order.payments = [];
    ctx.session.order.payments.push({ method, amount });
    const total = ctx.session.order.items.reduce((s, i) => s + i.total, 0);
    const paid = ctx.session.order.payments.reduce((s, p) => s + p.amount, 0);
    const debt = total - paid;
    await ctx.reply(
      `💰 Tulov qo'shildi: ${formatPrice(amount)} (${method})\n` +
      `✅ To'langan: ${formatPrice(paid)}\n` +
      `${debt > 0 ? "💸 Qoldi: " + formatPrice(debt) : "✅ To'liq to'langan"}`
    );
    return showPaymentMenu(ctx, total, paid);
  }
  if (step === "order_worker_price") {
    const mat = ctx.session.editingMat;
    const price = parseInt(text);
    if (!price || price < 1000) return ctx.reply("❌ Narx noto'g'ri!");
    await db.setWorkerPrice(ctx.session.workerId, mat, price);
    ctx.session.step = null;
    const matNames = { banner: "Banner", arakal: "Arakal", setka: "Setka" };
    await ctx.reply(`✅ ${matNames[mat]} narxi ${formatPrice(price)} ga o'zgartirildi!`);
    return showWorkerMenu(ctx);
  }

  // ── ADMIN: yangi ishchi ──
  if (step === "admin_new_worker_name") {
    ctx.session.newWorkerName = text.trim();
    ctx.session.step = "admin_new_worker_pass";
    return ctx.reply("🔑 Parol kiriting:", Markup.forceReply());
  }
  if (step === "admin_new_worker_pass") {
    await db.addWorker(ctx.session.newWorkerName, text.trim());
    ctx.session.step = null;
    await ctx.reply(`✅ ${ctx.session.newWorkerName} ishchi qo'shildi!`);
    return showAdminMenu(ctx);
  }

  // ── ADMIN: narx o'zgartirish ──
  if (step === "admin_set_price") {
    const mat = ctx.session.editingMat;
    const price = parseInt(text);
    if (!price) return ctx.reply("❌ Noto'g'ri raqam!");
    await db.setPrice(mat, price);
    ctx.session.step = null;
    await ctx.reply(`✅ Narx saqlandi: ${formatPrice(price)}`);
    return showAdminMenu(ctx);
  }
  if (step === "admin_debt_payment") {
    const orderId = ctx.session.debtOrderId;
    const amount = parseInt(text);
    if (!amount) return ctx.reply("❌ Noto'g'ri summa!");
    const order = await db.getOrder(orderId);
    const newDebt = Math.max(0, (order.debtAmount || 0) - amount);
    await db.updateOrder(orderId, {
      debtAmount: newDebt,
      paidAmount: order.paidAmount + amount,
      status: newDebt === 0 ? "qabul" : "qarz"
    });
    ctx.session.step = null;
    await ctx.reply(`✅ Qarz to'lovi qabul qilindi: ${formatPrice(amount)}\n${newDebt > 0 ? "💸 Qolgan qarz: " + formatPrice(newDebt) : "🎉 Qarz to'liq to'landi!"}`);
    return showAdminMenu(ctx);
  }
});

// ── Callback (tugmalar) ──
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();

  // Worker menu
  if (data === "new_order") {
    ctx.session.step = "order_client_name";
    ctx.session.order = {};
    return ctx.reply("👤 Mijoz ismini kiriting:", Markup.forceReply());
  }
  if (data === "my_orders") return showMyOrders(ctx);
  if (data === "change_prices") return showChangePricesMenu(ctx);
  if (data.startsWith("set_price_")) {
    const mat = data.replace("set_price_", "");
    ctx.session.step = "order_worker_price";
    ctx.session.editingMat = mat;
    const prices = await db.getPrices();
    const wp = await db.getWorkerPrices(ctx.session.workerId);
    const cur = wp[mat] || prices[mat];
    const matNames = { banner: "Banner", arakal: "Arakal", setka: "Setka" };
    return ctx.reply(`💰 ${matNames[mat]} narxi (joriy: ${formatPrice(cur)})\nYangi narxni kiriting:`, Markup.forceReply());
  }

  // Item type selection
  if (data.startsWith("item_type_")) {
    const mat = data.replace("item_type_", "");
    if (mat === "harf3d") {
      ctx.session.step = "order_harf3d_price";
      return ctx.reply("💰 Kelishilgan narxni kiriting (so'm):", Markup.forceReply());
    }
    ctx.session.currentMat = mat;
    ctx.session.step = "order_item_size";
    const matNames = { banner: "Banner", arakal: "Arakal", setka: "Setka" };
    const prices = await db.getPrices();
    const wp = await db.getWorkerPrices(ctx.session.workerId);
    const price = wp[mat] || prices[mat];
    return ctx.reply(
      `📐 *${matNames[mat]}* — ${formatPrice(price)}/m²\n\nO'lcham kiriting:\n\`kenlik uzunlik [dona]\`\nMasalan: \`300 500\` yoki \`200 400 2\``,
      { parse_mode: "Markdown" }
    );
  }
  if (data === "item_done") {
    if (!ctx.session.order.items?.length) return ctx.reply("❌ Hech narsa qo'shmadingiz!");
    ctx.session.order.payments = [];
    ctx.session.step = "order_payment";
    const total = ctx.session.order.items.reduce((s, i) => s + i.total, 0);
    return ctx.reply(
      `💳 Tulov:\nJami: *${formatPrice(total)}*\n\nSumma kiriting (naqd uchun: \`500000\`, click uchun: \`500000 click\`):`,
      { parse_mode: "Markdown" }
    );
  }

  // Payment
  if (data === "pay_done_full") {
    const total = ctx.session.order.items.reduce((s, i) => s + i.total, 0);
    ctx.session.order.payments = [{ method: "naqd", amount: total }];
    return saveOrder(ctx, false);
  }
  if (data === "pay_done_debt") return saveOrder(ctx, true);
  if (data === "pay_add_more") {
    ctx.session.step = "order_payment";
    const total = ctx.session.order.items.reduce((s, i) => s + i.total, 0);
    const paid = (ctx.session.order.payments || []).reduce((s, p) => s + p.amount, 0);
    return ctx.reply(`Qolgan summa: *${formatPrice(total - paid)}*\nQo'shimcha tulov kiriting:`, { parse_mode: "Markdown" });
  }

  // Admin menu
  if (data === "admin_orders") return showAdminOrders(ctx);
  if (data === "admin_debts") return showAdminDebts(ctx);
  if (data === "admin_report") return showAdminReport(ctx);
  if (data === "admin_m2report") return showM2Report(ctx);
  if (data === "admin_workers") return showAdminWorkers(ctx);
  if (data === "admin_add_worker") {
    ctx.session.step = "admin_new_worker_name";
    return ctx.reply("👤 Yangi ishchi ismi:", Markup.forceReply());
  }
  if (data === "admin_prices") return showAdminPricesMenu(ctx);
  if (data.startsWith("admin_set_price_")) {
    const mat = data.replace("admin_set_price_", "");
    ctx.session.step = "admin_set_price";
    ctx.session.editingMat = mat;
    const prices = await db.getPrices();
    const matNames = { banner: "Banner", arakal: "Arakal", setka: "Setka" };
    return ctx.reply(`💰 ${matNames[mat]} yangi narx (joriy: ${formatPrice(prices[mat])}):`, Markup.forceReply());
  }
  if (data.startsWith("debt_pay_")) {
    const orderId = data.replace("debt_pay_", "");
    ctx.session.step = "admin_debt_payment";
    ctx.session.debtOrderId = orderId;
    const order = await db.getOrder(orderId);
    return ctx.reply(`💸 ${order.client.name} — Qarz: ${formatPrice(order.debtAmount)}\nTo'lov miqdorini kiriting:`);
  }
  if (data.startsWith("pickup_")) {
    const orderId = data.replace("pickup_", "");
    await db.updateOrder(orderId, { status: "arxiv", pickedUpAt: nowStr() });
    return ctx.reply("✅ Buyurtma arxivga o'tkazildi!");
  }
  if (data.startsWith("cancel_order_")) {
    const orderId = data.replace("cancel_order_", "");
    await db.updateOrder(orderId, { status: "bekor", canceledAt: nowStr() });
    return ctx.reply("❌ Buyurtma bekor qilindi.");
  }
  if (data.startsWith("status_")) {
    const [, orderId, status] = data.split("_status_").length > 1
      ? ["", ...data.replace("status_", "").split("_s_")]
      : data.split("__");
    // format: status__orderId__newStatus
    const parts = data.replace("status__", "").split("__");
    if (parts.length === 2) {
      await db.updateOrder(parts[0], { status: parts[1] });
      return ctx.reply(`✅ Status: ${parts[1]}`);
    }
  }
  if (data === "back_worker") return showWorkerMenu(ctx);
  if (data === "back_admin") return showAdminMenu(ctx);
});

// ── Menyular ──
async function showWorkerMenu(ctx) {
  const name = ctx.session.workerName;
  const prices = await db.getPrices();
  const wp = await db.getWorkerPrices(ctx.session.workerId);
  return ctx.reply(
    `👤 *${name}* — Reklama Studio\n\n` +
    `💰 Narxlar:\n` +
    `  Banner: *${formatPrice(wp.banner || prices.banner)}*/m²\n` +
    `  Arakal: *${formatPrice(wp.arakal || prices.arakal)}*/m²\n` +
    `  Setka: *${formatPrice(wp.setka || prices.setka)}*/m²`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📝 Yangi Buyurtma", "new_order")],
        [Markup.button.callback("📋 Mening Buyurtmalarim", "my_orders")],
        [Markup.button.callback("💰 Narxlarni O'zgartirish", "change_prices")],
      ])
    }
  );
}

async function showAdminMenu(ctx) {
  const orders = await db.getAllOrders();
  const active = orders.filter(o => o.status !== "bekor" && o.status !== "arxiv");
  const debts = active.filter(o => (o.debtAmount || 0) > 0);
  const totalDebt = debts.reduce((s, o) => s + (o.debtAmount || 0), 0);
  return ctx.reply(
    `🔐 *Admin Panel*\n\n` +
    `📋 Faol buyurtmalar: *${active.length}* ta\n` +
    `💸 Umumiy qarz: *${formatPrice(totalDebt)}* (${debts.length} ta)`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📋 Buyurtmalar", "admin_orders"), Markup.button.callback("💸 Qarzlar", "admin_debts")],
        [Markup.button.callback("📐 m² Hisobot", "admin_m2report"), Markup.button.callback("💰 Kassa", "admin_report")],
        [Markup.button.callback("👷 Ishchilar", "admin_workers"), Markup.button.callback("⚙️ Narxlar", "admin_prices")],
      ])
    }
  );
}

async function showAddItemMenu(ctx) {
  const items = ctx.session.order.items || [];
  let text = "🛒 *Mahsulot qo'shish*\n";
  if (items.length > 0) {
    text += `\nQo'shilganlar (${items.length} ta):\n`;
    items.forEach((it, i) => {
      text += `${i+1}. ${it.material} — ${formatPrice(it.total)}\n`;
    });
    text += `\n💰 Jami: *${formatPrice(items.reduce((s,i)=>s+i.total,0))}*\n`;
  }
  text += "\nQaysi material?";
  return ctx.reply(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🖼 Banner", "item_type_banner"), Markup.button.callback("🖼 Arakal", "item_type_arakal")],
      [Markup.button.callback("🕸 Setka", "item_type_setka"), Markup.button.callback("3D Harf", "item_type_harf3d")],
      [Markup.button.callback("✅ Tulovga o'tish", "item_done")],
    ])
  });
}

async function showPaymentMenu(ctx, total, paid) {
  const debt = total - paid;
  return ctx.reply(
    `💳 *Tulov holati*\nJami: ${formatPrice(total)}\nTo'langan: ${formatPrice(paid)}\n${debt > 0 ? "Qoldi: *" + formatPrice(debt) + "*" : "✅ To'liq to'langan"}`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        debt > 0 ? [Markup.button.callback("➕ Yana tulov", "pay_add_more")] : [],
        [Markup.button.callback("✅ To'liq to'langan deb saqlash", "pay_done_full")],
        debt > 0 ? [Markup.button.callback("💸 Qarz bilan saqlash", "pay_done_debt")] : [],
      ].filter(r => r.length > 0))
    }
  );
}

async function showChangePricesMenu(ctx) {
  const prices = await db.getPrices();
  const wp = await db.getWorkerPrices(ctx.session.workerId);
  return ctx.reply(
    `💰 *Narxlarni O'zgartirish*\n\nJoriy narxlar:\nBanner: ${formatPrice(wp.banner || prices.banner)}/m²\nArakal: ${formatPrice(wp.arakal || prices.arakal)}/m²\nSetka: ${formatPrice(wp.setka || prices.setka)}/m²`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("Banner narxi", "set_price_banner")],
        [Markup.button.callback("Arakal narxi", "set_price_arakal")],
        [Markup.button.callback("Setka narxi", "set_price_setka")],
        [Markup.button.callback("◀️ Orqaga", "back_worker")],
      ])
    }
  );
}

async function showMyOrders(ctx) {
  const orders = await db.getWorkerOrders(ctx.session.workerId);
  if (!orders.length) return ctx.reply("Hali buyurtma yo'q.");
  const recent = orders.slice(0, 10);
  let text = `📋 *Mening buyurtmalarim* (oxirgi ${recent.length}):\n\n`;
  recent.forEach((o, i) => {
    const statusEmoji = { qabul:"✅",qarz:"💸",dizayn:"🎨",pechat:"🖨",chiqdi:"📦",ishxona:"🏭",arxiv:"📁",bekor:"❌" };
    text += `${i+1}. ${statusEmoji[o.status]||"•"} *${o.client.name}*\n`;
    text += `   📌 ${o.client.topic} — ${formatPrice(o.totalPrice)}\n`;
    text += `   📅 ${o.date}\n`;
    if ((o.debtAmount || 0) > 0) text += `   💸 Qarz: ${formatPrice(o.debtAmount)}\n`;
    text += "\n";
  });
  return ctx.reply(text, { parse_mode: "Markdown" });
}

async function showAdminOrders(ctx) {
  const orders = await db.getAllOrders();
  const active = orders.filter(o => o.status !== "bekor" && o.status !== "arxiv").slice(0, 8);
  if (!active.length) return ctx.reply("Faol buyurtmalar yo'q.", Markup.inlineKeyboard([[Markup.button.callback("◀️ Orqaga", "back_admin")]]));
  for (const o of active) {
    const statusLabels = { kutilmoqda:"⏳",tulovsiz:"🚫",qarz:"💸",qabul:"✅",dizayn:"🎨",pechat:"🖨️",chiqdi:"📦",ishxona:"🏭" };
    const text =
      `${statusLabels[o.status]||"•"} *${o.client.name}* | ${o.client.phone}\n` +
      `📌 ${o.client.topic}\n` +
      `👤 ${o.worker} | 📅 ${o.date}\n` +
      `💰 Jami: ${formatPrice(o.totalPrice)} | To'ldi: ${formatPrice(o.paidAmount)}` +
      ((o.debtAmount||0)>0?`\n💸 Qarz: *${formatPrice(o.debtAmount)}*`:"");
    const btns = [
      [Markup.button.callback("🎉 Olib ketti", `pickup_${o.id}`), Markup.button.callback("❌ Bekor", `cancel_order_${o.id}`)],
    ];
    if ((o.debtAmount||0)>0) btns.push([Markup.button.callback("💰 Qarz to'lovi", `debt_pay_${o.id}`)]);
    btns.push([
      Markup.button.callback("🎨 Dizayn", `status__${o.id}__dizayn`),
      Markup.button.callback("🖨 Pechat", `status__${o.id}__pechat`),
      Markup.button.callback("📦 Tayyor", `status__${o.id}__chiqdi`),
    ]);
    await ctx.reply(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(btns) });
  }
}

async function showAdminDebts(ctx) {
  const orders = await db.getAllOrders();
  const debts = orders.filter(o => (o.debtAmount||0)>0 && o.status!=="bekor" && o.status!=="arxiv");
  if (!debts.length) return ctx.reply("🎉 Qarz yo'q!", Markup.inlineKeyboard([[Markup.button.callback("◀️ Orqaga", "back_admin")]]));
  const total = debts.reduce((s,o)=>s+(o.debtAmount||0),0);
  await ctx.reply(`💸 *Qarzlar: ${debts.length} ta*\nJami: *${formatPrice(total)}*`, { parse_mode: "Markdown" });
  for (const o of debts.slice(0,10)) {
    const text = `👤 *${o.client.name}* | ${o.client.phone}\n📌 ${o.client.topic}\n💸 Qarz: *${formatPrice(o.debtAmount)}*\n✅ To'ldi: ${formatPrice(o.paidAmount)}\n📅 ${o.date}`;
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("💰 To'lov qabul qilish", `debt_pay_${o.id}`)]])
    });
  }
}

async function showAdminReport(ctx) {
  const orders = await db.getAllOrders();
  const now = new Date();
  const thisMonth = orders.filter(o => {
    const d = new Date(o.timestamp);
    return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && o.status!=="bekor";
  });
  const expenses = await db.getExpenses();
  const thisMonthExp = expenses.filter(e => {
    const d = new Date(e.timestamp);
    return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
  });
  const kirim = thisMonth.reduce((s,o)=>s+o.paidAmount,0);
  const chiqim = thisMonthExp.reduce((s,e)=>s+e.amount,0);
  const months = ["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];
  return ctx.reply(
    `💰 *Kassa — ${months[now.getMonth()]} ${now.getFullYear()}*\n\n` +
    `📥 Kirim: *${formatPrice(kirim)}*\n` +
    `📤 Chiqim: *${formatPrice(chiqim)}*\n` +
    `💼 Qoldi: *${formatPrice(kirim-chiqim)}*\n\n` +
    `📊 Buyurtmalar: ${thisMonth.length} ta`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Orqaga", "back_admin")]]) }
  );
}

async function showM2Report(ctx) {
  const orders = await db.getAllOrders();
  const now = new Date();
  const thisMonth = orders.filter(o => {
    const d = new Date(o.timestamp);
    return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && o.status!=="bekor";
  });
  const mats = { banner: {m2:0,rev:0}, arakal: {m2:0,rev:0}, setka: {m2:0,rev:0} };
  const matNames = { banner:"Banner", arakal:"Arakal", setka:"Setka" };
  thisMonth.forEach(o => {
    o.items.forEach(it => {
      const key = Object.keys(matNames).find(k => matNames[k]===it.material);
      if (key && it.billedAreaM2) {
        mats[key].m2 += it.billedAreaM2 * (it.qty||1);
        mats[key].rev += it.total||0;
      }
    });
  });
  const months = ["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];
  const totalM2 = Object.values(mats).reduce((s,v)=>s+v.m2,0);
  const totalRev = Object.values(mats).reduce((s,v)=>s+v.rev,0);
  return ctx.reply(
    `📐 *m² Hisobot — ${months[now.getMonth()]}*\n\n` +
    `🖼 Banner: *${mats.banner.m2.toFixed(2)} m²* — ${formatPrice(mats.banner.rev)}\n` +
    `🖼 Arakal: *${mats.arakal.m2.toFixed(2)} m²* — ${formatPrice(mats.arakal.rev)}\n` +
    `🕸 Setka: *${mats.setka.m2.toFixed(2)} m²* — ${formatPrice(mats.setka.rev)}\n\n` +
    `📊 Jami: *${totalM2.toFixed(2)} m²*\n` +
    `💰 Jami daromad: *${formatPrice(totalRev)}*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Orqaga", "back_admin")]]) }
  );
}

async function showAdminWorkers(ctx) {
  const workers = await db.getAllWorkers();
  let text = "👷 *Ishchilar:*\n\n";
  workers.forEach((w,i) => { text += `${i+1}. *${w.name}*\n`; });
  return ctx.reply(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("➕ Yangi ishchi qo'shish", "admin_add_worker")],
      [Markup.button.callback("◀️ Orqaga", "back_admin")],
    ])
  });
}

async function showAdminPricesMenu(ctx) {
  const prices = await db.getPrices();
  return ctx.reply(
    `⚙️ *Narxlar:*\nBanner: ${formatPrice(prices.banner)}/m²\nArakal: ${formatPrice(prices.arakal)}/m²\nSetka: ${formatPrice(prices.setka)}/m²`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("Banner narxi", "admin_set_price_banner")],
        [Markup.button.callback("Arakal narxi", "admin_set_price_arakal")],
        [Markup.button.callback("Setka narxi", "admin_set_price_setka")],
        [Markup.button.callback("◀️ Orqaga", "back_admin")],
      ])
    }
  );
}

async function saveOrder(ctx, isDebt) {
  const o = ctx.session.order;
  const tp = o.items.reduce((s, i) => s + i.total, 0);
  const pa = (o.payments || []).reduce((s, p) => s + p.amount, 0);
  const da = isDebt ? Math.max(0, tp - pa) : 0;
  const actualPa = isDebt ? pa : tp;
  const order = {
    id: genId("ORD"),
    date: nowStr(),
    timestamp: Date.now(),
    worker: ctx.session.workerName,
    workerId: ctx.session.workerId,
    client: { name: o.clientName, phone: o.clientPhone, topic: o.topic },
    items: o.items,
    totalPrice: tp,
    paidAmount: actualPa,
    debtAmount: da,
    payments: o.payments || [],
    status: da > 0 ? "qarz" : "qabul"
  };
  await db.saveOrder(order);
  ctx.session.step = null;
  ctx.session.order = {};
  await ctx.reply(
    `✅ *Buyurtma saqlandi!*\n\n` +
    `👤 ${order.client.name} | ${order.client.phone}\n` +
    `📌 ${order.client.topic}\n` +
    `🆔 ${order.id}\n` +
    `💰 Jami: ${formatPrice(tp)}\n` +
    `✅ To'langan: ${formatPrice(actualPa)}\n` +
    (da > 0 ? `💸 Qarz: *${formatPrice(da)}*\n` : "") +
    `\nMahsulotlar:\n` +
    order.items.map(it => `• ${it.material} — ${formatPrice(it.total)}`).join("\n"),
    { parse_mode: "Markdown" }
  );
  // Admin ga xabar yuborish
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId,
        `🔔 *Yangi buyurtma!*\n👤 ${order.client.name}\n📌 ${order.client.topic}\n💰 ${formatPrice(tp)}\n👷 ${order.worker}`,
        { parse_mode: "Markdown" }
      );
    } catch(e) {}
  }
  return showWorkerMenu(ctx);
}

// ── Haftalik qarz eslatmasi (Dushanba) ──
async function sendWeeklyDebtReminder() {
  const orders = await db.getAllOrders();
  const debts = orders.filter(o => (o.debtAmount||0)>0 && o.status!=="bekor" && o.status!=="arxiv");
  if (!debts.length) return;
  const total = debts.reduce((s,o)=>s+(o.debtAmount||0),0);
  let msg = `⚠️ *Haftalik Qarz Eslatmasi*\n\n${debts.length} ta to'lanmagan qarz:\nJami: *${formatPrice(total)}*\n\n`;
  debts.slice(0,10).forEach((o,i) => {
    msg += `${i+1}. ${o.client.name} — *${formatPrice(o.debtAmount)}*\n   📱 ${o.client.phone}\n`;
  });
  for (const adminId of ADMIN_IDS) {
    try { await bot.telegram.sendMessage(adminId, msg, { parse_mode: "Markdown" }); } catch(e) {}
  }
}

// Dushanba 9:00 da eslatma
function scheduleWeeklyReminder() {
  const checkTime = () => {
    const now = new Date();
    if (now.getDay() === 1 && now.getHours() === 9 && now.getMinutes() === 0) {
      sendWeeklyDebtReminder();
    }
  };
  setInterval(checkTime, 60 * 1000); // har daqiqa tekshiradi
}

scheduleWeeklyReminder();
bot.launch();
console.log("Bot ishga tushdi! ✅");
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
