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
  fetchCivitaiImage,
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
    width: 1000,
    height: 720,
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

  if (seg[0] === 'user' && seg[1]) {
    return { kind: 'user', username: decodeURIComponent(seg[1]) };
  }

  return { kind: 'unknown' };
}

// ---------- Download helpers ----------

function sanitizeName (s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

async function downloadStream (stream, filepath) {
  await mkdirp(path.dirname(filepath));
  const out = fs.createWriteStream(filepath);
  await pipeline(Readable.fromWeb(stream), out);
}

function emit (event, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, payload);
  }
}

async function downloadPost ({ postId, secretKey, downloadDir, subfolder, signal }) {
  emit('log', { level: 'info', msg: `Fetching post ${postId}...` });

  const postData = await getPost({ id: postId, secretKey, signal });
  if (postData?.error) {
    throw new Error(postData.error?.json?.message || 'Post request failed');
  }
  const post = postData?.result?.data?.json;
  if (!post) throw new Error('Post not found');

  const images = await getPostImageMeta({ postId, secretKey, signal });
  emit('log', { level: 'info', msg: `Post has ${images.length} media item(s)` });

  const cdnBase = await getCivitaiImageBase({ secretKey });
  const folderName = subfolder
    ? sanitizeName(subfolder)
    : `post_${postId}_${sanitizeName(post.title || '')}`.replace(/_+$/, '');
  const outDir = path.join(downloadDir, folderName);
  await mkdirp(outDir);

  // Save post metadata
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
      emit('progress', { current: i + 1, total: images.length, skipped: true, file: filename });
      saved++;
      continue;
    }

    emit('progress', { current: i + 1, total: images.length, file: filename });
    const body = await fetchCivitaiImage(url, { signal });
    if (!body) {
      emit('log', { level: 'warn', msg: `Skipped (fetch failed): ${filename}` });
      continue;
    }
    await downloadStream(body, filepath);
    saved++;
  }

  return { outDir, saved, total: images.length };
}

async function downloadModel ({ modelId, modelVersionId, secretKey, downloadDir, subfolder, signal }) {
  emit('log', { level: 'info', msg: `Fetching model ${modelId}...` });

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
  emit('log', { level: 'info', msg: `Version: ${version.name} — ${version.files?.length || 0} file(s)` });

  const files = version.files || [];
  let saved = 0;

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) break;
    const f = files[i];
    const filepath = path.join(outDir, sanitizeName(f.name));
    if (fs.existsSync(filepath)) {
      emit('progress', { current: i + 1, total: files.length, skipped: true, file: f.name });
      saved++;
      continue;
    }

    emit('progress', { current: i + 1, total: files.length, file: f.name });
    const fetchHeaders = secretKey ? { Authorization: `Bearer ${secretKey}` } : {};
    const resp = await fetch(f.downloadUrl, { headers: fetchHeaders, signal });
    if (resp.status !== 200) {
      emit('log', { level: 'warn', msg: `HTTP ${resp.status} for ${f.name}` });
      continue;
    }
    await downloadStream(resp.body, filepath);
    saved++;
  }

  // Also grab version preview images
  const imgs = version.images || [];
  if (imgs.length) {
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
        const resp = await fetch(img.url, {
          headers: { ...headers.sharedHeaders, ...headers.imageHeaders },
          signal
        });
        if (resp.status === 200) await downloadStream(resp.body, filepath);
      } catch { /* ignore */ }
    }
  }

  return { outDir, saved, total: files.length };
}

async function downloadSingleImage ({ imageId, secretKey, downloadDir, subfolder, signal }) {
  emit('log', { level: 'info', msg: `Resolving image ${imageId}...` });
  const url = `https://civitai.red/api/v1/images?imageId=${imageId}&limit=1`;
  const resp = await fetch(url, {
    headers: { ...headers.sharedHeaders, ...headers.jsonHeaders, Authorization: `Bearer ${secretKey}` },
    signal
  });
  const data = await resp.json();
  const item = data?.items?.[0];
  if (!item) throw new Error('Image not found (API may require post URL instead)');

  const outDir = path.join(downloadDir, subfolder ? sanitizeName(subfolder) : 'images');
  await mkdirp(outDir);
  const ext = item.type === 'video' ? '.mp4' : '.jpeg';
  const filepath = path.join(outDir, `${imageId}${ext}`);

  if (!fs.existsSync(filepath)) {
    const body = await fetchCivitaiImage(item.url, { signal });
    if (!body) throw new Error('Image fetch failed');
    await downloadStream(body, filepath);
  }

  fs.writeFileSync(path.join(outDir, `${imageId}.json`), JSON.stringify(item, null, 2));
  return { outDir, saved: 1, total: 1 };
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
  if (me?.error || !me?.username) {
    return { ok: false, error: me?.error?.message || 'Invalid key' };
  }
  return { ok: true, username: me.username };
});

