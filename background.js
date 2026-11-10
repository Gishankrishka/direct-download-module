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
 * Messages from popup / content script
 * ------------------------------------------------------------------- */
async function handle(msg, sender) {
  switch (msg.type) {
    case 'downloadUrl':
      await smartDownload(msg.url, msg.referrer || null, msg.title);
      return { ok: true };
  }
  return { ok: false, error: 'Unknown message' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});