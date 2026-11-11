'use strict';
const $ = (s) => document.querySelector(s);
const P = new URLSearchParams(location.search);
const RULE_ID = 2000000000 + Math.floor(Math.random() * 100000000);
let parsed = null, aborter = null, running = false;
let converter = null, converterLoading = null;
const jobId = crypto.randomUUID();
const jobKey = 'hls-job:' + jobId;

const log = (t, cls) => { const el = $('#status'); el.textContent = t; el.className = cls || ''; };
const setDetail = (t) => { $('#detail').textContent = t; };
const updateJob = (data) => chrome.storage.session.set({ [jobKey]: { id: jobId, name: $('#fileName').textContent || 'HLS video', time: Date.now(), ...data } }).catch(() => {});

/* The fetches below come from this extension page, so give them the same Referer/Origin
   the real player would send. */
async function setReferer() {
  const page = P.get('r') || '';
  if (!/^https?:/i.test(page)) return;
  const headers = [{ header: 'referer', operation: 'set', value: page }];
  try { headers.push({ header: 'origin', operation: 'set', value: new URL(page).origin }); } catch { /* ignore */ }
  const dnr = chrome.declarativeNetRequest;
  const make = (h) => ({ id: RULE_ID, priority: 2, action: { type: 'modifyHeaders', requestHeaders: h },
    condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] } });
  await dnr.updateSessionRules({ removeRuleIds: [RULE_ID] });
  try { await dnr.updateSessionRules({ addRules: [make(headers)] }); }
  catch { await dnr.updateSessionRules({ addRules: [make(headers.slice(0, 1))] }); }
}
const clearRule = () => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] }).catch(() => {});
addEventListener('pagehide', clearRule);
addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });

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

async function getConverter() {
  if (!converterLoading) {
    converterLoading = (async () => {
      const instance = new FFmpegWASM.FFmpeg();
      await instance.load({
        coreURL: chrome.runtime.getURL('ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('ffmpeg-core.wasm')
      });
      converter = instance;
      return instance;
    })();
  }
  return converter || converterLoading;
}

async function remuxTs(blob) {
  const ffmpeg = await getConverter();
  await ffmpeg.writeFile('input.ts', new Uint8Array(await blob.arrayBuffer()));
  try {
    await ffmpeg.exec(['-i', 'input.ts', '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', 'output.mp4']);
  } catch (firstError) {
    await ffmpeg.deleteFile('output.mp4').catch(() => {});
    try {
      await ffmpeg.exec(['-i', 'input.ts', '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);
    } catch { throw firstError; }
  }
  const output = await ffmpeg.readFile('output.mp4');
  await ffmpeg.deleteFile('input.ts').catch(() => {});
  await ffmpeg.deleteFile('output.mp4').catch(() => {});
  return new Blob([output], { type: 'video/mp4' });
}

async function loadAndStart() {
  const url = P.get('u') || '';
  if (!/^https?:\/\//i.test(url)) return log('Invalid URL', 'err');

  const title = P.get('n') || '';
  const baseName = safeName(title.replace(/^Watching\s+/i, ''), 'video');
  $('#fileName').textContent = baseName;

  await setReferer();
  log('Loading playlist…');

  try {
    const { text, base } = await fetchPlaylist(url);
    let media;
    if (HLS.isMaster(text)) {
      const m = HLS.parseMaster(text, base);
      if (!m.variants.length) throw new Error('Playlist has no playable variants.');
      const v = m.variants[0]; // auto-select highest quality
      log('Loading selected quality…');
      const { text: vText, base: vBase } = await fetchPlaylist(v.url);
      media = HLS.parseMedia(vText, vBase);
    } else {
      media = HLS.parseMedia(text, base);
    }
    if (!media.segments.length) throw new Error('The playlist has no segments.');
    if (!media.ended) throw new Error('This looks like a live stream (no end marker), so it would never finish downloading.');

    log('Downloading segments…');
    updateJob({ state: 'downloading', done: 0, total: media.segments.length, message: 'Downloading segments' });

    const t0 = performance.now();
    const res = await HLS.downloadSegments(media, {
      fetchBuf, signal: aborter.signal, skipFailed: false, concurrency: 6,
      onProgress: (p) => {
        const percent = Math.round(p.done / p.total * 100);
        $('#bar').value = percent;
        log(`Downloading ${p.done} / ${p.total} segments (${percent}%)`);
        setDetail(`${fmtMB(p.bytes)} · ${fmtMB(p.bytes / ((performance.now() - t0) / 1000))}/s · ~${fmtTime(p.done ? ((performance.now() - t0) / 1000) * (p.total - p.done) / p.done : 0)} left`);
        updateJob({ state: 'downloading', done: p.done, total: p.total, bytes: p.bytes, message: 'Downloading segments' });
      }
    });

    log('Converting to MP4…');
    updateJob({ state: 'converting', done: res.parts.length, total: media.segments.length, message: 'Converting to MP4' });
    let blob = new Blob(res.parts, { type: media.map ? 'video/mp4' : 'video/mp2t' });
    if (!media.map) blob = await remuxTs(blob);

    const burl = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({ url: burl, filename: baseName + '.mp4', conflictAction: 'uniquify', saveAs: false });
    await chrome.storage.session.set({ ['ddm-download:' + id]: { id, url: baseName + '.mp4', time: Date.now() } });

    chrome.downloads.onChanged.addListener(function done(d) {
      if (d.id === id && d.state && (d.state.current === 'complete' || d.state.current === 'interrupted')) {
        chrome.downloads.onChanged.removeListener(done); URL.revokeObjectURL(burl);
      }
    });

    log('✓ Done! Saved to Downloads', 'ok');
    updateJob({ state: 'complete', done: media.segments.length, total: media.segments.length, message: 'Saved MP4' });

    // Auto-close after a short delay
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    const isCancelled = e.message === 'Cancelled' || aborter?.signal.aborted;
    log(isCancelled ? 'Cancelled' : 'Failed: ' + (e.message || e), 'err');
    updateJob({ state: isCancelled ? 'cancelled' : 'failed', message: e.message || String(e) });
  } finally {
    running = false; aborter = null;
  }
}

$('#cancel').addEventListener('click', () => aborter?.abort());
$('#closePopup').addEventListener('click', () => window.close());

// Auto-start when page loads with URL params
if (P.get('u')) {
  running = true; aborter = new AbortController();
  loadAndStart();
}