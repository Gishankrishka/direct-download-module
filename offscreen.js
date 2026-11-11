'use strict';
/* Offscreen document for HLS stream processing - runs in background, survives popup close */

let currentJob = null;
let aborter = null;
let running = false;
let ffmpeg = null;
let ffmpegLoading = null;

const RULE_ID = 2100000000 + Math.floor(Math.random() * 100000000); // different from popup's 2000...

function updateJob(data) {
  if (!currentJob) return;
  const key = 'hls-job:' + currentJob.id;
  chrome.storage.session.set({ [key]: { ...currentJob, ...data, time: Date.now() } }).catch(() => {});
}

async function getFfmpeg() {
  if (!ffmpegLoading) {
    ffmpegLoading = (async () => {
      const instance = new FFmpegWASM.FFmpeg();
      await instance.load({
        coreURL: chrome.runtime.getURL('ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('ffmpeg-core.wasm')
      });
      ffmpeg = instance;
      return instance;
    })();
  }
  return ffmpeg || ffmpegLoading;
}

async function setRefererRule(url, referrer) {
  if (!referrer || !/^https?:/i.test(referrer)) return null;
  const dnr = chrome.declarativeNetRequest;
  const regex = '^' + new URL(url).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  if (regex.length > 1900) return null;
  const headers = [{ header: 'referer', operation: 'set', value: referrer }];
  try {
    const origin = new URL(referrer).origin;
    headers.push({ header: 'origin', operation: 'set', value: origin });
  } catch { /* ignore */ }
  await dnr.updateSessionRules({ removeRuleIds: [RULE_ID] });
  await dnr.updateSessionRules({
    addRules: [{
      id: RULE_ID, priority: 2,
      action: { type: 'modifyHeaders', requestHeaders: headers },
      condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] }
    }]
  });
  return RULE_ID;
}

async function clearRefererRule() {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] }).catch(() => {});
}

async function fetchOk(url, range, signal) {
  const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
  const res = await fetch(url, { headers, credentials: 'include', cache: 'no-store', signal });
  if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
  return res;
}

async function fetchBuf(url, range) {
  let err;
  for (let a = 0; a < 4; a++) {
    if (aborter?.signal.aborted) throw new Error('Cancelled');
    try { return await (await fetchOk(url, range, aborter?.signal)).arrayBuffer(); }
    catch (e) { err = e; await new Promise((r) => setTimeout(r, 400 * (a + 1))); }
  }
  throw err;
}

async function fetchPlaylist(url) {
  const res = await fetchOk(url, null);
  const text = await res.text();
  if (!/^\s*#EXTM3U/.test(text)) throw new Error('That URL did not return an HLS playlist (no #EXTM3U header).');
  return { text, base: res.url || url };
}

const fmtTime = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + 'h ' : '') + m + 'm ' + (s % 60) + 's'; };
const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';
const withoutExtension = (name) => name.replace(/\.(?:mp4|ts|m4s|mkv|webm)$/i, '');
const safeName = (s, fallback) => (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[. ]+$/, '') || fallback || 'video';

function tsOffset(u8) {
  if (u8.length >= 376 && u8[0] === 0x47 && u8[188] === 0x47 && u8[376] === 0x47) return 0;
  const lim = Math.min(Math.max(0, u8.length - 377), 1 << 20);
  for (let i = 0; i <= lim; i++) if (u8[i] === 0x47 && u8[i + 188] === 0x47 && u8[i + 376] === 0x47) return i;
  return 0;
}

function cleanTs(buf) {
  const input = new Uint8Array(buf);
  const offset = tsOffset(input);
  if (input.length - offset < 188 || input[offset] !== 0x47) throw new Error('Segment is not valid MPEG-TS');
  const length = Math.floor((input.length - offset) / 188) * 188;
  return input.slice(offset, offset + length).buffer;
}

