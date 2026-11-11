'use strict';
const $ = (selector) => document.querySelector(selector);
const tbody = $('#downloads');
const status = $('#status');
const hlsJobs = $('#hlsJobs');

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
function formatDate(value) { return value ? new Date(value).toLocaleString() : ''; }
function label(item) { return item.paused ? 'Paused' : 'Downloading'; }
function progress(item) {
  if (!item.totalBytes || item.totalBytes < 0) return 'Unknown size';
  return `${Math.min(100, Math.round(item.bytesReceived / item.totalBytes * 100))}% (${formatBytes(item.bytesReceived)} / ${formatBytes(item.totalBytes)})`;
}
function speed(item) {
  if (!item.bytesReceived || !item.startTime) return '';
  const elapsed = (Date.now() - item.startTime) / 1000;
  if (elapsed < 1) return '';
  return `${formatBytes(item.bytesReceived / elapsed)}/s`;
}
function button(text, handler) {
  const element = document.createElement('button');
  element.textContent = text;
  element.className = 'btn';
  element.addEventListener('click', handler);
  return element;
}
function statusBadge(text) {
  const span = document.createElement('span');
  span.className = 'status-badge ' + text.toLowerCase().replace(/\s+/g, '-');
  span.textContent = text;
  return span;
}
function progressBar(percent, complete) {
  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.innerHTML = `<div class="progress-track"><div class="progress-fill" style="width:${percent}%" ${complete ? 'data-complete="true"' : ''}></div></div>`;
  const pct = document.createElement('span');
  pct.style.marginLeft = '8px';
  pct.style.fontSize = '12px';
  pct.style.fontWeight = '600';
  pct.style.color = 'var(--color-accent)';
  pct.style.fontVariantNumeric = 'tabular-nums';
  pct.textContent = percent + '%';
  wrapper.append(pct);
  return wrapper;
}

function render(items) {
  tbody.textContent = '';
  if (!items.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="4" class="muted" style="padding:24px;text-align:center">No active downloads from this extension.</td>';
    tbody.append(row);
    return;
  }
  for (const item of items) {
    const row = document.createElement('tr');
    const file = document.createElement('td');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'file-display';
    nameDiv.textContent = item.filename || item.url || 'Unnamed download';
    const detail = document.createElement('div');
    detail.className = 'muted';
    detail.style.fontSize = '10px';
    detail.style.marginTop = '4px';
    detail.textContent = formatDate(item.startTime) + (speed(item) ? ` · ${speed(item)}` : '');
    file.append(nameDiv, detail);
    const state = document.createElement('td');
    state.append(statusBadge(label(item)));
    const amount = document.createElement('td');
    const pct = item.totalBytes && item.totalBytes > 0 ? Math.round(item.bytesReceived / item.totalBytes * 100) : 0;
    amount.append(progressBar(pct, false));
    const actions = document.createElement('td');
    if (item.filename) actions.append(button('Show in folder', () => chrome.downloads.show(item.id)));
    row.append(file, state, amount, actions);
    tbody.append(row);
  }
}

function renderHlsJobs(jobs) {
  hlsJobs.textContent = '';
  if (!jobs.length) {
    hlsJobs.innerHTML = '<div class="msg info" style="text-align:center;padding:16px">No active HLS processors.</div>';
    return;
  }
  const table = document.createElement('table');
  table.style.width = '100%';
  table.innerHTML = '<thead><tr><th>Name</th><th>State</th><th>Progress</th><th>Details</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const job of jobs) {
    const row = document.createElement('tr');
    const percent = job.total ? Math.round(job.done / job.total * 100) : 0;
    const isComplete = job.state === 'complete';
    const name = document.createElement('td');
    name.className = 'file-display';
    name.textContent = job.name;
    const state = document.createElement('td');
    state.append(statusBadge(job.state));
    const prog = document.createElement('td');
    prog.append(progressBar(percent, isComplete));
    if (job.bytes) {
      const spd = document.createElement('div');
      spd.className = 'muted';
      spd.style.fontSize = '10px';
      spd.style.marginTop = '4px';
      spd.textContent = `${formatBytes(job.bytes)} downloaded`;
      prog.append(spd);
    }
    const details = document.createElement('td');
    details.className = 'muted';
    details.style.fontSize = '10px';
    details.textContent = job.message || '';
    if (job.failed) details.textContent += ` · ${job.failed} skipped`;
    row.append(name, state, prog, details);
    tbody.append(row);
  }
  table.append(tbody);
  hlsJobs.append(table);
}

async function refreshJobs() {
  const all = await chrome.storage.session.get(null);
  const jobs = Object.values(all).filter((value) => value && value.id && value.state && value.name);
  const active = jobs.filter((job) => !['complete', 'cancelled', 'failed'].includes(job.state));
  renderHlsJobs(active);
}

async function refresh() {
  const tracked = await chrome.storage.session.get(null);
  const ids = new Set(Object.keys(tracked).filter((key) => key.startsWith('ddm-download:')).map((key) => Number(key.slice(13))));
  const items = (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1000 }))
    .filter((item) => ids.has(item.id) && item.state === 'in_progress');
  status.textContent = `${items.length} active browser download${items.length === 1 ? '' : 's'}`;
  status.className = 'msg info';
  render(items);
  await refreshJobs();
}

$('#refresh').addEventListener('click', refresh);
chrome.downloads.onCreated.addListener(refresh);
chrome.downloads.onChanged.addListener(refresh);
chrome.storage.onChanged.addListener(refreshJobs);

/* Periodic poll for real-time progress updates */
setInterval(refresh, 2000);

refresh();