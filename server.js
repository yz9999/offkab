const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.json')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// State
let scraperProcess = null;
let autoScrapeInterval = null;
const AUTO_SCRAPE_MS = 60 * 60 * 1000; // 1 hour

// Logging state
let scraperLogs = [];
const MAX_LOGS = 200; // keep last 200 lines

function appendLog(text) {
  const lines = text.toString().split('\n').filter(line => line.trim() !== '');
  lines.forEach(line => {
    scraperLogs.push(line);
    console.log(line); // also log to server console
    if (scraperLogs.length > MAX_LOGS) {
      scraperLogs.shift();
    }
  });
}

function startScraper(isAuto = false) {
  if (scraperProcess) return false;

  scraperLogs = []; // Clear logs on new run
  appendLog(`[${new Date().toLocaleTimeString()}] 🔄 启动${isAuto ? '自动' : '手动'}爬取任务...`);

  const args = [path.join(__dirname, 'scraper.js')];
  if (!isAuto) {
    args.push('--limit=20');
  }

  scraperProcess = spawn('node', args);

  scraperProcess.stdout.on('data', (data) => appendLog(data));
  scraperProcess.stderr.on('data', (data) => appendLog(data));

  scraperProcess.on('close', (code) => {
    appendLog(`[${new Date().toLocaleTimeString()}] ✅ 爬虫任务结束，退出码：${code}`);
    scraperProcess = null;
  });

  return true;
}

// API endpoint for data
app.get('/api/data', (req, res) => {
  const dataFile = path.join(__dirname, 'public', 'data.json');
  try {
    const fs = require('fs');
    if (fs.existsSync(dataFile)) {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
      res.json(data);
    } else {
      res.json([]);
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to read data' });
  }
});

// API endpoint for status
app.get('/api/status', (req, res) => {
  res.json({
    isScraping: scraperProcess !== null,
    autoScrapeActive: autoScrapeInterval !== null
  });
});

// API endpoint for logs
app.get('/api/logs', (req, res) => {
  res.json({ logs: scraperLogs });
});

// API endpoint to trigger scrape
app.post('/api/scrape', (req, res) => {
  if (scraperProcess) {
    return res.status(400).json({ error: 'Scraping already in progress' });
  }
  
  startScraper(false);
  res.json({ success: true, message: 'Scraping started' });
});

// API endpoint to toggle auto-scrape
app.post('/api/auto-scrape', (req, res) => {
  const { enabled } = req.body;

  if (enabled && !autoScrapeInterval) {
    console.log('⏱️ Auto-scrape enabled (runs every 1 hour)');
    // Run immediately when enabled
    startScraper(true);

    autoScrapeInterval = setInterval(() => {
      startScraper(true);
    }, AUTO_SCRAPE_MS);
    
    res.json({ success: true, enabled: true });
  } else if (!enabled && autoScrapeInterval) {
    console.log('🛑 Auto-scrape disabled');
    clearInterval(autoScrapeInterval);
    autoScrapeInterval = null;
    res.json({ success: true, enabled: false });
  } else {
    res.json({ success: true, enabled: !!autoScrapeInterval });
  }
});

// API endpoint for blacklisting an item
app.post('/api/blacklist/:id', (req, res) => {
  const id = req.params.id;
  const fs = require('fs');
  
  // 1. Add to blacklist.json
  const blacklistFile = path.join(__dirname, 'public', 'blacklist.json');
  let blacklist = [];
  if (fs.existsSync(blacklistFile)) {
    try { blacklist = JSON.parse(fs.readFileSync(blacklistFile, 'utf-8')); } catch (e) {}
  }
  if (!blacklist.includes(id)) {
    blacklist.push(id);
    fs.writeFileSync(blacklistFile, JSON.stringify(blacklist, null, 2), 'utf-8');
  }

  // 2. Remove from data.json
  const dataFile = path.join(__dirname, 'public', 'data.json');
  if (fs.existsSync(dataFile)) {
    try {
      let data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
      data = data.filter(item => item.viewId !== id);
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {}
  }

  // 3. Delete local images directory
  const imgDir = path.join(__dirname, 'public', 'images', id);
  if (fs.existsSync(imgDir)) {
    fs.rmSync(imgDir, { recursive: true, force: true });
  }

  res.json({ success: true, message: 'Item blacklisted and data deleted' });
});

app.listen(PORT, () => {
  console.log(`\n🌐 Offkab Gallery Server running at:`);
  console.log(`   http://localhost:${PORT}\n`);
});
