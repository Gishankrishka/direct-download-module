'use strict';
importScripts('hls-core.js'); // defines self.HLS

/* =====================================================================
 * Direct Download Module - service worker
 * Replaces the IDM bridge: every download goes through chrome.downloads,
 * i.e. straight to the local Downloads folder. No external app needed.
 * ===================================================================== */

const DEFAULTS = { saveAs: false };
const getSettings = () => chrome.storage.local.get(DEFAULTS);
let extensionEnabled = true;
chrome.storage.local.get({ enabled: true }).then((settings) => { extensionEnabled = settings.enabled !== false; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) extensionEnabled = changes.enabled.newValue !== false;
});

const isHttp = (u) => /^(https?|ftp):/i.test(u || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function stripHash(u) { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } }

/* ---------------------------------------------------------------------
 * Offscreen document port for HLS processing
 * ------------------------------------------------------------------- */
let offscreenPort = null;
let offscreenPortReady = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen') {
    offscreenPort = port;
    if (offscreenPortReady) offscreenPortReady.resolve(port);
    port.onDisconnect.addListener(() => {
      if (offscreenPort === port) offscreenPort = null;
    });
  }
});

async function getOffscreenPort() {
  if (offscreenPort) return offscreenPort;
  // Create offscreen document if needed
  const hasDoc = await chrome.offscreen.hasDocument();
  if (!hasDoc) {
    try {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        reasons: ['WORKERS', 'IFRAME_SCRIPTING'],
        justification: 'HLS stream download processing'
      });
    } catch (e) {
      console.error('Failed to create offscreen document:', e);
      return null;
    }
  }
  // Wait for offscreen document to connect with timeout
  offscreenPortReady = {};
  offscreenPortReady.promise = new Promise((resolve) => { offscreenPortReady.resolve = resolve; });
  try {
    return await Promise.race([
      offscreenPortReady.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Offscreen connection timeout')), 10000))
    ]);
  } catch (e) {
    console.error('Offscreen port connection failed:', e);
    return null;
  }
}

/* ---------------------------------------------------------------------
 * Referer support. chrome.downloads can't set a Referer header, but many
 * hosts require one, so we add a short-lived session rule for that URL.
 * Rule ids are epoch seconds, so stale ones can be recognised and purged.
 * ------------------------------------------------------------------- */
let lastRuleId = 0;

async function purgeOldRules() {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const old = rules.filter((r) => r.id < nowSec - 120).map((r) => r.id);
    if (old.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old });
  } catch { /* ignore */ }
}
purgeOldRules();

async function addRefererRule(url, referrer) {
  if (!referrer || !isHttp(referrer)) return null;
  const regex = '^' + stripHash(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  if (regex.length > 1900) return null; // RE2 / DNR size limit
  let id = Math.floor(Date.now() / 1000);
  if (id <= lastRuleId) id = lastRuleId + 1;
  lastRuleId = id;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referrer }] },
      condition: { regexFilter: regex, resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'other'] }
    }]
  });
  return id;
}

const dropRule = (id) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
const trackDownload = (id, url) => chrome.storage.session.set({ ['ddm-download:' + id]: { id, url, time: Date.now() } }).catch(() => {});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && ['complete', 'interrupted'].includes(delta.state.current)) {
    chrome.storage.session.remove('ddm-download:' + delta.id).catch(() => {});
  }
});

/* ---------------------------------------------------------------------
 * The one place a download actually starts.
 * ------------------------------------------------------------------- */
async function startDownload(url, { referrer = null, saveAs } = {}) {
  if (!isHttp(url)) throw new Error('Unsupported URL (only http, https and ftp can be downloaded): ' + String(url).slice(0, 80));
  const settings = await getSettings();
  const ruleId = await addRefererRule(url, referrer).catch(() => null);
  try {
    const id = await chrome.downloads.download({
      url,
      conflictAction: 'uniquify',
      saveAs: saveAs ?? settings.saveAs
    });
    trackDownload(id, url);
    return id;
  } finally {
    if (ruleId) setTimeout(() => dropRule(ruleId), 20000);
  }
}

