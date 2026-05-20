require('dotenv').config();
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

// 移除预签名函数，改由前端 JS SDK 直传

async function enrichPlanFiles(plan) {
  if (!plan || !plan.files) return;
  for (const file of plan.files) {
    const cosKey = getCOSKey(file);
    file.url = useCOS ? await getPresignedUrl(cosKey) : '/uploads/' + cosKey;
  }
}

// ==================== COS 服务端中转上传 ====================
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 * 1024 } });

app.post('/cos/upload', isAuthenticated, mediaUpload.single('file'), async (req, res) => {
  if (!useCOS) return res.status(400).json({ error: '未配置 COS' });
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  const file = req.file;
  const ext = file.originalname.lastIndexOf('.') > -1 ? file.originalname.substring(file.originalname.lastIndexOf('.')) : '';
  const base = file.originalname.substring(0, file.originalname.lastIndexOf('.')).replace(/[\\/:*?"<>|]/g, '_').substring(0, 60);
  const filename = Date.now() + '_' + base + ext;
  const fileType = file.mimetype.startsWith('image/') ? 'image' : file.mimetype.startsWith('video/') ? 'video' : 'document';
  const cosKey = (fileType === 'video' ? 'videos' : fileType === 'image' ? 'images' : 'docs') + '/' + filename;
  try {
    await new Promise((resolve, reject) => {
      cosClient.putObject({
        Bucket: cosBucket, Region: cosRegion, Key: cosKey,
        Body: file.buffer,
        ContentLength: file.size,
        ContentType: file.mimetype
      }, (err, data) => {
        if (err) reject(err); else resolve(data);
      });
    });
    res.json({
      success: true,
      file: { filename, originalName: file.originalname, type: fileType, mimeType: file.mimetype, size: file.size, uploadedAt: new Date().toISOString() }
    });
  } catch (e) {
    res.status(500).json({ error: '上传失败: ' + (e.message || e) });
  }
});

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
    const base = path.basename(file.originalname, ext).replace(/[\\/:*?"<>|]/g, '_').substring(0, 60);
    const safeName = Date.now() + '_' + base + ext;
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
    courseId TEXT DEFAULT '',
    sessionName TEXT DEFAULT '',
    coverUrl TEXT DEFAULT '',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    color TEXT DEFAULT '#3498db',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plan_tags (
    planId TEXT NOT NULL,
    tagId TEXT NOT NULL,
    PRIMARY KEY (planId, tagId)
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    planId TEXT NOT NULL,
    folderId TEXT DEFAULT '',
    createdAt TEXT NOT NULL,
    UNIQUE(userId, planId)
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    planId TEXT NOT NULL,
    userId TEXT NOT NULL,
    content TEXT NOT NULL,
    rating INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    planId TEXT NOT NULL,
    content TEXT DEFAULT '',
    files TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
`);

// 数据库迁移：添加新字段（如果不存在）
function migrateSchema() {
  const cols = db.prepare("PRAGMA table_info(plans)").all().map(c => c.name);
  if (!cols.includes('courseId')) {
    db.exec("ALTER TABLE plans ADD COLUMN courseId TEXT DEFAULT ''");
    console.log('[迁移] plans 表增加 courseId 字段');
  }
  if (!cols.includes('sessionName')) {
    db.exec("ALTER TABLE plans ADD COLUMN sessionName TEXT DEFAULT ''");
    console.log('[迁移] plans 表增加 sessionName 字段');
  }
  if (!cols.includes('coverUrl')) {
    db.exec("ALTER TABLE plans ADD COLUMN coverUrl TEXT DEFAULT ''");
    console.log('[迁移] plans 表增加 coverUrl 字段');
  }
  if (!cols.includes('viewCount')) {
    db.exec("ALTER TABLE plans ADD COLUMN viewCount INTEGER DEFAULT 0");
    console.log('[迁移] plans 表增加 viewCount 字段');
  }
  if (!cols.includes('favCount')) {
    db.exec("ALTER TABLE plans ADD COLUMN favCount INTEGER DEFAULT 0");
    console.log('[迁移] plans 表增加 favCount 字段');
  }
  if (!cols.includes('commentCount')) {
    db.exec("ALTER TABLE plans ADD COLUMN commentCount INTEGER DEFAULT 0");
    console.log('[迁移] plans 表增加 commentCount 字段');
  }
  if (!cols.includes('isPublic')) {
    db.exec("ALTER TABLE plans ADD COLUMN isPublic INTEGER DEFAULT 0");
    console.log('[迁移] plans 表增加 isPublic 字段');
  }
}

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
migrateSchema();

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

function createPlan(title, content, author, authorId, files, courseId, sessionName, coverUrl, isPublic) {
  const id = 'plan_' + uuidv4().slice(0, 8);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO plans (id, title, content, author, authorId, files, courseId, sessionName, coverUrl, isPublic, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, title, content || '', author, authorId, JSON.stringify(files || []), courseId || '', sessionName || '', coverUrl || '', isPublic ? 1 : 0, now, now);
  return id;
}

function updatePlan(id, title, content, files, courseId, sessionName, coverUrl, isPublic) {
  db.prepare('UPDATE plans SET title = ?, content = ?, files = ?, courseId = ?, sessionName = ?, coverUrl = ?, isPublic = ?, updatedAt = ? WHERE id = ?')
    .run(title, content || '', JSON.stringify(files || []), courseId || '', sessionName || '', coverUrl || '', isPublic ? 1 : 0, new Date().toISOString(), id);
}

function deletePlan(id) {
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
}

// ==================== 课程查询 ====================
function getAllCourses() {
  return db.prepare('SELECT * FROM courses ORDER BY createdAt DESC').all();
}
function getCourseById(id) {
  return db.prepare('SELECT * FROM courses WHERE id = ?').get(id);
}
function createCourse(name, description) {
  const id = 'course_' + uuidv4().slice(0, 8);
  db.prepare('INSERT INTO courses (id, name, description, createdAt) VALUES (?, ?, ?, ?)')
    .run(id, name, description || '', new Date().toISOString());
  return id;
}
function updateCourse(id, name, description) {
  db.prepare('UPDATE courses SET name = ?, description = ? WHERE id = ?').run(name, description || '', id);
}
function deleteCourse(id) {
  db.prepare('DELETE FROM courses WHERE id = ?').run(id);
  db.prepare("UPDATE plans SET courseId = '' WHERE courseId = ?").run(id);
}

// ==================== 标签 ====================
function getAllTags() {
  return db.prepare('SELECT * FROM tags ORDER BY name ASC').all();
}
function createTag(name, color) {
  const id = 'tag_' + uuidv4().slice(0, 8);
  db.prepare('INSERT OR IGNORE INTO tags (id, name, color, createdAt) VALUES (?, ?, ?, ?)').run(id, name, color || '#3498db', new Date().toISOString());
  return db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
}
function getPlanTags(planId) {
  return db.prepare('SELECT t.* FROM tags t JOIN plan_tags pt ON t.id = pt.tagId WHERE pt.planId = ?').all(planId);
}
function setPlanTags(planId, tagIds) {
  db.prepare('DELETE FROM plan_tags WHERE planId = ?').run(planId);
  const ins = db.prepare('INSERT OR IGNORE INTO plan_tags (planId, tagId) VALUES (?, ?)');
  for (const tid of tagIds) ins.run(planId, tid);
}
function deleteTag(id) {
  db.prepare('DELETE FROM plan_tags WHERE tagId = ?').run(id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
}

// ==================== 收藏 ====================
function toggleFavorite(userId, planId) {
  const existing = db.prepare('SELECT * FROM favorites WHERE userId = ? AND planId = ?').get(userId, planId);
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE id = ?').run(existing.id);
    db.prepare('UPDATE plans SET favCount = MAX(0, favCount - 1) WHERE id = ?').run(planId);
    return { favorited: false };
  }
  const id = 'fav_' + uuidv4().slice(0, 8);
  db.prepare('INSERT INTO favorites (id, userId, planId, folderId, createdAt) VALUES (?, ?, ?, ?, ?)').run(id, userId, planId, '', new Date().toISOString());
  db.prepare('UPDATE plans SET favCount = favCount + 1 WHERE id = ?').run(planId);
  return { favorited: true };
}
function getUserFavorites(userId) {
  return db.prepare('SELECT p.* FROM plans p JOIN favorites f ON p.id = f.planId WHERE f.userId = ? ORDER BY f.createdAt DESC').all(userId);
}
function isFavorited(userId, planId) {
  return !!db.prepare('SELECT 1 FROM favorites WHERE userId = ? AND planId = ?').get(userId, planId);
}

// ==================== 收藏夹 ====================
function getFolders(userId) {
  return db.prepare('SELECT * FROM folders WHERE userId = ? ORDER BY createdAt ASC').all(userId);
}
function createFolder(userId, name) {
  const id = 'fld_' + uuidv4().slice(0, 8);
  db.prepare('INSERT INTO folders (id, userId, name, createdAt) VALUES (?, ?, ?, ?)').run(id, userId, name, new Date().toISOString());
  return id;
}

// ==================== 评论与评分 ====================
function getComments(planId) {
  return db.prepare('SELECT c.*, u.displayName, u.username FROM comments c JOIN users u ON c.userId = u.id WHERE c.planId = ? ORDER BY c.createdAt DESC').all(planId);
}
function addComment(planId, userId, content, rating) {
  const id = 'cmt_' + uuidv4().slice(0, 8);
  db.prepare('INSERT INTO comments (id, planId, userId, content, rating, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, planId, userId, content, rating || 0, new Date().toISOString());
  db.prepare('UPDATE plans SET commentCount = (SELECT COUNT(*) FROM comments WHERE planId = ?) WHERE id = ?').run(planId, planId);
  return id;
}
function deleteComment(id) {
  const c = db.prepare('SELECT planId FROM comments WHERE id = ?').get(id);
  if (c) {
    db.prepare('DELETE FROM comments WHERE id = ?').run(id);
    db.prepare('UPDATE plans SET commentCount = (SELECT COUNT(*) FROM comments WHERE planId = ?) WHERE id = ?').run(c.planId, c.planId);
  }
}
function getAvgRating(planId) {
  const r = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as count FROM comments WHERE planId = ? AND rating > 0').get(planId);
  return r;
}

// ==================== 版本管理 ====================
function getVersions(planId) {
  return db.prepare('SELECT v.*, u.displayName as authorName FROM versions v JOIN users u ON v.createdBy = u.id WHERE v.planId = ? ORDER BY v.createdAt DESC').all(planId);
}
function createVersion(planId, content, files, notes, userId) {
  const id = 'ver_' + uuidv4().slice(0, 8);
  db.prepare('INSERT INTO versions (id, planId, content, files, notes, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, planId, content || '', JSON.stringify(files || []), notes || '', userId, new Date().toISOString());
  return id;
}
function getVersion(id) {
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
}
function deleteOldVersions(planId, keep) {
  const versions = db.prepare('SELECT id FROM versions WHERE planId = ? ORDER BY createdAt DESC').all(planId);
  if (versions.length > keep) {
    const toDelete = versions.slice(keep);
    const del = db.prepare('DELETE FROM versions WHERE id = ?');
    for (const v of toDelete) del.run(v.id);
  }
}

// 统计
function getPlanStats(userId) {
  const total = db.prepare('SELECT COUNT(*) as c FROM plans WHERE authorId = ?').get(userId).c;
  const totalViews = db.prepare('SELECT SUM(viewCount) as c FROM plans WHERE authorId = ?').get(userId).c || 0;
  const totalFavs = db.prepare('SELECT SUM(favCount) as c FROM plans WHERE authorId = ?').get(userId).c || 0;
  const totalComments = db.prepare('SELECT COUNT(*) as c FROM comments c JOIN plans p ON c.planId = p.id WHERE p.authorId = ?').get(userId).c;
  const topPlans = db.prepare('SELECT id, title, viewCount, favCount FROM plans WHERE authorId = ? ORDER BY viewCount DESC LIMIT 5').all(userId);
  return { total, myTotal: total, totalViews, totalFavs, totalComments, topPlans };
}

function getPublicStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM plans WHERE isPublic = 1').get().c;
  const totalViews = db.prepare('SELECT SUM(viewCount) as c FROM plans WHERE isPublic = 1').get().c || 0;
  const totalFavs = db.prepare('SELECT SUM(favCount) as c FROM plans WHERE isPublic = 1').get().c || 0;
  const totalComments = db.prepare('SELECT COUNT(*) as c FROM comments c JOIN plans p ON c.planId = p.id WHERE p.isPublic = 1').get().c;
  return { total, myTotal: total, totalViews, totalFavs, totalComments };
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

// ==================== 路由: 注册 ====================
app.get('/register', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('register', { error: null });
});

app.post('/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) {
    return res.render('register', { error: '用户名和密码不能为空' });
  }
  if (username.length < 2) {
    return res.render('register', { error: '用户名至少2个字符' });
  }
  if (password.length < 4) {
    return res.render('register', { error: '密码至少4位' });
  }
  if (getUserByUsername(username)) {
    return res.render('register', { error: '用户名已存在' });
  }

  createUser(username, password, displayName || username);

  const user = getUserByUsername(username);
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

// ==================== 路由: 课程管理 ====================
app.get('/courses', isAuthenticated, isAdmin, (req, res) => {
  const courses = getAllCourses();
  res.render('courses', { courses, error: null, success: null });
});

app.post('/courses/add', isAuthenticated, isAdmin, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    const courses = getAllCourses();
    return res.render('courses', { courses, error: '请输入课程名称', success: null });
  }
  createCourse(name.trim(), description);
  const courses = getAllCourses();
  res.render('courses', { courses, error: null, success: '课程「' + name.trim() + '」已创建' });
});

app.post('/courses/edit/:id', isAuthenticated, isAdmin, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    const courses = getAllCourses();
    return res.render('courses', { courses, error: '请输入课程名称', success: null });
  }
  updateCourse(req.params.id, name.trim(), description);
  res.redirect('/courses');
});

app.post('/courses/delete/:id', isAuthenticated, isAdmin, (req, res) => {
  deleteCourse(req.params.id);
  res.redirect('/courses');
});

// ==================== 路由: 教案管理 ====================
app.get('/dashboard', isAuthenticated, async (req, res, next) => {
  try {
    const allPlans = getAllPlans().map(parsePlanFiles);
    const plans = allPlans.filter(p => p.authorId === req.session.user.id);
    const courses = getAllCourses();
    const allTags = getAllTags();
    for (const plan of plans) {
      await enrichPlanFiles(plan);
      plan.tags = getPlanTags(plan.id);
    }
    const stats = getPlanStats(req.session.user.id);
    res.render('dashboard', { plans, courses, allTags, stats, pageType: 'private' });
  } catch (e) { next(e); }
});

// ==================== 路由: 公共大厅 ====================
app.get('/hall', isAuthenticated, async (req, res, next) => {
  try {
    const allPlans = getAllPlans().map(parsePlanFiles);
    const plans = allPlans.filter(p => p.isPublic == 1);
    const courses = getAllCourses();
    const allTags = getAllTags();
    for (const plan of plans) {
      await enrichPlanFiles(plan);
      plan.tags = getPlanTags(plan.id);
    }
    const stats = getPublicStats();
    res.render('dashboard', { plans, courses, allTags, stats, pageType: 'public' });
  } catch (e) { next(e); }
});

app.get('/plan/new', isAuthenticated, (req, res) => {
  const courses = getAllCourses();
  const allTags = getAllTags();
  res.render('plan-edit', { plan: null, error: null, courses, allTags });
});

app.post('/plan', isAuthenticated, (req, res) => {
  const { title, content, fileList, courseId, sessionName, coverUrl, isPublic } = req.body;
  if (!title || !title.trim()) {
    const courses = getAllCourses();
    return res.render('plan-edit', { plan: null, error: '请输入教案标题', courses });
  }

  let parsedFiles = [];
  if (fileList) {
    try { parsedFiles = JSON.parse(fileList); } catch (e) { /* keep empty */ }
  }

  const planId = createPlan(title.trim(), content || '', req.session.user.displayName, req.session.user.id, parsedFiles, courseId, sessionName, coverUrl, isPublic === '1');
  // 保存标签
  const tagIds = req.body.tagIds || [];
  const safeTagIds = Array.isArray(tagIds) ? tagIds : [tagIds];
  if (safeTagIds.length > 0) setPlanTags(planId, safeTagIds.filter(Boolean));
  res.redirect('/dashboard');
});

app.get('/plan/:id', isAuthenticated, async (req, res, next) => {
  try {
    const plan = parsePlanFiles(getPlanById(req.params.id));
    if (!plan) {
      return res.status(404).send('教案不存在');
    }
    // 累加浏览次数
    db.prepare('UPDATE plans SET viewCount = viewCount + 1 WHERE id = ?').run(req.params.id);
    plan.viewCount = (plan.viewCount || 0) + 1;
    await enrichPlanFiles(plan);
    const course = plan.courseId ? getCourseById(plan.courseId) : null;
    const tags = getPlanTags(req.params.id);
    const comments = getComments(req.params.id);
    const avgRating = getAvgRating(req.params.id);
    const favorited = isFavorited(req.session.user.id, req.params.id);
    const versions = getVersions(req.params.id);
    res.render('plan-view', { plan, course, tags, comments, avgRating, favorited, versions });
  } catch (e) { next(e); }
});

app.get('/plan/:id/edit', isAuthenticated, (req, res) => {
  const plan = parsePlanFiles(getPlanById(req.params.id));
  if (!plan) {
    return res.status(404).send('教案不存在');
  }
  const courses = getAllCourses();
  const allTags = getAllTags();
  const planTags = getPlanTags(req.params.id);
  res.render('plan-edit', { plan, error: null, courses, allTags, planTags });
});

app.post('/plan/:id', isAuthenticated, (req, res) => {
  const { title, content, fileList, courseId, sessionName, coverUrl, isPublic } = req.body;
  if (!title || !title.trim()) {
    const plan = parsePlanFiles(getPlanById(req.params.id));
    const courses = getAllCourses();
    return res.render('plan-edit', { plan, error: '请输入教案标题', courses });
  }

  const existing = getPlanById(req.params.id);
  if (!existing) {
    return res.status(404).send('教案不存在');
  }

  let parsedFiles = [];
  if (fileList) {
    try { parsedFiles = JSON.parse(fileList); } catch (e) { /* keep empty */ }
  }

  updatePlan(req.params.id, title.trim(), content || '', parsedFiles, courseId, sessionName, coverUrl, isPublic === '1');
  // 保存标签
  const tagIds = req.body.tagIds || [];
  const safeTagIds = Array.isArray(tagIds) ? tagIds : [tagIds];
  setPlanTags(req.params.id, safeTagIds.filter(Boolean));
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

// ==================== COS 上传记录 ====================
app.post('/cos/uploaded', isAuthenticated, (req, res) => {
  if (!useCOS) return res.json({ success: true });
  // 客户端直传 COS 完成后，记录文件信息到服务器（仅记录，不存储文件）
  res.json({ success: true });
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

// ==================== API: 统计 ====================
app.get('/api/stats', isAuthenticated, (req, res) => {
  const stats = getPlanStats(req.session.user.id);
  res.json(stats);
});

// ==================== API: 标签 ====================
app.get('/api/tags', isAuthenticated, (req, res) => {
  res.json(getAllTags());
});

app.post('/api/tags', isAuthenticated, isAdmin, (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '请输入标签名称' });
  const tag = createTag(name.trim(), color);
  res.json(tag);
});

app.post('/api/plan/:id/tags', isAuthenticated, (req, res) => {
  setPlanTags(req.params.id, req.body.tagIds || []);
  res.json({ success: true });
});

app.delete('/api/tags/:id', isAuthenticated, isAdmin, (req, res) => {
  deleteTag(req.params.id);
  res.json({ success: true });
});

// ==================== API: 收藏 ====================
app.post('/api/plan/:id/favorite', isAuthenticated, (req, res) => {
  const result = toggleFavorite(req.session.user.id, req.params.id);
  res.json(result);
});

app.get('/api/favorites', isAuthenticated, (req, res) => {
  const plans = getUserFavorites(req.session.user.id).map(parsePlanFiles);
  res.json(plans);
});

// ==================== API: 评论 ====================
app.post('/api/plan/:id/comment', isAuthenticated, (req, res) => {
  const { content, rating } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '请输入评论内容' });
  addComment(req.params.id, req.session.user.id, content.trim(), parseInt(rating) || 0);
  const comments = getComments(req.params.id);
  const avgRating = getAvgRating(req.params.id);
  res.json({ success: true, comments, avgRating });
});

app.delete('/api/plan/:id/comment/:commentId', isAuthenticated, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.commentId);
  if (!c) return res.status(404).json({ error: '评论不存在' });
  if (c.userId !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '无权限' });
  }
  deleteComment(req.params.commentId);
  res.json({ success: true });
});

// ==================== API: 版本管理 ====================
app.post('/api/plan/:id/version', isAuthenticated, (req, res) => {
  const { notes } = req.body;
  const plan = getPlanById(req.params.id);
  if (!plan) return res.status(404).json({ error: '教案不存在' });
  createVersion(req.params.id, plan.content, JSON.parse(plan.files || '[]'), notes || '', req.session.user.id);
  deleteOldVersions(req.params.id, 20);
  res.json({ success: true, versions: getVersions(req.params.id) });
});

app.get('/api/plan/:id/versions', isAuthenticated, (req, res) => {
  res.json(getVersions(req.params.id));
});

app.get('/api/plan/:id/versions/:vid', isAuthenticated, (req, res) => {
  const v = getVersion(req.params.vid);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  if (v.planId !== req.params.id) return res.status(400).json({ error: '版本不匹配' });
  res.json(v);
});

app.post('/api/plan/:id/restore/:vid', isAuthenticated, (req, res) => {
  const v = getVersion(req.params.vid);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  if (v.planId !== req.params.id) return res.status(400).json({ error: '版本不匹配' });
  db.prepare('UPDATE plans SET content = ?, files = ?, updatedAt = ? WHERE id = ?')
    .run(v.content, v.files, new Date().toISOString(), req.params.id);
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