async function remuxTs(blob) {
  const instance = await getFfmpeg();
  await instance.writeFile('input.ts', new Uint8Array(await blob.arrayBuffer()));
  try {
    await instance.exec(['-i', 'input.ts', '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', 'output.mp4']);
  } catch (firstError) {
    await instance.deleteFile('output.mp4').catch(() => {});
    try {
      await instance.exec(['-i', 'input.ts', '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);
    } catch { throw firstError; }
  }
  const output = await instance.readFile('output.mp4');
  await instance.deleteFile('input.ts').catch(() => {});
  await instance.deleteFile('output.mp4').catch(() => {});
  return new Blob([output], { type: 'video/mp4' });
}

async function parseAttrs(s) {
  const o = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
}

function isMaster(text) { return /#EXT-X-STREAM-INF/.test(text); }

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [], audio = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = await parseAttrs(l.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (j < lines.length) {
        variants.push({
          url: new URL(lines[j], base).href,
          bandwidth: parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10),
          resolution: a.RESOLUTION || '', codecs: a.CODECS || '', audioGroup: a.AUDIO || ''
        });
        i = j;
      }
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = await parseAttrs(l.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) audio.push({ group: a['GROUP-ID'], name: a.NAME, url: new URL(a.URI, base).href });
    }
  }
  variants.sort((x, y) => y.bandwidth - x.bandwidth);
  return { variants, audio };
}

function toRange(spec, lastEnd, url) {
  const [len, off] = spec.split('@');
  const length = parseInt(len, 10);
  const start = off !== undefined ? parseInt(off, 10) : (lastEnd[url] || 0);
  lastEnd[url] = start + length;
  return { start, end: start + length - 1 };
}

function parseMedia(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let mediaSeq = 0, key = null, map = null, dur = 0, ended = false, range = null;
  const segments = [], lastEnd = {};
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSeq = parseInt(l.slice(22), 10) || 0;
    else if (l.startsWith('#EXT-X-ENDLIST')) ended = true;
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) range = l.slice(17);
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = await parseAttrs(l.slice(11));
      const method = (a.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') key = null;
      else if (method === 'AES-128' && a.URI) key = { uri: new URL(a.URI, base).href, iv: a.IV || null };
      else throw new Error('Unsupported encryption (' + method + '). Only unencrypted and AES-128 streams can be saved.');
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = await parseAttrs(l.slice(11));
      const url = new URL(a.URI, base).href;
      map = { url, range: a.BYTERANGE ? toRange(a.BYTERANGE, {}, url) : null };
    } else if (!l.startsWith('#')) {
      const url = new URL(l, base).href;
      let r = null;
      if (range) { r = toRange(range, lastEnd, url); range = null; }
      segments.push({ url, dur, seq: mediaSeq + segments.length, key, range: r });
      dur = 0;
    }
  }
  return { segments, map, ended, duration: segments.reduce((s, x) => s + x.dur, 0) };
}

async function ivBytes(key, seq) {
  const iv = new Uint8Array(16);
  if (key.iv) {
    const h = key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(h.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seq >>> 0);
  }
  return iv;
}

async function decrypt(buf, keyBytes, iv) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, buf);
}

async function downloadSegments(media, opt) {
  const { fetchBuf, onProgress, signal, skipFailed = false, concurrency = 6 } = opt;
  const segs = media.segments, n = segs.length;
  const out = new Array(n).fill(null), failed = [];
  const keyCache = new Map();
  const getKey = (uri) => {
    if (!keyCache.has(uri)) keyCache.set(uri, fetchBuf(uri).then((b) => new Uint8Array(b)));
    return keyCache.get(uri);
  };
  let next = 0, done = 0, bytes = 0, fatal = null;

  const parts = [];
  if (media.map) {
    const initBuf = await fetchBuf(media.map.url, media.map.range);
    parts.push(new Blob([initBuf]));
    bytes += initBuf.byteLength;
  }

  async function worker() {
    while (!fatal && !(signal && signal.aborted)) {
      const i = next++;
      if (i >= n) return;
      const s = segs[i];
      try {
        let buf = await fetchBuf(s.url, s.range);
        if (s.key) buf = await decrypt(buf, await getKey(s.key.uri), await ivBytes(s.key, s.seq));
        if (!media.map) buf = cleanTs(buf);
        out[i] = new Blob([buf]);
        bytes += buf.byteLength;
      } catch (e) {
        if (signal && signal.aborted) return;
        if (skipFailed) failed.push(i + 1);
        else { fatal = new Error('Segment ' + (i + 1) + ' failed: ' + (e.message || e)); return; }
      }
      done++;
      if (onProgress) onProgress({ done, total: n, bytes, failed: failed.length });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, n)) }, worker));
  if (signal && signal.aborted) throw new Error('Cancelled');
  if (fatal) throw fatal;
  for (const b of out) if (b) parts.push(b);
  return { parts, failed };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'startHlsDownload') {
    handleHlsDownload(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'cancelHlsDownload') {
    if (aborter) aborter.abort();
    sendResponse({ ok: true });
    return true;
  }
});

