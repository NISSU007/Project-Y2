// ===== นำเข้าโมดูล =====
const express = require('express');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');

// ===== ตั้งค่าแอป =====
const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===== เชื่อมต่อฐานข้อมูล mala.db =====
const db = new sqlite3.Database(path.join(__dirname, 'mala.db'), (err) => {
  if (err) console.error(err.message);
  else console.log('เชื่อมต่อ mala.db สำเร็จ');
});

// ===== ฟังก์ชันช่วยเรียกฐานข้อมูล (Promise) =====
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// ===== ค่าคงที่สถานะออเดอร์ =====
const STATUS = {
  CART: 'ตะกร้า',
  WAIT_PAY: 'รอชำระเงิน',
  PREPARING: 'กำลังเตรียมอาหาร',
  COOKED: 'ปรุงเสร็จสิ้น',
  READY: 'พร้อมเสิร์ฟ',
  DONE: 'เสร็จสิ้น'
};
const SPICE_LEVELS = ['ไม่เผ็ด', 'เผ็ดน้อย', 'เผ็ดกลาง', 'เผ็ดมาก'];
const PAYMENT_TIMEOUT_MIN = 15;

// ===== ตัวนับการแจ้งเตือนลูกค้า (เก็บในหน่วยความจำ) =====
const notifyCount = {};

// ===== ฟังก์ชันช่วยทั่วไป =====
function orderNo(ref) {
  return ref ? ref.replace('-', '') : '-';
}
function baht(n) {
  return Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
}
function groupOf(categoryName) {
  if (categoryName === 'ซุป') return 'soup';
  if (categoryName === 'ของทานเล่น') return 'snack';
  if (categoryName === 'เครื่องดื่ม') return 'drink';
  return 'raw';
}
const CATEGORY_ICON = {
  'ซุป': '🍲', 'เนื้อสัตว์': '🥩', 'ซีฟู้ด': '🦐', 'ผัก': '🥬',
  'ลูกชิ้นและของแปรรูป': '🍢', 'เส้น': '🍜', 'อื่นๆ': '🥚',
  'ของทานเล่น': '🥟', 'เครื่องดื่ม': '🥤'
};

// ===== ตัวแปรที่ใช้ได้ทุกหน้า EJS =====
app.locals.orderNo = orderNo;
app.locals.baht = baht;
app.locals.STATUS = STATUS;
app.locals.CATEGORY_ICON = CATEGORY_ICON;

// ===== หา IP ของเครื่องในวง LAN (ใช้ทำ QR Code) =====
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
function getBaseURL(req) {
  if (req.query.base) return req.query.base.replace(/\/$/, '');
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  return 'http://' + getLocalIP() + ':' + PORT;
}

// ===== ฟังก์ชันจัดการตะกร้า / ออเดอร์ =====
async function getTable(tableId) {
  return dbGet('SELECT * FROM "Table" WHERE Table_ID = ?', [tableId]);
}

async function getCart(tableId) {
  return dbGet(
    'SELECT * FROM "Order" WHERE Table_ID = ? AND Order_Status = ? ORDER BY Order_ID DESC LIMIT 1',
    [tableId, STATUS.CART]
  );
}

async function getOrCreateCart(tableId) {
  let cart = await getCart(tableId);
  if (!cart) {
    const r = await dbRun(
      'INSERT INTO "Order" (Table_ID, Order_Type, Total_Price, Order_Status) VALUES (?, ?, ?, ?)',
      [tableId, 'ทานที่ร้าน', 0, STATUS.CART]
    );
    cart = await dbGet('SELECT * FROM "Order" WHERE Order_ID = ?', [r.lastID]);
  }
  return cart;
}

async function getOrderItems(orderId) {
  return dbAll(
    `SELECT d.*, m.Menu_Name, m.Image_URL, m.Description, c.Category_Name
     FROM Order_Detail d
     JOIN Menu m ON d.Menu_ID = m.Menu_ID
     LEFT JOIN Category c ON m.Category_ID = c.Category_ID
     WHERE d.Order_ID = ?
     ORDER BY d.Order_Detail_ID`,
    [orderId]
  );
}