const M3U8 = /m3u8/i;
function openHls(url, page, title, auto) {
  const q = new URLSearchParams({ u: url, r: page || '', n: title || '' });
  if (auto) q.set('auto', '1');
  return chrome.windows.create({
    url: chrome.runtime.getURL('hls.html?' + q), type: 'popup', width: 900, height: 760, focused: true
  });
}
/* Plain files go to the browser's download engine; HLS playlists go to the stream downloader. */
async function smartDownload(url, referrer, title) {
  let path = '';
  try { path = new URL(url).pathname; } catch { /* ignore */ }
  if (M3U8.test(path)) { await openHls(url, referrer, title); return; }
  await startDownload(url, { referrer });
}

/* ---------------------------------------------------------------------
 * Reading HLS playlists ahead of time so the on-video menu can list qualities.
 * ------------------------------------------------------------------- */
const expandCache = new Map();

async function fetchPlaylistText(url, referrer) {
  const id = 2100000000 + Math.floor(Math.random() * 40000000); // never purged by purgeOldRules
  const dnr = chrome.declarativeNetRequest;
  const mk = (h) => ({ id, priority: 1, action: { type: 'modifyHeaders', requestHeaders: h },
    condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] } });
  let added = false;
  if (referrer && isHttp(referrer)) {
    const h = [{ header: 'referer', operation: 'set', value: referrer }];
    try { await dnr.updateSessionRules({ addRules: [mk(h.concat({ header: 'origin', operation: 'set', value: new URL(referrer).origin }))] }); added = true; }
    catch { try { await dnr.updateSessionRules({ addRules: [mk(h)] }); added = true; } catch { /* ignore */ } }
  }
  const candidates = [url];
  try {
    const parsed = new URL(url);
    for (const key of ['url', 'src', 'source', 'stream', 'target']) {
      const value = parsed.searchParams.get(key);
      if (value && isHttp(value) && !candidates.includes(value)) candidates.push(value);
    }
  } catch { /* use the original URL */ }
  let lastError = null;
  try {
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        if (/^\s*#EXTM3U/.test(text)) return { text, base: res.url || candidate };
        lastError = new Error('That URL did not return an HLS playlist');
      } catch (e) { lastError = e; }
    }
    throw lastError || new Error('Playlist request failed');
  } finally {
    if (added) dnr.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
}

async function expandHls(url, page) {
  const hit = expandCache.get(url);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.data;
  let data;
  try {
    const { text, base } = await fetchPlaylistText(url, page);
    if (!/^\s*#EXTM3U/.test(text)) throw new Error('not an HLS playlist');
    if (HLS.isMaster(text)) {
      const m = HLS.parseMaster(text, base);
      data = {
        url, master: true,
        variants: m.variants.map((v) => {
          const h = parseInt(/x(\d+)/.exec(v.resolution)?.[1] || '0', 10);
          return {
            url: v.url, bandwidth: v.bandwidth, height: h,
            label: (h ? h + 'p' : 'Stream') + (v.bandwidth ? ' · ' + Math.round(v.bandwidth / 1000) + ' kbps' : ''),
            videoOnly: !!v.audioGroup && m.audio.some((a) => a.group === v.audioGroup)
          };
        })
      };
    } else {
      const med = HLS.parseMedia(text, base);
      data = { url, master: false, variants: [{ url, label: 'Original quality', duration: med.duration, live: !med.ended }] };
    }
  } catch (e) {
    data = { url, master: false, error: String(e?.message || e), variants: [] };
  }
  expandCache.set(url, { t: Date.now(), data });
  return data;
}

async function getOptions(sender, msg) {
  const tabId = sender.tab?.id;
  const page = msg.pageUrl || sender.tab?.url || '';
  const list = tabId == null ? [] : await getMedia(tabId);
  const files = list.filter((e) => e.kind === 'file').map((e) => ({ url: e.url, mime: e.mime, size: e.size }));
  const dash = list.filter((e) => e.kind === 'stream' && !e.hls).slice(0, 2).map((e) => ({ url: e.url, cmd: ytdlpCmd(e.url, page) }));
  const hlsEntries = list.filter((e) => e.kind === 'stream' && e.hls)
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_PER_TAB);
  const expanded = await Promise.all(hlsEntries.map((e) => expandHls(e.url, page)));
  const usable = expanded.filter((x) => !x.error);
  const candidates = usable.length ? usable : expanded;
  const inMaster = new Set(candidates.filter((x) => x.master).flatMap((x) => x.variants.map((v) => v.url)));
  const streams = candidates.filter((x) => x.master || !inMaster.has(x.url));
  return { ok: true, files, streams, dash, title: sender.tab?.title || '', page };
}

