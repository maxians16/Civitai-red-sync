import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdirp } from 'mkdirp';

import {
  getMe,
  getPost,
  getPostImageMeta,
  getCivitaiImageBase,
  fetchModel
} from '../src/civitaiApi.mjs';
import headers from '../src/headers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(app.getPath('userData'), 'civitai-gui');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let mainWindow;

function loadGuiConfig () {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return { secretKey: '', downloadDir: path.join(app.getPath('downloads'), 'Civitai') };
}

function saveGuiConfig (cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'Civitai Sync GUI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------- URL parsing ----------

function parseCivitaiUrl (raw) {
  const input = String(raw || '').trim();
  if (!input) return { kind: 'unknown' };

  let u;
  try { u = new URL(input); }
  catch { return { kind: 'unknown' }; }

  const host = u.hostname.replace(/^www\./, '');
  if (!/civitai\.(red|com)$/.test(host)) return { kind: 'unknown' };

  const seg = u.pathname.split('/').filter(Boolean);

  if (seg[0] === 'posts' && seg[1]) {
    const id = Number(seg[1]);
    if (Number.isFinite(id)) return { kind: 'post', id };
  }

  if (seg[0] === 'images' && seg[1]) {
    const id = Number(seg[1]);
    if (Number.isFinite(id)) return { kind: 'image', id };
  }

  if (seg[0] === 'models' && seg[1]) {
    const id = Number(seg[1]);
    const modelVersionId = Number(u.searchParams.get('modelVersionId')) || null;
    if (Number.isFinite(id)) return { kind: 'model', id, modelVersionId };
  }

  return { kind: 'unknown' };
}

// ---------- Helpers ----------

function sanitizeName (s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

function emit (event, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, payload);
  }
}

// Minimal image-fetch rate limiter (images only)
let _lastImgFetch = 0;
const IMG_RATE_MS = 100;
async function imgRateLimit () {
  const now = Date.now();
  const wait = _lastImgFetch + IMG_RATE_MS - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastImgFetch = Date.now();
}

/**
 * Stream a URL to a file, emitting byte-level progress.
 * onProgress({ bytes, totalBytes }) fires throttled to ~10/s.
 */
async function downloadHttp (url, filepath, { fetchHeaders = {}, signal, onProgress, rateLimit = false } = {}) {
  if (rateLimit) await imgRateLimit();

  const resp = await fetch(url, { headers: fetchHeaders, signal });
  if (resp.status !== 200) return { ok: false, status: resp.status };

  const totalBytes = Number(resp.headers.get('content-length')) || 0;
  let bytes = 0;
  let lastEmit = 0;

  await mkdirp(path.dirname(filepath));
  const body = Readable.fromWeb(resp.body);
  body.on('data', (chunk) => {
    bytes += chunk.length;
    const now = Date.now();
    if (onProgress && (now - lastEmit > 100 || bytes === totalBytes)) {
      lastEmit = now;
      onProgress({ bytes, totalBytes });
    }
  });

  const out = fs.createWriteStream(filepath);
  await pipeline(body, out);
  if (onProgress) onProgress({ bytes, totalBytes, done: true });
  return { ok: true, bytes, totalBytes };
}

const imageFetchHeaders = { ...headers.sharedHeaders, ...headers.imageHeaders };

// ---------- Per-kind download implementations ----------

