require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
var UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');

// 迁移旧上传文件（从 /src/uploads/ 到 DATA_DIR/uploads/）
var OLD_UPLOADS = path.join(__dirname, 'uploads');
if (OLD_UPLOADS !== UPLOADS_DIR && fs.existsSync(OLD_UPLOADS)) {
  try {
    var entries = fs.readdirSync(OLD_UPLOADS);
    for (var ei = 0; ei < entries.length; ei++) {
      var sub = entries[ei];
      var srcDir = path.join(OLD_UPLOADS, sub);
      var dstDir = path.join(UPLOADS_DIR, sub);
      if (fs.statSync(srcDir).isDirectory() && !fs.existsSync(dstDir)) {
        fs.mkdirSync(dstDir, { recursive: true });
        var files = fs.readdirSync(srcDir);
        for (var fi = 0; fi < files.length; fi++) {
          var f = files[fi];
          fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
        }
      }
    }
    console.log('[迁移] 旧上传文件已复制到持久卷');
  } catch (e) { console.error('[迁移] 复制上传文件失败:', e.message); }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 安全配置 ====================
app.set('trust proxy', 1);

// ==================== 中间件 ====================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// 安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; connect-src 'self' https://*.cos.ap-guangzhou.myqcloud.com; media-src 'self' data: https:;");
  next();
});

// CSRF Origin 检查（所有 POST/DELETE 请求）
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('Origin');
    const referer = req.get('Referer');
    const allowedHosts = ['jiaoyou.preview.aliyun-zeabur.cn', 'localhost', '39.96.31.118'];
    if (origin) {
      const allowed = origin === 'null' ? false : allowedHosts.some(h => origin.includes(h));
      if (!allowed) return res.status(403).json({ error: '拒绝跨站请求' });
    } else if (referer) {
      const allowed = allowedHosts.some(h => referer.includes(h));
      if (!allowed) return res.status(403).json({ error: '拒绝跨站请求' });
    }
  }
  next();
});

// 速率限制（内存）
const rateLimitStore = {};
function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  if (!rateLimitStore[key]) rateLimitStore[key] = [];
  rateLimitStore[key] = rateLimitStore[key].filter(t => now - t < windowMs);
  if (rateLimitStore[key].length >= maxAttempts) return false;
  rateLimitStore[key].push(now);
  return true;
}
// 定时清理过期的限流记录
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(rateLimitStore)) {
    rateLimitStore[k] = rateLimitStore[k].filter(t => now - t < 3600000);
    if (rateLimitStore[k].length === 0) delete rateLimitStore[k];
  }
}, 60000);

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'strict',
    secure: 'auto'
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
  
  // 配置 CORS 允许浏览器直传
  cosClient.putBucketCors({
    Bucket: cosBucket, Region: cosRegion,
    CORSRules: [{
      AllowedOrigin: ['*'],
      AllowedMethod: ['GET', 'PUT', 'POST', 'HEAD'],
      AllowedHeader: ['*'],
      ExposeHeader: ['Content-Length', 'ETag'],
      MaxAgeSeconds: 3600
    }]
  }, (err) => { if (err) console.error('[COS CORS] 配置失败:', err.message); });
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
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