/* ---------------------------------------------------------------------
 * Media sniffing (what IDM's "Download this video" panel is based on)
 * ------------------------------------------------------------------- */
const MEDIA_EXT = /\.(mp4|m4v|m4a|webm|mkv|mov|avi|flv|wmv|mp3|aac|ogg|oga|ogv|opus|wav|flac|3gp)$/i;
const STREAM_EXT = /\.(m3u8|mpd)$/i;
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa|vtt|webvtt)$/i;
const MIN_FILE_SIZE = 100 * 1024;
const MAX_PER_TAB = 40;

const header = (hs, name) => (hs || []).find((h) => h.name.toLowerCase() === name)?.value || '';

function normaliseMediaUrl(u) {
  try {
    const x = new URL(u);
    for (const p of ['range', 'rn', 'rbuf', 'bytestart', 'byteend']) x.searchParams.delete(p);
    x.hash = '';
    return x.href;
  } catch { return u; }
}

let mediaQueue = Promise.resolve();
const queueMedia = (fn) => (mediaQueue = mediaQueue.then(fn).catch(() => {}));

function setBadge(tabId, n) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode < 200 || d.statusCode >= 300) return;
  if (d.type === 'image' || d.type === 'stylesheet' || d.type === 'script' || d.type === 'font') return;

  let path;
  try { path = new URL(d.url).pathname; } catch { return; }
  if (SEGMENT_EXT.test(path)) return;

  const mime = header(d.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
  if (mime === 'video/mp2t') return;

  let kind = null;
  if (/mpegurl|dash\+xml/.test(mime) || STREAM_EXT.test(path)
      || (M3U8.test(d.url) && /^(xmlhttprequest|other|media)$/.test(d.type))) kind = 'stream';
  else if (/^(video|audio)\//.test(mime)) kind = 'file';
  else if (/octet-stream/.test(mime) && MEDIA_EXT.test(path)) kind = 'file';
  if (!kind) return;

  const total = /\/(\d+)\s*$/.exec(header(d.responseHeaders, 'content-range'))?.[1];
  const size = parseInt(total || header(d.responseHeaders, 'content-length'), 10) || 0;
  if (kind === 'file' && size && size < MIN_FILE_SIZE) return;

  const url = normaliseMediaUrl(d.url);
  const tabId = d.tabId;
  const hls = kind === 'stream' && (/mpegurl/.test(mime) || M3U8.test(d.url));

  queueMedia(async () => {
    const key = 'media:' + tabId;
    const list = (await chrome.storage.session.get(key))[key] || [];
    const existing = list.find((e) => e.url === url);
    if (existing) {
      if (size > existing.size) { existing.size = size; await chrome.storage.session.set({ [key]: list }); }
      return;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    list.unshift({ url, kind, hls, mime, size, page: tab?.url || '', title: tab?.title || '', time: Date.now() });
    list.length = Math.min(list.length, MAX_PER_TAB);
    await chrome.storage.session.set({ [key]: list });
    setBadge(tabId, list.length);
  });
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0 || d.transitionType === 'auto_subframe') return;
  queueMedia(() => chrome.storage.session.remove('media:' + d.tabId));
  setBadge(d.tabId, 0);
});
chrome.tabs.onRemoved.addListener((tabId) => queueMedia(() => chrome.storage.session.remove('media:' + tabId)));