async function downloadPost ({ postId, secretKey, downloadDir, subfolder, signal, onItemProgress, onByteProgress }) {
  emit('log', { msg: `抓取 post ${postId}...` });

  const postData = await getPost({ id: postId, secretKey, signal });
  if (postData?.error) throw new Error(postData.error?.json?.message || 'Post request failed');
  const post = postData?.result?.data?.json;
  if (!post) throw new Error('Post not found');

  const images = await getPostImageMeta({ postId, secretKey, signal });
  emit('log', { msg: `Post 有 ${images.length} 个媒体` });

  const cdnBase = await getCivitaiImageBase({ secretKey });
  const folderName = subfolder
    ? sanitizeName(subfolder)
    : `post_${postId}_${sanitizeName(post.title || '')}`.replace(/_+$/, '');
  const outDir = path.join(downloadDir, folderName);
  await mkdirp(outDir);
  fs.writeFileSync(path.join(outDir, 'post.json'), JSON.stringify({ post, images }, null, 2));

  let saved = 0;
  for (let i = 0; i < images.length; i++) {
    if (signal?.aborted) break;
    const img = images[i];
    const ext = img.type === 'video' ? '.mp4' : '.jpeg';
    const base = img.name ? img.name.split('?')[0].replace(/\.[^.]+$/, '') : img.url;
    const url = img.name
      ? `${cdnBase}/${img.url}/original=true/${base}${ext}`
      : `${cdnBase}/${img.url}/original=true/${img.url}${ext}`;
    const filename = `${String(i + 1).padStart(2, '0')}_${img.id}${ext}`;
    const filepath = path.join(outDir, filename);

    if (fs.existsSync(filepath)) {
      onItemProgress?.({ current: i + 1, total: images.length, file: filename, skipped: true });
      saved++;
      continue;
    }

    onItemProgress?.({ current: i + 1, total: images.length, file: filename });

    const r = await downloadHttp(url, filepath, {
      fetchHeaders: imageFetchHeaders,
      signal,
      rateLimit: true,
      onProgress: (p) => onByteProgress?.({ file: filename, ...p })
    });
    if (!r.ok) { emit('log', { level: 'warn', msg: `HTTP ${r.status}: ${filename}` }); continue; }
    saved++;
  }

  return { outDir, saved, total: images.length };
}

async function downloadModel ({ modelId, modelVersionId, secretKey, downloadDir, subfolder, signal, onItemProgress, onByteProgress }) {
  emit('log', { msg: `抓取 model ${modelId}...` });

  const model = await fetchModel(modelId);
  if (model?.error) throw new Error(model.error?.json?.message || 'Model request failed');
  if (!model?.modelVersions?.length) throw new Error('Model has no versions');

  const version = modelVersionId
    ? model.modelVersions.find(v => v.id === modelVersionId) || model.modelVersions[0]
    : model.modelVersions[0];

  const folderName = subfolder
    ? sanitizeName(subfolder)
    : `model_${modelId}_${sanitizeName(model.name || '')}`;
  const outDir = path.join(downloadDir, folderName);
  await mkdirp(outDir);
  fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(model, null, 2));
  emit('log', { msg: `版本: ${version.name} — ${version.files?.length || 0} 个文件` });

  const files = version.files || [];
  let saved = 0;

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) break;
    const f = files[i];
    const filepath = path.join(outDir, sanitizeName(f.name));
    if (fs.existsSync(filepath)) {
      onItemProgress?.({ current: i + 1, total: files.length, file: f.name, skipped: true });
      saved++;
      continue;
    }

    onItemProgress?.({ current: i + 1, total: files.length, file: f.name });

    const fetchHeaders = secretKey ? { Authorization: `Bearer ${secretKey}` } : {};
    const r = await downloadHttp(f.downloadUrl, filepath, {
      fetchHeaders,
      signal,
      onProgress: (p) => onByteProgress?.({ file: f.name, ...p })
    });
    if (!r.ok) { emit('log', { level: 'warn', msg: `HTTP ${r.status}: ${f.name}` }); continue; }
    saved++;
  }

  // Version preview images
  const imgs = version.images || [];
  if (imgs.length && !signal?.aborted) {
    const imgDir = path.join(outDir, 'previews');
    await mkdirp(imgDir);
    for (let i = 0; i < imgs.length; i++) {
      if (signal?.aborted) break;
      const img = imgs[i];
      if (!img.url) continue;
      const ext = img.type === 'video' ? '.mp4' : '.jpeg';
      const filename = `${String(i + 1).padStart(2, '0')}${ext}`;
      const filepath = path.join(imgDir, filename);
      if (fs.existsSync(filepath)) continue;
      try {
        await downloadHttp(img.url, filepath, {
          fetchHeaders: imageFetchHeaders,
          signal,
          rateLimit: true
        });
      } catch { /* ignore previews */ }
    }
  }

  return { outDir, saved, total: files.length };
}

