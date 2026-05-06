/**
 * gasms.cn API Server
 * 燃气监管工具平台后端
 * 
 * 功能：用户注册/登录、许可证管理、云数据同步
 * 支付：LemonSqueezy Webhook 回调（也可手动发Key）
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// ===== DB 初始化 =====
const db = new Database(join(__dirname, 'gasms.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    company TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan TEXT NOT NULL CHECK(plan IN ('pro', 'enterprise')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'cancelled')),
    device_limit INTEGER NOT NULL DEFAULT 3,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS license_devices (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT DEFAULT '',
    last_seen TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (license_id) REFERENCES licenses(id),
    UNIQUE(license_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS payment_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    license_id TEXT,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT DEFAULT 'cny',
    method TEXT DEFAULT 'alipay',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'expired', 'refunded')),
    paid_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS cloud_data (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    app TEXT NOT NULL CHECK(app IN ('inspection', 'pipeline')),
    data_key TEXT NOT NULL,
    data_value TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, app, data_key)
  );
`);

// ===== 中间件 =====
app.use(cors({ origin: ['https://www.gasms.cn', 'https://hlbfox.github.io', 'http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'], credentials: true }));
app.use(express.json({ limit: '10mb' }));

// JWT 验证中间件
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ===== 用户 API =====

// 注册
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, name, password, company, phone } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: '邮箱、姓名、密码为必填项' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少6位' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: '该邮箱已注册，请直接登录' });
    }

    const id = randomUUID();
    const hashed = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO users (id, email, name, password, company, phone) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, email, name, hashed, company || '', phone || '');

    const token = jwt.sign({ id, email, name }, JWT_SECRET, { expiresIn: '365d' });
    res.json({ token, user: { id, email, name, company, phone } });
  } catch (e) {
    console.error('注册失败:', e);
    res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

// 登录
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '365d' });
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, company: user.company, phone: user.phone }
    });
  } catch (e) {
    console.error('登录失败:', e);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

// 获取用户信息
app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, email, name, company, phone, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ user });
});

// ===== 许可证 API =====

// 获取当前用户的许可证
app.get('/api/licenses', auth, (req, res) => {
  const licenses = db.prepare(`
    SELECT * FROM licenses WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id);

  // 获取每个许可证的设备数
  const result = licenses.map(l => {
    const deviceCount = db.prepare('SELECT COUNT(*) as count FROM license_devices WHERE license_id = ?').get(l.id).count;
    return { ...l, device_count: deviceCount, password: undefined };
  });

  res.json({ licenses: result });
});

// 验证许可证（设备端调用）
app.post('/api/licenses/verify', (req, res) => {
  const { license_key, device_id, device_name } = req.body;
  if (!license_key || !device_id) {
    return res.status(400).json({ error: '缺少许可证Key或设备ID' });
  }

  // 其实 license_key 就是数据库里的 license id
  const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(license_key);
  if (!license) {
    return res.status(404).json({ error: '许可证不存在' });
  }
  if (license.status === 'expired') {
    return res.status(403).json({ error: '许可证已过期' });
  }
  if (license.status === 'cancelled') {
    return res.status(403).json({ error: '许可证已取消' });
  }

  // 检查到期
  const now = new Date();
  const expires = new Date(license.expires_at);
  if (now > expires) {
    db.prepare('UPDATE licenses SET status = ? WHERE id = ?').run('expired', license.id);
    return res.status(403).json({ error: '许可证已过期' });
  }

  // 检查设备数
  const deviceCount = db.prepare('SELECT COUNT(*) as count FROM license_devices WHERE license_id = ?').get(license.id).count;
  if (deviceCount >= license.device_limit) {
    // 检查这个设备是否已注册
    const existing = db.prepare('SELECT id FROM license_devices WHERE license_id = ? AND device_id = ?').get(license.id, device_id);
    if (!existing) {
      return res.status(403).json({ error: `设备数已达上限(${license.device_limit}台)，请先解绑其他设备` });
    }
  }

  // 注册或更新设备
  db.prepare(`
    INSERT INTO license_devices (id, license_id, device_id, device_name) VALUES (?, ?, ?, ?)
    ON CONFLICT(license_id, device_id) DO UPDATE SET last_seen = datetime('now'), device_name = ?
  `).run(randomUUID(), license.id, device_id, device_name || '', device_name || '');

  // 获取用户信息用于自定义品牌
  const user = db.prepare('SELECT name, company FROM users WHERE id = ?').get(license.user_id);

  res.json({
    valid: true,
    plan: license.plan,
    expires_at: license.expires_at,
    user: { name: user.name, company: user.company }
  });
});

// 创建设备解绑码
app.post('/api/licenses/unbind', auth, (req, res) => {
  const { license_id, device_id } = req.body;
  const license = db.prepare('SELECT * FROM licenses WHERE id = ? AND user_id = ?').get(license_id, req.user.id);
  if (!license) return res.status(404).json({ error: '许可证不存在' });

  db.prepare('DELETE FROM license_devices WHERE license_id = ? AND device_id = ?').run(license_id, device_id);
  res.json({ ok: true });
});

// ===== 支付订单 API =====

// 创建支付订单（生成付款二维码）
app.post('/api/orders/create', auth, (req, res) => {
  const { plan, method } = req.body;
  if (!['pro', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: '无效的套餐类型' });
  }

  const prices = { pro: 9900, enterprise: 49900 }; // 单位：分
  const id = randomUUID();
  const orderId = 'ORD' + Date.now().toString(36).toUpperCase();

  db.prepare('INSERT INTO payment_orders (id, user_id, plan, amount, method) VALUES (?, ?, ?, ?, ?)')
    .run(orderId, req.user.id, plan, prices[plan], method || 'alipay');

  // 返回支付信息（实际场景集成 LemonSqueezy / Stripe 的支付链接）
  const payInfo = {
    order_id: orderId,
    plan,
    amount: prices[plan],
    amount_yuan: (prices[plan] / 100).toFixed(2),
    method: method || 'alipay',
    // 支付二维码图片（需要实际发布时替换为真实支付链接）
    qr_pay_url: `https://api.gasms.cn/api/orders/qrcode/${orderId}`,
    // 直接支付链接（跳转 LemonSqueezy 结账页）
    checkout_url: `https://api.gasms.cn/api/orders/checkout/${orderId}`
  };

  res.json(payInfo);
});

// 查询订单状态
app.get('/api/orders/:orderId', auth, (req, res) => {
  const order = db.prepare('SELECT * FROM payment_orders WHERE id = ? AND user_id = ?')
    .get(req.params.orderId, req.user.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  res.json({ order });
});

// 管理员：手动确认付款（开发阶段使用）
app.post('/api/admin/confirm-payment', auth, (req, res) => {
  // 简单管理员验证
  if (req.user.email !== process.env.ADMIN_EMAIL) {
    return res.status(403).json({ error: '无权限' });
  }
  const { order_id } = req.body;
  const order = db.prepare('SELECT * FROM payment_orders WHERE id = ?').get(order_id);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  // 生成本次订阅周期的 license
  const licenseId = randomUUID();
  const duration = order.plan === 'enterprise' ? 365 : 365; // 都是按年
  const deviceLimit = order.plan === 'enterprise' ? 50 : 3;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + duration);

  db.transaction(() => {
    db.prepare('UPDATE payment_orders SET status = ?, paid_at = datetime("now"), license_id = ? WHERE id = ?')
      .run('paid', licenseId, order_id);
    db.prepare('INSERT INTO licenses (id, user_id, plan, device_limit, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(licenseId, order.user_id, order.plan, deviceLimit, expiresAt.toISOString());
  })();

  res.json({
    ok: true,
    license_key: licenseId,
    plan: order.plan,
    expires_at: expiresAt.toISOString()
  });
});

// ===== 云同步 API =====

// 保存云数据
app.post('/api/sync/save', auth, (req, res) => {
  const { app, data_key, data_value } = req.body;
  if (!app || !data_key) return res.status(400).json({ error: '缺少参数' });

  // 检查许可证
  const license = db.prepare('SELECT * FROM licenses WHERE user_id = ? AND status = ? ORDER BY expires_at DESC LIMIT 1')
    .get(req.user.id, 'active');
  if (!license) return res.status(403).json({ error: '请先订阅专业版以使用云同步功能' });
  if (new Date() > new Date(license.expires_at)) return res.status(403).json({ error: '许可证已过期' });

  db.prepare(`
    INSERT INTO cloud_data (id, user_id, app, data_key, data_value, version)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(user_id, app, data_key) DO UPDATE SET
      data_value = ?, version = version + 1, updated_at = datetime('now')
  `).run(randomUUID(), req.user.id, app, data_key, data_value, data_value);

  res.json({ ok: true, saved_at: new Date().toISOString() });
});

// 获取云数据
app.get('/api/sync/:app/:key', auth, (req, res) => {
  const data = db.prepare('SELECT data_value, version, updated_at FROM cloud_data WHERE user_id = ? AND app = ? AND data_key = ?')
    .get(req.user.id, req.params.app, req.params.key);
  if (!data) return res.json({ data: null });
  res.json({ data: data.data_value, version: data.version, updated_at: data.updated_at });
});

// 获取用户所有云数据（恢复用）
app.get('/api/sync/:app', auth, (req, res) => {
  const rows = db.prepare('SELECT data_key, data_value, version, updated_at FROM cloud_data WHERE user_id = ? AND app = ?')
    .all(req.user.id, req.params.app);
  res.json({ records: rows });
});

// ===== 支付回调（LemonSqueezy Webhook） =====
app.post('/api/webhook/lemon-squeezy', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());
    console.log('LemonSqueezy webhook:', event.meta.event_name);

    // 处理付款成功事件
    if (event.meta.event_name === 'order_created') {
      const orderData = event.data.attributes;
      const variantId = orderData.first_order_item.variant_id;
      const customerEmail = orderData.user_email;
      const customerName = orderData.user_name;

      // 映射套餐
      const planMap = {
        'pro_variant_id': 'pro',
        'enterprise_variant_id': 'enterprise'
      };
      const plan = planMap[variantId] || 'pro';

      // 查找或创建用户
      let user = db.prepare('SELECT id FROM users WHERE email = ?').get(customerEmail);
      if (!user) {
        const uid = randomUUID();
        db.prepare('INSERT INTO users (id, email, name, password) VALUES (?, ?, ?, ?)')
          .run(uid, customerEmail, customerName || '用户', '');
        user = { id: uid };
      }

      // 创建许可证
      const licenseId = randomUUID();
      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      db.prepare('INSERT INTO licenses (id, user_id, plan, device_limit, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(licenseId, user.id, plan, plan === 'enterprise' ? 50 : 3, expiresAt.toISOString());

      // 记录订单
      db.prepare('INSERT INTO payment_orders (id, user_id, license_id, plan, amount, method, status, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime("now"))')
        .run(randomUUID(), user.id, licenseId, plan, orderData.total, 'lemon-squeezy', 'paid');

      console.log(`✅ License created for ${customerEmail}: ${licenseId}`);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(400).json({ error: 'invalid payload' });
  }
});

// ===== 管理端：查看订单列表 & 手动发Key =====
app.get('/api/admin/orders', auth, (req, res) => {
  if (req.user.email !== process.env.ADMIN_EMAIL) return res.status(403).json({ error: '无权限' });
  const orders = db.prepare(`
    SELECT o.*, u.email as user_email, u.name as user_name
    FROM payment_orders o LEFT JOIN users u ON o.user_id = u.id
    ORDER BY o.created_at DESC LIMIT 100
  `).all();
  res.json({ orders });
});

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ===== 静态文件服务（用于生成简单的支付页面） =====
app.use('/pricing', express.static(join(__dirname, '../pricing')));

// ===== 启动 =====
app.listen(PORT, () => {
  console.log(`🚀 gasms.cn API 服务运行中: http://localhost:${PORT}`);
  console.log(`📋 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`💡 部署前请修改 JWT_SECRET 和环境变量`);
});
