const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ── Jadvallarni yaratish ──
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(100) NOT NULL,
      telegram_id BIGINT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS worker_prices (
      worker_id INTEGER REFERENCES workers(id),
      material VARCHAR(50),
      price INTEGER,
      PRIMARY KEY (worker_id, material)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(50) PRIMARY KEY,
      data JSONB NOT NULL,
      worker_id INTEGER REFERENCES workers(id),
      status VARCHAR(50),
      timestamp BIGINT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prices (
      material VARCHAR(50) PRIMARY KEY,
      price INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id VARCHAR(50) PRIMARY KEY,
      data JSONB NOT NULL,
      timestamp BIGINT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS incomes (
      id VARCHAR(50) PRIMARY KEY,
      data JSONB NOT NULL,
      timestamp BIGINT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Default narxlar
  await pool.query(`
    INSERT INTO prices (material, price) VALUES
      ('banner', 45000), ('arakal', 75000), ('setka', 85000)
    ON CONFLICT (material) DO NOTHING;
  `);

  // Default ishchilar
  const defaultWorkers = [
    { name: "Javohir", password: "20060818" },
    { name: "Shoira",  password: "1987" },
    { name: "Akbar",   password: "1985" },
  ];
  for (const w of defaultWorkers) {
    await pool.query(
      `INSERT INTO workers (name, password) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [w.name, w.password]
    );
  }
  console.log("✅ DB tayyor!");
}

// ── Workers ──
async function getAllWorkers() {
  const res = await pool.query("SELECT * FROM workers ORDER BY id");
  return res.rows;
}

async function getWorkerByTelegramId(telegramId) {
  const res = await pool.query("SELECT * FROM workers WHERE telegram_id = $1", [telegramId]);
  return res.rows[0] || null;
}

async function getWorkerByPassword(password) {
  const res = await pool.query("SELECT * FROM workers WHERE password = $1", [password]);
  return res.rows[0] || null;
}

async function setWorkerTelegramId(workerId, telegramId) {
  await pool.query("UPDATE workers SET telegram_id = $1 WHERE id = $2", [telegramId, workerId]);
}

async function addWorker(name, password) {
  await pool.query("INSERT INTO workers (name, password) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET password = $2", [name, password]);
}

async function removeWorker(workerId) {
  await pool.query("DELETE FROM workers WHERE id = $1", [workerId]);
}

// ── Worker prices ──
async function getWorkerPrices(workerId) {
  const res = await pool.query("SELECT * FROM worker_prices WHERE worker_id = $1", [workerId]);
  const prices = {};
  res.rows.forEach(r => { prices[r.material] = r.price; });
  return prices;
}

async function setWorkerPrice(workerId, material, price) {
  await pool.query(
    `INSERT INTO worker_prices (worker_id, material, price) VALUES ($1, $2, $3)
     ON CONFLICT (worker_id, material) DO UPDATE SET price = $3`,
    [workerId, material, price]
  );
}

// ── Global prices ──
async function getPrices() {
  const res = await pool.query("SELECT * FROM prices");
  const prices = {};
  res.rows.forEach(r => { prices[r.material] = r.price; });
  return prices;
}

async function setPrice(material, price) {
  await pool.query("UPDATE prices SET price = $1 WHERE material = $2", [price, material]);
}

// ── Orders ──
async function saveOrder(order) {
  const worker = await pool.query("SELECT id FROM workers WHERE name = $1", [order.worker]);
  const workerId = worker.rows[0]?.id;
  await pool.query(
    "INSERT INTO orders (id, data, worker_id, status, timestamp) VALUES ($1, $2, $3, $4, $5)",
    [order.id, JSON.stringify(order), workerId, order.status, order.timestamp]
  );
}

async function getAllOrders() {
  const res = await pool.query("SELECT data FROM orders ORDER BY timestamp DESC");
  return res.rows.map(r => r.data);
}

async function getOrder(orderId) {
  const res = await pool.query("SELECT data FROM orders WHERE id = $1", [orderId]);
  return res.rows[0]?.data || null;
}

async function getWorkerOrders(workerId) {
  const res = await pool.query("SELECT data FROM orders WHERE worker_id = $1 ORDER BY timestamp DESC", [workerId]);
  return res.rows.map(r => r.data);
}

async function updateOrder(orderId, updates) {
  const res = await pool.query("SELECT data FROM orders WHERE id = $1", [orderId]);
  if (!res.rows[0]) return;
  const order = { ...res.rows[0].data, ...updates };
  await pool.query(
    "UPDATE orders SET data = $1, status = $2 WHERE id = $3",
    [JSON.stringify(order), order.status, orderId]
  );
}

// ── Expenses ──
async function getExpenses() {
  const res = await pool.query("SELECT data FROM expenses ORDER BY timestamp DESC");
  return res.rows.map(r => r.data);
}

async function saveExpense(expense) {
  await pool.query(
    "INSERT INTO expenses (id, data, timestamp) VALUES ($1, $2, $3)",
    [expense.id, JSON.stringify(expense), expense.timestamp]
  );
}

initDB().catch(console.error);

module.exports = {
  getAllWorkers, getWorkerByTelegramId, getWorkerByPassword, setWorkerTelegramId,
  addWorker, removeWorker, getWorkerPrices, setWorkerPrice,
  getPrices, setPrice,
  saveOrder, getAllOrders, getOrder, getWorkerOrders, updateOrder,
  getExpenses, saveExpense,
};