async function recalcTotal(orderId) {
  const row = await dbGet('SELECT IFNULL(SUM(Subtotal), 0) AS total FROM Order_Detail WHERE Order_ID = ?', [orderId]);
  await dbRun('UPDATE "Order" SET Total_Price = ? WHERE Order_ID = ?', [row.total, orderId]);
  return row.total;
}

async function getOrderFull(orderId) {
  const order = await dbGet(
    `SELECT o.*, t.Table_Number,
       strftime('%H:%M', o.Order_Date_Time, 'localtime') AS Order_Time,
       strftime('%d/%m/%Y', o.Order_Date_Time, 'localtime') AS Order_Date,
       p.Payment_ID, p.Payment_Method, p.Payment_Amount, p.Change_Amount, p.Payment_Status, p.Transaction_Ref
     FROM "Order" o
     LEFT JOIN "Table" t ON o.Table_ID = t.Table_ID
     LEFT JOIN Payment p ON p.Order_ID = o.Order_ID
     WHERE o.Order_ID = ?`,
    [orderId]
  );
  if (!order) return null;
  order.items = await getOrderItems(orderId);
  return order;
}

async function getOrdersByStatus(statusList, search) {
  const marks = statusList.map(() => '?').join(',');
  let sql = `SELECT o.*, t.Table_Number,
       strftime('%H:%M', o.Order_Date_Time, 'localtime') AS Order_Time,
       (SELECT COUNT(*) FROM Order_Detail d WHERE d.Order_ID = o.Order_ID) AS Item_Count
     FROM "Order" o
     LEFT JOIN "Table" t ON o.Table_ID = t.Table_ID
     WHERE o.Order_Status IN (${marks})`;
  const params = [...statusList];
  if (search) {
    sql += ` AND REPLACE(o.Reference_Code, '-', '') LIKE ?`;
    params.push('%' + search.replace('-', '') + '%');
  }
  sql += ' ORDER BY o.Order_Date_Time ASC';
  const orders = await dbAll(sql, params);
  for (const o of orders) o.items = await getOrderItems(o.Order_ID);
  return orders;
}

async function makeReferenceCode(table) {
  const row = await dbGet(
    'SELECT COUNT(*) AS n FROM "Order" WHERE Table_ID = ? AND Reference_Code IS NOT NULL',
    [table.Table_ID]
  );
  return table.Table_Number + '-' + String(row.n + 1).padStart(3, '0');
}

async function cutStock(orderId) {
  const items = await dbAll('SELECT Menu_ID, Quantity FROM Order_Detail WHERE Order_ID = ?', [orderId]);
  for (const it of items) {
    await dbRun('UPDATE Menu SET Stock_Quantity = Stock_Quantity - ? WHERE Menu_ID = ?', [it.Quantity, it.Menu_ID]);
  }
  await dbRun('UPDATE Menu SET Is_Available = 0 WHERE Stock_Quantity <= 0');
}

async function getEmployee(role) {
  return dbGet('SELECT * FROM Employee WHERE Role = ? LIMIT 1', [role]);
}