async function getMedia(tabId) {
  const key = 'media:' + tabId;
  return (await chrome.storage.session.get(key))[key] || [];
}

async function pickMedia(tabId) {
  const list = await getMedia(tabId);
  const files = list.filter((e) => e.kind === 'file');
  const video = files.filter((e) => /^video\//.test(e.mime) || /\.(mp4|m4v|webm|mkv|mov|avi|flv|wmv|3gp)(\?|$)/i.test(e.url));
  const best = (arr) => arr.slice().sort((a, b) => b.size - a.size)[0];
  return { file: best(video) || best(files) || null, stream: list.find((e) => e.kind === 'stream') || null };
}

const ytdlpCmd = (url, page) => `yt-dlp ${page ? '--referer ' + shq(page) + ' ' : ''}${shq(url)}`;

/* ---------------------------------------------------------------------
 * "Download all / selected links" - gather links, show a picker page
 * ------------------------------------------------------------------- */
function gatherLinks(selectedOnly) {
  const out = [];
  const sel = window.getSelection();
  if (selectedOnly && (!sel || sel.isCollapsed)) return out;
  const add = (url, text, kind) => { if (url) out.push({ url, text: (text || '').replace(/\s+/g, ' ').trim().slice(0, 160), kind }); };
  for (const a of document.querySelectorAll('a[href]')) {
    if (selectedOnly && !sel.containsNode(a, true)) continue;
    add(a.href, a.textContent || a.title || a.getAttribute('aria-label'), 'link');
  }
  if (!selectedOnly) {
    for (const el of document.querySelectorAll('img[src], video[src], audio[src], source[src], embed[src]')) {
      add(el.src, el.alt || el.title, el.localName);
    }
  }
  return out;
}

function alertInTab(tabId, message) {
  if (tabId == null) return;
  chrome.scripting.executeScript({ target: { tabId }, func: (m) => alert(m), args: [message] }).catch(() => {});
}

async function openLinkPicker(tab, selectedOnly) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true }, func: gatherLinks, args: [!!selectedOnly]
  });
  const seen = new Set();
  const items = [];
  for (const r of results) {
    for (const it of r.result || []) {
      if (!isHttp(it.url)) continue;
      const k = stripHash(it.url);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
    }
  }
  if (!items.length) {
    alertInTab(tab.id, selectedOnly
      ? 'No links found in the selection.'
      : 'Cannot find any links. If this page does have links, refresh it and try again.');
    return;
  }
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ ['links:' + id]: { pageUrl: tab.url, title: tab.title, selectedOnly: !!selectedOnly, items } });
  await chrome.tabs.create({ url: chrome.runtime.getURL('links.html?id=' + id), index: tab.index + 1 });
}

/* ---------------------------------------------------------------------
 * Context menus
 * ------------------------------------------------------------------- */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ddm-link', title: 'Download directly', contexts: ['link', 'image', 'video', 'audio'] });
    chrome.contextMenus.create({ id: 'ddm-page', title: 'Download this page directly', contexts: ['page', 'frame'] });
    chrome.contextMenus.create({ id: 'ddm-selected', title: 'Download selected links', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'ddm-all', title: 'Download all links on this page', contexts: ['page', 'frame'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    switch (info.menuItemId) {
      case 'ddm-link':
        await smartDownload(info.linkUrl || info.srcUrl, info.pageUrl, tab?.title);
        break;
      case 'ddm-page':
        await startDownload(info.frameUrl && info.frameUrl !== 'about:blank' ? info.frameUrl : info.pageUrl);
        break;
      case 'ddm-selected': await openLinkPicker(tab, true); break;
      case 'ddm-all': await openLinkPicker(tab, false); break;
    }
  } catch (e) {
    alertInTab(tab?.id, 'Direct Download Module: ' + (e.message || e));
  }
});

/* ---------------------------------------------------------------------
 * Messages from popup / content script / link picker
 * ------------------------------------------------------------------- */
