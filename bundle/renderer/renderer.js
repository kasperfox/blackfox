const queryParams = new URLSearchParams(window.location.search);
const resolvedAssetsDir = queryParams.get('assetsDir') || '';
if (resolvedAssetsDir) {
  const toFileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
  const iconEl = document.getElementById('brand-icon-img');
  const heroEl = document.getElementById('hero-banner-img');
  if (iconEl) iconEl.src = toFileUrl(resolvedAssetsDir + '/icon.jpg');
  if (heroEl) heroEl.src = toFileUrl(resolvedAssetsDir + '/hero.jpg');
}

const nickInput = document.getElementById('nickname-input');
const ramSelect = document.getElementById('ram-select');
const vanillaCheckbox = document.getElementById('vanilla-mode-checkbox');
const safeGraphicsCheckbox = document.getElementById('safe-graphics-checkbox');
const discordRpcCheckbox = document.getElementById('discord-rpc-checkbox');
const serverUrlInput = document.getElementById('server-url-input');
const btnSaveUrl = document.getElementById('btn-save-url');
const versionLabel = document.getElementById('launcher-version-label');
const selfUpdateBanner = document.getElementById('self-update-banner');
const selfUpdateText = document.getElementById('self-update-text');
const btnApplySelfUpdate = document.getElementById('btn-apply-self-update');
const statusTitle = document.getElementById('status-title');
const statusDetail = document.getElementById('status-detail');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const btnCheckHome = document.getElementById('btn-check-home');
const btnUpdate = document.getElementById('btn-update');
const btnPlay = document.getElementById('btn-play');
const modsList = document.getElementById('mods-list');
const consoleOut = document.getElementById('console-output');

let currentState = null;

document.getElementById('btn-min').addEventListener('click', () => window.blackfoxApi.windowControl('minimize'));
document.getElementById('btn-close').addEventListener('click', () => window.blackfoxApi.windowControl('close'));
document.getElementById('btn-open-folder').addEventListener('click', () => window.blackfoxApi.openGameFolder());
document.getElementById('btn-recheck').addEventListener('click', refreshStatus);
btnCheckHome.addEventListener('click', refreshStatus);

document.getElementById('btn-clear-cache').addEventListener('click', async () => {
  await window.blackfoxApi.clearGameCache();
  await refreshStatus();
});

document.getElementById('btn-show-diag').addEventListener('click', async () => {
  const diag = await window.blackfoxApi.getDiagnostics();
  appendLog('--- ДИАГНОСТИКА ---');
  appendLog('Версия .exe: ' + diag.builtInExeVersion + ' | Патч #' + diag.activeBundleVersion);
  appendLog('Безопасный режим GPU: ' + (diag.safeGraphicsMode ? 'ВКЛ' : 'ВЫКЛ'));
  if (diag.crashLogTail) {
    appendLog('crash.log:\n' + diag.crashLogTail);
  } else {
    appendLog('crash.log пуст (сбоев не зафиксировано).');
  }
});

safeGraphicsCheckbox.addEventListener('change', async () => {
  await window.blackfoxApi.setSafeGraphics(safeGraphicsCheckbox.checked);
});

btnApplySelfUpdate.addEventListener('click', async () => {
  btnApplySelfUpdate.disabled = true;
  btnApplySelfUpdate.textContent = 'Обновление...';
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '10%';
  try {
    await window.blackfoxApi.applyLauncherUpdate();
  } catch (err) {
    appendLog('[ERR self-update] ' + err.message);
    btnApplySelfUpdate.disabled = false;
    btnApplySelfUpdate.textContent = 'Повторить';
  }
});

btnSaveUrl.addEventListener('click', async () => {
  const nextUrl = serverUrlInput.value.trim();
  if (!nextUrl) return;
  await window.blackfoxApi.saveSettings({ serverUrl: nextUrl });
  appendLog('Установлен URL сервера: ' + nextUrl);
  await checkSelfUpdateBanner();
  await refreshStatus();
});

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

function appendLog(line) {
  consoleOut.textContent += line + '\n';
  consoleOut.scrollTop = consoleOut.scrollHeight;
}

function formatBytes(b) {
  if (!b) return '0 Б';
  const k = 1024;
  const s = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(i >= 2 ? 1 : 0) + ' ' + s[i];
}

function renderState(state) {
  currentState = state;
  const files = state.manifest.files || [];
  const modsCount = files.filter((f) => f.path.startsWith('mods/')).length;
  let hostLabel = '';
  try {
    hostLabel = new URL(state.serverUrl || serverUrlInput.value).host;
  } catch {}

  if (vanillaCheckbox.checked) {
    statusTitle.textContent = 'Режим теста Vanilla 1.21.1';
    statusTitle.className = 'status-title ok';
    statusDetail.textContent = 'Запуск чистого Minecraft 1.21.1 без модов и без ожидания сервера';
    btnUpdate.classList.add('hidden');
    btnPlay.disabled = false;
    return;
  }

  if (state.status === 'up_to_date') {
    if (modsCount === 0) {
      statusTitle.textContent = 'На сервере 0 модов (только меню)';
      statusTitle.className = 'status-title warn';
      statusDetail.textContent = `Файлов: ${state.manifest.totalFiles} · ${hostLabel}. Если моды на другом URL — вставьте его слева и нажмите OK.`;
    } else {
      statusTitle.textContent = 'Все обновления установлены';
      statusTitle.className = 'status-title ok';
      statusDetail.textContent = `Модов: ${modsCount} · Файлов: ${state.manifest.totalFiles} · Ревизия #${state.manifest.revision} · ${hostLabel}`;
    }
    btnUpdate.classList.add('hidden');
    btnPlay.disabled = false;
  } else {
    statusTitle.textContent = 'Требуется обновление';
    statusTitle.className = 'status-title warn';
    const count = state.missingOrChanged.length;
    statusDetail.textContent = `Файлов к загрузке: ${count} (${formatBytes(state.bytesToDownload)}) · Модов на сервере: ${modsCount} · ${hostLabel}`;
    btnUpdate.classList.remove('hidden');
    btnUpdate.disabled = false;
    btnPlay.disabled = true;
  }

  if (files.length === 0) {
    modsList.innerHTML = '<div style="color:#9ca3af;padding:12px;">На сервере пока нет загруженных модов (папка mods пуста).</div>';
  } else {
    modsList.innerHTML = files
      .slice(0, 500)
      .map(
        (f) =>
          `<div class="mod-row"><span>${f.path}</span><span>${formatBytes(f.size)}</span></div>`
      )
      .join('') + (files.length > 500 ? `<div style="color:#9ca3af;padding:10px;">...и ещё ${files.length - 500} файлов</div>` : '');
  }
}

