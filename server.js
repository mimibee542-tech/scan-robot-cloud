/**
 * SCAN ROBOT - 云端监控服务器 (Cloud Edition)
 * 部署平台: Render.com (永久免费)
 * 核心功能: 即使所有本地电脑停电，仍能检测离线并推送 Telegram 告警
 *
 * 环境变量 (在 Render 控制台配置):
 *   TELEGRAM_BOT_TOKEN  - 机器人 token
 *   TELEGRAM_CHAT_ID    - 接收告警的 chat id
 *   OFFLINE_THRESHOLD   - 判定离线的秒数 (默认 180 秒 = 3 分钟)
 *   ALERT_COOLDOWN      - 同一设备告警冷却时间秒数 (默认 600 = 10 分钟)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── 配置 ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const OFFLINE_THRESHOLD_SEC = parseInt(process.env.OFFLINE_THRESHOLD || '180', 10);
const ALERT_COOLDOWN_SEC = parseInt(process.env.ALERT_COOLDOWN || '600', 10);

// ─── 数据目录 ─────────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
const devicesFile = path.join(dataDir, 'devices.json');
const reportsFile = path.join(dataDir, 'reports.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ─── 内存数据 ─────────────────────────────────────────────────────────────
// 注意: Render 免费版重启会丢失数据，但对监控场景影响极小（重启后设备重新上报即可）
let devices = loadJson(devicesFile, {});
let reports = loadJson(reportsFile, []);

// 离线告警记录：避免同一设备短时间内反复告警
// key: deviceId, value: timestamp of last alert sent
const offlineAlertSent = {};

// ─── 工具函数 ─────────────────────────────────────────────────────────────
function loadJson(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return defaultVal;
}

function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch (e) {}
}

function getNowStr() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

// ─── Telegram 通知 ────────────────────────────────────────────────────────
function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.slice(0, 4000) });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(options);
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function sendTelegramPhoto(caption, base64png) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !base64png) return;
  // 使用 sendPhoto with base64 via sendDocument 代替
  // 先通过 sendMessage 发文字，截图太大则跳过
  sendTelegram(caption);
}

// ─── 停电/离线定时巡检 ────────────────────────────────────────────────────
function checkOfflineDevices() {
  const now = Date.now();
  devices = loadJson(devicesFile, {}); // 每次重新从文件读取最新数据

  for (const [deviceId, dev] of Object.entries(devices)) {
    const diffSec = Math.floor((now - (dev.lastSeen || 0)) / 1000);

    if (diffSec > OFFLINE_THRESHOLD_SEC) {
      // 检查是否在冷却时间内（避免刷屏告警）
      const lastAlert = offlineAlertSent[deviceId] || 0;
      const alertDiff = Math.floor((now - lastAlert) / 1000);

      if (alertDiff > ALERT_COOLDOWN_SEC) {
        offlineAlertSent[deviceId] = now;

        const devName = dev.customName
          ? `${dev.computerName} [${dev.customName}]`
          : dev.computerName;
        const offlineMin = Math.floor(diffSec / 60);

        const msg =
          `🔴 【设备掉线/停电告警】\n\n` +
          `📍 设备: ${devName}\n` +
          `👤 用户: ${dev.userName}\n` +
          `🌐 IP: ${dev.ip || '未知'}\n` +
          `⏱ 已离线: ${offlineMin} 分钟\n` +
          `🕐 告警时间: ${getNowStr()}\n\n` +
          `⚠️ 该设备已超过 ${Math.floor(OFFLINE_THRESHOLD_SEC / 60)} 分钟未发送心跳信号，` +
          `可能发生了停电、断网或关机，请尽快检查！`;

        console.log(`[离线告警] ${devName} 已离线 ${offlineMin} 分钟，发送 Telegram 告警...`);
        sendTelegram(msg);

        // 更新设备状态
        if (devices[deviceId]) {
          devices[deviceId].status = 'offline';
          saveJson(devicesFile, devices);
        }
      }
    } else if (dev.status === 'offline' && diffSec <= OFFLINE_THRESHOLD_SEC) {
      // 设备重新上线：发送恢复通知
      const devName = dev.customName
        ? `${dev.computerName} [${dev.customName}]`
        : dev.computerName;

      // 只在确实之前发过离线告警时才发恢复通知
      if (offlineAlertSent[deviceId]) {
        const msg =
          `🟢 【设备恢复上线通知】\n\n` +
          `📍 设备: ${devName}\n` +
          `👤 用户: ${dev.userName}\n` +
          `🌐 IP: ${dev.ip || '未知'}\n` +
          `🕐 恢复时间: ${getNowStr()}\n\n` +
          `✅ 该设备已重新连接并恢复正常心跳，机器人正在运行中！`;

        console.log(`[恢复通知] ${devName} 已重新上线`);
        sendTelegram(msg);
        delete offlineAlertSent[deviceId]; // 清除告警记录
      }

      devices[deviceId].status = dev.robotStatus === 'running' ? 'healthy' : 'warning';
      saveJson(devicesFile, devices);
    }
  }
}

// 每 60 秒执行一次离线巡检
setInterval(checkOfflineDevices, 60 * 1000);

// ─── HTTP 路由 ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // ── 健康检查 / 防休眠 ping ──────────────────────────────────────────────
  if (pathname === '/ping' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong ' + Date.now());
    return;
  }

  // ── 首页看板 ──────────────────────────────────────────────────────────
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboard());
    return;
  }

  // ── 一键安装包直接下载 ──────────────────────────────────────────────────
  if (pathname === '/download' && req.method === 'GET') {
    res.writeHead(302, { 'Location': 'https://files.catbox.moe/zvsons.zip' });
    res.end();
    return;
  }

  // ── 上传文件访问 ──────────────────────────────────────────────────────
  if (pathname.startsWith('/uploads/') && req.method === 'GET') {
    const filename = path.basename(pathname);
    const filePath = path.join(uploadsDir, filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const ct = ext === '.png' ? 'image/png' : 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': ct });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404); res.end('Not Found');
    }
    return;
  }

  // ── GET /api/devices ──────────────────────────────────────────────────
  if (pathname === '/api/devices' && req.method === 'GET') {
    devices = loadJson(devicesFile, {});
    const now = Date.now();
    const result = Object.values(devices).map(dev => {
      const diffSec = Math.floor((now - (dev.lastSeen || 0)) / 1000);
      const calcStatus = diffSec > OFFLINE_THRESHOLD_SEC ? 'offline' : (dev.status || 'healthy');
      return { ...dev, status: calcStatus, lastSeenDiffSec: diffSec };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, devices: result, serverTime: now, serverRegion: '☁️ Cloud' }));
    return;
  }

  // ── GET /api/reports ──────────────────────────────────────────────────
  if (pathname === '/api/reports' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, reports: reports.slice(-100).reverse() }));
    return;
  }

  // ── POST /api/heartbeat ───────────────────────────────────────────────
  if (pathname === '/api/heartbeat' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const deviceId = data.deviceId || `${data.computerName}_${data.userName}`;
      const now = Date.now();
      const wasOffline = devices[deviceId] && devices[deviceId].status === 'offline';

      devices[deviceId] = {
        deviceId,
        computerName: data.computerName || 'Unknown',
        userName: data.userName || 'Unknown',
        customName: data.customName || '',
        ip: data.ip || req.socket.remoteAddress,
        robotPid: data.robotPid || null,
        robotStatus: data.robotStatus || 'unknown',
        idleMinutes: data.idleMinutes || 0,
        stuckTimeout: data.stuckTimeout || 15,
        lastLogTime: data.lastLogTime || '',
        status: data.status || 'healthy',
        lastSeen: now,
        version: data.version || '2.0.0'
      };

      saveJson(devicesFile, devices);

      // 如果刚从离线恢复，立即在下一次巡检时发送恢复通知
      if (wasOffline) {
        const dev = devices[deviceId];
        const devName = dev.customName ? `${dev.computerName} [${dev.customName}]` : dev.computerName;
        if (offlineAlertSent[deviceId]) {
          sendTelegram(
            `🟢 【设备恢复上线】\n\n` +
            `📍 设备: ${devName}\n` +
            `👤 用户: ${dev.userName} | 🌐 IP: ${dev.ip}\n` +
            `🕐 恢复时间: ${getNowStr()}\n` +
            `✅ 设备已重新联网，机器人守护程序恢复运行中！`
          );
          delete offlineAlertSent[deviceId];
        }
        devices[deviceId].status = data.status || 'healthy';
        saveJson(devicesFile, devices);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, serverTime: now }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST /api/report ──────────────────────────────────────────────────
  if (pathname === '/api/report' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const reportId = `rep_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      let screenshotUrl = '';
      let logFileUrl = '';

      if (data.screenshotBase64) {
        const pngName = `${reportId}_screen.png`;
        fs.writeFileSync(path.join(uploadsDir, pngName), Buffer.from(data.screenshotBase64, 'base64'));
        screenshotUrl = `/uploads/${pngName}`;
      }
      if (data.reportText) {
        const txtName = `${reportId}_log.txt`;
        fs.writeFileSync(path.join(uploadsDir, txtName), data.reportText, 'utf8');
        logFileUrl = `/uploads/${txtName}`;
      }

      const newReport = {
        id: reportId,
        timestamp: Date.now(),
        timeStr: data.timeStr || getNowStr(),
        computerName: data.computerName || 'Unknown',
        userName: data.userName || 'Unknown',
        customName: data.customName || '',
        ip: data.ip || req.socket.remoteAddress,
        reason: data.reason || '未指定',
        idleMinutes: data.idleMinutes || 0,
        screenshotUrl,
        logFileUrl,
        reportText: data.reportText || ''
      };

      reports.push(newReport);
      if (reports.length > 300) reports = reports.slice(-300);
      saveJson(reportsFile, reports);

      const deviceId = data.deviceId || `${data.computerName}_${data.userName}`;
      if (devices[deviceId]) {
        devices[deviceId].status = 'warning';
        devices[deviceId].lastFault = newReport.reason;
        devices[deviceId].lastFaultTime = newReport.timestamp;
        saveJson(devicesFile, devices);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reportId }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST /api/delete-device ───────────────────────────────────────────
  if (pathname === '/api/delete-device' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { deviceId } = JSON.parse(body);
      devices = loadJson(devicesFile, {});
      if (deviceId && devices[deviceId]) { delete devices[deviceId]; saveJson(devicesFile, devices); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST /api/clear-offline ───────────────────────────────────────────
  if (pathname === '/api/clear-offline' && req.method === 'POST') {
    devices = loadJson(devicesFile, {});
    const now = Date.now();
    // 保护机制：仅清理离线超过 24 小时 (86400秒) 的废弃旧设备，绝不误删刚断电/重启的设备！
    for (const [id, dev] of Object.entries(devices)) {
      if (Math.floor((now - (dev.lastSeen || 0)) / 1000) > 86400) delete devices[id];
    }
    saveJson(devicesFile, devices);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, remaining: Object.keys(devices).length }));
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

// ─── 启动 ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log('☁️  SCAN ROBOT 云端监控服务器已启动！');
  console.log(`🌐 端口: ${PORT}`);
  console.log(`🔴 离线告警阈值: ${OFFLINE_THRESHOLD_SEC} 秒`);
  console.log(`📱 Telegram 告警: ${TELEGRAM_TOKEN ? '✅ 已配置' : '❌ 未配置'}`);
  console.log('='.repeat(60));

  // 启动时立即执行一次巡检
  setTimeout(checkOfflineDevices, 5000);
});

// ─── 网页看板 HTML ────────────────────────────────────────────────────────
function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SCAN ROBOT - 云端监控看板</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    @keyframes pulse-green { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(1.1)} }
    @keyframes pulse-red   { 0%,100%{opacity:1} 50%{opacity:.4} }
    .pulse-dot-green { animation: pulse-green 2s infinite ease-in-out; }
    .pulse-dot-red   { animation: pulse-red 1.5s infinite ease-in-out; }
    .glass-card { background:rgba(30,41,59,.7); backdrop-filter:blur(12px); border:1px solid rgba(255,255,255,.08); }
    .modal-backdrop { background:rgba(0,0,0,.85); backdrop-filter:blur(8px); }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans antialiased">

  <!-- Header -->
  <header class="sticky top-0 z-40 bg-slate-900/80 backdrop-blur-md border-b border-slate-800 px-6 py-4">
    <div class="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-violet-500 to-purple-600 flex items-center justify-center shadow-lg">
          <i class="fa-solid fa-cloud text-xl text-white"></i>
        </div>
        <div>
          <h1 class="text-xl font-bold tracking-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
            SCAN ROBOT 云端监控看板
          </h1>
          <p class="text-xs text-slate-400 flex items-center gap-2 mt-0.5">
            <span class="inline-flex items-center gap-1 text-violet-400"><i class="fa-solid fa-cloud"></i> 云端服务器 · 停电不掉线</span>
            <span class="inline-flex items-center gap-1 text-emerald-400"><i class="fa-solid fa-bell"></i> 停电自动 Telegram 告警</span>
          </p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <a href="https://files.catbox.moe/zvsons.zip" target="_blank" download class="inline-flex items-center gap-2 px-3.5 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-xs font-bold rounded-lg shadow-md shadow-violet-600/30 transition-all active:scale-95" title="点击下载40台电脑通用一键安装包">
          <i class="fa-solid fa-download"></i> 📥 下载客户端一键安装包
        </a>
        <button onclick="clearOffline()" class="px-3 py-2 bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-300 rounded-lg border border-slate-700 text-xs flex items-center gap-1.5 transition" title="仅清理离线超过24小时的废弃记录，离线设备会正常保留">
          <i class="fa-solid fa-broom"></i> 清理失效历史 (&gt;24小时)
        </button>
        <button onclick="refreshData()" class="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition" title="刷新状态">
          <i class="fa-solid fa-rotate" id="refresh-icon"></i>
        </button>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-6 py-8 space-y-8">

    <!-- Stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="glass-card rounded-2xl p-5 relative overflow-hidden">
        <div class="text-slate-400 text-xs font-semibold uppercase tracking-wider">已接入设备</div>
        <div class="text-3xl font-extrabold text-white mt-2" id="stat-total">0</div>
        <div class="text-xs text-slate-500 mt-1">40台设备集群</div>
        <i class="fa-solid fa-network-wired absolute right-4 bottom-4 text-3xl text-slate-800"></i>
      </div>
      <div class="glass-card rounded-2xl p-5 relative overflow-hidden border-emerald-500/20">
        <div class="text-emerald-400 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full bg-emerald-400 pulse-dot-green"></span> 正常运行中
        </div>
        <div class="text-3xl font-extrabold text-emerald-400 mt-2" id="stat-healthy">0</div>
        <div class="text-xs text-slate-500 mt-1">心跳活跃中</div>
        <i class="fa-solid fa-circle-check absolute right-4 bottom-4 text-3xl text-emerald-950"></i>
      </div>
      <div class="glass-card rounded-2xl p-5 relative overflow-hidden border-amber-500/20">
        <div class="text-amber-400 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full bg-amber-400 pulse-dot-red"></span> 报警/卡顿
        </div>
        <div class="text-3xl font-extrabold text-amber-400 mt-2" id="stat-warning">0</div>
        <div class="text-xs text-slate-500 mt-1">已触发自愈</div>
        <i class="fa-solid fa-triangle-exclamation absolute right-4 bottom-4 text-3xl text-amber-950"></i>
      </div>
      <div class="glass-card rounded-2xl p-5 relative overflow-hidden border-rose-500/20">
        <div class="text-rose-400 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full bg-rose-500 pulse-dot-red"></span> 停电/离线
        </div>
        <div class="text-3xl font-extrabold text-rose-400 mt-2" id="stat-offline">0</div>
        <div class="text-xs text-slate-500 mt-1">已推送 Telegram</div>
        <i class="fa-solid fa-power-off absolute right-4 bottom-4 text-3xl text-rose-950"></i>
      </div>
    </div>

    <!-- Cloud Banner -->
    <div class="glass-card rounded-2xl p-4 flex items-center gap-4 border-violet-500/20">
      <div class="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center flex-shrink-0">
        <i class="fa-solid fa-shield-halved text-violet-400 text-lg"></i>
      </div>
      <div class="flex-1 text-sm">
        <span class="text-violet-300 font-semibold">云端守护已激活</span>
        <span class="text-slate-400 ml-2">本服务器运行于云端，不依赖任何本地电脑。设备停电 → 超过 3 分钟无心跳 → 自动推送 Telegram 告警。</span>
      </div>
      <div class="text-xs text-slate-500 font-mono" id="server-time">--</div>
    </div>

    <!-- Tabs -->
    <div class="flex items-center justify-between border-b border-slate-800 pb-3">
      <div class="flex gap-2">
        <button onclick="switchTab('devices')" id="tab-btn-devices" class="px-4 py-2 text-sm font-semibold rounded-lg bg-violet-600 text-white transition">
          <i class="fa-solid fa-desktop mr-1.5"></i> 设备监控矩阵
        </button>
        <button onclick="switchTab('reports')" id="tab-btn-reports" class="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition">
          <i class="fa-solid fa-camera mr-1.5"></i> 故障记录 (<span id="report-count">0</span>)
        </button>
      </div>
      <input type="text" id="search-box" oninput="renderDevices()" placeholder="搜索设备名/IP..." class="hidden sm:block w-56 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-violet-500 transition">
    </div>

    <!-- Tab: Devices -->
    <section id="tab-devices">
      <div id="devices-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"></div>
      <div id="no-devices" class="hidden text-center py-16 glass-card rounded-2xl">
        <i class="fa-solid fa-satellite-dish text-4xl text-slate-700 mb-3"></i>
        <p class="text-slate-400">暂无设备接入</p>
        <p class="text-xs text-slate-600 mt-1">请在各台电脑上运行一键安装包，守护程序将自动上报心跳</p>
      </div>
    </section>

    <!-- Tab: Reports -->
    <section id="tab-reports" class="hidden">
      <div id="reports-list" class="space-y-4"></div>
      <div id="no-reports" class="hidden text-center py-16 glass-card rounded-2xl">
        <i class="fa-solid fa-shield-heart text-4xl text-emerald-800 mb-3"></i>
        <p class="text-slate-400">暂无故障记录，集群运行平稳 🎉</p>
      </div>
    </section>

  </main>

  <!-- Lightbox -->
  <div id="img-modal" class="fixed inset-0 z-50 modal-backdrop hidden flex items-center justify-center p-4" onclick="closeImgModal()">
    <div class="relative max-w-6xl w-full flex flex-col items-center" onclick="event.stopPropagation()">
      <div class="w-full flex items-center justify-between pb-3 text-white">
        <span id="modal-caption" class="text-sm font-bold text-slate-200"></span>
        <div class="flex items-center gap-2">
          <button onclick="window.open(document.getElementById('modal-img').src, '_blank')" class="px-3.5 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 shadow transition">
            <i class="fa-solid fa-up-right-from-square"></i> 在新窗口打开 100% 超清大图
          </button>
          <button onclick="closeImgModal()" class="text-slate-400 hover:text-white text-2xl p-1"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>
      <div class="w-full max-h-[80vh] overflow-auto rounded-xl border border-slate-700 bg-black/60 p-1 flex items-center justify-center">
        <img id="modal-img" src="" class="rounded-lg max-h-[78vh] w-auto shadow-2xl object-contain mx-auto cursor-zoom-in" onclick="window.open(this.src, '_blank')" title="点击在新窗口查看 100% 原始尺寸">
      </div>
      <p class="text-xs text-slate-400 mt-2"><i class="fa-solid fa-circle-info mr-1 text-cyan-400"></i>提示：点击图片或右上角按钮即可在浏览器新标签页以 100% 原始分辨率查看终端代码细节</p>
    </div>
  </div>

  <!-- Log Modal -->
  <div id="log-modal" class="fixed inset-0 z-50 modal-backdrop hidden flex items-center justify-center p-4" onclick="closeLogModal()">
    <div class="glass-card bg-slate-900 border border-slate-700 rounded-2xl max-w-5xl w-full max-h-[88vh] flex flex-col p-6 shadow-2xl" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between pb-3 border-b border-slate-800">
        <h3 id="log-modal-title" class="font-bold text-slate-100 flex items-center gap-2 text-sm md:text-base">
          <i class="fa-solid fa-file-code text-emerald-400"></i> 故障现场记事本与运行代码
        </h3>
        <div class="flex items-center gap-3">
          <button onclick="copyLogModalText()" id="copy-log-btn" class="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg shadow-md flex items-center gap-1.5 transition active:scale-95">
            <i class="fa-solid fa-copy"></i> 📋 一键复制当前全部代码与日志
          </button>
          <button onclick="closeLogModal()" class="text-slate-400 hover:text-white text-lg p-1">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>
      <div class="relative flex-1 overflow-hidden mt-4">
        <pre id="log-modal-body" class="h-full overflow-auto bg-slate-950 p-4 rounded-xl text-xs font-mono text-emerald-400 border border-slate-800 leading-relaxed whitespace-pre-wrap select-all"></pre>
      </div>
    </div>
  </div>

  <script>
    let allDevices = [], allReports = [], currentTab = 'devices';

    async function fetchData() {
      try {
        const [dr, rr] = await Promise.all([fetch('/api/devices'), fetch('/api/reports')]);
        const dd = await dr.json(), rd = await rr.json();
        allDevices = dd.devices || [];
        allReports = rd.reports || [];
        document.getElementById('server-time').textContent = '服务器时间: ' + new Date(dd.serverTime).toLocaleTimeString('zh-CN');
        updateStats(); renderDevices(); renderReports();
      } catch(e) {}
    }

    function updateStats() {
      document.getElementById('stat-total').textContent = allDevices.length;
      document.getElementById('stat-healthy').textContent = allDevices.filter(d=>d.status==='healthy').length;
      document.getElementById('stat-warning').textContent = allDevices.filter(d=>d.status==='warning').length;
      document.getElementById('stat-offline').textContent = allDevices.filter(d=>d.status==='offline').length;
      document.getElementById('report-count').textContent = allReports.length;
    }

    function renderDevices() {
      const grid = document.getElementById('devices-grid');
      const empty = document.getElementById('no-devices');
      const q = (document.getElementById('search-box').value||'').toLowerCase();
      const filtered = allDevices.filter(d=>(d.computerName+' '+(d.customName||'')+' '+d.ip).toLowerCase().includes(q));
      if (!filtered.length) { grid.innerHTML=''; empty.classList.remove('hidden'); return; }
      empty.classList.add('hidden');
      grid.innerHTML = filtered.map(d => {
        let badge, border;
        if (d.status==='healthy') {
          badge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-dot-green"></span> 正常运行</span>';
          border = 'border-emerald-500/20 hover:border-emerald-500/40';
        } else if (d.status==='warning') {
          badge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20"><span class="w-1.5 h-1.5 rounded-full bg-amber-400 pulse-dot-red"></span> 卡顿/报警</span>';
          border = 'border-amber-500/30';
        } else {
          badge = '<div class="flex items-center gap-1.5"><span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30"><span class="w-1.5 h-1.5 rounded-full bg-rose-500 pulse-dot-red"></span> 停电/离线</span><button onclick="deleteDevice(\\'' + d.deviceId + '\\')" class="p-1 text-slate-500 hover:text-rose-400 text-xs transition" title="删除记录"><i class="fa-solid fa-trash-can"></i></button></div>';
          border = 'border-rose-500/20';
        }
        const title = d.customName ? d.computerName+' ['+d.customName+']' : d.computerName;
        const hb = d.lastSeenDiffSec < 60 ? d.lastSeenDiffSec+'秒前' : Math.floor(d.lastSeenDiffSec/60)+'分前';
        return \`<div class="glass-card rounded-2xl p-5 \${border} transition-all duration-200 hover:-translate-y-0.5 shadow-lg">
          <div class="flex items-start justify-between">
            <div>
              <h3 class="font-bold text-base text-white flex items-center gap-2"><i class="fa-solid fa-laptop text-violet-400"></i> \${title}</h3>
              <p class="text-xs text-slate-400 mt-0.5">用户: <span class="text-slate-300 font-mono">\${d.userName}</span> · IP: <span class="text-slate-300 font-mono">\${d.ip}</span></p>
            </div>
            <div>\${badge}</div>
          </div>
          <div class="mt-4 pt-3 border-t border-slate-800/80 grid grid-cols-2 gap-2 text-xs">
            <div><span class="text-slate-500">机器人进程:</span> <span class="font-mono text-slate-300 ml-1">\${d.robotPid ? 'PID '+d.robotPid : '<span class="text-rose-400">未检测到</span>'}</span></div>
            <div><span class="text-slate-500">空闲计时:</span> <span class="font-mono text-slate-300 ml-1 \${d.idleMinutes>=15?'text-amber-400 font-bold':''}">\${d.idleMinutes ? d.idleMinutes.toFixed(1)+' 分钟' : '刚刚'}</span></div>
            <div class="col-span-2 flex justify-between text-slate-500 mt-1">
              <span>最近活动: \${d.lastLogTime||'暂无'}</span>
              <span>心跳: \${hb}</span>
            </div>
          </div>
        </div>\`;
      }).join('');
    }

    function renderReports() {
      const list = document.getElementById('reports-list');
      const empty = document.getElementById('no-reports');
      if (!allReports.length) { list.innerHTML=''; empty.classList.remove('hidden'); return; }
      empty.classList.add('hidden');
      list.innerHTML = allReports.map(r => {
        const title = r.customName ? r.computerName+' ['+r.customName+']' : r.computerName;
        return \`<div class="glass-card rounded-2xl p-5 border-slate-800 hover:border-slate-700 transition flex flex-col md:flex-row gap-5 items-start">
          \${r.screenshotUrl ? \`<div class="w-full md:w-56 flex-shrink-0 cursor-pointer group relative overflow-hidden rounded-xl border border-slate-700" onclick="openImgModal('\${r.screenshotUrl}','\${title}')"><img src="\${r.screenshotUrl}" class="w-full h-32 object-cover group-hover:scale-105 transition duration-300"><div class="absolute inset-0 bg-slate-950/40 flex items-center justify-center"><span class="text-xs text-cyan-400 bg-slate-900/90 px-2 py-1 rounded-lg"><i class="fa-solid fa-magnifying-glass-plus"></i> 看大图</span></div></div>\` : ''}
          <div class="flex-1 space-y-2">
            <div class="flex items-center justify-between">
              <h4 class="font-bold text-white flex items-center gap-2"><span class="px-2 py-0.5 rounded bg-rose-500/20 text-rose-400 text-xs border border-rose-500/30">故障报警</span> \${title}</h4>
              <span class="text-xs text-slate-400 font-mono">\${r.timeStr}</span>
            </div>
            <p class="text-sm text-amber-300 bg-amber-500/10 px-3 py-1.5 rounded-lg border border-amber-500/20"><i class="fa-solid fa-triangle-exclamation mr-1.5"></i> \${r.reason}</p>
            \${r.logFileUrl ? \`<button onclick="viewLog('\${r.id}')" class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition flex items-center gap-1.5"><i class="fa-solid fa-file-lines text-violet-400"></i> 查看报错日志</button>\` : ''}
          </div>
        </div>\`;
      }).join('');
    }

    function switchTab(tab) {
      currentTab = tab;
      document.getElementById('tab-devices').classList.toggle('hidden', tab!=='devices');
      document.getElementById('tab-reports').classList.toggle('hidden', tab==='devices');
      document.getElementById('tab-btn-devices').className = 'px-4 py-2 text-sm font-semibold rounded-lg transition ' + (tab==='devices' ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700');
      document.getElementById('tab-btn-reports').className = 'px-4 py-2 text-sm font-semibold rounded-lg transition ' + (tab==='reports' ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700');
    }

    function openImgModal(url, cap) { document.getElementById('modal-img').src=url; document.getElementById('modal-caption').textContent=cap; document.getElementById('img-modal').classList.remove('hidden'); }
    function closeImgModal() { document.getElementById('img-modal').classList.add('hidden'); }
    function viewLog(id) {
      const r = allReports.find(x=>x.id===id); if(!r) return;
      document.getElementById('log-modal-title').innerHTML = '<i class="fa-solid fa-file-code text-emerald-400"></i> '+r.computerName+' - 当前卡死脚本与全部代码';
      document.getElementById('log-modal-body').textContent = r.reportText || '无内容';
      document.getElementById('log-modal').classList.remove('hidden');
    }
    function closeLogModal() { document.getElementById('log-modal').classList.add('hidden'); }

    function copyLogModalText() {
      const text = document.getElementById('log-modal-body').innerText;
      const btn = document.getElementById('copy-log-btn');
      if (!navigator.clipboard) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } else {
        navigator.clipboard.writeText(text);
      }
      btn.innerHTML = '<i class="fa-solid fa-check text-white"></i> ✅ 已成功复制全部代码！';
      btn.classList.replace('bg-emerald-600', 'bg-cyan-600');
      setTimeout(() => {
        btn.innerHTML = '<i class="fa-solid fa-copy"></i> 📋 一键复制当前全部代码与日志';
        btn.classList.replace('bg-cyan-600', 'bg-emerald-600');
      }, 2500);
    }

    async function refreshData() {
      const ic = document.getElementById('refresh-icon');
      ic.classList.add('fa-spin');
      await fetchData();
      setTimeout(()=>ic.classList.remove('fa-spin'), 600);
    }

    async function clearOffline() {
      if (!confirm('提示：此操作仅会清除【已离线超过 24 小时】的废弃旧设备。刚关机、断电或正在重启的设备会受到安全保护，不会被误删。确定清理吗？')) return;
      await fetch('/api/clear-offline', {method:'POST'});
      await fetchData();
    }

    async function deleteDevice(id) {
      if (!confirm('确定删除此设备记录吗？')) return;
      await fetch('/api/delete-device', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({deviceId:id})});
      await fetchData();
    }

    setInterval(fetchData, 5000);
    fetchData();
  </script>
</body>
</html>`;
}