app.post('/cos/upload', isAuthenticated, mediaUpload.single('file'), async (req, res) => {
  if (!useCOS) return res.status(400).json({ error: '未配置 COS' });
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  const file = req.file;
  const ext = file.originalname.lastIndexOf('.') > -1 ? file.originalname.substring(file.originalname.lastIndexOf('.')) : '';
  const base = file.originalname.substring(0, file.originalname.lastIndexOf('.')).replace(/[\\/:*?"<>|\s]/g, '_').substring(0, 60);
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
    const fileInfo = { filename, originalName: file.originalname, type: fileType, mimeType: file.mimetype, size: file.size, uploadedAt: new Date().toISOString() };
    fileInfo.url = await getPresignedUrl(cosKey);
    res.json({ success: true, file: fileInfo });
  } catch (e) {
    console.error('[COS上传错误]', e.message);
    res.status(500).json({ error: '上传失败，请稍后重试' });
  }
});

// ==================== COS 浏览器直传 ====================
// 获取预签名 PUT URL（浏览器直传 COS，不经过服务器）
app.post('/cos/presign', isAuthenticated, (req, res) => {
  if (!useCOS) return res.status(400).json({ error: '未启用 COS' });
  const { filename, contentType } = req.body;
  if (!filename) return res.status(400).json({ error: '缺少文件名' });
  const ext = filename.lastIndexOf('.') > -1 ? filename.substring(filename.lastIndexOf('.')) : '';
  const safeName = Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
  const mimeType = contentType || 'application/octet-stream';
  let fileType = 'document';
  if (mimeType.startsWith('image/')) fileType = 'image';
  else if (mimeType.startsWith('video/')) fileType = 'video';
  const cosKey = (fileType === 'video' ? 'videos' : fileType === 'image' ? 'images' : 'docs') + '/' + safeName;
  cosClient.getObjectUrl({
    Bucket: cosBucket, Region: cosRegion, Key: cosKey,
    Method: 'PUT', Sign: true, Expires: 3600,
    Headers: { 'Content-Type': mimeType }
  }, (err, data) => {
    if (err) { console.error('[COS签名]', err.message); return res.status(500).json({ error: '签名生成失败' }); }
    res.json({ url: data.Url, cosKey, filename: safeName, originalName: filename, type: fileType, mimeType });
  });
});

// COS 直传完成确认（生成访问 URL）
app.post('/cos/done', isAuthenticated, async (req, res) => {
  if (!useCOS) return res.json({ success: true });
  const { cosKey, filename, originalName, type, mimeType, size } = req.body;
  if (!cosKey || !filename) return res.status(400).json({ error: '参数不完整' });
  const fileInfo = { filename, originalName: originalName || filename, type: type || 'document', mimeType: mimeType || 'application/octet-stream', size: parseInt(size) || 0, uploadedAt: new Date().toISOString() };
  try { fileInfo.url = await getPresignedUrl(cosKey); } catch (e) { fileInfo.url = '/uploads/' + cosKey; }
  res.json({ success: true, file: fileInfo });
});

// ==================== 文件上传配置 ====================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const mime = file.mimetype;
    let subfolder = 'images';
    if (mime.startsWith('video/')) subfolder = 'videos';
    else if (!mime.startsWith('image/')) subfolder = 'docs';
    const dir = path.join(UPLOADS_DIR, subfolder);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const safeName = Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
    cb(null, safeName);
  }
});