async function handleHlsDownload(params) {
  if (running) return { ok: false, error: 'Already running' };
  running = true;
  aborter = new AbortController();

  currentJob = {
    id: params.jobId,
    name: params.name,
    state: 'downloading',
    done: 0,
    total: 0,
    message: 'Preparing stream'
  };
  updateJob({ state: 'downloading', done: 0, total: 0, message: 'Preparing stream' });

  try {
    await setRefererRule(params.url, params.referrer);

    let media;
    const { text, base } = await fetchPlaylist(params.url);
    if (isMaster(text)) {
      updateJob({ message: 'Loading selected quality…' });
      const master = await parseMaster(text, base);
      if (!master.variants.length) throw new Error('Playlist has no playable variants.');
      const v = master.variants[params.qualityIndex || 0];
      const { text: vText, base: vBase } = await fetchPlaylist(v.url);
      media = await parseMedia(vText, vBase);
    } else {
      media = await parseMedia(text, base);
    }

    if (!media.segments.length) throw new Error('The playlist has no segments.');
    if (!media.ended) throw new Error('This looks like a live stream (no end marker), so it would never finish downloading.');

    currentJob.total = media.segments.length;
    updateJob({ total: media.segments.length, message: 'Downloading segments' });

    const t0 = performance.now();
    const res = await downloadSegments(media, {
      fetchBuf, signal: aborter.signal, skipFailed: params.skipFailed, concurrency: 6,
      onProgress: (p) => {
        updateJob({
          state: 'downloading',
          done: p.done,
          total: p.total,
          bytes: p.bytes,
          failed: p.failed,
          message: 'Downloading segments'
        });
      }
    });

    const baseName = safeName(withoutExtension(params.name), 'video');
    let blob = new Blob(res.parts, { type: media.map ? 'video/mp4' : 'video/mp2t' });
    if (!media.map) {
      updateJob({ state: 'converting', done: res.parts.length, total: media.segments.length, message: 'Converting to MP4' });
      blob = await remuxTs(blob);
    }

    const burl = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({ url: burl, filename: baseName + '.mp4', conflictAction: 'uniquify', saveAs: false });
    await chrome.storage.session.set({ ['ddm-download:' + id]: { id, url: baseName + '.mp4', time: Date.now() } });

    chrome.downloads.onChanged.addListener(function done(d) {
      if (d.id === id && d.state && (d.state.current === 'complete' || d.state.current === 'interrupted')) {
        chrome.downloads.onChanged.removeListener(done);
        URL.revokeObjectURL(burl);
      }
    });

    updateJob({
      state: 'complete',
      done: media.segments.length,
      total: media.segments.length,
      message: 'Saved MP4'
    });

    return { ok: true, id, name: baseName + '.mp4', size: blob.size };
  } catch (e) {
    const isCancelled = e.message === 'Cancelled' || aborter?.signal.aborted;
    updateJob({
      state: isCancelled ? 'cancelled' : 'failed',
      message: e.message || String(e)
    });
    return { ok: false, error: e.message || String(e) };
  } finally {
    running = false;
    aborter = null;
    await clearRefererRule();
  }
}

// Keep the offscreen document alive
chrome.runtime.onConnect.addListener(() => {});