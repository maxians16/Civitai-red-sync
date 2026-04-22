const $ = (id) => document.getElementById(id);

const apiKeyEl = $('apiKey');
const dirEl = $('downloadDir');
const urlInput = $('urlInput');
const logEl = $('log');
const userInfo = $('userInfo');
const previewBtn = $('previewBtn');
const clearBtn = $('clearBtn');
const startBtn = $('startBtn');
const cancelBtn = $('cancelBtn');
const previewCard = $('previewCard');
const queueList = $('queueList');
const queueSummary = $('queueSummary');
const urlCount = $('urlCount');
const batchFill = $('batchFill');
const batchText = $('batchText');
const fileFill = $('fileFill');
const fileText = $('fileText');
const bytesText = $('bytesText');

let previews = [];

function log (msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function fmtBytes (b) {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtSizeKB (kb) {
  if (!kb) return '';
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`;
  if (kb > 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${Math.round(kb)} KB`;
}
function escapeHtml (s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function init () {
  const cfg = await window.api.getConfig();
  apiKeyEl.value = cfg.secretKey || '';
  dirEl.value = cfg.downloadDir || '';
  if (cfg.secretKey) verifyKey(cfg.secretKey, true);
  updateUrlCount();
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

function parseUrlList () {
  return urlInput.value.split('\n').map(s => s.trim()).filter(Boolean);
}
function updateUrlCount () {
  const n = parseUrlList().length;
  urlCount.textContent = n ? `${n} 个链接` : '';
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
$('openFolder').addEventListener('click', () => { if (dirEl.value) window.api.openPath(dirEl.value); });
$('saveConfig').addEventListener('click', async () => {
  await window.api.setConfig({ secretKey: apiKeyEl.value.trim(), downloadDir: dirEl.value.trim() });
  $('saveStatus').textContent = '已保存 ✓';
  setTimeout(() => { $('saveStatus').textContent = ''; }, 2000);
});
urlInput.addEventListener('input', updateUrlCount);
clearBtn.addEventListener('click', () => { urlInput.value = ''; previewCard.style.display = 'none'; previews = []; updateUrlCount(); });

previewBtn.addEventListener('click', async () => {
  const urls = parseUrlList();
  if (!urls.length) { log('请至少输入一个链接', 'err'); return; }
  previewBtn.disabled = true;
  previewBtn.textContent = '加载中...';
  log(`预览 ${urls.length} 个链接...`);
  const r = await window.api.previewFetch(urls);
  previewBtn.disabled = false;
  previewBtn.textContent = '预览 / 刷新';
  if (!r.ok) { log(`预览失败: ${r.error}`, 'err'); return; }
  previews = r.previews;
  renderQueue();
  previewCard.style.display = 'block';
  const okCount = previews.filter(p => p.ok).length;
  log(`预览完成: ${okCount}/${previews.length} 成功`, 'ok');
});

function renderQueue () {
  queueSummary.textContent = `(${previews.filter(p => p.ok).length}/${previews.length} 就绪)`;
  queueList.innerHTML = '';
  previews.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = 'queue-item pending';
    div.id = `qitem-${idx}`;

    if (!p.ok) {
      div.classList.add('error');
      div.innerHTML = `
        <div class="queue-head">
          <span class="title">${escapeHtml(p.url)}</span>
          <span class="badge err">失败</span>
        </div>
        <div class="queue-meta">${escapeHtml(p.error)}</div>
      `;
      queueList.appendChild(div);
      return;
    }

    let body = '';
    if (p.kind === 'post') {
      body = `
        <div class="queue-head">
          <span class="title">${escapeHtml(p.title)}</span>
          <span class="badge post">POST · ${p.itemCount}</span>
        </div>
        <div class="queue-meta">作者: ${escapeHtml(p.username)} · ${p.items.length} 个媒体</div>
        <div class="queue-thumbs">${p.items.slice(0, 8).map(it => it.type === 'video'
          ? `<video src="${it.full}" muted></video>`
          : `<img src="${it.thumb}" loading="lazy" />`).join('')}</div>
        <input type="text" data-field="subfolder" placeholder="${escapeHtml(p.suggestedFolder)}" />
      `;
    }
    else if (p.kind === 'model') {
      const verOptions = p.versions.map(v =>
        `<option value="${v.id}"${v.id === p.selectedVersionId ? ' selected' : ''}>${escapeHtml(v.name)} (${v.baseModel || ''})</option>`
      ).join('');
      const selected = p.versions.find(v => v.id === p.selectedVersionId) || p.versions[0];
      const totalMB = (selected.files || []).reduce((a, f) => a + (f.size || 0) / 1024, 0);
      body = `
        <div class="queue-head">
          <span class="title">${escapeHtml(p.title)}</span>
          <span class="badge model">MODEL</span>
        </div>
        <div class="queue-meta">${escapeHtml(p.modelType || '')} · ${escapeHtml(p.creator)} · 版本 ${p.versions.length} · 约 ${totalMB.toFixed(1)} MB</div>
        <select data-field="version">${verOptions}</select>
        <div class="queue-thumbs">${(selected.previews || []).slice(0, 6).map(it => it.type === 'video'
          ? `<video src="${it.url}" muted></video>`
          : `<img src="${it.url}" loading="lazy" />`).join('')}</div>
        <input type="text" data-field="subfolder" placeholder="${escapeHtml(p.suggestedFolder)}" />
      `;
    }
    else if (p.kind === 'image') {
      body = `
        <div class="queue-head">
          <span class="title">${escapeHtml(p.title)}</span>
          <span class="badge image">IMAGE</span>
        </div>
        <div class="queue-thumbs">${p.items.map(it => it.type === 'video'
          ? `<video src="${it.full}" muted></video>`
          : `<img src="${it.thumb}" loading="lazy" />`).join('')}</div>
        <input type="text" data-field="subfolder" placeholder="${escapeHtml(p.suggestedFolder)}" />
      `;
    }
    div.innerHTML = body;
    queueList.appendChild(div);
  });
}

startBtn.addEventListener('click', async () => {
  await window.api.setConfig({ secretKey: apiKeyEl.value.trim(), downloadDir: dirEl.value.trim() });

  const tasks = previews.map((p, idx) => {
    if (!p.ok) return null;
    const el = document.getElementById(`qitem-${idx}`);
    const subfolderEl = el?.querySelector('[data-field="subfolder"]');
    const versionEl = el?.querySelector('[data-field="version"]');
    return {
      url: p.url,
      subfolder: subfolderEl?.value.trim() || undefined,
      modelVersionId: versionEl ? Number(versionEl.value) : undefined
    };
  }).filter(Boolean);

  if (!tasks.length) { log('没有可下载的任务', 'err'); return; }

  startBtn.disabled = true;
  cancelBtn.disabled = false;
  batchFill.style.width = '0%';
  fileFill.style.width = '0%';
  log(`开始批量下载 ${tasks.length} 个任务`);

  const r = await window.api.startDownload(tasks);

  startBtn.disabled = false;
  cancelBtn.disabled = true;
  if (r.ok) {
    const ok = r.results.filter(x => x.ok).length;
    log(`批量完成: ${ok}/${r.results.length} 成功`, 'ok');
  } else {
    log(`失败: ${r.error}`, 'err');
  }
});

cancelBtn.addEventListener('click', async () => {
  await window.api.cancelDownload();
  log('已请求取消', 'warn');
});

// ---- events ----

window.api.onLog(({ level, msg }) => log(msg, level === 'warn' ? 'warn' : level === 'error' ? 'err' : ''));

window.api.onBatchBegin(({ total }) => {
  batchText.textContent = `0/${total}`;
  batchFill.style.width = '0%';
});

window.api.onBatchItemStart(({ index, total }) => {
  const el = document.getElementById(`qitem-${index}`);
  if (el) { el.classList.remove('pending'); el.classList.add('running'); }
  batchText.textContent = `${index + 1}/${total}`;
  batchFill.style.width = `${Math.round(((index) / total) * 100)}%`;
});

window.api.onBatchItemEnd(({ index, ok, error }) => {
  const el = document.getElementById(`qitem-${index}`);
  if (el) {
    el.classList.remove('running', 'pending');
    el.classList.add(ok ? 'done' : 'error');
  }
  if (!ok) log(`#${index + 1} 失败: ${error}`, 'err');
});

window.api.onBatchDone(({ results }) => {
  batchFill.style.width = '100%';
  batchText.textContent = `完成 ${results.filter(r => r.ok).length}/${results.length}`;
  fileText.textContent = '—';
  bytesText.textContent = '—';
  fileFill.style.width = '0%';
});

window.api.onItemProgress(({ taskIndex, totalTasks, current, total, file, skipped }) => {
  fileText.textContent = `[任务 ${taskIndex + 1}/${totalTasks}] 文件 ${current}/${total}: ${file}${skipped ? ' (跳过)' : ''}`;
  // reset per-file bar at start of each file
  fileFill.style.width = skipped ? '100%' : '0%';
  if (skipped) bytesText.textContent = '已存在,跳过';
});

window.api.onBytesProgress(({ bytes, totalBytes, file, done }) => {
  if (totalBytes > 0) {
    fileFill.style.width = `${Math.round((bytes / totalBytes) * 100)}%`;
    bytesText.textContent = `${fmtBytes(bytes)} / ${fmtBytes(totalBytes)} (${Math.round((bytes / totalBytes) * 100)}%)`;
  } else {
    // unknown size: indeterminate visual — fill slowly based on bytes
    bytesText.textContent = `${fmtBytes(bytes)} 已下载`;
    fileFill.style.width = `${Math.min(90, Math.round(bytes / 1024 / 1024))}%`;
  }
  if (done) fileFill.style.width = '100%';
});

init();