async function checkSelfUpdateBanner() {
  try {
    const info = await window.blackfoxApi.checkLauncherUpdate();
    if (info && info.available) {
      selfUpdateText.textContent = info.notes || 'Доступно обновление лаунчера';
      selfUpdateBanner.classList.remove('hidden');
    } else {
      selfUpdateBanner.classList.add('hidden');
    }
  } catch {}
}

async function refreshStatus() {
  if (vanillaCheckbox.checked) {
    renderState(currentState || { status: 'up_to_date', manifest: { files: [], totalFiles: 0, revision: 1 } });
    return;
  }
  statusTitle.textContent = 'Проверка обновлений...';
  statusTitle.className = 'status-title';
  modsList.textContent = 'Загрузка списка...';
  btnPlay.disabled = true;
  try {
    const state = await window.blackfoxApi.checkUpdates();
    const updatedSettings = await window.blackfoxApi.getSettings();
    if (updatedSettings.serverUrl) serverUrlInput.value = updatedSettings.serverUrl;
    renderState(state);
  } catch (err) {
    statusTitle.textContent = 'Нет ответа от сервера манифеста';
    statusTitle.className = 'status-title warn';
    statusDetail.textContent = err.message;
    modsList.innerHTML = `<div style="color:#f87171;padding:12px;line-height:1.5;">Не удалось получить список файлов: ${err.message}</div>`;
    appendLog('[ERR] ' + err.message);
  }
}

btnUpdate.addEventListener('click', async () => {
  btnUpdate.disabled = true;
  btnPlay.disabled = true;
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '5%';
  try {
    const nextState = await window.blackfoxApi.syncModpack();
    renderState(nextState);
  } catch (err) {
    statusTitle.textContent = 'Ошибка обновления';
    statusDetail.textContent = err.message;
    btnUpdate.disabled = false;
  }
});

btnPlay.addEventListener('click', async () => {
  await window.blackfoxApi.saveSettings({
    nickname: nickInput.value.trim(),
    ramMb: Number(ramSelect.value),
    vanillaTestMode: vanillaCheckbox.checked,
    discordRpcEnabled: discordRpcCheckbox.checked,
    serverUrl: serverUrlInput.value.trim(),
  });
  btnPlay.disabled = true;
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '5%';
  try {
    await window.blackfoxApi.launchGame();
  } catch (err) {
    appendLog('[ERR] ' + err.message);
    statusTitle.textContent = 'Ошибка запуска';
    statusTitle.className = 'status-title warn';
    statusDetail.textContent = err.message;
    btnPlay.disabled = false;
  }
});

nickInput.addEventListener('change', () => {
  window.blackfoxApi.saveSettings({ nickname: nickInput.value.trim() });
});
ramSelect.addEventListener('change', () => {
  window.blackfoxApi.saveSettings({ ramMb: Number(ramSelect.value) });
});
discordRpcCheckbox.addEventListener('change', () => {
  window.blackfoxApi.saveSettings({ discordRpcEnabled: discordRpcCheckbox.checked });
});
vanillaCheckbox.addEventListener('change', async () => {
  await window.blackfoxApi.saveSettings({ vanillaTestMode: vanillaCheckbox.checked });
  await refreshStatus();
});

window.blackfoxApi.onProgress((p) => {
  progressWrap.classList.remove('hidden');
  progressBar.style.width = (p.percent || 0) + '%';
  statusDetail.textContent = p.label || '';
});
window.blackfoxApi.onLog(appendLog);
window.blackfoxApi.onGameExit(() => {
  btnPlay.disabled = false;
  progressWrap.classList.add('hidden');
  refreshStatus();
});

(async function init() {
  const [cfg, settings] = await Promise.all([
    window.blackfoxApi.getConfig(),
    window.blackfoxApi.getSettings(),
  ]);
  nickInput.value = settings.nickname || '';
  ramSelect.value = String(settings.ramMb || 4096);
  vanillaCheckbox.checked = Boolean(settings.vanillaTestMode);
  discordRpcCheckbox.checked = settings.discordRpcEnabled !== false;
  serverUrlInput.value = settings.serverUrl || '';
  safeGraphicsCheckbox.checked = Boolean(cfg && cfg.safeGraphicsMode);
  if (cfg) {
    versionLabel.textContent = `v${cfg.builtInExeVersion || '2.0.0'} · #${cfg.activeBundleVersion || 1}`;
  }
  await Promise.all([checkSelfUpdateBanner(), refreshStatus()]);
})();
