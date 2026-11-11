'use strict';
const $ = (s) => document.querySelector(s);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const isYouTube = (url) => { try { const host = new URL(url).hostname.toLowerCase(); return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be'; } catch { return false; } };
const say = (t, bad) => { const el = $('#msg'); el.textContent = t; el.className = 'msg ' + (bad ? 'err' : 'ok'); };
const send = (m) => chrome.runtime.sendMessage(m);

function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function fileName(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || new URL(url).hostname); }
  catch { return url; }
}
function createBtn(label, fn, primary) {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = 'btn' + (primary ? ' primary' : '');
  b.addEventListener('click', fn);
  return b;
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); say(what + ' copied'); }
  catch { say('Could not copy to clipboard', true); }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (isYouTube(tab.url)) {
    $('#youtube').hidden = false;
    $('#youtubeDownload').addEventListener('click', async () => {
      const result = await send({ type: 'videoDownload', src: '', pageUrl: tab.url });
      if (result?.ok) say('YouTube download started');
      else say(result?.error || 'YouTube requires a native downloader to merge signed video and audio streams.', true);
    });
  }

  const st = await chrome.storage.local.get({ saveAs: false });
  $('#enabled').checked = st.enabled !== false;
  $('#enabled').addEventListener('change', (e) => {
    chrome.storage.local.set({ enabled: e.target.checked });
    say(e.target.checked ? 'Extension enabled' : 'Extension disabled');
  });
  $('#saveAs').checked = st.saveAs;
  $('#saveAs').addEventListener('change', (e) => chrome.storage.local.set({ saveAs: e.target.checked }));

  $('#urlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('#url').value.trim();
    if (!url) return;
    const r = await send({ type: 'downloadUrl', url, title: tab.title });
    r?.ok ? say('Download started') : say(r?.error || 'Failed', true);
  });
  $('#all').addEventListener('click', async () => { await send({ type: 'pickLinks', tabId: tab.id, selectedOnly: false }); window.close(); });
  $('#hls').addEventListener('click', async () => { await send({ type: 'openHls', url: '', page: tab.url, title: tab.title }); window.close(); });
  $('#dashboard').addEventListener('click', async () => { await send({ type: 'openDashboard' }); window.close(); });
  $('#sel').addEventListener('click', async () => { await send({ type: 'pickLinks', tabId: tab.id, selectedOnly: true }); window.close(); });

  const key = 'media:' + tab.id;
  const list = (await chrome.storage.session.get(key))[key] || [];
  $('#count').textContent = list.length ? `(${list.length})` : '';
  const ul = $('#media');
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'media-item';
    li.innerHTML = '<div class="muted" style="text-align:center;padding:16px">Nothing yet. Start playing a video or audio, then reopen this popup.</div>';
    ul.append(li);
    return;
  }
  for (const e of list) {
    const li = document.createElement('li');
    li.className = 'media-item';

    const nm = document.createElement('div');
    nm.className = 'media-name';
    nm.textContent = fileName(e.url);

    const meta = document.createElement('div');
    meta.className = 'media-meta';
    meta.textContent = [e.kind === 'stream' ? 'HLS/DASH stream' : e.mime, fmtSize(e.size)].filter(Boolean).join(' · ');

    const row = document.createElement('div');
    row.className = 'media-actions';

    if (e.kind === 'file') {
      row.append(
        createBtn('Download', async () => {
          const r = await send({ type: 'downloadUrl', url: e.url, referrer: e.page });
          r?.ok ? say('Download started') : say(r?.error || 'Failed', true);
        }, true),
        createBtn('Copy URL', () => copy(e.url, 'URL'))
      );
    } else {
      const ref = e.page ? '--referer ' + shq(e.page) + ' ' : '';
      if (e.hls) row.append(createBtn('Download as file', async () => { await send({ type: 'openHls', url: e.url, page: e.page, title: e.title, tabId: tab.id }); window.close(); }, true));
      row.append(
        createBtn('Copy yt-dlp', () => copy(`yt-dlp ${ref}${shq(e.url)}`, 'yt-dlp command'), !e.hls),
        createBtn('Copy ffmpeg', () => copy(`ffmpeg ${e.page ? '-headers ' + shq('Referer: ' + e.page) + ' ' : ''}-i ${shq(e.url)} -c copy output.mp4`, 'ffmpeg command')),
        createBtn('Copy URL', () => copy(e.url, 'URL'))
      );
    }
    li.append(nm, meta, row);
    ul.append(li);
  }
}
init();