const ALLOWED_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|mp4|webm|avi|mov|wmv|flv|mkv|pdf|ppt|pptx|doc|docx|xls|xlsx|txt|zip|rar)$/i;
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'application/pdf', 'application/msword', 'application/vnd', 'text/', 'application/zip', 'application/x-rar', 'application/octet-stream'];
const fileFilter = (req, file, cb) => {
  const extMatch = ALLOWED_EXTS.test(path.extname(file.originalname));
  const mimeMatch = ALLOWED_MIME_PREFIXES.some(p => file.mimetype.startsWith(p));
  if (extMatch && mimeMatch) {
    cb(null, true);
  } else {
    cb(new Error('不支持的文件格式'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }
});

// ==================== 数据库 ====================
const Database = require('better-sqlite3');
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
  if (!cols.includes('sportGroup')) {
    db.exec("ALTER TABLE plans ADD COLUMN sportGroup TEXT DEFAULT ''");
    console.log('[迁移] plans 表增加 sportGroup 字段');
  }
  if (!cols.includes('sportName')) {
    db.exec("ALTER TABLE plans ADD COLUMN sportName TEXT DEFAULT ''");
    console.log('[迁移] plans 表增加 sportName 字段');
  }
  if (!cols.includes('sessionNumber')) {
    db.exec("ALTER TABLE plans ADD COLUMN sessionNumber INTEGER DEFAULT 0");
    console.log('[迁移] plans 表增加 sessionNumber 字段');
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

// ---------- 运动项目配置表 ----------
db.exec(`CREATE TABLE IF NOT EXISTS sport_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sportGroup TEXT NOT NULL,
  sportName TEXT NOT NULL,
  sortOrder INTEGER DEFAULT 0,
  createdAt TEXT DEFAULT (datetime('now'))
)`);
var configCount = db.prepare('SELECT COUNT(*) as c FROM sport_config').get().c;
if (configCount === 0) {
  var defaultGroups = {
    '体育1': ['足球', '篮球', '排球', '羽毛球', '网球'],
    '体育2': ['游泳', '田径', '体操', '举重', '柔道'],
    '体育3': ['乒乓球', '跆拳道', '武术', '击剑', '射箭'],
    '体育4': ['自行车', '滑雪', '滑冰', '跳水', '蹦床']
  };
  var insertConfig = db.prepare('INSERT INTO sport_config (sportGroup, sportName, sortOrder) VALUES (?, ?, ?)');
  var order = 0;
  var groups = Object.keys(defaultGroups);
  for (var gi = 0; gi < groups.length; gi++) {
    var sports = defaultGroups[groups[gi]];
    for (var si = 0; si < sports.length; si++) {
      insertConfig.run(groups[gi], sports[si], order++);
    }
  }
  console.log('[初始化] 运动项目配置写入 ' + order + ' 项');
}

function seedSportLessons() {
  const count = db.prepare("SELECT COUNT(*) as count FROM plans WHERE sportGroup != ''").get().count;
  if (count > 0) return;

  var sportsData = {
    '体育1': ['足球', '篮球', '排球', '羽毛球', '网球'],
    '体育2': ['游泳', '田径', '体操', '举重', '柔道'],
    '体育3': ['乒乓球', '跆拳道', '武术', '击剑', '射箭'],
    '体育4': ['自行车', '滑雪', '滑冰', '跳水', '蹦床']
  };

  var sessionTitles = [
    '第一期 基础知识'
  ];

  var now = new Date().toISOString();
  var items = [];
  var groups = Object.keys(sportsData);

  for (var gi = 0; gi < groups.length; gi++) {
    var group = groups[gi];
    var sports = sportsData[group];
    for (var si = 0; si < sports.length; si++) {
      var sport = sports[si];
      for (var ti = 0; ti < sessionTitles.length; ti++) {
        items.push({
          title: sessionTitles[ti],
          group: group,
          sport: sport,
          session: ti + 1
        });
      }
    }
  }

  var insertStmt = db.prepare('INSERT OR IGNORE INTO plans (id, title, content, author, authorId, files, courseId, sessionName, sportGroup, sportName, sessionNumber, coverUrl, isPublic, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

  var insertAll = db.transaction(function(list) {
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var id = 'plan_' + crypto.randomBytes(4).toString('hex');
      insertStmt.run(
        id, p.title,
        '<p>《' + p.sport + '》' + p.title + '教案内容。</p><p>请编辑具体教学内容。</p>',
        '管理员', 'user_admin', '[]', '', '',
        p.group, p.sport, p.session,
        '', 1, now, now
      );
    }
  });

  insertAll(items);
  console.log('[种子数据] 已创建 ' + items.length + ' 节课');
}

seedSportLessons();

// 迁移中文文件名→十六进制（Express static 不支持中文）
var migrateFiles = db.prepare("SELECT id,files FROM plans WHERE files IS NOT NULL AND files != '[]'").all();
for (var mi = 0; mi < migrateFiles.length; mi++) {
  var row = migrateFiles[mi];
  var fileList;
  try { fileList = JSON.parse(row.files); } catch (e) { continue; }
  var changed = false;
  for (var fi = 0; fi < fileList.length; fi++) {
    var f = fileList[fi];
    if (!f.filename || /^[\x00-\x7F]+$/.test(f.filename)) continue;
    var ext = f.filename.lastIndexOf('.') > -1 ? f.filename.substring(f.filename.lastIndexOf('.')) : '';
    var newName = Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
    var subfolder = f.type === 'video' ? 'videos' : f.type === 'image' ? 'images' : 'docs';
    var oldPath = path.join(UPLOADS_DIR, subfolder, f.filename);
    var newPath = path.join(UPLOADS_DIR, subfolder, newName);
  try {
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, newPath);
      console.log('[迁移] 重命名: ' + f.filename + ' → ' + newName);
      f.filename = newName;
      f.url = '/uploads/' + subfolder + '/' + newName;
      changed = true;
    }
  } catch (e) { console.error('[迁移] 重命名失败:', f.filename, e.message); }
  }
  if (changed) {
    db.prepare("UPDATE plans SET files = ? WHERE id = ?").run(JSON.stringify(fileList), row.id);
  }
}

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
  return db.prepare('SELECT * FROM plans ORDER BY createdAt ASC').all();
}

