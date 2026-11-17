const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodeNet = require('net');
const { spawnSync, spawn } = require('child_process');

exports.start = function startBlackFoxCore(ctx) {
  const {
    app,
    BrowserWindow,
    ipcMain,
    shell,
    net,
    session,
    AdmZip,
    bundleDir,
    assetsDir,
    configPath,
    otaDir,
    builtInExeVersion = "2.0.0",
    activeBundleVersion = 1,
    getSafeGraphicsMode,
    setSafeGraphicsMode,
    getDiagnostics,
  } = ctx;

  const appConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const rawAppData = app.getPath('appData');
  const isNonAsciiPath = (p) => /[^\x00-\x7F]/.test(String(p || ''));
  // NeoForge BootstrapLauncher crashes if gameDir contains Cyrillic/non-ASCII characters
  const defaultGameDir = isNonAsciiPath(rawAppData)
    ? path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'BlackFox')
    : path.join(rawAppData, '.blackfox');
  const settingsPath = path.join(app.getPath('userData'), 'blackfox-settings.json');

  let mainWindow = null;
  let pendingLauncherUpdate = null;

  // Player-editable Minecraft settings: seeded only on first install, never overwritten once local copy exists
  const PLAYER_SETTINGS_EXACT_PATHS = new Set([
    'options.txt',
    'optionsof.txt',
    'optionsshaders.txt',
    'servers.dat',
    'servers.dat_old',
    'command_history.txt',
    'realms_persistence.json',
    'config/sodium-options.json',
    'config/sodium-extra-options.json',
    'config/embeddium-options.json',
    'config/embeddium-extra-options.json',
    'config/iris.properties',
    'config/oculus.properties',
    'config/xaerominimap.txt',
    'config/xaeroworldmap.txt',
    'config/xaeropatreon.txt',
    'config/jade/jade.json',
    'config/jei/jei-client.ini',
    'config/entityculling.json',
    'config/immediatelyfast.json',
  ]);
  const PLAYER_SETTINGS_PREFIXES = ['saves/', 'screenshots/', 'xaero/', 'journeymap/'];

  function isPlayerEditableFile(relPath) {
    const clean = String(relPath || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .toLowerCase();
    if (PLAYER_SETTINGS_EXACT_PATHS.has(clean)) return true;
    return PLAYER_SETTINGS_PREFIXES.some((prefix) => clean.startsWith(prefix));
  }

  // Zero-dependency Discord Rich Presence over Windows Named Pipe (\\?\pipe\discord-ipc-0..9)
  const launcherStartedAt = Date.now();
  let activeDiscordClientId = /^\d{17,22}$/.test(String(appConfig.discordClientId || '').trim())
    ? String(appConfig.discordClientId).trim()
    : '';
  let discordSocket = null;
  let discordReady = false;
  let discordConnecting = false;
  let discordRxBuffer = Buffer.alloc(0);
  let discordActivity = {
    details: `В лаунчере ${appConfig.serverName || 'BlackFox'}`,
    state: `Minecraft ${appConfig.minecraftVersion || '1.21.1'} · NeoForge`,
    startTimestamp: launcherStartedAt,
  };

  function encodeDiscordPacket(op, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
  }

  function makeDiscordNonce() {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
  }

  function sendDiscordActivity() {
    if (!discordSocket || !discordReady || discordSocket.destroyed) return;
    const settings = loadSettings();
    if (settings.discordRpcEnabled === false) return;
    try {
      const activity = {
        details: discordActivity.details,
        state: discordActivity.state,
        instance: false,
      };
      if (discordActivity.startTimestamp) {
        activity.timestamps = { start: Math.floor(discordActivity.startTimestamp / 1000) };
      }
      discordSocket.write(
        encodeDiscordPacket(1, {
          cmd: 'SET_ACTIVITY',
          args: { pid: process.pid, activity },
          nonce: makeDiscordNonce(),
        })
      );
    } catch {}
  }

  function closeDiscordPipe(clearFirst = true) {
    const sock = discordSocket;
    const wasReady = discordReady;
    discordSocket = null;
    discordReady = false;
    discordConnecting = false;
    discordRxBuffer = Buffer.alloc(0);
    if (!sock || sock.destroyed) return;
    try {
      if (clearFirst && wasReady) {
        sock.write(
          encodeDiscordPacket(1, {
            cmd: 'SET_ACTIVITY',
            args: { pid: process.pid, activity: null },
            nonce: makeDiscordNonce(),
          })
        );
      }
    } catch {}
    try {
      sock.end();
      setTimeout(() => {
        if (!sock.destroyed) sock.destroy();
      }, 150);
    } catch {}
  }

  function connectDiscordPipe() {
    const settings = loadSettings();
    if (settings.discordRpcEnabled === false) {
      if (discordSocket) closeDiscordPipe(true);
      return;
    }
    if (!/^\d{17,22}$/.test(activeDiscordClientId)) return;
    if (discordSocket || discordConnecting) return;

    discordConnecting = true;
    const tryPipe = (idx) => {
      const latestSettings = loadSettings();
      if (latestSettings.discordRpcEnabled === false || idx > 9) {
        discordConnecting = false;
        return;
      }
      const pipePath = ['', '', '?', 'pipe', `discord-ipc-${idx}`].join('\\');
      let connected = false;
      const sock = nodeNet.createConnection(pipePath);

      sock.on('connect', () => {
        connected = true;
        discordConnecting = false;
        discordSocket = sock;
        discordReady = false;
        discordRxBuffer = Buffer.alloc(0);
        try {
          sock.write(encodeDiscordPacket(0, { v: 1, client_id: activeDiscordClientId }));
        } catch {
          closeDiscordPipe(false);
        }
      });

      sock.on('data', (chunk) => {
        discordRxBuffer = Buffer.concat([discordRxBuffer, chunk]);
        while (discordRxBuffer.length >= 8) {
          const op = discordRxBuffer.readInt32LE(0);
          const len = discordRxBuffer.readInt32LE(4);
          if (len < 0 || len > 1024 * 1024 || discordRxBuffer.length < 8 + len) break;
          const payloadBuf = discordRxBuffer.subarray(8, 8 + len);
          discordRxBuffer = discordRxBuffer.subarray(8 + len);
          try {
            const msg = JSON.parse(payloadBuf.toString('utf8'));
            if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
              discordReady = true;
              sendDiscordActivity();
            } else if (op === 2 || msg.evt === 'ERROR') {
              closeDiscordPipe(false);
            }
          } catch {}
        }
      });

      sock.on('error', () => {
        if (!connected) {
          try { sock.destroy(); } catch {}
          tryPipe(idx + 1);
        } else if (discordSocket === sock) {
          closeDiscordPipe(false);
        }
      });

      sock.on('close', () => {
        if (discordSocket === sock) {
          discordSocket = null;
          discordReady = false;
          discordRxBuffer = Buffer.alloc(0);
        }
      });
    };

    tryPipe(0);
  }

  function updateDiscordClientId(nextId) {
    const clean = String(nextId || '').trim();
    if (!/^\d{17,22}$/.test(clean) || clean === activeDiscordClientId) return;
    activeDiscordClientId = clean;
    if (discordSocket) {
      closeDiscordPipe(false);
    }
    connectDiscordPipe();
  }

  function setDiscordPresence(details, state, startTimestamp) {
    discordActivity = {
      details: details || `В лаунчере ${appConfig.serverName || 'BlackFox'}`,
      state: state || `Minecraft ${appConfig.minecraftVersion || '1.21.1'} · NeoForge`,
      startTimestamp: typeof startTimestamp === 'number' ? startTimestamp : launcherStartedAt,
    };
    if (discordReady) {
      sendDiscordActivity();
    } else {
      connectDiscordPipe();
    }
  }

  function sendLog(text) {
    if (!text) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launcher-log', String(text));
    }
  }

  function sendProgress(payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-progress', payload);
    }
  }

  function loadSettings() {
    const defaults = {
      nickname: 'BlackFoxPlayer',
      ramMb: appConfig.defaultRamMb || 4096,
      gameDir: defaultGameDir,
      serverUrl: appConfig.serverUrl,
      vanillaTestMode: false,
      discordRpcEnabled: true,
    };
    try {
      if (fs.existsSync(settingsPath)) {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const merged = { ...defaults, ...parsed };
        if (!merged.gameDir || isNonAsciiPath(merged.gameDir)) {
          merged.gameDir = defaultGameDir;
        }
        return merged;
      }
    } catch {}
    return defaults;
  }

  function saveSettings(next) {
    const current = loadSettings();
    const merged = { ...current, ...next };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  function sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  function normalizeServerUrl(rawUrl) {
    let clean = String(rawUrl || '').trim().replace(/\/+$/, '');
    if (!clean || clean.includes('ai.studio/apps/')) {
      clean = appConfig.fallbackServerUrl || appConfig.serverUrl;
    }
    return clean.replace(/\/+$/, '');
  }

  function compareSemver(a, b) {
    const pa = String(a || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  function passAiStudioCookieGate(baseUrl) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const targetUrl = `${baseUrl}/api/manifest`;
      const authWin = new BrowserWindow({
        width: 520,
        height: 680,
        show: false,
        title: 'BlackFox — Подключение к серверу',
        parent: mainWindow || undefined,
        webPreferences: {
          session: session.defaultSession,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (!authWin.isDestroyed()) authWin.close();
          reject(new Error('Превышено время ожидания проверки cookies сервера.'));
        }
      }, 60000);

      const checkUrl = (navUrl) => {
        if (settled || !navUrl) return;
        if (navUrl.includes('accounts.google.com')) {
          if (!authWin.isDestroyed() && !authWin.isVisible()) {
            authWin.show();
          }
          return;
        }
        if (navUrl.startsWith(baseUrl) && navUrl.includes('/api/manifest') && !navUrl.includes('__cookie_check')) {
          settled = true;
          clearTimeout(timeout);
          if (!authWin.isDestroyed()) authWin.close();
          resolve(true);
        }
      };

      authWin.webContents.on('did-navigate', (_, navUrl) => checkUrl(navUrl));
      authWin.webContents.on('did-finish-load', () => {
        if (!authWin.isDestroyed()) {
          checkUrl(authWin.webContents.getURL());
        }
      });
      authWin.on('closed', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Окно авторизации закрыто до завершения проверки.'));
        }
      });

      authWin.loadURL(targetUrl).catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          if (!authWin.isDestroyed()) authWin.close();
          reject(err);
        }
      });
    });
  }

  async function sessionFetch(url, timeoutMs = 20000, extraHeaders = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await net.fetch(url, {
        session: session.defaultSession,
        credentials: 'include',
        headers: extraHeaders,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function tryFetchManifestUrl(url) {
    const clean = normalizeServerUrl(url);
    let res = await sessionFetch(`${clean}/api/manifest`, 25000, { Accept: 'application/json' });
    let ct = (res.headers.get('content-type') || '').toLowerCase();

    if (!ct.includes('application/json')) {
      sendLog(`Сервер вернул страницу проверки для ${clean}, открываю cookie-сессию...`);
      await passAiStudioCookieGate(clean);
      res = await sessionFetch(`${clean}/api/manifest`, 25000, { Accept: 'application/json' });
      ct = (res.headers.get('content-type') || '').toLowerCase();
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} от ${clean}`);
    }
    if (!ct.includes('application/json')) {
      throw new Error('Сервер закрыт авторизацией Google. Переключите URL сервера на свой VPS.');
    }
    return { manifest: await res.json(), usedUrl: clean };
  }

  async function fetchManifest(serverUrl) {
    const target = normalizeServerUrl(serverUrl);
    const { manifest, usedUrl } = await tryFetchManifestUrl(target);
    if (usedUrl !== serverUrl) {
      saveSettings({ serverUrl: usedUrl });
      sendLog(`Подключено к серверу: ${usedUrl}`);
    }
    return { manifest, usedUrl };
  }

  async function fetchJsonWithMirrors(urls, timeoutMs = 20000) {
    const errors = [];
    for (const url of urls) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await sessionFetch(url, timeoutMs, { Accept: 'application/json' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          errors.push(`${url} (#${attempt}): ${msg}`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
    throw new Error(`Не удалось получить JSON ни с одного зеркала: ${errors.slice(0, 3).join(' | ')}`);
  }

  async function downloadToFileWithMirrors(urls, destPath, timeoutMs = 45000, options = {}) {
    const list = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const partPath = destPath + '.part';
    const errors = [];

    for (let uIdx = 0; uIdx < list.length; uIdx++) {
      const url = list[uIdx];
      const maxAttempts = list.length > 1 ? 2 : 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await sessionFetch(url, timeoutMs);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const arrayBuffer = await res.arrayBuffer();
          const buf = Buffer.from(arrayBuffer);
          if (buf.length === 0) {
            throw new Error('Пустой ответ сервера (0 байт)');
          }
          if (options.rejectHtml) {
            const head = buf.subarray(0, 64).toString('utf8').trim().toLowerCase();
            if (head.startsWith('<!doctype') || head.startsWith('<html')) {
              throw new Error('Получена HTML-страница вместо файла');
            }
          }
          if (options.expectedSha256) {
            const actualHash = crypto.createHash('sha256').update(buf).digest('hex');
            if (actualHash !== options.expectedSha256) {
              throw new Error(`Несовпадение SHA-256 (${actualHash.slice(0, 8)})`);
            }
          }
          fs.writeFileSync(partPath, buf);
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          fs.renameSync(partPath, destPath);
          return url;
        } catch (err) {
          if (fs.existsSync(partPath)) {
            try { fs.unlinkSync(partPath); } catch {}
          }
          const msg = err && err.message ? err.message : String(err);
          errors.push(`${url} (#${attempt}): ${msg}`);
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 600 * attempt));
          }
        }
      }
      if (uIdx < list.length - 1) {
        sendLog(`[Зеркало] Переключаюсь на резервный источник для ${path.basename(destPath)}...`);
      }
    }

    throw new Error(`Ошибка загрузки ${path.basename(destPath)}: ${errors[errors.length - 1] || 'таймаут'}`);
  }

  function rewriteMojangUrlToMirrors(url) {
    if (!url) return [];
    const out = [url];
    try {
      const parsed = new URL(url);
      if (
        parsed.hostname === 'piston-meta.mojang.com' ||
        parsed.hostname === 'piston-data.mojang.com' ||
        parsed.hostname === 'launchermeta.mojang.com' ||
        parsed.hostname === 'launcher.mojang.com'
      ) {
        out.push(`https://bmclapi2.bangbang93.com${parsed.pathname}${parsed.search}`);
      } else if (parsed.hostname === 'libraries.minecraft.net') {
        out.push(`https://bmclapi2.bangbang93.com/maven${parsed.pathname}`);
      } else if (parsed.hostname === 'resources.download.minecraft.net') {
        out.push(`https://bmclapi2.bangbang93.com/assets${parsed.pathname}`);
      }
    } catch {}
    return Array.from(new Set(out));
  }

  function buildMavenMirrorUrls(relPath, primaryUrl, serverUrl) {
    const cleanRel = String(relPath || '').replace(/^\/+/, '');
    const urls = [];
    if (primaryUrl) {
      urls.push(primaryUrl);
      try {
        const parsed = new URL(primaryUrl);
        if (
          parsed.hostname === 'maven.neoforged.net' ||
          parsed.hostname === 'libraries.minecraft.net' ||
          parsed.hostname === 'maven.minecraftforge.net'
        ) {
          urls.push(`https://bmclapi2.bangbang93.com/maven/${cleanRel}`);
        }
      } catch {}
    }
    if (cleanRel) {
      urls.push(`https://maven.neoforged.net/releases/${cleanRel}`);
      urls.push(`https://bmclapi2.bangbang93.com/maven/${cleanRel}`);
      urls.push(`https://repo1.maven.org/maven2/${cleanRel}`);
      if (serverUrl) {
        urls.push(`${serverUrl}/api/mirror/maven?path=${encodeURIComponent(cleanRel)}`);
      }
    }
    return Array.from(new Set(urls));
  }

  function walkModsDir(dir, baseDir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkModsDir(full, baseDir, out);
      } else {
        out.push(path.relative(baseDir, full).replace(/\\/g, '/'));
      }
    }
    return out;
  }

  async function checkModpackState() {
    const settings = loadSettings();
    const gameDir = settings.gameDir || defaultGameDir;
    let { manifest, usedUrl } = await fetchManifest(settings.serverUrl || appConfig.serverUrl);

    let waitAttempts = 0;
    while (manifest && manifest.restoring && waitAttempts < 30) {
      waitAttempts++;
      const label = manifest.restoreStage || 'Сервер восстанавливает сборку после сна...';
      sendLog(`[Ожидание сервера] ${label}`);
      sendProgress({ phase: 'sync', label, percent: 5 });
      await new Promise((r) => setTimeout(r, 3000));
      const next = await fetchManifest(usedUrl || settings.serverUrl || appConfig.serverUrl);
      manifest = next.manifest;
      usedUrl = next.usedUrl;
    }

    if (manifest && typeof manifest.discordClientId === 'string') {
      updateDiscordClientId(manifest.discordClientId);
    }

    const missingOrChanged = [];
    for (const file of manifest.files) {
      const localPath = path.join(gameDir, file.path);
      if (!fs.existsSync(localPath)) {
        missingOrChanged.push(file);
        continue;
      }
      // Never overwrite player's local Minecraft settings once created
      if (isPlayerEditableFile(file.path)) {
        continue;
      }
      const stat = fs.statSync(localPath);
      if (stat.size !== file.size) {
        missingOrChanged.push(file);
        continue;
      }
      const localHash = await sha256File(localPath);
      if (localHash !== file.sha256) {
        missingOrChanged.push(file);
      }
    }

    const serverModPaths = new Set(
      manifest.files.filter((f) => f.path.startsWith('mods/')).map((f) => f.path)
    );
    const localMods = walkModsDir(path.join(gameDir, 'mods'), gameDir);
    const obsoleteMods =
      serverModPaths.size > 0 ? localMods.filter((rel) => !serverModPaths.has(rel)) : [];

    const updateRequired = missingOrChanged.length > 0 || obsoleteMods.length > 0;
    return {
      status: updateRequired ? 'update_required' : 'up_to_date',
      serverUrl: usedUrl,
      manifest,
      missingOrChanged,
      obsoleteMods,
      bytesToDownload: missingOrChanged.reduce((sum, f) => sum + f.size, 0),
    };
  }

  async function checkLauncherSelfUpdate() {
    const settings = loadSettings();
    const serverUrl = normalizeServerUrl(settings.serverUrl || appConfig.serverUrl);
    try {
      const res = await sessionFetch(`${serverUrl}/api/launcher/ota-manifest`, 10000, {
        Accept: 'application/json',
      });
      if (!res.ok) return { available: false };
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) return { available: false };
      const remote = await res.json();

      if (remote.exeVersion && remote.exeUrl && compareSemver(remote.exeVersion, builtInExeVersion) > 0) {
        pendingLauncherUpdate = {
          kind: 'exe',
          serverUrl,
          targetVersion: remote.exeVersion,
          downloadUrl: remote.exeUrl,
          notes: `Доступна новая версия .exe (${remote.exeVersion})`,
        };
        return {
          available: true,
          kind: 'exe',
          targetVersion: remote.exeVersion,
          currentVersion: builtInExeVersion,
          notes: pendingLauncherUpdate.notes,
        };
      }

      const remoteBundle = Number(remote.bundleVersion || 1);
      if (remoteBundle > Number(activeBundleVersion || 1) && Array.isArray(remote.files) && remote.files.length > 0) {
        pendingLauncherUpdate = {
          kind: 'ota',
          serverUrl,
          bundleVersion: remoteBundle,
          files: remote.files,
          notes: `Быстрый патч лаунчера #${remoteBundle}`,
        };
        return {
          available: true,
          kind: 'ota',
          targetVersion: String(remoteBundle),
          currentVersion: String(activeBundleVersion),
          notes: pendingLauncherUpdate.notes,
        };
      }

      pendingLauncherUpdate = null;
      return { available: false };
    } catch (err) {
      return { available: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async function applyLauncherSelfUpdate() {
    if (!pendingLauncherUpdate) {
      await checkLauncherSelfUpdate();
    }
    if (!pendingLauncherUpdate) {
      return { updated: false, reason: 'Актуальная версия уже установлена.' };
    }

    if (pendingLauncherUpdate.kind === 'ota') {
      const { serverUrl, bundleVersion, files } = pendingLauncherUpdate;
      const stagingDir = path.join(path.dirname(otaDir), 'ota-staging');
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.mkdirSync(stagingDir, { recursive: true });

      sendLog(`Скачиваю обновление лаунчера (патч #${bundleVersion})...`);
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        sendProgress({
          phase: 'self-update',
          label: `Обновление лаунчера: ${f.path} (${i + 1}/${files.length})`,
          percent: Math.round(((i + 1) / files.length) * 90),
        });
        const dest = path.join(stagingDir, f.path);
        const url = `${serverUrl}/api/launcher/ota-file?path=${encodeURIComponent(f.path)}`;
        await downloadToFileWithMirrors([url], dest, 30000, {
          expectedSha256: f.sha256,
        });
      }

      fs.writeFileSync(
        path.join(stagingDir, 'ota-state.json'),
        JSON.stringify(
          {
            bundleVersion,
            builtInExeVersion,
            files,
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf8'
      );

      if (fs.existsSync(otaDir)) fs.rmSync(otaDir, { recursive: true, force: true });
      fs.renameSync(stagingDir, otaDir);
      sendLog(`Патч #${bundleVersion} установлен. Перезапуск лаунчера...`);
      app.relaunch();
      setTimeout(() => app.exit(0), 250);
      return { updated: true, kind: 'ota', relaunching: true };
    }

    // Full .exe self-update
    const { downloadUrl, targetVersion } = pendingLauncherUpdate;
    const tempExe = path.join(app.getPath('temp'), `BlackFox-Launcher-${targetVersion}-Update.exe`);
    sendLog(`Скачиваю новый .exe (${targetVersion}) с ${downloadUrl}...`);
    sendProgress({
      phase: 'self-update',
      label: `Загрузка новой версии лаунчера ${targetVersion}...`,
      percent: 40,
    });
    await downloadToFileWithMirrors([downloadUrl], tempExe, 180000, { rejectHtml: true });

    const header = Buffer.alloc(2);
    const fd = fs.openSync(tempExe, 'r');
    fs.readSync(fd, header, 0, 2, 0);
    fs.closeSync(fd);
    if (header.toString('ascii') !== 'MZ') {
      fs.unlinkSync(tempExe);
      throw new Error('Скачанный файл не является корректным Windows .exe.');
    }

    const portableExePath = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portableExePath && fs.existsSync(portableExePath)) {
      const cmdPath = path.join(app.getPath('temp'), 'blackfox-update.cmd');
      const bat = [
        '@echo off',
        'ping 127.0.0.1 -n 3 > nul',
        `:retry`,
        `copy /y "${tempExe}" "${portableExePath}" > nul 2>&1`,
        'if errorlevel 1 (',
        '  ping 127.0.0.1 -n 2 > nul',
        '  goto retry',
        ')',
        `del /f /q "${tempExe}" > nul 2>&1`,
        `start "" "${portableExePath}"`,
        `del /f /q "%~f0" > nul 2>&1`,
      ].join('\r\n');
      fs.writeFileSync(cmdPath, bat, 'utf8');
      spawn('cmd.exe', ['/c', cmdPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      app.exit(0);
      return { updated: true, kind: 'exe', relaunching: true };
    }

    if (!process.defaultApp && process.execPath.toLowerCase().endsWith('.exe')) {
      spawn(tempExe, ['/S'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      app.exit(0);
      return { updated: true, kind: 'exe', relaunching: true };
    }

    shell.showItemInFolder(tempExe);
    return {
      updated: true,
      kind: 'exe',
      relaunching: false,
      downloadedPath: tempExe,
    };
  }

  function findSystemJava21(gameDir) {
    const bundledJava = path.join(gameDir, 'runtime', 'jre-21', 'bin', 'java.exe');
    if (fs.existsSync(bundledJava)) return bundledJava;

    try {
      const res = spawnSync('java', ['-version'], { encoding: 'utf8' });
      const combined = `${res.stderr || ''}\n${res.stdout || ''}`;
      const match = combined.match(/version "(\d+)/);
      if (match && Number(match[1]) >= 21) {
        return 'java';
      }
    } catch {}
    return null;
  }

  async function ensureJava21(gameDir, serverUrl) {
    const existing = findSystemJava21(gameDir);
    if (existing) {
      sendLog(`Используется Java 21: ${existing}`);
      return existing;
    }

    sendLog('Java 21 не найдена. Скачиваю Eclipse Temurin JRE 21 для Windows x64...');
    sendProgress({ phase: 'java', label: 'Загрузка Java 21...', percent: 15 });

    const runtimeDir = path.join(gameDir, 'runtime');
    const zipPath = path.join(runtimeDir, 'jre21.zip');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const javaUrls = [
      'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse',
      serverUrl ? `${serverUrl}/api/mirror/java21` : null,
    ].filter(Boolean);
    await downloadToFileWithMirrors(javaUrls, zipPath, 120000, { rejectHtml: true });

    sendProgress({ phase: 'java', label: 'Распаковка Java 21...', percent: 60 });
    const zip = new AdmZip(zipPath);
    const extractTemp = path.join(runtimeDir, '_extract');
    if (fs.existsSync(extractTemp)) fs.rmSync(extractTemp, { recursive: true, force: true });
    zip.extractAllTo(extractTemp, true);

    const subdirs = fs.readdirSync(extractTemp);
    const targetDir = path.join(runtimeDir, 'jre-21');
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(path.join(extractTemp, subdirs[0]), targetDir);
    fs.rmSync(extractTemp, { recursive: true, force: true });
    fs.unlinkSync(zipPath);

    sendLog('Java 21 успешно установлена.');
    return path.join(targetDir, 'bin', 'java.exe');
  }

  function mavenCoordsToPath(coords) {
    const parts = coords.split(':');
    const group = parts[0].replace(/\./g, '/');
    const artifact = parts[1];
    const verAndExt = parts[2].split('@');
    const version = verAndExt[0];
    const ext = verAndExt[1] || (parts[3] && parts[3].includes('@') ? parts[3].split('@')[1] : 'jar');
    const classifier = parts[3] ? parts[3].split('@')[0] : '';
    const fileName = classifier ? `${artifact}-${version}-${classifier}.${ext}` : `${artifact}-${version}.${ext}`;
    return `${group}/${artifact}/${version}/${fileName}`;
  }

  async function downloadPool(tasks, concurrency, labelPrefix) {
    let idx = 0;
    let done = 0;
    const total = tasks.length;
    if (total === 0) return;

    async function worker() {
      while (idx < total) {
        const current = tasks[idx++];
        try {
          const urls = Array.isArray(current.urls) ? current.urls : [current.url];
          await downloadToFileWithMirrors(urls, current.dest, 45000, { rejectHtml: true });
        } catch (err) {
          if (current.optional) {
            sendLog(`[Инфо] Пропущен генеративный артефакт ${path.basename(current.dest)}`);
          } else {
            throw err;
          }
        }
        done++;
        if (done % 10 === 0 || done === total) {
          sendProgress({
            phase: 'minecraft',
            label: `${labelPrefix}: ${done}/${total}`,
            percent: Math.round((done / total) * 100),
          });
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, total); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  async function preCacheNeoForgeInstallerLibs(installerPath, gameDir, serverUrl) {
    try {
      const zip = new AdmZip(installerPath);
      const readZipJson = (name) => {
        const entry = zip.getEntry(name);
        if (!entry) return null;
        return JSON.parse(entry.getData().toString('utf8'));
      };
      const installProfile = readZipJson('install_profile.json');
      const versionJson = readZipJson('version.json');
      const combinedLibs = [
        ...((installProfile && installProfile.libraries) || []),
        ...((versionJson && versionJson.libraries) || []),
      ];

      const tasks = [];
      const seenDest = new Set();
      for (const lib of combinedLibs) {
        const artifact = lib && lib.downloads && lib.downloads.artifact;
        let relPath = artifact && artifact.path;
        let primaryUrl = artifact && artifact.url;
        if (!relPath && lib && lib.name) {
          relPath = mavenCoordsToPath(lib.name);
        }
        if (!relPath) continue;
        // Skip local installer-generated artifacts (have no URL)
        if (!primaryUrl) continue;

        const dest = path.join(gameDir, 'libraries', relPath);
        if (seenDest.has(dest) || fs.existsSync(dest)) continue;
        seenDest.add(dest);

        tasks.push({
          urls: buildMavenMirrorUrls(relPath, primaryUrl, serverUrl),
          dest,
          optional: false,
        });
      }

      if (tasks.length > 0) {
        sendLog(`Предзагрузка ${tasks.length} библиотек NeoForge через зеркала...`);
        await downloadPool(tasks, 8, 'Библиотеки NeoForge');
      }
    } catch (err) {
      sendLog(`[Предупреждение] Предзагрузка библиотек NeoForge: ${err.message}`);
    }
  }

  async function ensureNeoForge(gameDir, javaExe, mcVersion, neoforgeVersion, serverUrl) {
    const versionId = `neoforge-${neoforgeVersion}`;
    const versionJson = path.join(gameDir, 'versions', versionId, `${versionId}.json`);
    if (fs.existsSync(versionJson)) {
      return versionId;
    }

    sendLog(`Устанавливаю NeoForge ${neoforgeVersion} для Minecraft ${mcVersion}...`);
    sendProgress({ phase: 'neoforge', label: `Загрузка NeoForge ${neoforgeVersion}...`, percent: 30 });

    fs.mkdirSync(gameDir, { recursive: true });
    const profilesPath = path.join(gameDir, 'launcher_profiles.json');
    if (!fs.existsSync(profilesPath)) {
      fs.writeFileSync(
        profilesPath,
        JSON.stringify({ profiles: {}, selectedProfile: '(Default)', clientToken: 'blackfox' }, null, 2)
      );
    }

    const installerPath = path.join(gameDir, `neoforge-${neoforgeVersion}-installer.jar`);
    const installerUrls = [
      `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoforgeVersion}/neoforge-${neoforgeVersion}-installer.jar`,
      `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${neoforgeVersion}/neoforge-${neoforgeVersion}-installer.jar`,
      serverUrl ? `${serverUrl}/api/mirror/neoforge/${encodeURIComponent(neoforgeVersion)}/installer` : null,
    ].filter(Boolean);

    await downloadToFileWithMirrors(installerUrls, installerPath, 90000, { rejectHtml: true });
    await preCacheNeoForgeInstallerLibs(installerPath, gameDir, serverUrl);

    sendProgress({ phase: 'neoforge', label: 'Установка NeoForge в клиент...', percent: 70 });
    await new Promise((resolve, reject) => {
      const proc = spawn(javaExe, ['-jar', installerPath, '--installClient', gameDir], { cwd: gameDir });
      proc.stdout.on('data', (d) => sendLog(d.toString().trim()));
      proc.stderr.on('data', (d) => sendLog(d.toString().trim()));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Установщик NeoForge завершился с кодом ${code}`));
      });
    });

    if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath);
    sendLog(`NeoForge ${neoforgeVersion} установлен.`);
    return versionId;
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1080,
      height: 670,
      minWidth: 960,
      minHeight: 600,
      frame: false,
      backgroundColor: '#141619',
      webPreferences: {
        preload: path.join(bundleDir, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    mainWindow.loadFile(path.join(bundleDir, 'renderer', 'index.html'), {
      query: { assetsDir },
    });
  }

  createWindow();

  const discordRetryTimer = setInterval(() => {
    connectDiscordPipe();
  }, 20000);
  app.on('before-quit', () => {
    clearInterval(discordRetryTimer);
    closeDiscordPipe(true);
  });
  connectDiscordPipe();

  ipcMain.on('window-control', (_, action) => {
    if (!mainWindow) return;
    if (action === 'minimize') mainWindow.minimize();
    if (action === 'close') mainWindow.close();
  });

  ipcMain.handle('get-config', () => ({
    ...appConfig,
    builtInExeVersion,
    activeBundleVersion,
    safeGraphicsMode: getSafeGraphicsMode(),
  }));

  ipcMain.handle('get-settings', () => loadSettings());
  ipcMain.handle('save-settings', (_, next) => {
    const saved = saveSettings(next);
    if (saved.discordRpcEnabled === false) {
      closeDiscordPipe(true);
    } else {
      connectDiscordPipe();
      sendDiscordActivity();
    }
    return saved;
  });
  ipcMain.handle('get-diagnostics', () => getDiagnostics());
  ipcMain.handle('set-safe-graphics', (_, enabled) => {
    setSafeGraphicsMode(Boolean(enabled));
    app.relaunch();
    setTimeout(() => app.exit(0), 200);
    return { relaunching: true };
  });

  ipcMain.handle('clear-game-cache', () => {
    const { gameDir } = loadSettings();
    const targets = [
      path.join(gameDir, 'tmp'),
      path.join(gameDir, 'versions', `neoforge-${appConfig.neoforgeVersion || '21.1.266'}`),
    ];
    for (const t of targets) {
      if (fs.existsSync(t)) fs.rmSync(t, { recursive: true, force: true });
    }
    sendLog('Кэш NeoForge и временные файлы очищены. При следующем запуске они скачаются заново через зеркала.');
    return { ok: true };
  });

  ipcMain.handle('check-launcher-update', () => checkLauncherSelfUpdate());
  ipcMain.handle('apply-launcher-update', () => applyLauncherSelfUpdate());

  ipcMain.handle('open-game-folder', () => {
    const { gameDir } = loadSettings();
    fs.mkdirSync(gameDir, { recursive: true });
    shell.openPath(gameDir);
  });

  ipcMain.handle('check-updates', async () => {
    return checkModpackState();
  });

  ipcMain.handle('sync-modpack', async () => {
    const state = await checkModpackState();
    const settings = loadSettings();
    const gameDir = settings.gameDir || defaultGameDir;
    const serverUrl = normalizeServerUrl(state.serverUrl || settings.serverUrl || appConfig.serverUrl);

    const totalFiles = state.missingOrChanged.length;
    const totalBytes = Math.max(1, state.bytesToDownload);
    let downloadedBytes = 0;
    let completedFiles = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < totalFiles) {
        const idx = cursor++;
        const file = state.missingOrChanged[idx];
        const destPath = path.join(gameDir, file.path);
        const fileUrl = `${serverUrl}/api/download?path=${encodeURIComponent(file.path)}`;
        await downloadToFileWithMirrors([fileUrl], destPath, 60000);
        completedFiles++;
        downloadedBytes += file.size;
        if (completedFiles === totalFiles || completedFiles % 5 === 0) {
          sendProgress({
            phase: 'sync',
            label: `Загрузка ${file.name || file.path} (${completedFiles}/${totalFiles})`,
            percent: Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)),
          });
        }
      }
    }

    try {
      if (totalFiles > 0) {
        setDiscordPresence(
          `Обновление сборки ${appConfig.serverName || 'BlackFox'}`,
          `Загрузка файлов (${totalFiles} шт.)...`,
          Date.now()
        );
        sendLog(`Начинаю загрузку ${totalFiles} файлов сборки с ${serverUrl}...`);
        const concurrency = Math.min(8, totalFiles);
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        sendLog(`Загружено файлов: ${completedFiles}.`);
      }

      for (const rel of state.obsoleteMods) {
        const target = path.join(gameDir, rel);
        if (fs.existsSync(target)) {
          fs.unlinkSync(target);
          sendLog(`Удалён устаревший мод: ${rel}`);
        }
      }
    } finally {
      setDiscordPresence(
        `В лаунчере ${appConfig.serverName || 'BlackFox'}`,
        `Minecraft ${state.manifest.minecraftVersion || appConfig.minecraftVersion || '1.21.1'} · NeoForge`,
        launcherStartedAt
      );
    }

    sendProgress({ phase: 'done', label: 'Все обновления установлены', percent: 100 });
    return checkModpackState();
  });

  function offlineUuid(name) {
    const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function matchesRules(rules) {
    if (!Array.isArray(rules) || rules.length === 0) return true;
    let allowed = false;
    for (const rule of rules) {
      if (rule.features && Object.keys(rule.features).length > 0) {
        continue;
      }
      let osMatch = true;
      if (rule.os && rule.os.name) {
        osMatch = rule.os.name === 'windows';
      }
      if (osMatch) {
        allowed = rule.action === 'allow';
      }
    }
    return allowed;
  }

  async function ensureVanilla1211(gameDir, mcVersion) {
    const verDir = path.join(gameDir, 'versions', mcVersion);
    const verJsonPath = path.join(verDir, `${mcVersion}.json`);
    const verJarPath = path.join(verDir, `${mcVersion}.jar`);
    const nativesDir = path.join(verDir, 'natives');
    fs.mkdirSync(verDir, { recursive: true });
    fs.mkdirSync(nativesDir, { recursive: true });

    let verJson;
    if (fs.existsSync(verJsonPath)) {
      verJson = JSON.parse(fs.readFileSync(verJsonPath, 'utf8'));
    } else {
      sendLog(`Загрузка манифеста Mojang для Minecraft ${mcVersion}...`);
      sendProgress({ phase: 'minecraft', label: `Получение версии ${mcVersion}...`, percent: 5 });
      const manifestData = await fetchJsonWithMirrors([
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
        'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
      ]);
      const entry = manifestData.versions.find((v) => v.id === mcVersion);
      if (!entry) throw new Error(`Версия ${mcVersion} не найдена в манифесте Mojang.`);
      verJson = await fetchJsonWithMirrors(rewriteMojangUrlToMirrors(entry.url));
      fs.writeFileSync(verJsonPath, JSON.stringify(verJson, null, 2), 'utf8');
    }

    if (!fs.existsSync(verJarPath)) {
      sendLog(`Скачиваю клиент Minecraft ${mcVersion}.jar...`);
      sendProgress({ phase: 'minecraft', label: `Загрузка ${mcVersion}.jar...`, percent: 12 });
      await downloadToFileWithMirrors(
        rewriteMojangUrlToMirrors(verJson.downloads.client.url),
        verJarPath,
        90000,
        { rejectHtml: true }
      );
    }

    const libTasks = [];
    for (const lib of verJson.libraries || []) {
      if (!matchesRules(lib.rules)) continue;
      if (lib.downloads && lib.downloads.artifact) {
        const dest = path.join(gameDir, 'libraries', lib.downloads.artifact.path);
        if (!fs.existsSync(dest)) {
          libTasks.push({
            urls: rewriteMojangUrlToMirrors(lib.downloads.artifact.url),
            dest,
          });
        }
      }
      if (lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers['natives-windows']) {
        const nat = lib.downloads.classifiers['natives-windows'];
        const dest = path.join(gameDir, 'libraries', nat.path);
        if (!fs.existsSync(dest)) {
          libTasks.push({
            urls: rewriteMojangUrlToMirrors(nat.url),
            dest,
          });
        }
      }
    }
    if (libTasks.length > 0) {
      sendLog(`Загрузка библиотек Minecraft (${libTasks.length} шт.)...`);
      await downloadPool(libTasks, 10, 'Загрузка библиотек');
    }

    if (verJson.assetIndex) {
      const idxPath = path.join(gameDir, 'assets', 'indexes', `${verJson.assetIndex.id}.json`);
      if (!fs.existsSync(idxPath)) {
        await downloadToFileWithMirrors(
          rewriteMojangUrlToMirrors(verJson.assetIndex.url),
          idxPath,
          30000,
          { rejectHtml: true }
        );
      }
      const idxData = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      const assetTasks = [];
      for (const obj of Object.values(idxData.objects || {})) {
        const prefix = obj.hash.slice(0, 2);
        const dest = path.join(gameDir, 'assets', 'objects', prefix, obj.hash);
        if (!fs.existsSync(dest)) {
          assetTasks.push({
            urls: [
              `https://resources.download.minecraft.net/${prefix}/${obj.hash}`,
              `https://bmclapi2.bangbang93.com/assets/${prefix}/${obj.hash}`,
            ],
            dest,
          });
        }
      }
      if (assetTasks.length > 0) {
        sendLog(`Загрузка ресурсов игры (${assetTasks.length} файлов)...`);
        await downloadPool(assetTasks, 24, 'Загрузка ресурсов');
      }
    }

    return verJson;
  }

  ipcMain.handle('launch-game', async () => {
    const settings = loadSettings();
    const nickname = (settings.nickname || '').trim();
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(nickname)) {
      throw new Error('Введите корректный никнейм Minecraft (3–16 символов: латиница, цифры, _).');
    }

    let mcVersion = appConfig.minecraftVersion || '1.21.1';
    let nfVersion = appConfig.neoforgeVersion || '21.1.266';
    const activeServerUrl = normalizeServerUrl(settings.serverUrl || appConfig.serverUrl);

    if (!settings.vanillaTestMode) {
      const state = await checkModpackState();
      if (state.status === 'update_required') {
        throw new Error('Сначала нажмите ОБНОВИТЬ для загрузки файлов сборки.');
      }
      mcVersion = state.manifest.minecraftVersion || mcVersion;
      nfVersion = state.manifest.neoforgeVersion || nfVersion;
    }

    const gameDir = settings.gameDir || defaultGameDir;
    fs.mkdirSync(gameDir, { recursive: true });
    const tmpDir = path.join(gameDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });

    const javaExe = await ensureJava21(gameDir, activeServerUrl);
    const vanillaJson = await ensureVanilla1211(gameDir, mcVersion);

    let childJson = null;
    let targetVersionId = mcVersion;
    if (!settings.vanillaTestMode) {
      targetVersionId = await ensureNeoForge(gameDir, javaExe, mcVersion, nfVersion, activeServerUrl);
      const childJsonPath = path.join(gameDir, 'versions', targetVersionId, `${targetVersionId}.json`);
      childJson = JSON.parse(fs.readFileSync(childJsonPath, 'utf8'));

      const nfLibTasks = [];
      for (const lib of childJson.libraries || []) {
        if (!matchesRules(lib.rules)) continue;
        if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.url) {
          const dest = path.join(gameDir, 'libraries', lib.downloads.artifact.path);
          if (!fs.existsSync(dest)) {
            nfLibTasks.push({
              urls: buildMavenMirrorUrls(
                lib.downloads.artifact.path,
                lib.downloads.artifact.url,
                activeServerUrl
              ),
              dest,
            });
          }
        }
      }
      if (nfLibTasks.length > 0) {
        await downloadPool(nfLibTasks, 8, 'Загрузка библиотек NeoForge');
      }
    } else {
      sendLog(`Тестовый режим: запуск чистого Minecraft ${mcVersion} без модов (Vanilla).`);
    }

    const nativesDir = path.join(gameDir, 'versions', targetVersionId, 'natives');
    fs.mkdirSync(nativesDir, { recursive: true });
    const librariesDir = path.join(gameDir, 'libraries');

    const cpSet = new Set();
    const allLibs = [...(childJson?.libraries || []), ...(vanillaJson.libraries || [])];
    for (const lib of allLibs) {
      if (!matchesRules(lib.rules)) continue;
      let rel = lib.downloads?.artifact?.path;
      if (!rel && lib.name) {
        rel = mavenCoordsToPath(lib.name);
      }
      if (rel) {
        const full = path.join(librariesDir, rel);
        if (fs.existsSync(full)) cpSet.add(full);
      }
    }
    const mainClass = childJson?.mainClass || vanillaJson.mainClass;
    if (!childJson || mainClass !== 'cpw.mods.bootstraplauncher.BootstrapLauncher') {
      cpSet.add(path.join(gameDir, 'versions', mcVersion, `${mcVersion}.jar`));
    }
    const classpath = Array.from(cpSet).join(';');

    const vars = {
      '${natives_directory}': nativesDir,
      '${launcher_name}': 'BlackFox',
      '${launcher_version}': builtInExeVersion,
      '${classpath}': classpath,
      '${library_directory}': librariesDir,
      '${classpath_separator}': ';',
      '${version_name}': targetVersionId,
      '${auth_player_name}': nickname,
      '${game_directory}': gameDir,
      '${assets_root}': path.join(gameDir, 'assets'),
      '${assets_index_name}': childJson?.assets || vanillaJson.assets || vanillaJson.assetIndex?.id || '17',
      '${auth_uuid}': offlineUuid(nickname),
      '${auth_access_token}': '0',
      '${clientid}': '0',
      '${auth_xuid}': '0',
      '${user_type}': 'mojang',
      '${version_type}': vanillaJson.type || 'release',
    };

    function subst(str) {
      let out = String(str);
      for (const [k, v] of Object.entries(vars)) {
        out = out.split(k).join(v);
      }
      return out;
    }

    function collectArgs(list) {
      const out = [];
      for (const item of list || []) {
        if (typeof item === 'string') {
          out.push(subst(item));
        } else if (item && typeof item === 'object' && matchesRules(item.rules)) {
          const vals = Array.isArray(item.value) ? item.value : [item.value];
          for (const v of vals) out.push(subst(v));
        }
      }
      return out;
    }

    const jvmArgs = [
      `-Xmx${settings.ramMb || 4096}M`,
      '-Xms2048M',
      `-Djava.io.tmpdir=${tmpDir}`,
      ...collectArgs(vanillaJson.arguments?.jvm),
      ...collectArgs(childJson?.arguments?.jvm),
    ];
    const gameArgs = [
      ...collectArgs(vanillaJson.arguments?.game),
      ...collectArgs(childJson?.arguments?.game),
    ];

    sendProgress({ phase: 'running', label: `Запуск Minecraft ${mcVersion}...`, percent: 100 });
    sendLog(`Папка игры: ${gameDir}`);
    sendLog(`Запуск ${mainClass} для игрока ${nickname} (ОЗУ: ${settings.ramMb} МБ)...`);

    const proc = spawn(javaExe, [...jvmArgs, mainClass, ...gameArgs], {
      cwd: gameDir,
      env: { ...process.env, TEMP: tmpDir, TMP: tmpDir },
    });

    const resetDiscordToLauncher = () => {
      setDiscordPresence(
        `В лаунчере ${appConfig.serverName || 'BlackFox'}`,
        `Minecraft ${mcVersion} · NeoForge`,
        launcherStartedAt
      );
    };

    setDiscordPresence(
      `Играет на сервере ${appConfig.serverName || 'BlackFox'}`,
      settings.vanillaTestMode
        ? `Ник: ${nickname} · Vanilla ${mcVersion}`
        : `Ник: ${nickname} · ${mcVersion} NeoForge`,
      Date.now()
    );

    proc.stdout.on('data', (d) => {
      const txt = d.toString().trim();
      if (txt) sendLog(txt);
    });
    proc.stderr.on('data', (d) => {
      const txt = d.toString().trim();
      if (txt) sendLog('[STDERR] ' + txt);
    });
    proc.on('error', (err) => {
      resetDiscordToLauncher();
      sendLog('[SPAWN ERR] ' + err.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('game-exit', -1);
      }
    });
    proc.on('close', (code) => {
      resetDiscordToLauncher();
      sendLog(`Minecraft завершил работу с кодом ${code}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('game-exit', code);
      }
    });

    return { ok: true };
  });
};
