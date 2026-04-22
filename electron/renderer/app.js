const $ = (id) => document.getElementById(id);

const apiKeyEl = $('apiKey');
const dirEl = $('downloadDir');
const urlEl = $('urlInput');
const logEl = $('log');
const progressFill = $('progressFill');
const progressText = $('progressText');
const userInfo = $('userInfo');
const parsedInfo = $('parsedInfo');
const previewBtn = $('previewBtn');
const startBtn = $('startBtn');
const cancelBtn = $('cancelBtn');
const previewCard = $('previewCard');
const previewMeta = $('previewMeta');
const previewItems = $('previewItems');
const fileList = $('fileList');
const subfolderInput = $('subfolderInput');
const versionSelectWrap = $('versionSelectWrap');
const versionSelect = $('versionSelect');
const previewSummary = $('previewSummary');

let currentPreview = null;

function log (msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function fmtSize (kb) {
  if (!kb) return '';
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`;
  if (kb > 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${Math.round(kb)} KB`;
}

async function init () {
  const cfg = await window.api.getConfig();
  apiKeyEl.value = cfg.secretKey || '';
  dirEl.value = cfg.downloadDir || '';
  if (cfg.secretKey) verifyKey(cfg.secretKey, true);
}

async function verifyKey (key, silent = false) {
  if (!key) { userInfo.textContent = '未登录'; return; }
  const r = await window.api.verifyKey(key);
  if (r.ok) {
    userInfo.textContent = `已登录: ${r.username}`;
    userInfo.style.color = '#69db7c';
    if (!silent) log(`密钥验证成功: ${r.username}`, 'ok');
  } else {
    userInfo.textContent = '密钥无效';
    userInfo.style.color = '#ff8787';
    if (!silent) log(`密钥无效: ${r.error}`, 'err');
  }
}

$('toggleKey').addEventListener('click', () => {
  apiKeyEl.type = apiKeyEl.type === 'password' ? 'text' : 'password';
  $('toggleKey').textContent = apiKeyEl.type === 'password' ? '显示' : '隐藏';
});

$('verifyKey').addEventListener('click', () => verifyKey(apiKeyEl.value.trim()));

$('pickFolder').addEventListener('click', async () => {
  const p = await window.api.pickFolder();
  if (p) dirEl.value = p;
});

$('openFolder').addEventListener('click', () => {
  if (dirEl.value) window.api.openPath(dirEl.value);
});

$('saveConfig').addEventListener('click', async () => {
  await window.api.setConfig({ secretKey: apiKeyEl.value.trim(), downloadDir: dirEl.value.trim() });
  $('saveStatus').textContent = '已保存 ✓';
  setTimeout(() => { $('saveStatus').textContent = ''; }, 2000);
});

urlEl.addEventListener('input', async () => {
  const v = urlEl.value.trim();
  if (!v) { parsedInfo.textContent = ''; return; }
  const p = await window.api.parseUrl(v);
  if (p.kind === 'post') parsedInfo.textContent = `识别: Post #${p.id}`;
  else if (p.kind === 'model') parsedInfo.textContent = `识别: Model #${p.id}${p.modelVersionId ? ` (v${p.modelVersionId})` : ''}`;
  else if (p.kind === 'image') parsedInfo.textContent = `识别: Image #${p.id}`;
  else parsedInfo.textContent = '无法识别的链接';
});

function renderPreview (data) {
  currentPreview = data;
  previewCard.style.display = 'block';
  previewItems.innerHTML = '';
  fileList.innerHTML = '';
  versionSelectWrap.style.display = 'none';
  subfolderInput.value = '';
  subfolderInput.placeholder = data.suggestedFolder || '自动';

  if (data.kind === 'post') {
    previewMeta.innerHTML = `
      <div class="title">${escapeHtml(data.title)}</div>
      <div class="sub">作者: ${escapeHtml(data.username)} · 共 ${data.items.length} 项 · ${data.publishedAt ? new Date(data.publishedAt).toLocaleDateString() : ''}</div>
    `;
    renderMediaGrid(data.items);
    previewSummary.textContent = `准备下载 ${data.items.length} 个文件`;
  }

  else if (data.kind === 'model') {
    previewMeta.innerHTML = `
      <div class="title">${escapeHtml(data.title)}</div>
      <div class="sub">${escapeHtml(data.modelType || '')} · 作者: ${escapeHtml(data.creator || '')} · ${data.versions.length} 个版本</div>
    `;
    versionSelectWrap.style.display = 'block';
    versionSelect.innerHTML = data.versions.map(v =>
      `<option value="${v.id}"${v.id === data.selectedVersionId ? ' selected' : ''}>${escapeHtml(v.name)} (${v.baseModel || ''})</option>`
    ).join('');
    renderModelVersion(data.versions.find(v => v.id === Number(versionSelect.value)) || data.versions[0]);
  }

  else if (data.kind === 'image') {
    previewMeta.innerHTML = `<div class="title">${escapeHtml(data.title)}</div>`;
    renderMediaGrid(data.items);
    previewSummary.textContent = '准备下载 1 个文件';
  }
}

function renderMediaGrid (items) {
  previewItems.innerHTML = items.map(it => {
    const isVideo = it.type === 'video';
    return `<div class="item">
      ${isVideo
        ? `<video src="${it.full}" muted loop playsinline onmouseover="this.play()" onmouseout="this.pause()"></video>`
        : `<img src="${it.thumb}" loading="lazy" />`}
      ${isVideo ? '<span class="badge">VIDEO</span>' : ''}
    </div>`;
  }).join('');
}

function renderModelVersion (ver) {
  if (!ver) { previewItems.innerHTML = ''; fileList.innerHTML = ''; return; }
  renderMediaGrid((ver.previews || []).map(p => ({ type: p.type, thumb: p.url, full: p.url })));
  fileList.innerHTML = (ver.files || []).map(f =>
    `<div class="file"><span class="name">${escapeHtml(f.name)} <span class="sub">${escapeHtml(f.type || '')}</span></span><span class="size">${fmtSize(f.size)}</span></div>`
  ).join('');
  previewSummary.textContent = `将下载 ${ver.files.length} 个文件 + ${ver.previews.length} 张预览`;
}

versionSelect.addEventListener('change', () => {
  if (!currentPreview || currentPreview.kind !== 'model') return;
  const v = currentPreview.versions.find(x => x.id === Number(versionSelect.value));
  renderModelVersion(v);
});

function escapeHtml (s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

previewBtn.addEventListener('click', async () => {
  const url = urlEl.value.trim();
  if (!url) { log('请输入链接', 'err'); return; }
  previewBtn.disabled = true;
  previewBtn.textContent = '加载中...';
  previewSummary.textContent = '';
  log(`预览: ${url}`);
  const r = await window.api.previewFetch(url);
  previewBtn.disabled = false;
  previewBtn.textContent = '预览';
  if (!r.ok) { log(`预览失败: ${r.error}`, 'err'); previewCard.style.display = 'none'; return; }
  renderPreview(r);
  log('预览加载完成', 'ok');
});

startBtn.addEventListener('click', async () => {
  if (!currentPreview) { log('请先预览', 'err'); return; }

  await window.api.setConfig({ secretKey: apiKeyEl.value.trim(), downloadDir: dirEl.value.trim() });

  const opts = {
    url: urlEl.value.trim(),
    subfolder: subfolderInput.value.trim() || undefined
  };
  if (currentPreview.kind === 'model') {
    opts.modelVersionId = Number(versionSelect.value);
  }

  startBtn.disabled = true;
  cancelBtn.disabled = false;
  progressFill.style.width = '0%';
  progressText.textContent = '开始...';
  log(`开始下载: ${opts.url}${opts.subfolder ? ` → ${opts.subfolder}` : ''}`);

  const r = await window.api.startDownload(opts);
  if (r.ok) {
    log(`完成: 保存到 ${r.outDir} (${r.saved}/${r.total})`, 'ok');
    progressText.textContent = `完成 ${r.saved}/${r.total}`;
    progressFill.style.width = '100%';
  } else {
    log(`失败: ${r.error}`, 'err');
    progressText.textContent = `失败: ${r.error}`;
  }
  startBtn.disabled = false;
  cancelBtn.disabled = true;
});

cancelBtn.addEventListener('click', async () => {
  await window.api.cancelDownload();
  log('已请求取消', 'warn');
});

window.api.onLog(({ level, msg }) => log(msg, level === 'warn' ? 'warn' : level === 'error' ? 'err' : ''));
window.api.onProgress(({ current, total, file, skipped }) => {
  progressFill.style.width = `${Math.round((current / total) * 100)}%`;
  progressText.textContent = `${current}/${total} · ${file}${skipped ? ' (已存在)' : ''}`;
});
window.api.onBegin(({ kind }) => log(`任务开始: ${kind}`));
window.api.onEnd((r) => { if (!r.ok) log(`结束: ${r.error}`, 'err'); });

init();