// =====================================================================
// ===== หน้าแรก (เลือกหน้าจอ ลูกค้า / พนักงาน) =====
// =====================================================================
app.get('/', async (req, res) => {
  try {
    const tables = await dbAll('SELECT * FROM "Table" ORDER BY Table_ID');
    res.render('index', { tables, baseURL: getBaseURL(req) });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== หน้า QR Code ประจำโต๊ะ (สำหรับเปิดให้สแกน / พิมพ์) =====
// =====================================================================
app.get('/qr', async (req, res) => {
  try {
    const baseURL = getBaseURL(req);
    const tables = await dbAll('SELECT * FROM "Table" ORDER BY Table_ID');
    for (const t of tables) {
      t.fullURL = baseURL + t.QR_Code_URL;
      t.qrImage = await QRCode.toDataURL(t.fullURL, { width: 320, margin: 1 });
    }
    res.render('staff/qr', { tables, baseURL, single: false });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/qr/:tableId', async (req, res) => {
  try {
    const baseURL = getBaseURL(req);
    const t = await getTable(req.params.tableId);
    if (!t) return res.status(404).send('ไม่พบโต๊ะ');
    t.fullURL = baseURL + t.QR_Code_URL;
    t.qrImage = await QRCode.toDataURL(t.fullURL, { width: 480, margin: 1 });
    res.render('staff/qr', { tables: [t], baseURL, single: true });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== ลูกค้า : UC01 แสดงรายการอาหาร =====
// =====================================================================
app.get('/table/:tableId', (req, res) => {
  res.redirect('/table/' + req.params.tableId + '/menu');
});

app.get('/table/:tableId/menu', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    if (!table) return res.status(404).send('ไม่พบโต๊ะนี้ กรุณาสแกน QR Code ใหม่');

    const tab = req.query.tab || 'all';
    const categories = await dbAll('SELECT * FROM Category ORDER BY Category_ID');
    categories.forEach((c) => (c.group = groupOf(c.Category_Name)));

    const menus = await dbAll(
      `SELECT m.*, c.Category_Name FROM Menu m
       LEFT JOIN Category c ON m.Category_ID = c.Category_ID
       ORDER BY m.Category_ID, m.Menu_ID`
    );
    menus.forEach((m) => {
      m.group = groupOf(m.Category_Name);
      m.soldOut = m.Is_Available === 0 || m.Stock_Quantity <= 0;
    });

    const rawCats = categories.filter((c) => c.group === 'raw');
    const selectedCat = Number(req.query.cat) || (rawCats[0] ? rawCats[0].Category_ID : 0);

    const cart = await getCart(table.Table_ID);
    let cartCount = 0;
    let cartTotal = 0;
    if (cart) {
      const s = await dbGet(
        'SELECT IFNULL(SUM(Quantity),0) AS qty, IFNULL(SUM(Subtotal),0) AS total FROM Order_Detail WHERE Order_ID = ?',
        [cart.Order_ID]
      );
      cartCount = s.qty;
      cartTotal = s.total;
    }

    res.render('customer/menu', {
      table, tab, categories, rawCats, selectedCat, menus,
      cartCount, cartTotal,
      added: req.query.added,
      error: req.query.error
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== ลูกค้า : UC02 เลือกและปรับแต่งรายการอาหาร =====
// =====================================================================
app.get('/table/:tableId/item/:menuId', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    const menu = await dbGet(
      `SELECT m.*, c.Category_Name FROM Menu m
       LEFT JOIN Category c ON m.Category_ID = c.Category_ID WHERE m.Menu_ID = ?`,
      [req.params.menuId]
    );
    if (!table || !menu) return res.status(404).send('ไม่พบรายการ');
    menu.soldOut = menu.Is_Available === 0 || menu.Stock_Quantity <= 0;
    menu.isSoup = menu.Category_Name === 'ซุป';

    let editItem = null;
    if (req.query.edit) {
      editItem = await dbGet('SELECT * FROM Order_Detail WHERE Order_Detail_ID = ?', [req.query.edit]);
    }

    res.render('customer/item', {
      table, menu, editItem,
      spiceLevels: SPICE_LEVELS,
      error: req.query.error,
      backTab: groupOf(menu.Category_Name)
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/table/:tableId/cart/add', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const { menuId, spice, note, detailId } = req.body;
    const qty = Math.max(1, parseInt(req.body.qty, 10) || 1);
    const menu = await dbGet(
      `SELECT m.*, c.Category_Name FROM Menu m
       LEFT JOIN Category c ON m.Category_ID = c.Category_ID WHERE m.Menu_ID = ?`,
      [menuId]
    );
    if (!menu) return res.redirect('/table/' + tableId + '/menu');

    const backURL = '/table/' + tableId + '/item/' + menuId + (detailId ? '?edit=' + detailId + '&' : '?');

    if (menu.Is_Available === 0 || menu.Stock_Quantity <= 0) {
      return res.redirect(backURL + 'error=soldout');
    }

    const isSoup = menu.Category_Name === 'ซุป';
    if (isSoup && !SPICE_LEVELS.includes(spice)) {
      return res.redirect(backURL + 'error=spice');
    }

    const spiceValue = isSoup ? spice : null;
    const soupValue = isSoup ? menu.Menu_Name : null;
    const noteValue = (note || '').trim();
    const finalQty = isSoup ? 1 : qty;

    const cart = await getOrCreateCart(tableId);

    if (detailId) {
      await dbRun(
        `UPDATE Order_Detail SET Quantity = ?, Unit_Price = ?, Subtotal = ?, Spiciness_Level = ?, Soup_Type = ?, Special_Note = ?
         WHERE Order_Detail_ID = ? AND Order_ID = ?`,
        [finalQty, menu.Price, finalQty * menu.Price, spiceValue, soupValue, noteValue, detailId, cart.Order_ID]
      );
      await recalcTotal(cart.Order_ID);
      return res.redirect('/table/' + tableId + '/cart');
    }

    const same = await dbGet(
      `SELECT * FROM Order_Detail WHERE Order_ID = ? AND Menu_ID = ?
       AND IFNULL(Spiciness_Level,'') = ? AND IFNULL(Special_Note,'') = ?`,
      [cart.Order_ID, menu.Menu_ID, spiceValue || '', noteValue]
    );
    if (same && !isSoup) {
      const newQty = same.Quantity + finalQty;
      await dbRun('UPDATE Order_Detail SET Quantity = ?, Subtotal = ? WHERE Order_Detail_ID = ?',
        [newQty, newQty * same.Unit_Price, same.Order_Detail_ID]);
    } else {
      await dbRun(
        `INSERT INTO Order_Detail (Order_ID, Menu_ID, Quantity, Unit_Price, Subtotal, Spiciness_Level, Soup_Type, Special_Note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [cart.Order_ID, menu.Menu_ID, finalQty, menu.Price, finalQty * menu.Price, spiceValue, soupValue, noteValue]
      );
    }
    await recalcTotal(cart.Order_ID);
    res.redirect('/table/' + tableId + '/menu?tab=' + groupOf(menu.Category_Name) + '&cat=' + menu.Category_ID + '&added=' + encodeURIComponent(menu.Menu_Name));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== ลูกค้า : UC03 แก้ไขรายการอาหารในตะกร้า =====
// =====================================================================
app.get('/table/:tableId/cart', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    if (!table) return res.status(404).send('ไม่พบโต๊ะ');
    const cart = await getCart(table.Table_ID);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    const total = items.reduce((sum, it) => sum + it.Subtotal, 0);
    res.render('customer/cart', { table, cart, items, total, error: req.query.error });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/table/:tableId/cart/update/:detailId', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const cart = await getCart(tableId);
    if (!cart) return res.redirect('/table/' + tableId + '/cart');
    const item = await dbGet('SELECT * FROM Order_Detail WHERE Order_Detail_ID = ? AND Order_ID = ?',
      [req.params.detailId, cart.Order_ID]);
    if (item) {
      const newQty = req.body.action === 'plus' ? item.Quantity + 1 : item.Quantity - 1;
      if (newQty <= 0) {
        await dbRun('DELETE FROM Order_Detail WHERE Order_Detail_ID = ?', [item.Order_Detail_ID]);
      } else {
        await dbRun('UPDATE Order_Detail SET Quantity = ?, Subtotal = ? WHERE Order_Detail_ID = ?',
          [newQty, newQty * item.Unit_Price, item.Order_Detail_ID]);
      }
      await recalcTotal(cart.Order_ID);
    }
    res.redirect('/table/' + tableId + '/cart');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/table/:tableId/cart/delete/:detailId', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const cart = await getCart(tableId);
    if (cart) {
      await dbRun('DELETE FROM Order_Detail WHERE Order_Detail_ID = ? AND Order_ID = ?',
        [req.params.detailId, cart.Order_ID]);
      await recalcTotal(cart.Order_ID);
    }
    res.redirect('/table/' + tableId + '/cart');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== ลูกค้า : UC04 ยืนยันคำสั่งซื้อ =====
// =====================================================================
app.post('/table/:tableId/cart/confirm', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const cart = await getCart(tableId);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    if (items.length === 0) return res.redirect('/table/' + tableId + '/cart?error=empty');
    res.redirect('/table/' + tableId + '/summary');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/table/:tableId/summary', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    const cart = await getCart(req.params.tableId);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    if (items.length === 0) return res.redirect('/table/' + req.params.tableId + '/cart?error=empty');
    const total = items.reduce((sum, it) => sum + it.Subtotal, 0);
    res.render('customer/summary', { table, cart, items, total });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/table/:tableId/checkout', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const table = await getTable(tableId);
    const cart = await getCart(tableId);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    if (items.length === 0) return res.redirect('/table/' + tableId + '/cart?error=empty');

    const ref = await makeReferenceCode(table);
    await recalcTotal(cart.Order_ID);
    await dbRun(
      'UPDATE "Order" SET Order_Status = ?, Reference_Code = ?, Order_Date_Time = CURRENT_TIMESTAMP WHERE Order_ID = ?',
      [STATUS.WAIT_PAY, ref, cart.Order_ID]
    );
    await dbRun('UPDATE "Table" SET Table_Status = ? WHERE Table_ID = ?', ['มีลูกค้า', tableId]);
    res.redirect('/table/' + tableId + '/payment/' + cart.Order_ID);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== ลูกค้า : UC05 เลือกช่องทางการชำระเงิน และชำระเงิน =====
// =====================================================================
async function expireOrder(order) {
  const cart = await getCart(order.Table_ID);
  if (cart) {
    await dbRun('UPDATE Order_Detail SET Order_ID = ? WHERE Order_ID = ?', [cart.Order_ID, order.Order_ID]);
    await dbRun('DELETE FROM "Order" WHERE Order_ID = ?', [order.Order_ID]);
    await recalcTotal(cart.Order_ID);
  } else {
    await dbRun('UPDATE "Order" SET Order_Status = ?, Reference_Code = NULL WHERE Order_ID = ?',
      [STATUS.CART, order.Order_ID]);
  }
}

app.get('/table/:tableId/payment/:orderId', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const table = await getTable(tableId);
    const order = await getOrderFull(req.params.orderId);
    if (!table || !order) return res.redirect('/table/' + tableId + '/menu');

    if (order.Order_Status !== STATUS.WAIT_PAY) {
      return res.redirect('/table/' + tableId + '/order/' + order.Order_ID);
    }

    const age = await dbGet(
      "SELECT (julianday('now') - julianday(Order_Date_Time)) * 86400 AS sec FROM \"Order\" WHERE Order_ID = ?",
      [order.Order_ID]
    );
    const secondsLeft = Math.max(0, Math.floor(PAYMENT_TIMEOUT_MIN * 60 - age.sec));

    if (!order.Payment_ID && secondsLeft <= 0) {
      await expireOrder(order);
      return res.redirect('/table/' + tableId + '/cart?error=expired');
    }

    let method = req.query.method || null;
    if (order.Payment_Method === 'เงินสด' && !method) method = 'cash';

    let qrImage = null;
    if (method === 'qr') {
      const payload = 'MALA-PAY|REF:' + order.Reference_Code + '|AMOUNT:' + order.Total_Price;
      qrImage = await QRCode.toDataURL(payload, { width: 260, margin: 1 });
    }

    res.render('customer/payment', { table, order, method, qrImage, secondsLeft, hasPayment: !!order.Payment_ID });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/table/:tableId/payment/:orderId/cash', async (req, res) => {
  const { tableId, orderId } = req.params;
  try {
    const order = await dbGet('SELECT * FROM "Order" WHERE Order_ID = ?', [orderId]);
    if (!order || order.Order_Status !== STATUS.WAIT_PAY) return res.redirect('/table/' + tableId + '/order/' + orderId);
    const pay = await dbGet('SELECT * FROM Payment WHERE Order_ID = ?', [orderId]);
    if (!pay) {
      await dbRun(
        'INSERT INTO Payment (Order_ID, Payment_Method, Payment_Amount, Change_Amount, Payment_Status) VALUES (?, ?, ?, ?, ?)',
        [orderId, 'เงินสด', 0, 0, 'รอชำระ']
      );
    } else {
      await dbRun('UPDATE Payment SET Payment_Method = ?, Payment_Status = ? WHERE Order_ID = ?', ['เงินสด', 'รอชำระ', orderId]);
    }
    res.redirect('/table/' + tableId + '/payment/' + orderId + '?method=cash');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/table/:tableId/payment/:orderId/qr', async (req, res) => {
  const { tableId, orderId } = req.params;
  try {
    const order = await dbGet('SELECT * FROM "Order" WHERE Order_ID = ?', [orderId]);
    if (!order || order.Order_Status !== STATUS.WAIT_PAY) return res.redirect('/table/' + tableId + '/order/' + orderId);
    const txn = 'TXN' + Date.now();
    const pay = await dbGet('SELECT * FROM Payment WHERE Order_ID = ?', [orderId]);
    if (!pay) {
      await dbRun(
        `INSERT INTO Payment (Order_ID, Payment_Method, Payment_Amount, Change_Amount, Payment_Status, Transaction_Ref)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, 'QR Code', order.Total_Price, 0, 'ชำระแล้ว', txn]
      );
    } else {
      await dbRun(
        `UPDATE Payment SET Payment_Method = ?, Payment_Amount = ?, Change_Amount = 0, Payment_Status = ?,
         Transaction_Ref = ?, Payment_Date_Time = CURRENT_TIMESTAMP WHERE Order_ID = ?`,
        ['QR Code', order.Total_Price, 'ชำระแล้ว', txn, orderId]
      );
    }
    await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ?', [STATUS.PREPARING, orderId]);
    await cutStock(orderId);
    res.redirect('/table/' + tableId + '/order/' + orderId);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== ลูกค้า : UC07 ติดตามสถานะคำสั่งซื้อ และแสดงรายละเอียดออเดอร์ =====
// =====================================================================
app.get('/table/:tableId/order/:orderId', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    const order = await getOrderFull(req.params.orderId);
    if (!table || !order || order.Order_Status === STATUS.CART) {
      return res.redirect('/table/' + req.params.tableId + '/menu');
    }
    res.render('customer/order', { table, order, notify: notifyCount[order.Order_ID] || 0 });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/table/:tableId/orders', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    if (!table) return res.status(404).send('ไม่พบโต๊ะ');
    const orders = await dbAll(
      `SELECT o.*, strftime('%H:%M', o.Order_Date_Time, 'localtime') AS Order_Time
       FROM "Order" o
       WHERE o.Table_ID = ? AND o.Order_Status != ?
       AND date(o.Order_Date_Time, 'localtime') = date('now', 'localtime')
       ORDER BY o.Order_ID DESC`,
      [table.Table_ID, STATUS.CART]
    );
    res.render('customer/orders', { table, orders });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ===== API สถานะออเดอร์ (หน้าลูกค้าเรียกเช็คทุก 3 วินาที) =====
app.get('/api/order/:orderId', async (req, res) => {
  try {
    const order = await dbGet('SELECT Order_ID, Order_Status FROM "Order" WHERE Order_ID = ?', [req.params.orderId]);
    if (!order) return res.json({ ok: false });
    res.json({ ok: true, status: order.Order_Status, notify: notifyCount[order.Order_ID] || 0 });
  } catch (err) {
    res.json({ ok: false });
  }
});

// =====================================================================
// ===== พนักงานแคชเชียร์ : UC06 รับชำระเงินสด =====
// =====================================================================
app.get('/cashier', async (req, res) => {
  try {
    const tab = req.query.tab || 'all';
    const q = (req.query.q || '').trim();

    let sql = `SELECT o.*, t.Table_Number, p.Payment_Method, p.Payment_Status,
         strftime('%H:%M', o.Order_Date_Time, 'localtime') AS Order_Time,
         (SELECT COUNT(*) FROM Order_Detail d WHERE d.Order_ID = o.Order_ID) AS Item_Count
       FROM "Order" o
       JOIN Payment p ON p.Order_ID = o.Order_ID
       LEFT JOIN "Table" t ON o.Table_ID = t.Table_ID
       WHERE date(o.Order_Date_Time, 'localtime') = date('now', 'localtime')`;
    const params = [];
    if (q) {
      sql += ` AND REPLACE(o.Reference_Code, '-', '') LIKE ?`;
      params.push('%' + q.replace('-', '') + '%');
    }
    sql += ' ORDER BY (p.Payment_Status = \'รอชำระ\') DESC, o.Order_Date_Time DESC';
    const all = await dbAll(sql, params);

    const pending = all.filter((o) => o.Payment_Status === 'รอชำระ');
    const paid = all.filter((o) => o.Payment_Status === 'ชำระแล้ว');
    const list = tab === 'pending' ? pending : tab === 'paid' ? paid : all;

    let selected = null;
    if (req.query.id) selected = await getOrderFull(req.query.id);

    const employee = await getEmployee('แคชเชียร์');
    res.render('cashier/index', {
      tab, q, list, selected, employee,
      counts: { all: all.length, pending: pending.length, paid: paid.length },
      error: req.query.error,
      success: req.query.success
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/cashier/pay/:orderId', async (req, res) => {
  const orderId = req.params.orderId;
  try {
    const order = await dbGet('SELECT * FROM "Order" WHERE Order_ID = ?', [orderId]);
    const pay = await dbGet('SELECT * FROM Payment WHERE Order_ID = ?', [orderId]);
    if (!order || !pay || pay.Payment_Status === 'ชำระแล้ว') return res.redirect('/cashier?id=' + orderId);

    const received = parseFloat(req.body.received);
    if (isNaN(received) || received < order.Total_Price) {
      return res.redirect('/cashier?tab=pending&id=' + orderId + '&error=notenough');
    }
    const change = received - order.Total_Price;

    await dbRun(
      `UPDATE Payment SET Payment_Amount = ?, Change_Amount = ?, Payment_Status = ?,
       Payment_Date_Time = CURRENT_TIMESTAMP, Transaction_Ref = ? WHERE Order_ID = ?`,
      [received, change, 'ชำระแล้ว', 'CASH' + Date.now(), orderId]
    );
    await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ?', [STATUS.PREPARING, orderId]);
    await cutStock(orderId);
    res.redirect('/cashier?tab=all&id=' + orderId + '&success=1');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== พนักงานครัว : UC08 แสดงรายละเอียดออเดอร์ที่ต้องปรุง และพิมพ์รายการอาหาร =====
// =====================================================================
app.get('/kitchen', async (req, res) => {
  try {
    const tab = req.query.tab || 'preparing';
    const q = (req.query.q || '').trim();

    const preparing = await getOrdersByStatus([STATUS.PREPARING], q);
    const cooked = await getOrdersByStatus([STATUS.COOKED], q);
    const doneToday = await dbGet(
      `SELECT COUNT(*) AS n FROM "Order" WHERE Order_Status IN (?, ?)
       AND date(Order_Date_Time, 'localtime') = date('now', 'localtime')`,
      [STATUS.READY, STATUS.DONE]
    );

    let list = preparing;
    if (tab === 'cooked') list = cooked;
    if (tab === 'all') list = await getOrdersByStatus([STATUS.PREPARING, STATUS.COOKED, STATUS.READY], q);

    let selected = null;
    if (req.query.id) selected = await getOrderFull(req.query.id);

    const employee = await getEmployee('ครัว');
    res.render('kitchen/index', {
      tab, q, list, selected, employee,
      counts: { preparing: preparing.length, cooked: cooked.length, done: doneToday.n },
      success: req.query.success
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/kitchen/print/:orderId', async (req, res) => {
  try {
    const order = await getOrderFull(req.params.orderId);
    if (!order) return res.status(404).send('ไม่พบออเดอร์');
    res.render('kitchen/print', { order });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== พนักงานครัว : UC09 อัปเดตสถานะออเดอร์ (ปรุงเสร็จสิ้น) =====
// =====================================================================
app.get('/kitchen/status', async (req, res) => {
  try {
    const list = await getOrdersByStatus([STATUS.PREPARING]);
    let selected = null;
    const id = req.query.id || (list[0] ? list[0].Order_ID : null);
    if (id) selected = await getOrderFull(id);
    const employee = await getEmployee('ครัว');
    res.render('kitchen/status', { list, selected, employee, success: req.query.success });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/kitchen/status/:orderId', async (req, res) => {
  try {
    await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ? AND Order_Status = ?',
      [STATUS.COOKED, req.params.orderId, STATUS.PREPARING]);
    const o = await dbGet('SELECT Reference_Code FROM "Order" WHERE Order_ID = ?', [req.params.orderId]);
    res.redirect('/kitchen?success=' + encodeURIComponent(orderNo(o ? o.Reference_Code : '')));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== พนักงานหน้าเคาน์เตอร์ : UC10 แสดงออเดอร์ที่พร้อมเสิร์ฟ =====
// =====================================================================
async function counterCounts() {
  const a = await dbGet('SELECT COUNT(*) AS n FROM "Order" WHERE Order_Status = ?', [STATUS.COOKED]);
  const b = await dbGet('SELECT COUNT(*) AS n FROM "Order" WHERE Order_Status = ?', [STATUS.READY]);
  return { cooked: a.n, ready: b.n };
}

app.get('/counter', async (req, res) => {
  try {
    const list = await getOrdersByStatus([STATUS.COOKED]);
    let selected = null;
    if (req.query.id) selected = await getOrderFull(req.query.id);
    const employee = await getEmployee('หน้าเคาน์เตอร์');
    res.render('counter/index', { list, selected, employee, counts: await counterCounts(), page: 'ready' });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== พนักงานหน้าเคาน์เตอร์ : UC09 อัปเดตสถานะออเดอร์ (พร้อมเสิร์ฟ) =====
// =====================================================================
app.get('/counter/status', async (req, res) => {
  try {
    const list = await getOrdersByStatus([STATUS.COOKED]);
    let selected = null;
    const id = req.query.id || (list[0] ? list[0].Order_ID : null);
    if (id) selected = await getOrderFull(id);
    const employee = await getEmployee('หน้าเคาน์เตอร์');
    res.render('counter/status', { list, selected, employee, counts: await counterCounts(), page: 'status', success: req.query.success });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/counter/status/:orderId', async (req, res) => {
  try {
    const r = await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ? AND Order_Status = ?',
      [STATUS.READY, req.params.orderId, STATUS.COOKED]);
    if (r.changes > 0) notifyCount[req.params.orderId] = 1;
    const o = await dbGet('SELECT Reference_Code FROM "Order" WHERE Order_ID = ?', [req.params.orderId]);
    res.redirect('/counter/status?success=' + encodeURIComponent(orderNo(o ? o.Reference_Code : '')));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =====================================================================
// ===== พนักงานหน้าเคาน์เตอร์ : UC11 แจ้งเตือนและยืนยันการรับอาหาร =====
// =====================================================================
app.get('/counter/notify', async (req, res) => {
  try {
    const list = await getOrdersByStatus([STATUS.READY]);
    let selected = null;
    const id = req.query.id || (list[0] ? list[0].Order_ID : null);
    if (id) selected = await getOrderFull(id);
    if (selected) selected.notify = notifyCount[selected.Order_ID] || 0;
    const employee = await getEmployee('หน้าเคาน์เตอร์');
    res.render('counter/notify', {
      list, selected, employee, counts: await counterCounts(), page: 'notify',
      message: req.query.message
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/counter/notify/:orderId', (req, res) => {
  const id = req.params.orderId;
  notifyCount[id] = (notifyCount[id] || 0) + 1;
  res.redirect('/counter/notify?id=' + id + '&message=renotify');
});

app.post('/counter/complete/:orderId', async (req, res) => {
  try {
    await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ? AND Order_Status = ?',
      [STATUS.DONE, req.params.orderId, STATUS.READY]);
    delete notifyCount[req.params.orderId];
    res.redirect('/counter/notify?message=done');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ===== เริ่มเซิร์ฟเวอร์ =====
app.listen(PORT, '0.0.0.0', () => {
  console.log('เปิดบนเครื่องนี้  : http://localhost:' + PORT);
  console.log('ให้มือถือสแกนผ่าน : http://' + getLocalIP() + ':' + PORT + '/qr');
});