function getPlanById(id) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
}

function createPlan(title, content, author, authorId, files, courseId, sessionName, coverUrl, isPublic, sportGroup, sportName, sessionNumber) {
  const id = 'plan_' + uuidv4().slice(0, 8);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO plans (id, title, content, author, authorId, files, courseId, sessionName, coverUrl, isPublic, sportGroup, sportName, sessionNumber, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, title, content || '', author, authorId, JSON.stringify(files || []), courseId || '', sessionName || '', coverUrl || '', isPublic ? 1 : 0, sportGroup || '', sportName || '', sessionNumber || 0, now, now);
  return id;
}

function updatePlan(id, title, content, files, courseId, sessionName, coverUrl, isPublic, sportGroup, sportName, sessionNumber) {
  db.prepare('UPDATE plans SET title = ?, content = ?, files = ?, courseId = ?, sessionName = ?, coverUrl = ?, isPublic = ?, sportGroup = ?, sportName = ?, sessionNumber = ?, updatedAt = ? WHERE id = ?')
    .run(title, content || '', JSON.stringify(files || []), courseId || '', sessionName || '', coverUrl || '', isPublic ? 1 : 0, sportGroup || '', sportName || '', sessionNumber || 0, new Date().toISOString(), id);
}

function deletePlan(id) {
  db.prepare('DELETE FROM plan_tags WHERE planId = ?').run(id);
  db.prepare('DELETE FROM favorites WHERE planId = ?').run(id);
  db.prepare('DELETE FROM comments WHERE planId = ?').run(id);
  db.prepare('DELETE FROM versions WHERE planId = ?').run(id);
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
}