async function handle(msg, sender) {
  if (!extensionEnabled && msg.type !== 'refreshMedia') return { ok: false, error: 'Extension is disabled.' };
  switch (msg.type) {
    case 'download': { // batch from link picker
      let ok = 0; const failed = [];
      for (const it of msg.items || []) {
        try { await startDownload(it.url, { referrer: it.referrer, saveAs: false }); ok++; }
        catch { failed.push(it.url); }
        await sleep(100);
      }
      return { ok: failed.length === 0, started: ok, failed };
    }
    case 'downloadUrl':
      await smartDownload(msg.url, msg.referrer || null, msg.title);
      return { ok: true };

    case 'openHls':
      await openHls(msg.url || '', msg.page || '', msg.title || '', !!msg.auto);
      return { ok: true };

    case 'startHlsDownload': {
      // Create offscreen document if needed and get port
      const port = await getOffscreenPort();
      if (!port) return { ok: false, error: 'Failed to connect to offscreen document' };
      // Send message via port
      return new Promise((resolve) => {
        port.onMessage.addListener(function listener(response) {
          port.onMessage.removeListener(listener);
          resolve(response);
        });
        port.postMessage(msg);
      });
    }

    case 'cancelHlsDownload': {
      // Forward cancel via port
      const port = await getOffscreenPort();
      if (!port) return { ok: false, error: 'Failed to connect to offscreen document' };
      return new Promise((resolve) => {
        port.onMessage.addListener(function listener(response) {
          port.onMessage.removeListener(listener);
          resolve(response);
        });
        port.postMessage(msg);
      });
    }

    case 'openDashboard':
      await chrome.tabs.create({ url: chrome.runtime.getURL('downloads.html') });
      return { ok: true };

    case 'refreshMedia': {
      const tabId = Number.isInteger(msg.tabId) ? msg.tabId : sender.tab?.id;
      if (Number.isInteger(tabId)) {
        expandCache.clear();
        await chrome.storage.session.remove('media:' + tabId);
        setBadge(tabId, 0);
      }
      return { ok: true };
    }

      case 'rememberMedia': {
        if (!isHttp(msg.url)) return { ok: false };
        const tabId = sender.tab?.id;
        if (!Number.isInteger(tabId)) return { ok: false };
        const key = 'media:' + tabId;
        const list = (await chrome.storage.session.get(key))[key] || [];
        const url = normaliseMediaUrl(msg.url);
        if (!list.some((item) => item.url === url)) {
          list.unshift({ url, kind: 'stream', hls: /\.m3u8(?:[?#]|$)/i.test(url), mime: '', size: 0,
            page: msg.pageUrl || '', title: sender.tab?.title || '', time: Date.now() });
          list.length = Math.min(list.length, MAX_PER_TAB);
          await chrome.storage.session.set({ [key]: list });
          setBadge(tabId, list.length);
        }
        return { ok: true };
      }

    case 'getOptions':
      return getOptions(sender, msg);

    case 'pickLinks': {
      const tab = await chrome.tabs.get(msg.tabId);
      await openLinkPicker(tab, !!msg.selectedOnly);
      return { ok: true };
    }
    case 'videoDownload': {
      const tabId = sender.tab?.id;
      const page = msg.pageUrl || sender.tab?.url || null;
      const src = msg.src || '';
      let direct = false;
      try { direct = isHttp(src) && !STREAM_EXT.test(new URL(src).pathname); } catch { /* ignore */ }
      if (direct) { await startDownload(src, { referrer: page }); return { ok: true }; }
      if (isHttp(src) && M3U8.test(src)) { await openHls(src, page, sender.tab?.title); return { ok: true, hls: true }; }
      const pick = await pickMedia(tabId);
      if (pick.file) { await startDownload(pick.file.url, { referrer: page }); return { ok: true }; }
      if (pick.stream?.hls) { await openHls(pick.stream.url, page, sender.tab?.title); return { ok: true, hls: true }; }
      if (pick.stream) return { ok: false, stream: true, cmd: ytdlpCmd(pick.stream.url, page) };
      return { ok: false, error: 'No downloadable media detected yet. Press play for a moment, then try again.' };
    }
  }
  return { ok: false, error: 'Unknown message' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});