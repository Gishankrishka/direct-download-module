'use strict';
const $ = (s) => document.querySelector(s);
const CATS = {
  video: /\.(mp4|m4v|webm|mkv|mov|avi|flv|wmv|3gp)$/i,
  audio: /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i,
  archives: /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|iso)$/i,
  docs: /\.(pdf|docx?|xlsx?|pptx?|odt|ods|epub|txt|csv)$/i,
  images: /\.(jpe?g|png|gif|webp|svg|avif|bmp)$/i,
  programs: /\.(exe|msi|deb|rpm|appimage|apk|dmg|pkg|sh|run)$/i
};
let data, rows = [];

function pathOf(u) { try { return new URL(u).pathname; } catch { return u; } }
function nameOf(u) { try { return decodeURIComponent(pathOf(u).split('/').filter(Boolean).pop() || new URL(u).hostname); } catch { return u; } }

function visible() { return rows.filter((r) => !r.tr.hidden); }
function refresh() {
  const q = $('#q').value.trim().toLowerCase();
  const cat = $('#cat').value;
  for (const r of rows) {
    const okQ = !q || r.it.url.toLowerCase().includes(q) || r.it.text.toLowerCase().includes(q);
    const okC = cat === 'all' || CATS[cat].test(pathOf(r.it.url));
    r.tr.hidden = !(okQ && okC);
  }
  count();
}
function count() {
  const n = rows.filter((r) => r.cb.checked).length;
  $('#go').textContent = `Download selected (${n})`;
  $('#status').textContent = `${visible().length} of ${rows.length} shown`;
}

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  data = (await chrome.storage.session.get('links:' + id))['links:' + id];
  if (!data) { $('#title').textContent = 'This list has expired. Run the command again from the page.'; return; }
  $('#title').textContent = data.selectedOnly ? 'Links in selection' : 'All links on page';
  $('#sub').textContent = data.title || data.pageUrl;
  const tbody = $('#rows');
  for (const it of data.items) {
    const tr = document.createElement('tr');
    const c1 = document.createElement('td'); c1.className = 'cb';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!data.selectedOnly;
    cb.addEventListener('change', count);
    c1.append(cb);
    const c2 = document.createElement('td'); c2.textContent = it.text || nameOf(it.url);
    const c3 = document.createElement('td'); c3.className = 'u'; c3.textContent = it.url;
    tr.append(c1, c2, c3);
    tbody.append(tr);
    rows.push({ it, tr, cb });
  }
  $('#q').addEventListener('input', refresh);
  $('#cat').addEventListener('change', refresh);
  $('#selVis').addEventListener('click', () => { visible().forEach((r) => (r.cb.checked = true)); count(); });
  $('#selNone').addEventListener('click', () => { rows.forEach((r) => (r.cb.checked = false)); count(); });
  $('#go').addEventListener('click', download);
  refresh();
}

async function download() {
  const items = rows.filter((r) => r.cb.checked).map((r) => ({ url: r.it.url, referrer: data.pageUrl }));
  if (!items.length) { $('#status').textContent = 'Nothing selected.'; return; }
  $('#go').disabled = true;
  let started = 0, failed = 0;
  for (let i = 0; i < items.length; i += 20) {
    const r = await chrome.runtime.sendMessage({ type: 'download', items: items.slice(i, i + 20) });
    started += r?.started || 0; failed += r?.failed?.length || 0;
    $('#status').textContent = `Started ${started} / ${items.length}` + (failed ? `, ${failed} failed` : '');
  }
  $('#go').disabled = false;
}
init();