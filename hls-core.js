'use strict';
/* Pure HLS helpers - used by hls.js in the browser and unit-tested in Node. */
(function (root) {
  const resolve = (rel, base) => new URL(rel, base).href;

  function parseAttrs(s) {
    const o = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) o[m[1]] = m[2].replace(/^"|"$/g, '');
    return o;
  }

  const isMaster = (text) => /#EXT-X-STREAM-INF/.test(text);

  function parseMaster(text, base) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const variants = [], audio = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
        if (j < lines.length) {
          variants.push({
            url: resolve(lines[j], base),
            bandwidth: parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10),
            resolution: a.RESOLUTION || '', codecs: a.CODECS || '', audioGroup: a.AUDIO || ''
          });
          i = j;
        }
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) audio.push({ group: a['GROUP-ID'], name: a.NAME, url: resolve(a.URI, base) });
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
        const a = parseAttrs(l.slice(11));
        const method = (a.METHOD || 'NONE').toUpperCase();
        if (method === 'NONE') key = null;
        else if (method === 'AES-128' && a.URI) key = { uri: resolve(a.URI, base), iv: a.IV || null };
        else throw new Error('Unsupported encryption (' + method + '). Only unencrypted and AES-128 streams can be saved.');
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(l.slice(11));
        const url = resolve(a.URI, base);
        map = { url, range: a.BYTERANGE ? toRange(a.BYTERANGE, {}, url) : null };
      } else if (!l.startsWith('#')) {
        const url = resolve(l, base);
        let r = null;
        if (range) { r = toRange(range, lastEnd, url); range = null; }
        segments.push({ url, dur, seq: mediaSeq + segments.length, key, range: r });
        dur = 0;
      }
    }
    return { segments, map, ended, duration: segments.reduce((s, x) => s + x.dur, 0) };
  }

  function ivBytes(key, seq) {
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

  /* Some hosts prepend junk (e.g. a fake image header) to MPEG-TS segments.
     Find the first offset where the 0x47 sync byte repeats every 188 bytes. */
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

  function safeName(s, fallback) {
    s = (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[. ]+$/, '');
    return s || fallback || 'video';
  }


  /* Downloads all segments of a parsed media playlist with N parallel workers.
     fetchBuf(url, range) -> ArrayBuffer. Returns { parts: Blob[], failed: number[] }.
     Segments are kept in playlist order regardless of completion order. */
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
          if (s.key) buf = await decrypt(buf, await getKey(s.key.uri), ivBytes(s.key, s.seq));
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

  const api = { downloadSegments, parseAttrs, isMaster, parseMaster, parseMedia, ivBytes, decrypt, tsOffset, safeName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HLS = api;
})(typeof self !== 'undefined' ? self : globalThis);