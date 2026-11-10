'use strict';
/* On-video download button + quality menu (replaces IDM's native overlay panel). */
(() => {
  if (window.__ddmLoaded) return;
  window.__ddmLoaded = true;

  let host = null, btn = null, panel = null, toast = null;
  let target = null, hideTimer = 0, toastTimer = 0, lastMove = 0, panelOpen = false, seq = 0;

  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    Object.assign(el, props || {});
    for (const k of kids) if (k != null) el.append(k);
    return el;
  };

  function build() {
    host = h('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
    const root = host.attachShadow({ mode: 'closed' });
    root.append(h('style', { textContent: `
      *{box-sizing:border-box;font-family:system-ui,sans-serif}
      .b{position:fixed;font:600 13px/1 system-ui,sans-serif;color:#fff;background:#2563eb;border:0;border-radius:6px;
         padding:8px 12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.5)}
      .b:hover{background:#1d4ed8}
      .p{position:fixed;width:310px;max-height:340px;overflow:auto;color:#f3f4f6;background:rgba(17,24,39,.97);
         border:1px solid #374151;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.6);font-size:13px}
      .hd{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #374151;font-weight:600}
      .x{background:none;border:0;color:#9ca3af;font-size:16px;cursor:pointer}
      .sec{padding:6px 10px 2px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#9ca3af}
      .row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 10px;cursor:pointer}
      .row:hover{background:#1f2937}
      .row .m{color:#9ca3af;font-size:12px;white-space:nowrap}
      .row .l{word-break:break-word}
      .note{padding:8px 10px;color:#9ca3af;font-size:12px}
      .t{position:fixed;right:16px;bottom:16px;max-width:360px;color:#fff;background:rgba(17,24,39,.95);
         padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.4;box-shadow:0 2px 10px rgba(0,0,0,.5)}
      [hidden]{display:none!important}` }));
    btn = h('button', { className: 'b', type: 'button', textContent: '⬇ Download', hidden: true });
    panel = h('div', { className: 'p', hidden: true });
    toast = h('div', { className: 't', hidden: true });
    root.append(btn, panel, toast);

    btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); panelOpen ? closePanel() : openPanel(); });
    panel.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  }

  function attach() {
    if (!host) build();
    const fs = document.fullscreenElement;
    const parent = fs && fs.localName !== 'video' ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function say(text, ms = 4000) {
    attach();
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
  }

  /* ---------- button ---------- */
  function show(video, r, idleMs = 3500) {
    attach();
    target = video;
    const left = Math.max(4, Math.min(r.right, innerWidth) - 112);
    const top = Math.max(r.top, 0) + 10;
    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
    btn.hidden = false;
    if (panelOpen) placePanel();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, idleMs);
  }
  function hide() {
    if (panelOpen || !btn) return;
    btn.hidden = true;
    target = null;
  }
  function scheduleHide(ms = 700) { clearTimeout(hideTimer); hideTimer = setTimeout(hide, ms); }

  function placePanel() {
    const bl = parseFloat(btn.style.left) || 4, bt = parseFloat(btn.style.top) || 4;
    panel.style.left = Math.max(8, Math.min(bl + 108 - 310, innerWidth - 318)) + 'px';
    panel.style.top = Math.min(bt + 38, Math.max(8, innerHeight - 120)) + 'px';
  }

  /* ---------- menu ---------- */
  const fmtSize = (n) => { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i > 1 ? 1 : 0) + ' ' + u[i]; };
  const extOf = (url, mime) => { try { const m = /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname); if (m) return m[1].toUpperCase(); } catch { /* ignore */ } return (mime || '').split('/').pop().toUpperCase(); };
  const isYouTube = (url) => { try { const host = new URL(url).hostname.toLowerCase(); return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be'; } catch { return false; } };
  const youtubeCommand = (url) => `yt-dlp --no-playlist --merge-output-format mp4 --newline '${url.replace(/'/g, `'\\''`)}'`;

  function closePanel() { panelOpen = false; panel.hidden = true; scheduleHide(1500); }

  async function openPanel() {
    panelOpen = true;
    placePanel();
    panel.hidden = false;
    const my = ++seq;
    renderMsg('Looking for available qualities…');
    const discovered = new Set();
    for (const entry of performance.getEntriesByType('resource')) {
      if (/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(entry.name)) discovered.add(entry.name);
    }
    for (const video of document.querySelectorAll('video')) {
      const source = video.currentSrc || video.src || '';
      if (/^https?:/i.test(source)) discovered.add(source);
    }
    await Promise.all([...discovered].map((url) => chrome.runtime.sendMessage({ type: 'rememberMedia', url, pageUrl: location.href }).catch(() => null)));
    let res;
    try { res = await chrome.runtime.sendMessage({ type: 'getOptions', pageUrl: location.href }); }
    catch { res = null; }
    if (my !== seq || !panelOpen) return;
    if (!res?.ok) return renderMsg('Extension was reloaded – please refresh this page.');
    render(res);
  }

  function header() {
    const x = h('button', { className: 'x', type: 'button', textContent: '✕', title: 'Close' });
    x.addEventListener('click', (e) => { e.stopPropagation(); closePanel(); });
    return h('div', { className: 'hd' }, h('span', { textContent: 'Download video' }), x);
  }
  function renderMsg(text) {
    panel.textContent = '';
    panel.append(header(), h('div', { className: 'note', textContent: text }));
  }
  function row(label, meta, onClick) {
    const r = h('div', { className: 'row' }, h('span', { className: 'l', textContent: label }), h('span', { className: 'm', textContent: meta || '' }));
    r.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return r;
  }

  function render(res) {
    panel.textContent = '';
    panel.append(header());
    let count = 0;
    const shownStreams = new Set();
    let shownError = false;
    const title = res.title.replace(/^Watching\s+/i, '');

    for (const st of res.streams) {
      let streamKey = st.url;
      if (st.error) {
        try { streamKey = new URL(st.url).origin + new URL(st.url).pathname + st.error; } catch { /* keep URL */ }
      }
      if (shownStreams.has(streamKey)) continue;
      shownStreams.add(streamKey);
      if (st.error) {
        if (shownError) continue;
        shownError = true;
        panel.append(h('div', { className: 'sec', textContent: 'Stream (HLS)' }),
          h('div', { className: 'note', textContent: 'Could not read the playlist: ' + st.error }),
          row('Retry current stream', '', () => {
            chrome.runtime.sendMessage({ type: 'refreshMedia' });
            closePanel();
            say('Stream list refreshed. Play the video briefly, then open Download again.', 5000);
          }));
        count++;
        continue;
      }
      panel.append(h('div', { className: 'sec', textContent: st.master ? 'Qualities (HLS stream)' : 'HLS stream' }));
      for (const v of st.variants) {
        count++;
        const meta = v.live ? 'live – not supported' : v.videoOnly ? 'video only' : v.duration ? Math.round(v.duration / 60) + ' min' : '';
        panel.append(row(v.label, meta, () => {
          if (v.live) return say('Live streams cannot be saved.', 4000);
          chrome.runtime.sendMessage({ type: 'openHls', url: v.url, page: res.page, title: title + ' ' + v.label, auto: true });
          say('Opened the stream downloader in a new tab.');
          closePanel();
        }));
      }
    }

    const own = target && (target.currentSrc || target.src || '');
    const files = res.files.slice();
    if (own && /^https?:/i.test(own) && !/\.m3u8|\.mpd/i.test(own) && !files.some((f) => f.url === own)) files.unshift({ url: own, mime: target.localName, size: 0 });
    if (files.length) {
      panel.append(h('div', { className: 'sec', textContent: 'Video files' }));
      for (const f of files) {
        count++;
        panel.append(row(extOf(f.url, f.mime) + (f.url === own ? ' · playing now' : ''), fmtSize(f.size), async () => {
          closePanel();
          const r = await chrome.runtime.sendMessage({ type: 'downloadUrl', url: f.url, referrer: res.page }).catch(() => null);
          say(r?.ok ? 'Download started ✔' : (r?.error || 'Download failed.'), 4000);
        }));
      }
    }

    if (res.dash.length) {
      panel.append(h('div', { className: 'sec', textContent: 'DASH stream' }));
      for (const d of res.dash) {
        count++;
        panel.append(row('Copy yt-dlp command', 'DASH', async () => {
          let ok = false;
          try { await navigator.clipboard.writeText(d.cmd); ok = true; } catch { /* ignore */ }
          say(ok ? 'Command copied – paste it in a terminal.' : 'Could not copy. Use the extension popup instead.', 5000);
          closePanel();
        }));
      }
    }

    if (isYouTube(location.href)) {
      count++;
      panel.append(h('div', { className: 'sec', textContent: 'YouTube' }),
        row('Copy YouTube MP4 command', 'yt-dlp', async () => {
          try { await navigator.clipboard.writeText(youtubeCommand(location.href)); say('YouTube MP4 command copied.', 5000); }
          catch { say('Could not copy the YouTube command.', 5000); }
        }));
    }

    if (!count) panel.append(h('div', { className: 'note', textContent: 'Nothing downloadable detected yet. Let the video play for a few seconds, then click the button again.' }));
    else if (res.streams.some((s) => s.variants.some((v) => v.videoOnly))) panel.append(h('div', { className: 'note', textContent: '"video only": this quality keeps sound in a separate track. Use yt-dlp (extension popup) to get both.' }));
  }

  /* ---------- triggers ---------- */
  const bigEnough = (r) => r.width >= 200 && r.height >= 110;

  function onMove(e) {
    const now = performance.now();
    if (now - lastMove < 100) return;
    lastMove = now;
    let v = null;
    try { v = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.localName === 'video'); } catch { /* ignore */ }
    if (v) {
      const r = v.getBoundingClientRect();
      if (bigEnough(r)) { show(v, r); return; }
    }
    if (btn && !btn.hidden) scheduleHide();
  }

  // Pop up when a video starts playing, even before the mouse moves.
  document.addEventListener('playing', (e) => {
    const v = e.target;
    if (!v || v.localName !== 'video') return;
    const r = v.getBoundingClientRect();
    if (bigEnough(r) && r.bottom > 0 && r.top < innerHeight) show(v, r, 5000);
  }, true);

  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  document.addEventListener('mousedown', (e) => { if (panelOpen && e.target !== host) closePanel(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelOpen) closePanel(); }, true);
  window.addEventListener('scroll', () => { if (btn && !btn.hidden && !panelOpen) btn.hidden = true; }, { passive: true });
  document.addEventListener('fullscreenchange', () => { if (host) attach(); });
})();