const { app, BrowserWindow, ipcMain, shell, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const BUILT_IN_EXE_VERSION = "2.0.0";
const BUILT_IN_BUNDLE_VERSION = 1;

const userDataDir = app.getPath('userData');
const sentinelPath = path.join(userDataDir, 'startup-sentinel.json');
const crashLogPath = path.join(userDataDir, 'crash.log');
const otaDir = path.join(userDataDir, 'ota-bundle');
const otaStatePath = path.join(otaDir, 'ota-state.json');

function appendCrashLog(msg) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(crashLogPath, line, 'utf8');
  } catch {}
}

function readSentinel() {
  try {
    if (fs.existsSync(sentinelPath)) {
      return JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    }
  } catch {}
  return {
    safeGraphicsMode: false,
    pendingBootStartedAt: 0,
    crashCount: 0,
    lastCrashAt: 0,
  };
}

function writeSentinel(next) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(sentinelPath, JSON.stringify(next, null, 2), 'utf8');
  } catch {}
}

const sentinel = readSentinel();
if (sentinel.pendingBootStartedAt && Date.now() - sentinel.pendingBootStartedAt < 120000) {
  sentinel.safeGraphicsMode = true;
  sentinel.crashCount = (sentinel.crashCount || 0) + 1;
  sentinel.lastCrashAt = Date.now();
  appendCrashLog('Detected incomplete/crashed previous startup (<12s). Enabling Safe Graphics Mode automatically.');
}

const cliSafe = process.argv.includes('--disable-gpu') || process.argv.includes('--safe-mode');
if (cliSafe) {
  sentinel.safeGraphicsMode = true;
}

if (sentinel.safeGraphicsMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}

sentinel.pendingBootStartedAt = Date.now();
writeSentinel(sentinel);

app.on('child-process-gone', (_, details) => {
  appendCrashLog(`child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  if (!sentinel.safeGraphicsMode && (details.type === 'GPU' || details.reason === 'crashed' || details.reason === 'launch-failed')) {
    sentinel.safeGraphicsMode = true;
    sentinel.pendingBootStartedAt = 0;
    writeSentinel(sentinel);
    app.relaunch({ args: [...process.argv.slice(1), '--disable-gpu'] });
    app.exit(0);
  }
});

function sha256FileSync(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function resolveActiveBundle() {
  const builtInBundleDir = path.join(__dirname, 'bundle');
  try {
    if (fs.existsSync(otaStatePath) && fs.existsSync(path.join(otaDir, 'app-core.js'))) {
      const state = JSON.parse(fs.readFileSync(otaStatePath, 'utf8'));
      const otaVer = Number(state.bundleVersion || 0);
      if (otaVer >= BUILT_IN_BUNDLE_VERSION && Array.isArray(state.files)) {
        let allValid = true;
        for (const f of state.files) {
          const fp = path.join(otaDir, f.path);
          if (!fs.existsSync(fp) || sha256FileSync(fp) !== f.sha256) {
            allValid = false;
            break;
          }
        }
        if (allValid) {
          return { dir: otaDir, bundleVersion: otaVer, isOta: true };
        }
      }
      fs.rmSync(otaDir, { recursive: true, force: true });
    }
  } catch (err) {
    appendCrashLog('Invalid OTA bundle detected, falling back to built-in: ' + err.message);
    try { fs.rmSync(otaDir, { recursive: true, force: true }); } catch {}
  }
  return { dir: builtInBundleDir, bundleVersion: BUILT_IN_BUNDLE_VERSION, isOta: false };
}

app.whenReady().then(() => {
  setTimeout(() => {
    const latest = readSentinel();
    latest.pendingBootStartedAt = 0;
    writeSentinel(latest);
  }, 12000);

  const selected = resolveActiveBundle();
  const buildContext = (bundleInfo) => ({
    app,
    BrowserWindow,
    ipcMain,
    shell,
    net,
    session,
    AdmZip,
    bundleDir: bundleInfo.dir,
    assetsDir: path.join(__dirname, 'assets'),
    configPath: path.join(__dirname, 'config.json'),
    otaDir,
    builtInExeVersion: BUILT_IN_EXE_VERSION,
    activeBundleVersion: bundleInfo.bundleVersion,
    getSafeGraphicsMode: () => Boolean(readSentinel().safeGraphicsMode),
    setSafeGraphicsMode: (enabled) => {
      const s = readSentinel();
      s.safeGraphicsMode = Boolean(enabled);
      s.pendingBootStartedAt = 0;
      writeSentinel(s);
    },
    getDiagnostics: () => {
      let tail = '';
      try {
        if (fs.existsSync(crashLogPath)) {
          const lines = fs.readFileSync(crashLogPath, 'utf8').trim().split('\n');
          tail = lines.slice(-30).join('\n');
        }
      } catch {}
      return {
        builtInExeVersion: BUILT_IN_EXE_VERSION,
        activeBundleVersion: bundleInfo.bundleVersion,
        isOta: bundleInfo.isOta,
        safeGraphicsMode: Boolean(readSentinel().safeGraphicsMode),
        crashLogTail: tail,
      };
    },
  });

  try {
    const core = require(path.join(selected.dir, 'app-core.js'));
    core.start(buildContext(selected));
  } catch (err) {
    appendCrashLog('Failed booting core (' + selected.dir + '): ' + err.stack);
    if (selected.isOta) {
      try { fs.rmSync(otaDir, { recursive: true, force: true }); } catch {}
      const fallback = { dir: path.join(__dirname, 'bundle'), bundleVersion: BUILT_IN_BUNDLE_VERSION, isOta: false };
      const core = require(path.join(fallback.dir, 'app-core.js'));
      core.start(buildContext(fallback));
    } else {
      throw err;
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