ipcMain.handle('parseUrl', (_e, url) => parseCivitaiUrl(url));

ipcMain.handle('preview:fetch', async (_e, { url }) => {
  const cfg = loadGuiConfig();
  if (!cfg.secretKey) return { ok: false, error: 'API key not set' };

  const parsed = parseCivitaiUrl(url);
  if (parsed.kind === 'unknown') return { ok: false, error: 'URL not recognized' };

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
        return { id: img.id, type: img.type || 'image', thumb, full, width: img.width, height: img.height };
      });
      return {
        ok: true,
        kind: 'post',
        id: parsed.id,
        title: post.title || `Post #${parsed.id}`,
        username: post.user?.username || '',
        publishedAt: post.publishedAt,
        items,
        suggestedFolder: sanitizeName(`post_${parsed.id}_${post.title || ''}`.replace(/_+$/, ''))
      };
    }

    if (parsed.kind === 'model') {
      const model = await fetchModel(parsed.id);
      if (model?.error) throw new Error(model.error?.json?.message || 'Model request failed');
      if (!model?.modelVersions?.length) throw new Error('Model has no versions');
      const versions = model.modelVersions.map(v => ({
        id: v.id,
        name: v.name,
        baseModel: v.baseModel,
        files: (v.files || []).map(f => ({ name: f.name, size: f.sizeKB, type: f.type })),
        previews: (v.images || []).slice(0, 8).map(i => ({ url: i.url, type: i.type || 'image' }))
      }));
      return {
        ok: true,
        kind: 'model',
        id: parsed.id,
        title: model.name,
        modelType: model.type,
        creator: model.creator?.username || '',
        versions,
        selectedVersionId: parsed.modelVersionId || versions[0]?.id,
        suggestedFolder: sanitizeName(`model_${parsed.id}_${model.name || ''}`)
      };
    }

    if (parsed.kind === 'image') {
      const resp = await fetch(`https://civitai.red/api/v1/images?imageId=${parsed.id}&limit=1`, {
        headers: { ...headers.sharedHeaders, ...headers.jsonHeaders, Authorization: `Bearer ${cfg.secretKey}` }
      });
      const data = await resp.json();
      const item = data?.items?.[0];
      if (!item) throw new Error('Image not found');
      return {
        ok: true,
        kind: 'image',
        id: parsed.id,
        title: `Image #${parsed.id}`,
        items: [{ id: item.id, type: item.type || 'image', thumb: item.url, full: item.url, width: item.width, height: item.height }],
        suggestedFolder: 'images'
      };
    }

    return { ok: false, error: `Unsupported: ${parsed.kind}` };
  }
  catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('download:start', async (_e, { url, subfolder, modelVersionId }) => {
  if (currentAbort) return { ok: false, error: 'Another download is in progress' };

  const cfg = loadGuiConfig();
  if (!cfg.secretKey) return { ok: false, error: 'API key not set' };
  if (!cfg.downloadDir) return { ok: false, error: 'Download folder not set' };

  const parsed = parseCivitaiUrl(url);
  if (parsed.kind === 'unknown') return { ok: false, error: 'URL not recognized. Expected /posts/<id>, /models/<id> or /images/<id>' };

  currentAbort = new AbortController();
  const { signal } = currentAbort;
  try {
    emit('download:begin', { kind: parsed.kind });
    let result;
    if (parsed.kind === 'post') {
      result = await downloadPost({ postId: parsed.id, secretKey: cfg.secretKey, downloadDir: cfg.downloadDir, subfolder, signal });
    } else if (parsed.kind === 'model') {
      result = await downloadModel({ modelId: parsed.id, modelVersionId: modelVersionId || parsed.modelVersionId, secretKey: cfg.secretKey, downloadDir: cfg.downloadDir, subfolder, signal });
    } else if (parsed.kind === 'image') {
      result = await downloadSingleImage({ imageId: parsed.id, secretKey: cfg.secretKey, downloadDir: cfg.downloadDir, subfolder, signal });
    } else {
      throw new Error(`Unsupported kind: ${parsed.kind}`);
    }
    emit('download:end', { ok: true, ...result });
    return { ok: true, ...result };
  } catch (err) {
    emit('download:end', { ok: false, error: err.message });
    return { ok: false, error: err.message };
  } finally {
    currentAbort = null;
  }
});

ipcMain.handle('download:cancel', () => {
  if (currentAbort) { currentAbort.abort(); return { ok: true }; }
  return { ok: false };
});
