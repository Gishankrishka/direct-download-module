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
function label(item) { return item.state === 'complete' ? 'Complete' : item.state === 'interrupted' ? 'Interrupted' : item.paused ? 'Paused' : 'Downloading'; }
function progress(item) {
  if (!item.totalBytes || item.totalBytes < 0) return 'Unknown size';
  return `${Math.min(100, Math.round(item.bytesReceived / item.totalBytes * 100))}% (${formatBytes(item.bytesReceived)} / ${formatBytes(item.totalBytes)})`;
}
function button(text, handler) {
  const element = document.createElement('button');
  element.textContent = text;
  element.addEventListener('click', handler);
  return element;
}
function render(items) {
  tbody.textContent = '';
  if (!items.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="4" class="muted">No downloads found.</td>';
    tbody.append(row);
    return;
  }
  for (const item of items) {
    const row = document.createElement('tr');
    const file = document.createElement('td');
    file.textContent = item.filename || item.url || 'Unnamed download';
    const detail = document.createElement('div'); detail.className = 'muted'; detail.textContent = formatDate(item.startTime);
    file.append(detail);
    const state = document.createElement('td'); state.textContent = label(item);
    const amount = document.createElement('td'); amount.textContent = progress(item);
    const actions = document.createElement('td');
    if (item.state === 'complete') actions.append(button('Open', () => chrome.downloads.open(item.id)));
    if (item.filename) actions.append(button('Show in folder', () => chrome.downloads.show(item.id)));
    row.append(file, state, amount, actions);
    tbody.append(row);
  }
}
async function refreshJobs() {
  const all = await chrome.storage.session.get(null);
  const jobs = Object.values(all).filter((value) => value && value.id && value.state && value.name);
  hlsJobs.textContent = '';
  if (!jobs.length) { hlsJobs.textContent = 'No HLS processors running.'; return; }
  for (const job of jobs) {
    const item = document.createElement('div');
    const percent = job.total ? Math.round(job.done / job.total * 100) : 0;
    item.textContent = `${job.name} · ${job.state} · ${percent}% · ${job.message || ''}`;
    hlsJobs.append(item);
  }
}
async function refresh() {
  const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 100 });
  status.textContent = `${items.length} download${items.length === 1 ? '' : 's'}`;
  render(items);
  await refreshJobs();
}
$('#refresh').addEventListener('click', refresh);
chrome.downloads.onCreated.addListener(refresh);
chrome.downloads.onChanged.addListener(refresh);
chrome.storage.onChanged.addListener(refreshJobs);
refresh();
