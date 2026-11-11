'use strict';
const $ = (s) => document.querySelector(s);
const P = new URLSearchParams(location.search);
const RULE_ID = 2000000000 + Math.floor(Math.random() * 100000000); // outside the range background.js purges
let parsed = null, aborter = null, running = false;
let converter = null, converterLoading = null;
const jobId = crypto.randomUUID();
const jobKey = 'hls-job:' + jobId;

const log = (t, cls) => { const el = $('#log'); el.textContent = t; el.className = cls || ''; };
const updateJob = (data) => chrome.storage.session.set({ [jobKey]: { id: jobId, name: $('#name').value || 'HLS video', time: Date.now(), ...data } }).catch(() => {});

/* The fetches below come from this extension page, so give them the same Referer/Origin
   the real player would send. */
async function setReferer() {
  const page = $('#referer').value.trim();
  const headers = [];
  if (/^https?:/i.test(page)) {
    headers.push({ header: 'referer', operation: 'set', value: page });
    try { headers.push({ header: 'origin', operation: 'set', value: new URL(page).origin }); } catch { /* ignore */ }
  }
  const dnr = chrome.declarativeNetRequest;
  const make = (h) => ({ id: RULE_ID, priority: 2, action: { type: 'modifyHeaders', requestHeaders: h },
    condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] } });
  await dnr.updateSessionRules({ removeRuleIds: [RULE_ID] });
  if (!headers.length) return;
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

async function load() {
  const url = $('#url').value.trim();
  if (!/^https?:\/\//i.test(url)) return log('Enter a valid http(s) playlist URL.', 'err');
  $('#load').disabled = true; $('#opts').hidden = true; log('Loading playlist…');
  try {
    await setReferer();
    const { text, base } = await fetchPlaylist(url);
    if (HLS.isMaster(text)) {
      const m = HLS.parseMaster(text, base);
      if (!m.variants.length) throw new Error('Playlist has no playable variants.');
      parsed = { master: m };
      const sel = $('#quality'); sel.textContent = '';
      m.variants.forEach((v, i) => {
        const o = document.createElement('option');
        o.value = i; o.textContent = [v.resolution, Math.round(v.bandwidth / 1000) + ' kbps'].filter(Boolean).join(' · ');
        sel.append(o);
      });
      $('#quality').parentElement.hidden = false;
      $('#info').textContent = m.variants.length + ' quality option(s)';
      if (m.audio.length) log('Note: this stream keeps audio in a separate track; only the video track is downloaded here. If the result has no sound, use the yt-dlp command from the extension popup instead.', 'muted');
      else log('');
    } else {
      const media = HLS.parseMedia(text, base);
      parsed = { media };
      $('#quality').parentElement.hidden = true;
      $('#info').textContent = media.segments.length + ' segments · ' + fmtTime(media.duration);
      log('');
    }
    $('#opts').hidden = false;
  } catch (e) {
    const detail = e.message || e;
    const hint = /^HTTP 404$/.test(detail)
      ? 'The playlist URL has expired or is no longer valid. Close this tab, reload the video page, start playback again, and open Download.'
      : 'If this says "Failed to fetch", the host name may not resolve on your network or the link has expired.';
    log('Could not load playlist: ' + detail + '\n\n' + hint, 'err');
  }
  $('#load').disabled = false;
}

async function start() {
  if (running) return;
  running = true;
  const jobId = crypto.randomUUID();
  const jobKey = 'hls-job:' + jobId;

  // Initialize job in storage
  const initialJob = {
    id: jobId,
    name: $('#name').value || 'HLS video',
    time: Date.now(),
    state: 'starting',
    done: 0,
    total: 0,
    message: 'Sending to background…'
  };
  await chrome.storage.session.set({ [jobKey]: initialJob });

  $('#start').disabled = true; $('#cancel').hidden = false; $('#bar').hidden = false; $('#bar').value = 0;
  log('Starting download in background…');

  const params = {
    jobId,
    url: $('#url').value.trim(),
    referrer: $('#referer').value.trim(),
    name: $('#name').value.trim(),
    qualityIndex: parseInt($('#quality').value || '0', 10),
    skipFailed: $('#skip').checked
  };

  try {
    const response = await chrome.runtime.sendMessage({ type: 'startHlsDownload', ...params });
    if (!response.ok) throw new Error(response.error || 'Failed to start download');
    log('Download started in background. You can close this window.', 'ok');
    // Poll job status from storage
    pollJobStatus(jobKey);
  } catch (e) {
    log('Failed to start: ' + (e.message || e), 'err');
    await chrome.storage.session.set({ [jobKey]: { ...initialJob, state: 'failed', message: e.message || String(e) } });
  } finally {
    running = false; $('#start').disabled = false; $('#cancel').hidden = true;
  }
}

function pollJobStatus(jobKey) {
  const check = async () => {
    const data = await chrome.storage.session.get(jobKey);
    const job = data[jobKey];
    if (!job) return;

    // Update UI with job status
    if (job.done && job.total) {
      $('#bar').value = Math.round(job.done / job.total * 100);
    }
    if (job.message) {
      log(job.message);
    }
    if (job.state === 'downloading' || job.state === 'converting') {
      setTimeout(check, 1000);
    } else if (job.state === 'complete') {
      log('✓ Download complete! Saved to Downloads folder.', 'ok');
      $('#bar').value = 100;
    } else if (job.state === 'failed' || job.state === 'cancelled') {
      log('Download ' + job.state + ': ' + (job.message || ''), 'err');
    }
  };
  check();
}

$('#load').addEventListener('click', load);
$('#start').addEventListener('click', start);
$('#cancel').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cancelHlsDownload' }));
$('#dashboard').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openDashboard' }));
$('#closePopup').addEventListener('click', () => window.close());
$('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

$('#url').value = P.get('u') || '';
$('#referer').value = P.get('r') || '';
$('#name').value = HLS.safeName((P.get('n') || '').replace(/^Watching\s+/i, ''), 'video');
if ($('#url').value) {
  load().then(() => { if (P.get('auto') === '1' && parsed && parsed.media && !$('#opts').hidden) start(); });
}