async function downloadSingleImage ({ imageId, secretKey, downloadDir, subfolder, signal, onItemProgress, onByteProgress }) {
  emit('log', { msg: `抓取 image ${imageId}...` });
  const apiUrl = `https://civitai.red/api/v1/images?imageId=${imageId}&limit=1`;
  const resp = await fetch(apiUrl, {
    headers: { ...headers.sharedHeaders, ...headers.jsonHeaders, Authorization: `Bearer ${secretKey}` },
    signal
  });
  const data = await resp.json();
  const item = data?.items?.[0];
  if (!item) throw new Error('Image not found');

  const outDir = path.join(downloadDir, subfolder ? sanitizeName(subfolder) : 'images');
  await mkdirp(outDir);
  const ext = item.type === 'video' ? '.mp4' : '.jpeg';
  const filename = `${imageId}${ext}`;
  const filepath = path.join(outDir, filename);
  fs.writeFileSync(path.join(outDir, `${imageId}.json`), JSON.stringify(item, null, 2));

  if (fs.existsSync(filepath)) {
    onItemProgress?.({ current: 1, total: 1, file: filename, skipped: true });
    return { outDir, saved: 1, total: 1 };
  }

  onItemProgress?.({ current: 1, total: 1, file: filename });
  const r = await downloadHttp(item.url, filepath, {
    fetchHeaders: imageFetchHeaders,
    signal,
    rateLimit: true,
    onProgress: (p) => onByteProgress?.({ file: filename, ...p })
  });

  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { outDir, saved: 1, total: 1 };
}

// ---------- Dispatch one task ----------

async function runTask (task, cfg, { signal, taskIndex, totalTasks }) {
  const parsed = parseCivitaiUrl(task.url);
  if (parsed.kind === 'unknown') throw new Error(`URL not recognized: ${task.url}`);

  const onItemProgress = (p) => emit('progress:item', { taskIndex, totalTasks, url: task.url, ...p });
  const onByteProgress = (p) => emit('progress:bytes', { taskIndex, totalTasks, url: task.url, ...p });

  const common = {
    secretKey: cfg.secretKey,
    downloadDir: cfg.downloadDir,
    subfolder: task.subfolder,
    signal,
    onItemProgress,
    onByteProgress
  };

  if (parsed.kind === 'post') {
    return await downloadPost({ postId: parsed.id, ...common });
  }
  if (parsed.kind === 'model') {
    return await downloadModel({ modelId: parsed.id, modelVersionId: task.modelVersionId || parsed.modelVersionId, ...common });
  }
  if (parsed.kind === 'image') {
    return await downloadSingleImage({ imageId: parsed.id, ...common });
  }
  throw new Error(`Unsupported kind: ${parsed.kind}`);
}

// ---------- IPC ----------

let currentAbort = null;

ipcMain.handle('config:get', () => loadGuiConfig());
ipcMain.handle('config:set', (_e, cfg) => { saveGuiConfig(cfg); return loadGuiConfig(); });

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('openPath', (_e, p) => shell.openPath(p));

ipcMain.handle('api:verifyKey', async (_e, { secretKey }) => {
  const me = await getMe({ secretKey });
  if (me?.error || !me?.username) return { ok: false, error: me?.error?.message || 'Invalid key' };
  return { ok: true, username: me.username };
});

ipcMain.handle('parseUrl', (_e, url) => parseCivitaiUrl(url));

