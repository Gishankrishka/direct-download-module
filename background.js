'use strict';

/* =====================================================================
 * Direct Download Module - service worker
 * Replaces the IDM bridge: every download goes through chrome.downloads,
 * i.e. straight to the local Downloads folder. No external app needed.
 * ===================================================================== */

const DEFAULTS = { saveAs: false };
const getSettings = () => chrome.storage.local.get(DEFAULTS);

const isHttp = (u) => /^(https?|ftp):/i.test(u || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function stripHash(u) { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } }

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

/* ---------------------------------------------------------------------
 * The one place a download actually starts.
 * ------------------------------------------------------------------- */
async function startDownload(url, { referrer = null, saveAs } = {}) {
  if (!isHttp(url)) throw new Error('Unsupported URL (only http, https and ftp can be downloaded): ' + String(url).slice(0, 80));
  const settings = await getSettings();
  const ruleId = await addRefererRule(url, referrer).catch(() => null);
  try {
    return await chrome.downloads.download({
      url,
      conflictAction: 'uniquify',
      saveAs: saveAs ?? settings.saveAs
    });
  } finally {
    if (ruleId) setTimeout(() => dropRule(ruleId), 20000);
  }
}

const M3U8 = /m3u8/i;
function openHls(url, page, title, auto) {
  const q = new URLSearchParams({ u: url, r: page || '', n: title || '' });
  if (auto) q.set('auto', '1');
  return chrome.tabs.create({ url: chrome.runtime.getURL('hls.html?' + q) });
}
/* Plain files go to the browser's download engine; HLS playlists go to the stream downloader. */
async function smartDownload(url, referrer, title) {
  let path = '';
  try { path = new URL(url).pathname; } catch { /* ignore */ }
  if (M3U8.test(path)) { await openHls(url, referrer, title); return; }
  await startDownload(url, { referrer });
}

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

    case 'pickLinks': {
      const tab = await chrome.tabs.get(msg.tabId);
      await openLinkPicker(tab, !!msg.selectedOnly);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Unknown message' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});