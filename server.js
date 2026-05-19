const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 中间件 ====================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
  secret: 'jiaoan-system-secret-key-' + Date.now(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax'
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ==================== 日期格式化工具 ====================
app.locals.formatDate = function (dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
};

app.locals.formatFileSize = function (bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
};

// ==================== 腾讯云 COS ====================
const COS = require('cos-nodejs-sdk-v5');
const cosSecretId = process.env.COS_SECRET_ID;
const cosSecretKey = process.env.COS_SECRET_KEY;
const cosBucket = process.env.COS_BUCKET;
const cosRegion = process.env.COS_REGION;
const useCOS = !!(cosSecretId && cosSecretKey && cosBucket && cosRegion);
let cosClient;
if (useCOS) {
  cosClient = new COS({ SecretId: cosSecretId, SecretKey: cosSecretKey });
  console.log('[COS] 已启用腾讯云对象存储');
}

function getCOSKey(file) {
  return (file.type === 'video' ? 'videos' : file.type === 'image' ? 'images' : 'docs') + '/' + file.filename;
}

function uploadToCOS(localPath, cosKey) {
  return new Promise((resolve, reject) => {
    cosClient.putObject({
      Bucket: cosBucket, Region: cosRegion, Key: cosKey,
      Body: fs.createReadStream(localPath),
      ContentLength: fs.statSync(localPath).size
    }, (err) => err ? reject(err) : resolve());
  });
}

function deleteFromCOS(cosKey) {
  return new Promise((resolve, reject) => {
    cosClient.deleteObject({
      Bucket: cosBucket, Region: cosRegion, Key: cosKey
    }, (err) => err ? reject(err) : resolve());
  });
}

function getPresignedUrl(cosKey) {
  return new Promise((resolve, reject) => {
    cosClient.getObjectUrl({
      Bucket: cosBucket, Region: cosRegion, Key: cosKey,
      Sign: true, Expires: 4 * 3600
    }, (err, data) => err ? reject(err) : resolve(data.Url));
  });
}

async function enrichPlanFiles(plan) {
  if (!plan || !plan.files) return;
  for (const file of plan.files) {
    const cosKey = getCOSKey(file);
    file.url = useCOS ? await getPresignedUrl(cosKey) : '/uploads/' + cosKey;
  }
}

// ==================== 文件上传配置 ====================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const mime = file.mimetype;
    let subfolder = 'images';
    if (mime.startsWith('video/')) subfolder = 'videos';
    else if (!mime.startsWith('image/')) subfolder = 'docs';
    const dir = path.join(__dirname, 'uploads', subfolder);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const safeName = Date.now() + '-' + Math.random().toString(36).substring(2, 10) + ext;
    cb(null, safeName);
  }
});

