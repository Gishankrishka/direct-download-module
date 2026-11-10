'use strict';
const $ = (s) => document.querySelector(s);
const P = new URLSearchParams(location.search);
const RULE_ID = 2000000000 + Math.floor(Math.random() * 100000000); // outside the range background.js purges
let parsed = null, aborter = null, running = false;

const log = (t, cls) => { const el = $('#log'); el.textContent = t; el.className = cls || ''; };

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
  running = true; aborter = new AbortController();
  $('#start').disabled = true; $('#cancel').hidden = false; $('#bar').hidden = false; $('#bar').value = 0;
  try {
    await setReferer();
    let media = parsed.media;
    if (parsed.master) {
      const v = parsed.master.variants[$('#quality').value || 0];
      log('Loading selected quality…');
      const { text, base } = await fetchPlaylist(v.url);
      media = HLS.parseMedia(text, base);
    }
    if (!media.segments.length) throw new Error('The playlist has no segments.');
    if (!media.ended) throw new Error('This looks like a live stream (no end marker), so it would never finish downloading.');

    const t0 = performance.now();
    const res = await HLS.downloadSegments(media, {
      fetchBuf, signal: aborter.signal, skipFailed: $('#skip').checked, concurrency: 6,
      onProgress: (p) => {
        $('#bar').value = (p.done / p.total) * 100;
        const rate = p.bytes / ((performance.now() - t0) / 1000);
        const eta = p.done ? ((performance.now() - t0) / 1000) * (p.total - p.done) / p.done : 0;
        log(`${p.done} / ${p.total} segments · ${fmtMB(p.bytes)} · ${fmtMB(rate)}/s · ~${fmtTime(eta)} left` + (p.failed ? ` · ${p.failed} skipped` : ''));
      }
    });

    const base = HLS.safeName(withoutExtension($('#name').value.trim()), 'video');
    const blob = new Blob(res.parts, { type: media.map ? 'video/mp4' : 'video/mp2t' });
    const burl = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({ url: burl, filename: base + (media.map ? '.mp4' : '.ts'), conflictAction: 'uniquify', saveAs: false });
    chrome.downloads.onChanged.addListener(function done(d) {
      if (d.id === id && d.state && (d.state.current === 'complete' || d.state.current === 'interrupted')) {
        chrome.downloads.onChanged.removeListener(done); URL.revokeObjectURL(burl);
      }
    });
    $('#bar').value = 100;
    let msg = `Done ✔  Saved ${base}${media.map ? '.mp4' : '.ts'} (${fmtMB(blob.size)}) to your Downloads folder.`;
    if (res.failed.length) msg += `\nSkipped segments: ${res.failed.join(', ')}`;
    log(msg, 'ok');
  } catch (e) {
    log(e.message === 'Cancelled' ? 'Cancelled.' : 'Download failed: ' + (e.message || e), 'err');
  } finally {
    running = false; aborter = null; $('#start').disabled = false; $('#cancel').hidden = true;
  }
}

$('#load').addEventListener('click', load);
$('#start').addEventListener('click', start);
$('#cancel').addEventListener('click', () => aborter?.abort());
$('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

$('#url').value = P.get('u') || '';
$('#referer').value = P.get('r') || '';
$('#name').value = HLS.safeName((P.get('n') || '').replace(/^Watching\s+/i, ''), 'video');
if ($('#url').value) {
  load().then(() => { if (P.get('auto') === '1' && parsed && parsed.media && !$('#opts').hidden) start(); });
}