ipcMain.handle('preview:fetch', async (_e, { urls }) => {
  const list = Array.isArray(urls) ? urls : [urls];
  const cfg = loadGuiConfig();
  if (!cfg.secretKey) return { ok: false, error: 'API key not set' };

  const results = [];
  for (const url of list) {
    const parsed = parseCivitaiUrl(url);
    if (parsed.kind === 'unknown') {
      results.push({ ok: false, url, error: 'URL not recognized' });
      continue;
    }
    try {
      if (parsed.kind === 'post') {
        const postData = await getPost({ id: parsed.id, secretKey: cfg.secretKey });
        if (postData?.error) throw new Error(postData.error?.json?.message || 'Post request failed');
        const post = postData?.result?.data?.json;
        if (!post) throw new Error('Post not found');
        const images = await getPostImageMeta({ postId: parsed.id, secretKey: cfg.secretKey });
        const cdnBase = await getCivitaiImageBase({ secretKey: cfg.secretKey });
        const items = images.map((img) => {
          const ext = img.type === 'video' ? '.mp4' : '.jpeg';
          const thumb = `${cdnBase}/${img.url}/width=450/${img.url}.jpeg`;
          const full = img.name
            ? `${cdnBase}/${img.url}/original=true/${img.name.split('?')[0].replace(/\.[^.]+$/, '')}${ext}`
            : `${cdnBase}/${img.url}/original=true/${img.url}${ext}`;
          return { id: img.id, type: img.type || 'image', thumb, full };
        });
        results.push({
          ok: true, url, kind: 'post', id: parsed.id,
          title: post.title || `Post #${parsed.id}`,
          username: post.user?.username || '',
          itemCount: items.length, items,
          suggestedFolder: sanitizeName(`post_${parsed.id}_${post.title || ''}`.replace(/_+$/, ''))
        });
      }
      else if (parsed.kind === 'model') {
        const model = await fetchModel(parsed.id);
        if (model?.error) throw new Error(model.error?.json?.message || 'Model request failed');
        if (!model?.modelVersions?.length) throw new Error('Model has no versions');
        const versions = model.modelVersions.map(v => ({
          id: v.id, name: v.name, baseModel: v.baseModel,
          files: (v.files || []).map(f => ({ name: f.name, size: f.sizeKB, type: f.type })),
          previews: (v.images || []).slice(0, 8).map(i => ({ url: i.url, type: i.type || 'image' }))
        }));
        results.push({
          ok: true, url, kind: 'model', id: parsed.id,
          title: model.name, modelType: model.type,
          creator: model.creator?.username || '',
          versions,
          selectedVersionId: parsed.modelVersionId || versions[0]?.id,
          suggestedFolder: sanitizeName(`model_${parsed.id}_${model.name || ''}`)
        });
      }
      else if (parsed.kind === 'image') {
        const resp = await fetch(`https://civitai.red/api/v1/images?imageId=${parsed.id}&limit=1`, {
          headers: { ...headers.sharedHeaders, ...headers.jsonHeaders, Authorization: `Bearer ${cfg.secretKey}` }
        });
        const data = await resp.json();
        const item = data?.items?.[0];
        if (!item) throw new Error('Image not found');
        results.push({
          ok: true, url, kind: 'image', id: parsed.id,
          title: `Image #${parsed.id}`,
          itemCount: 1,
          items: [{ id: item.id, type: item.type || 'image', thumb: item.url, full: item.url }],
          suggestedFolder: 'images'
        });
      }
    }
    catch (err) {
      results.push({ ok: false, url, error: err.message });
    }
  }
  return { ok: true, previews: results };
});

ipcMain.handle('download:start', async (_e, { tasks }) => {
  if (currentAbort) return { ok: false, error: '已有下载在进行' };

  const cfg = loadGuiConfig();
  if (!cfg.secretKey) return { ok: false, error: 'API key 未设置' };
  if (!cfg.downloadDir) return { ok: false, error: '下载目录未设置' };
  if (!tasks?.length) return { ok: false, error: '没有任务' };

  currentAbort = new AbortController();
  const { signal } = currentAbort;
  const results = [];

  try {
    emit('batch:begin', { total: tasks.length });
    for (let i = 0; i < tasks.length; i++) {
      if (signal.aborted) break;
      emit('batch:itemStart', { index: i, total: tasks.length, url: tasks[i].url });
      try {
        const r = await runTask(tasks[i], cfg, { signal, taskIndex: i, totalTasks: tasks.length });
        results.push({ ok: true, url: tasks[i].url, ...r });
        emit('batch:itemEnd', { index: i, ok: true, ...r });
      }
      catch (err) {
        results.push({ ok: false, url: tasks[i].url, error: err.message });
        emit('batch:itemEnd', { index: i, ok: false, error: err.message });
      }
    }
    emit('batch:done', { results });
    return { ok: true, results };
  }
  finally {
    currentAbort = null;
  }
});

ipcMain.handle('download:cancel', () => {
  if (currentAbort) { currentAbort.abort(); return { ok: true }; }
  return { ok: false };
});