const ALLOWED_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|svg|mp4|webm|avi|mov|wmv|flv|mkv|pdf|ppt|pptx|doc|docx|xls|xlsx|txt|zip|rar)$/i;
const fileFilter = (req, file, cb) => {
  if (ALLOWED_EXTS.test(path.extname(file.originalname))) {
    cb(null, true);
  } else {
    cb(new Error('不支持的文件格式'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 * 1024 }
});

// ==================== 数据库 ====================
const Database = require('better-sqlite3');
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const db = new Database(path.join(DATA_DIR, 'database.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 创建表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    displayName TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    author TEXT NOT NULL,
    authorId TEXT NOT NULL,
    files TEXT DEFAULT '[]',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`);

// 从 JSON 迁移数据（如果 JSON 文件存在且数据库为空）
function migrateFromJson() {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount > 0) return; // 已有数据，跳过迁移

  // 迁移用户
  const USERS_FILE = path.join(DATA_DIR, 'users.json');
  if (fs.existsSync(USERS_FILE)) {
    try {
      const jsonUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
      if (jsonUsers.users && jsonUsers.users.length > 0) {
        const insert = db.prepare('INSERT OR IGNORE INTO users (id, username, password, displayName, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
        for (const u of jsonUsers.users) {
          insert.run(u.id, u.username, u.password, u.displayName || u.username, u.role || 'user', u.createdAt);
        }
        console.log('[迁移] 已从 users.json 导入 ' + jsonUsers.users.length + ' 个用户');
      }
    } catch (e) {
      console.error('[迁移] users.json 读取失败:', e.message);
    }
  }

  // 迁移教案
  const PLANS_FILE = path.join(DATA_DIR, 'plans.json');
  if (fs.existsSync(PLANS_FILE)) {
    try {
      const jsonPlans = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf-8'));
      if (jsonPlans.plans && jsonPlans.plans.length > 0) {
        const insert = db.prepare('INSERT OR IGNORE INTO plans (id, title, content, author, authorId, files, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const p of jsonPlans.plans) {
          insert.run(p.id, p.title, p.content || '', p.author, p.authorId || '', JSON.stringify(p.files || []), p.createdAt, p.updatedAt);
        }
        console.log('[迁移] 已从 plans.json 导入 ' + jsonPlans.plans.length + ' 个教案');
      }
    } catch (e) {
      console.error('[迁移] plans.json 读取失败:', e.message);
    }
  }

  // 添加默认管理员（如果没有任何用户）
  const count = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO users (id, username, password, displayName, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('user_admin', 'admin', bcrypt.hashSync('admin123', 10), '管理员', 'admin', new Date().toISOString());
    console.log('[初始化] 已创建默认管理员账号: admin / admin123');
  }
}

migrateFromJson();

// ==================== 查询辅助函数 ====================
function getAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY createdAt ASC').all();
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function createUser(username, password, displayName) {
  const id = 'user_' + uuidv4().slice(0, 8);
  const hashed = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, password, displayName, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, username, hashed, displayName || username, 'user', new Date().toISOString());
  return id;
}

function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function updateUserPassword(id, newPassword) {
  const hashed = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, id);
}

function getAllPlans() {
  return db.prepare('SELECT * FROM plans ORDER BY updatedAt DESC').all();
}

function getPlanById(id) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
}

function createPlan(title, content, author, authorId, files) {
  const id = 'plan_' + uuidv4().slice(0, 8);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO plans (id, title, content, author, authorId, files, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, title, content || '', author, authorId, JSON.stringify(files || []), now, now);
  return id;
}

function updatePlan(id, title, content, files) {
  db.prepare('UPDATE plans SET title = ?, content = ?, files = ?, updatedAt = ? WHERE id = ?')
    .run(title, content || '', JSON.stringify(files || []), new Date().toISOString(), id);
}

function deletePlan(id) {
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
}

// 解析计划中的文件字段（从 JSON 字符串转为对象）
function parsePlanFiles(plan) {
  if (!plan) return null;
  if (typeof plan.files === 'string') {
    try { plan.files = JSON.parse(plan.files); } catch (e) { plan.files = []; }
  }
  return plan;
}

// ==================== 认证中间件 ====================
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    const currentUser = getUserById(req.session.user.id);
    if (!currentUser) {
      req.session.destroy();
      return res.redirect('/login');
    }
    req.session.user = {
      id: currentUser.id,
      username: currentUser.username,
      displayName: currentUser.displayName,
      role: currentUser.role
    };
    res.locals.user = req.session.user;
    return next();
  }
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).send('无权访问');
}

// ==================== 路由: 登录/登出 ====================
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: '请输入用户名和密码' });
  }

  const user = getUserByUsername(username);
  if (!user) {
    return res.render('login', { error: '用户名或密码错误' });
  }

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) {
    return res.render('login', { error: '用户名或密码错误' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role
  };

  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ==================== 路由: 用户管理(管理员) ====================
app.get('/users', isAuthenticated, isAdmin, (req, res) => {
  const users = getAllUsers();
  res.render('users', {
    users: users,
    error: null,
    success: null
  });
});

app.post('/users/add', isAuthenticated, isAdmin, (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) {
    const users = getAllUsers();
    return res.render('users', { users, error: '用户名和密码不能为空', success: null });
  }

  if (getUserByUsername(username)) {
    const users = getAllUsers();
    return res.render('users', { users, error: '用户名已存在', success: null });
  }

  createUser(username, password, displayName);

  const users = getAllUsers();
  res.render('users', {
    users,
    error: null,
    success: '用户 ' + (displayName || username) + ' 添加成功'
  });
});

app.post('/users/delete/:id', isAuthenticated, isAdmin, (req, res) => {
  const targetUser = getUserById(req.params.id);
  if (!targetUser) {
    const users = getAllUsers();
    return res.render('users', { users, error: '用户不存在', success: null });
  }

  if (targetUser.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
    if (adminCount <= 1) {
      const users = getAllUsers();
      return res.render('users', { users, error: '至少保留一个管理员账户', success: null });
    }
  }

  if (targetUser.id === req.session.user.id) {
    const users = getAllUsers();
    return res.render('users', { users, error: '不能删除自己', success: null });
  }

  deleteUser(req.params.id);

  const users = getAllUsers();
  res.render('users', { users, error: null, success: '用户 ' + targetUser.displayName + ' 已删除' });
});

app.post('/users/password/:id', isAuthenticated, isAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    const users = getAllUsers();
    return res.render('users', { users, error: '密码至少4位', success: null });
  }

  const user = getUserById(req.params.id);
  if (!user) {
    const users = getAllUsers();
    return res.render('users', { users, error: '用户不存在', success: null });
  }

  updateUserPassword(req.params.id, newPassword);

  const users = getAllUsers();
  res.render('users', { users, error: null, success: '用户 ' + user.displayName + ' 密码已更新' });
});

// ==================== 路由: 教案管理 ====================
app.get('/dashboard', isAuthenticated, async (req, res, next) => {
  try {
    const plans = getAllPlans().map(parsePlanFiles);
    for (const plan of plans) await enrichPlanFiles(plan);
    res.render('dashboard', { plans });
  } catch (e) { next(e); }
});

app.get('/plan/new', isAuthenticated, (req, res) => {
  res.render('plan-edit', { plan: null, error: null });
});

app.post('/plan', isAuthenticated, (req, res) => {
  const { title, content, fileList } = req.body;
  if (!title || !title.trim()) {
    return res.render('plan-edit', { plan: null, error: '请输入教案标题' });
  }

  let parsedFiles = [];
  if (fileList) {
    try { parsedFiles = JSON.parse(fileList); } catch (e) { /* keep empty */ }
  }

  createPlan(title.trim(), content || '', req.session.user.displayName, req.session.user.id, parsedFiles);
  res.redirect('/dashboard');
});

app.get('/plan/:id', isAuthenticated, async (req, res, next) => {
  try {
    const plan = parsePlanFiles(getPlanById(req.params.id));
    if (!plan) {
      return res.status(404).send('教案不存在');
    }
    await enrichPlanFiles(plan);
    res.render('plan-view', { plan });
  } catch (e) { next(e); }
});

app.get('/plan/:id/edit', isAuthenticated, (req, res) => {
  const plan = parsePlanFiles(getPlanById(req.params.id));
  if (!plan) {
    return res.status(404).send('教案不存在');
  }
  res.render('plan-edit', { plan, error: null });
});

app.post('/plan/:id', isAuthenticated, (req, res) => {
  const { title, content, fileList } = req.body;
  if (!title || !title.trim()) {
    const plan = parsePlanFiles(getPlanById(req.params.id));
    return res.render('plan-edit', { plan, error: '请输入教案标题' });
  }

  const existing = getPlanById(req.params.id);
  if (!existing) {
    return res.status(404).send('教案不存在');
  }

  let parsedFiles = [];
  if (fileList) {
    try { parsedFiles = JSON.parse(fileList); } catch (e) { /* keep empty */ }
  }

  updatePlan(req.params.id, title.trim(), content || '', parsedFiles);
  res.redirect('/dashboard');
});

app.post('/plan/:id/delete', isAuthenticated, (req, res) => {
  const plan = getPlanById(req.params.id);
  if (!plan) {
    return res.status(404).send('教案不存在');
  }

  // 删除关联文件
  const files = JSON.parse(plan.files || '[]');
  if (files.length > 0) {
    files.forEach(f => {
      const subfolder = f.type === 'video' ? 'videos' : f.type === 'image' ? 'images' : 'docs';
      const filePath = path.join(__dirname, 'uploads', subfolder, f.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      if (useCOS) {
        deleteFromCOS(subfolder + '/' + f.filename).catch(() => {});
      }
    });
  }

  deletePlan(req.params.id);
  res.redirect('/dashboard');
});

// ==================== 路由: 文件上传 ====================
app.post('/upload', isAuthenticated, (req, res) => {
  upload.single('file')(req, res, async function (err) {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: '文件大小超过限制(最大3GB)' });
        }
        return res.status(400).json({ error: '上传错误: ' + err.message });
      }
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }

    const mime = req.file.mimetype;
    let fileType;
    if (mime.startsWith('image/')) fileType = 'image';
    else if (mime.startsWith('video/')) fileType = 'video';
    else fileType = 'document';

    const fileInfo = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      type: fileType,
      mimeType: mime,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    // 如果启用了 COS，上传到 COS 并删除本地文件
    if (useCOS) {
      try {
        const cosKey = getCOSKey(fileInfo);
        await uploadToCOS(req.file.path, cosKey);
        fs.unlinkSync(req.file.path);
      } catch (e) {
        return res.status(500).json({ error: '上传到云存储失败: ' + e.message });
      }
    }

    res.json({ success: true, file: fileInfo });
  });
});

app.post('/upload/delete', isAuthenticated, (req, res) => {
  const { filename, type } = req.body;
  if (!filename) {
    return res.status(400).json({ error: '参数错误' });
  }

  // 删除本地文件
  const subfolder = type === 'video' ? 'videos' : type === 'image' ? 'images' : 'docs';
  const filePath = path.join(__dirname, 'uploads', subfolder, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  // 如果启用 COS，同时删除 COS 上的文件
  if (useCOS) {
    const cosKey = subfolder + '/' + filename;
    deleteFromCOS(cosKey).catch(() => {});
  }

  res.json({ success: true });
});

// ==================== 静态页面 fallback ====================
app.use((req, res) => {
  res.status(404).render('login', { error: '页面不存在，请重新登录' });
});

// ==================== 启动服务器 ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  教案管理系统已启动');
  console.log('  地址: http://localhost:' + PORT);
  console.log('  默认账号: admin / admin123');
  console.log('  (局域网访问: http://' + getLocalIP() + ':' + PORT + ')');
  console.log('============================================');
  console.log('  提示: 请及时修改默认密码！');
  console.log('============================================');
});

function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}