// ==================== 课程查询 ====================
function getAllCourses() {
  return db.prepare('SELECT * FROM courses ORDER BY createdAt ASC').all();
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
  const versions = db.prepare('SELECT id FROM versions WHERE planId = ? ORDER BY createdAt ASC').all(planId);
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

// HTML 防 XSS 清洗（允许 Quill 富文本，禁止脚本和事件处理器）
function sanitizeHtml(input) {
  if (!input) return '';
  let s = input.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  s = s.replace(/<[^>]*\s(on\w+)\s*=\s*(['"]?)[^'"]*\2[^>]*>/gi, '');
  s = s.replace(/javascript\s*:/gi, '');
  s = s.replace(/<\/?(iframe|object|embed|style|link|meta|base|form|input|button)[^>]*>/gi, '');
  s = s.replace(/<![\s\S]*?>/g, '');
  return s;
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
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit('login_' + ip, 10, 15 * 60 * 1000)) {
    return res.render('login', { error: '登录尝试次数过多，请15分钟后再试' });
  }

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
  const ip = req.ip || req.connection.remoteAddress;
  const isAjax = req.get('X-Requested-With') === 'XMLHttpRequest';
  if (!rateLimit('register_' + ip, 30, 60 * 60 * 1000)) {
    if (isAjax) return res.status(429).json({ error: '注册请求过多，请稍后再试' });
    return res.render('register', { error: '注册请求过多，请稍后再试' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    if (isAjax) return res.json({ error: '用户名和密码不能为空' });
    return res.render('register', { error: '用户名和密码不能为空' });
  }
  const uname = username.trim();
  if (uname.length < 2 || uname.length > 30) {
    if (isAjax) return res.json({ error: '用户名需要2-30个字符' });
    return res.render('register', { error: '用户名需要2-30个字符' });
  }
  if (password.length < 6) {
    if (isAjax) return res.json({ error: '密码至少6位' });
    return res.render('register', { error: '密码至少6位' });
  }
  if (getUserByUsername(uname)) {
    if (isAjax) return res.json({ error: '用户名已存在' });
    return res.render('register', { error: '用户名已存在' });
  }

  try {
    createUser(uname, password, uname);
  } catch (e) {
    console.error('[注册] 创建用户失败:', e.message);
    if (isAjax) return res.json({ error: '注册失败，请稍后重试' });
    return res.render('register', { error: '注册失败，请稍后重试' });
  }

  const user = getUserByUsername(uname);
  if (!user) {
    if (isAjax) return res.json({ error: '注册失败，请稍后重试' });
    return res.render('register', { error: '注册失败，请稍后重试' });
  }
  req.session.user = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role
  };
  if (isAjax) return res.json({ success: true });
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
app.get('/api/sports/hierarchy', isAuthenticated, (req, res) => {
  var configRows = db.prepare('SELECT * FROM sport_config ORDER BY sortOrder ASC').all();
  var scope = req.query.scope || 'all';
  var publicFilter = '';
  if (scope === 'public') publicFilter = ' AND isPublic = 1';
  var counts = {};
  var ids = {};
  for (var i = 0; i < configRows.length; i++) {
    var r = configRows[i];
    var key = r.sportGroup + '|' + r.sportName;
    counts[key] = db.prepare('SELECT COUNT(*) as cnt FROM plans WHERE sportGroup = ? AND sportName = ?' + publicFilter).get(r.sportGroup, r.sportName).cnt;
    ids[key] = r.id;
  }
  var tree = {};
  for (var ci = 0; ci < configRows.length; ci++) {
    var cr = configRows[ci];
    if (!tree[cr.sportGroup]) tree[cr.sportGroup] = {};
    tree[cr.sportGroup][cr.sportName] = { count: counts[cr.sportGroup + '|' + cr.sportName] || 0, id: cr.id };
  }
  res.json(tree);
});

app.post('/api/sports/config', isAuthenticated, isAdmin, (req, res) => {
  var { sportGroup, sportName } = req.body;
  if (!sportGroup || !sportName || !sportGroup.trim() || !sportName.trim()) {
    return res.status(400).json({ error: '请填写课程组和运动项目名称' });
  }
  sportGroup = sportGroup.trim();
  sportName = sportName.trim();
  var existing = db.prepare('SELECT id FROM sport_config WHERE sportGroup = ? AND sportName = ?').get(sportGroup, sportName);
  if (existing) return res.status(400).json({ error: '该项目已存在' });
  var maxOrder = db.prepare('SELECT MAX(sortOrder) as m FROM sport_config').get().m;
  db.prepare('INSERT INTO sport_config (sportGroup, sportName, sortOrder) VALUES (?, ?, ?)').run(sportGroup, sportName, (maxOrder || 0) + 1);
  var row = db.prepare('SELECT * FROM sport_config WHERE sportGroup = ? AND sportName = ?').get(sportGroup, sportName);
  res.json(row);
});

app.delete('/api/sports/config/:id', isAuthenticated, isAdmin, (req, res) => {
  var row = db.prepare('SELECT * FROM sport_config WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '项目不存在' });
  db.prepare('DELETE FROM sport_config WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/sports/:group/:sport/lessons', isAuthenticated, (req, res) => {
  var lessons = db.prepare('SELECT id, title, sessionNumber, author, authorId, createdAt FROM plans WHERE sportGroup = ? AND sportName = ? ORDER BY createdAt ASC').all(req.params.group, req.params.sport);
  res.json({ group: req.params.group, sport: req.params.sport, lessons: lessons });
});

app.get('/courses', isAuthenticated, (req, res) => {
  var sportGroup = req.query.group || '体育1';
  var sportName = req.query.sport || '';
  var lessons = [];
  if (sportName) {
    lessons = db.prepare('SELECT * FROM plans WHERE sportGroup = ? AND sportName = ? ORDER BY createdAt ASC').all(sportGroup, sportName).map(parsePlanFiles);
  }
  res.render('courses', { user: req.session.user, sportGroup, sportName, lessons, error: null, pageType: 'private' });
});

// ==================== 路由: 资源管理 ====================
app.get('/dashboard', isAuthenticated, async (req, res, next) => {
  try {
    const allPlans = getAllPlans().map(parsePlanFiles);
    let plans = allPlans.filter(p => p.authorId === req.session.user.id);
    const courses = getAllCourses();
    const allTags = getAllTags();
    const sportGroup = req.query.group || '体育1';
    const sportName = req.query.sport || '';
    if (sportGroup) {
      plans = plans.filter(p => p.sportGroup === sportGroup);
    }
    if (sportName) {
      plans = plans.filter(p => p.sportName === sportName);
    }
    for (const plan of plans) {
      await enrichPlanFiles(plan);
      plan.tags = getPlanTags(plan.id);
    }
    const stats = getPlanStats(req.session.user.id);
    res.render('dashboard', { plans, courses, allTags, stats, pageType: 'private', sportGroup, sportName });
  } catch (e) { next(e); }
});

// ==================== 路由: 公共大厅 ====================
app.get('/hall', isAuthenticated, async (req, res, next) => {
  try {
    const allPlans = getAllPlans().map(parsePlanFiles);
    let plans = allPlans.filter(p => p.isPublic == 1);
    const courses = getAllCourses();
    const allTags = getAllTags();
    const sportGroup = req.query.group || '体育1';
    const sportName = req.query.sport || '';
    if (sportGroup) {
      plans = plans.filter(p => p.sportGroup === sportGroup);
    }
    if (sportName) {
      plans = plans.filter(p => p.sportName === sportName);
    }
    for (const plan of plans) {
      await enrichPlanFiles(plan);
      plan.tags = getPlanTags(plan.id);
    }
    const stats = getPublicStats();
    res.render('dashboard', { plans, courses, allTags, stats, pageType: 'public', sportGroup, sportName });
  } catch (e) { next(e); }
});

app.get('/plan/new', isAuthenticated, (req, res) => {
  const courses = getAllCourses();
  const allTags = getAllTags();
  const preset = { sportGroup: req.query.sportGroup || '', sportName: req.query.sportName || '' };
  res.render('plan-edit', { plan: null, error: null, courses, allTags, useCOS, preset });
});

app.post('/plan', isAuthenticated, (req, res) => {
  const { title, content, fileList, courseId, sessionName, coverUrl, isPublic, sportGroup, sportName, sessionNumber } = req.body;
  if (!title || !title.trim()) {
    const courses = getAllCourses();
    return res.render('plan-edit', { plan: null, error: '请输入教案标题', courses, allTags: getAllTags(), useCOS });
  }

  let parsedFiles = [];
  if (fileList) {
    try { parsedFiles = JSON.parse(fileList); } catch (e) { /* keep empty */ }
  }

  // XSS 防护：清洗富文本内容
  const safeContent = sanitizeHtml(content || '');

  const planId = createPlan(title.trim(), safeContent, req.session.user.displayName, req.session.user.id, parsedFiles, courseId, sessionName, coverUrl, isPublic === '1', sportGroup, sportName, parseInt(sessionNumber) || 0);
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
    // XSS 防护：二次清洗（防御深度）
    plan.content = sanitizeHtml(plan.content || '');
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
  res.render('plan-edit', { plan, error: null, courses, allTags, planTags, useCOS });
});

app.post('/plan/:id', isAuthenticated, (req, res) => {
  const { title, content, fileList, courseId, sessionName, coverUrl, isPublic, sportGroup, sportName, sessionNumber } = req.body;
  if (!title || !title.trim()) {
    const plan = parsePlanFiles(getPlanById(req.params.id));
    const courses = getAllCourses();
    const allTags = getAllTags();
    return res.render('plan-edit', { plan, error: '请输入教案标题', courses, allTags, useCOS });
  }

  const existing = getPlanById(req.params.id);
  if (!existing) {
    return res.status(404).send('教案不存在');
  }
  if (existing.authorId !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).send('无权编辑他人教案');
  }

  let parsedFiles = [];
  if (fileList) {
    try { parsedFiles = JSON.parse(fileList); } catch (e) { /* keep empty */ }
  }

  // XSS 防护：清洗富文本内容
  const safeContent = sanitizeHtml(content || '');

  updatePlan(req.params.id, title.trim(), safeContent, parsedFiles, courseId, sessionName, coverUrl, isPublic === '1', sportGroup, sportName, parseInt(sessionNumber) || 0);
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
  if (plan.authorId !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).send('无权删除他人教案');
  }

  // 删除关联文件
  const files = JSON.parse(plan.files || '[]');
  if (files.length > 0) {
    files.forEach(f => {
      const subfolder = f.type === 'video' ? 'videos' : f.type === 'image' ? 'images' : 'docs';
      const filePath = path.join(UPLOADS_DIR, subfolder, f.filename);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      if (useCOS) {
        const cosKey = subfolder + '/' + f.filename;
        deleteFromCOS(cosKey).catch(() => {});
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
      console.error('[上传错误]', err.message || err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: '文件大小超过限制(最大5GB)' });
        }
        return res.status(400).json({ error: '上传错误' });
      }
      return res.status(400).json({ error: '不支持的文件格式' });
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
        fileInfo.url = await getPresignedUrl(cosKey);
      } catch (e) {
        console.error('[COS上传错误]', e.message);
        return res.status(500).json({ error: '上传到云存储失败，请稍后重试' });
      }
    }

    // 未启用 COS 时，设置 URL 指向本地文件
    if (!fileInfo.url) {
      const subfolder = fileType === 'image' ? 'images' : fileType === 'video' ? 'videos' : 'docs';
      fileInfo.url = '/uploads/' + subfolder + '/' + fileInfo.filename;
    }

    res.json({ success: true, file: fileInfo });
  });
});

app.post('/upload/delete', isAuthenticated, (req, res) => {
  const { filename, type } = req.body;
  if (!filename) {
    return res.status(400).json({ error: '参数错误' });
  }

  const validTypes = ['image', 'video', 'document'];
  const safeType = validTypes.includes(type) ? type : 'document';
  const subfolder = safeType === 'video' ? 'videos' : safeType === 'image' ? 'images' : 'docs';

  // 路径遍历防护：确保最终路径在 UPLOADS_DIR 内
  const resolvedPath = path.resolve(path.join(UPLOADS_DIR, subfolder, path.basename(filename)));
  if (!resolvedPath.startsWith(path.resolve(UPLOADS_DIR))) {
    return res.status(403).json({ error: '非法路径' });
  }

  if (fs.existsSync(resolvedPath)) {
    fs.unlinkSync(resolvedPath);
  }

  if (useCOS) {
    const cosKey = subfolder + '/' + path.basename(filename);
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
  const plan = getPlanById(req.params.id);
  if (!plan) return res.status(404).json({ error: '教案不存在' });
  if (plan.authorId !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '无权操作' });
  }
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
  if (content.length > 2000) return res.status(400).json({ error: '评论内容不超过2000字' });
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
  if (plan.authorId !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '无权操作' });
  }
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
  const plan = getPlanById(req.params.id);
  if (!plan) return res.status(404).json({ error: '教案不存在' });
  if (plan.authorId !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '无权操作' });
  }
  const v = getVersion(req.params.vid);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  if (v.planId !== req.params.id) return res.status(400).json({ error: '版本不匹配' });
  db.prepare('UPDATE plans SET content = ?, files = ?, updatedAt = ? WHERE id = ?')
    .run(v.content, v.files, new Date().toISOString(), req.params.id);
  res.json({ success: true });
});

// ==================== 全局错误处理 ====================
app.use((err, req, res, next) => {
  console.error('[服务器错误]', err.message || err);
  if (req.xhr || req.headers.accept?.includes('json')) {
    res.status(500).json({ error: '服务器内部错误' });
  } else {
    res.status(500).render('login', { error: '服务器内部错误，请稍后重试' });
  }
});

// ==================== 静态页面 fallback ====================
app.use((req, res) => {
  res.status(404).render('login', { error: '页面不存在，请重新登录' });
});

// ==================== 启动服务器 ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  《体育与健康》课程教学资源库已启动');
  console.log('  地址: http://localhost:' + PORT);
  console.log('============================================');
});
