/* ==========================================================================
   Apple 健康数据导入（health.js）
   - 支持：Apple 健康「导出所有健康数据」得到的 .zip / export.xml
   - 支持：快捷指令推送的 JSON（粘贴或 #hi= 链接）
   - 逻辑：解析 Workout（时长 / 心率 / 消耗 / 距离）→ 与本地训练记录按时间合并
   不依赖任何第三方库，纯前端、离线可用。
   ========================================================================== */
(function (root) {
  'use strict';

  var ACT = {
    HKWorkoutActivityTypeTraditionalStrengthTraining: '力量训练',
    HKWorkoutActivityTypeFunctionalStrengthTraining: '功能力量训练',
    HKWorkoutActivityTypeCoreTraining: '核心训练',
    HKWorkoutActivityTypeHighIntensityIntervalTraining: 'HIIT',
    HKWorkoutActivityTypeRunning: '跑步',
    HKWorkoutActivityTypeWalking: '步行',
    HKWorkoutActivityTypeCycling: '骑行',
    HKWorkoutActivityTypeSwimming: '游泳',
    HKWorkoutActivityTypeYoga: '瑜伽',
    HKWorkoutActivityTypePilates: '普拉提',
    HKWorkoutActivityTypeElliptical: '椭圆机',
    HKWorkoutActivityTypeRowing: '划船',
    HKWorkoutActivityTypeStairClimbing: '爬楼',
    HKWorkoutActivityTypeJumpRope: '跳绳',
    HKWorkoutActivityTypeFlexibility: '拉伸',
    HKWorkoutActivityTypeCooldown: '放松',
    HKWorkoutActivityTypeOther: '训练'
  };

  /* ---------------- 基础工具 ---------------- */
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  function attrMap(s) {
    var o = {}, re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g, m;
    while ((m = re.exec(s))) o[m[1]] = m[2];
    return o;
  }

  // Apple 导出里的日期形如：2024-01-01 10:52:06 +0800
  function parseAppleDate(s) {
    if (!s) return 0;
    s = String(s).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}:?\d{2})?$/.exec(s);
    if (!m) {
      var t0 = Date.parse(s);
      return isFinite(t0) ? t0 : 0;
    }
    var tz = m[7] ? m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : '';
    var iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + tz;
    var t = Date.parse(iso);
    if (!isFinite(t)) t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6]);
    return isFinite(t) ? t : 0;
  }

  function kcalOf(v, unit) {
    var n = num(v);
    if (!n) return 0;
    if (unit && /kj/i.test(unit)) n = n / 4.184;
    return Math.round(n);
  }

  function durSecOf(a) {
    var d = num(a.duration);
    var u = String(a.durationUnit || 'min').toLowerCase();
    if (u === 'min' || u === 'minutes' || u === 'minute') d *= 60;
    else if (u === 'hr' || u === 'hour' || u === 'hours') d *= 3600;
    return Math.round(d);
  }

  function hash32(s) {
    var h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h;
  }

  /* ---------------- XML 流式扫描（只挑 Workout，省内存） ---------------- */
  function fillWorkout(a) {
    var start = parseAppleDate(a.startDate), end = parseAppleDate(a.endDate);
    var dur = durSecOf(a);
    if (!dur && start && end) dur = Math.round((end - start) / 1000);
    if (!end && start && dur) end = start + dur * 1000;
    if (!start && end && dur) start = end - dur * 1000;
    return {
      type: a.workoutActivityType || '',
      start: start, end: end, dur: dur,
      kcal: kcalOf(a.totalEnergyBurned, a.totalEnergyBurnedUnit),
      hr: 0, hrMax: 0,
      dist: num(a.totalDistance), distUnit: a.totalDistanceUnit || '',
      source: a.sourceName || '',
      _hr: 0, _hrMax: 0, _kcal: 0, _dist: 0, _distU: ''
    };
  }

  function applyStat(w, a) {
    var t = a.type || '';
    if (/HeartRate$/.test(t)) {
      var avg = num(a.average), mx = num(a.maximum);
      if (avg) w._hr = Math.round(avg);
      if (mx) w._hrMax = Math.round(mx);
    } else if (/ActiveEnergyBurned$/.test(t)) {
      var s = num(a.sum);
      if (s) w._kcal = kcalOf(s, a.unit);
    } else if (/Distance/.test(t)) {
      var d = num(a.sum);
      if (d) { w._dist = d; w._distU = a.unit || ''; }
    }
  }

  function activityTitle(type) {
    if (ACT[type]) return ACT[type];
    var m = /HKWorkoutActivityType(.+)$/.exec(type || '');
    if (!m) return '训练';
    return m[1].replace(/([a-z])([A-Z])/g, '$1 $2').slice(0, 12);
  }

  function normalizeWorkout(w) {
    if (!w.end && !w.start) return null;
    if (!w.end) w.end = w.start + (w.dur || 0) * 1000;
    var kcal = w._kcal || w.kcal || 0;
    var hr = w._hr || w.hr || 0;
    var hrMax = w._hrMax || w.hrMax || 0;
    var dist = w._dist || w.dist || 0;
    var du = w._distU || w.distUnit || '';
    var km = dist;
    if (/mi/i.test(du)) km = dist * 1.60934;
    else if (/^(m|meter|meters)$/i.test(du)) km = dist / 1000;
    return {
      type: w.type || '', title: w.title || activityTitle(w.type),
      start: w.start, end: w.end, dur: Math.round(w.dur || 0),
      kcal: Math.round(kcal), hr: Math.round(hr), hrMax: Math.round(hrMax),
      dist: km ? Math.round(km * 100) / 100 : 0,
      source: w.source || '',
      id: 'h' + Math.abs(hash32((w.start || 0) + '|' + (w.end || 0) + '|' + (w.type || ''))).toString(36)
    };
  }

  function createScanner(onWorkout) {
    var buf = '', cur = null;

    function finalize() {
      if (!cur) return;
      var w = normalizeWorkout(cur);
      if (w && w.dur >= 30) onWorkout(w);
      cur = null;
    }

    function takeStats(str) {
      if (!cur) return;
      var re = /<WorkoutStatistics\b[^>]*>/g, m;
      while ((m = re.exec(str))) applyStat(cur, attrMap(m[0]));
    }

    function handleLine(line) {
      if (cur) {
        var close = line.indexOf('</Workout>');
        if (close >= 0) { takeStats(line.slice(0, close)); finalize(); return; }
        if (line.indexOf('<WorkoutStatistics') >= 0) takeStats(line);
        return;
      }
      var i = line.indexOf('<Workout ');
      if (i < 0) i = line.indexOf('<Workout>');
      if (i < 0) return;

      var tail = line.slice(i);
      var gt = tail.indexOf('>');
      if (gt < 0) return;
      var tag = tail.slice(0, gt + 1);
      var rest = tail.slice(gt + 1);
      cur = fillWorkout(attrMap(tag));

      if (rest.indexOf('</Workout>') >= 0) {
        takeStats(rest.slice(0, rest.indexOf('</Workout>')));
        finalize();
        return;
      }
      if (/\/>\s*$/.test(tag)) finalize();
    }

    return {
      push: function (chunk) {
        buf += chunk;
        var idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
        // 极端情况下单行超长，兜底处理
        if (buf.length > 4000000) { handleLine(buf); buf = ''; }
      },
      end: function () {
        if (buf) { handleLine(buf); buf = ''; }
        finalize();
      }
    };
  }

  /* ---------------- 解析入口 ---------------- */
  function parseXmlBlob(blob, onProgress) {
    var out = [];
    var sc = createScanner(function (w) {
      out.push(w);
      if (onProgress && out.length % 50 === 0) onProgress(out.length);
    });
    var hasTDS = typeof TextDecoderStream !== 'undefined';

    if (blob.stream && hasTDS) {
      var reader = blob.stream().pipeThrough(new TextDecoderStream('utf-8')).getReader();
      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) { sc.end(); return out; }
          sc.push(r.value);
          return pump();
        });
      })();
    }
    return blob.text().then(function (txt) { sc.push(txt); sc.end(); return out; });
  }

  function parseXmlText(text) {
    var out = [];
    var sc = createScanner(function (w) { out.push(w); });
    sc.push(text); sc.end();
    return out;
  }

  /* ---------------- 最小 ZIP 读取（只取 export.xml） ---------------- */
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  function readZipEntry(file, suffix) {
    suffix = suffix || 'export.xml';
    var size = file.size;
    var tailLen = Math.min(size, 65557);
    return file.slice(size - tailLen).arrayBuffer().then(function (tb) {
      var dv = new DataView(tb), eocd = -1, i;
      for (i = tb.byteLength - 22; i >= 0; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('这不是有效的 zip 文件');
      var count = u16(dv, eocd + 10);
      var cdSize = u32(dv, eocd + 12);
      var cdOff = u32(dv, eocd + 16);
      if (cdOff === 0xffffffff || count === 0xffff) throw new Error('暂不支持 ZIP64，请解压后选择 export.xml');

      return file.slice(cdOff, cdOff + cdSize).arrayBuffer().then(function (cb) {
        var cd = new DataView(cb), p = 0, n;
        for (n = 0; n < count; n++) {
          if (cd.getUint32(p, true) !== 0x02014b50) break;
          var method = u16(cd, p + 10);
          var compSize = u32(cd, p + 20);
          var nameLen = u16(cd, p + 28);
          var extraLen = u16(cd, p + 30);
          var commLen = u16(cd, p + 32);
          var lho = u32(cd, p + 42);
          var name = new TextDecoder('utf-8').decode(new Uint8Array(cb, p + 46, nameLen));
          if (name.toLowerCase().slice(-suffix.length) === suffix.toLowerCase()) {
            return file.slice(lho, lho + 30).arrayBuffer().then(function (lb) {
              var lh = new DataView(lb);
              if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('zip 文件头损坏');
              var start = lho + 30 + u16(lh, 26) + u16(lh, 28);
              var data = file.slice(start, start + compSize);
              if (method === 0) return data;
              if (method !== 8) throw new Error('不支持的压缩方式');
              if (typeof DecompressionStream === 'undefined') {
                throw new Error('当前浏览器不支持直接解压，请先在「文件」里解压，再选择 export.xml');
              }
              return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
            });
          }
          p += 46 + nameLen + extraLen + commLen;
        }
        throw new Error('zip 里没有找到 export.xml');
      });
    });
  }

  /* ---------------- 外部 JSON（快捷指令）归一化 ---------------- */
  function normalizeExternal(data) {
    var arr = [];
    if (Array.isArray(data)) arr = data;
    else if (data && Array.isArray(data.workouts)) arr = data.workouts;
    else if (data && typeof data === 'object') arr = [data];

    var out = [];
    arr.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var start = it.start ? parseAppleDate(it.start) : 0;
      var end = it.end ? parseAppleDate(it.end) : 0;
      var dur = num(it.dur || it.duration || it.secs);
      if (!dur && start && end) dur = Math.round((end - start) / 1000);
      if (!end && start && dur) end = start + dur * 1000;
      if (!start && end && dur) start = end - dur * 1000;
      if (!end) return;
      var w = normalizeWorkout({
        type: String(it.type || 'HKWorkoutActivityTypeOther'),
        title: it.title ? String(it.title).slice(0, 20) : '',
        start: start, end: end, dur: dur,
        kcal: num(it.kcal || it.energy), hr: num(it.hr || it.avgHr || it.heartRate),
        hrMax: num(it.hrMax || it.maxHr), dist: num(it.dist || it.distance),
        distUnit: it.distUnit || 'km', source: it.source || '快捷指令'
      });
      if (w) out.push(w);
    });
    return out;
  }

  /* ---------------- 合并到训练记录 ---------------- */
  var MATCH_MS = 10 * 60 * 1000;

  function mergeWorkouts(list, selected) {
    var log = root.trainLog = root.trainLog || [];
    var seen = {};
    log.forEach(function (r) { if (r && r.hid) seen[r.hid] = 1; });

    var added = 0, merged = 0, skipped = 0;

    list.forEach(function (w) {
      if (selected && !selected[w.id]) { skipped++; return; }
      if (seen[w.id]) { skipped++; return; }

      var hit = null, i;
      for (i = log.length - 1; i >= 0; i--) {
        var r = log[i];
        if (!r || r.src === 'health' || !r.t) continue;
        if (Math.abs(r.t - w.end) <= MATCH_MS) { hit = r; break; }
      }

      if (hit) {
        if (w.hr) hit.hr = w.hr;
        if (w.hrMax) hit.hrMax = w.hrMax;
        if (w.kcal) hit.kcal = w.kcal;
        if (w.dist) hit.dist = w.dist;
        hit.hid = w.id;
        if (w.source) hit.hsrc = w.source;
        merged++;
      } else if (w.dur >= 60) {
        log.push({
          t: w.end, sets: 0, total: 0, secs: w.dur, done: true,
          names: [w.title], exs: [], src: 'health', hid: w.id,
          hr: w.hr || 0, hrMax: w.hrMax || 0, kcal: w.kcal || 0,
          dist: w.dist || 0, hsrc: w.source || ''
        });
        added++;
      } else {
        skipped++;
      }
    });

    if (added || merged) {
      log.sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
      if (log.length > 500) root.trainLog = log.slice(-500);
      if (typeof root.saveHistory === 'function') root.saveHistory();
      if (typeof root.renderHistory === 'function') root.renderHistory();
    }
    return { added: added, merged: merged, skipped: skipped };
  }

  /* ---------------- 导出核心能力（便于测试） ---------------- */
  root.HI = {
    parseXmlText: parseXmlText,
    parseXmlBlob: parseXmlBlob,
    parseAppleDate: parseAppleDate,
    readZipEntry: readZipEntry,
    normalizeExternal: normalizeExternal,
    mergeWorkouts: mergeWorkouts,
    activityTitle: activityTitle,
    activityMap: ACT
  };

  /* ================= 以下为界面部分（无 DOM 时跳过） ================= */
  if (typeof document === 'undefined') return;

  var parsed = [];
  var selected = {};
  var lastImported = null;

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(sec) {
    sec = Math.round(sec || 0);
    if (sec >= 60) {
      var m = Math.floor(sec / 60), s = sec % 60;
      return s ? m + '分' + s + '秒' : m + '分钟';
    }
    return sec + '秒';
  }
  function p2(n) { return String(n).padStart(2, '0'); }
  function fmtDT(t) {
    var d = new Date(t);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function setStatus(msg, kind) {
    var el = $('#hi-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'ok' ? 'var(--lime)' : kind === 'err' ? 'var(--red)' : 'var(--dim)';
  }

  function isRecent(w, days) {
    return w.end >= Date.now() - days * 86400000;
  }

  function initSelection(all) {
    selected = {};
    parsed.forEach(function (w) {
      selected[w.id] = all ? true : isRecent(w, 14);
    });
    // 最近 14 天没有可用数据时，默认勾选最近的 20 条，避免空手状态
    if (!all && countSel() === 0 && parsed.length) {
      parsed.slice().sort(function (a, b) { return b.end - a.end; }).slice(0, 20)
        .forEach(function (w) { selected[w.id] = true; });
    }
  }

  function countSel() {
    var n = 0;
    parsed.forEach(function (w) { if (selected[w.id]) n++; });
    return n;
  }

  function updateImportBtn() {
    var btn = $('#hi-import');
    if (!btn) return;
    var n = countSel();
    btn.hidden = !parsed.length;
    btn.textContent = '导入选中（' + n + '）';
    btn.disabled = !n;
    btn.style.opacity = n ? '1' : '.5';
  }

  function renderPreview() {
    var box = $('#hi-list');
    if (!box) return;
    box.innerHTML = '';
    if (!parsed.length) {
      box.innerHTML = '<div class="hi-empty">没有发现训练数据</div>';
      updateImportBtn();
      return;
    }

    var sorted = parsed.slice().sort(function (a, b) { return b.end - a.end; });
    var shown = sorted.slice(0, 80);

    var bar = document.createElement('div');
    bar.className = 'hi-bar';
    bar.innerHTML = '<span>共 ' + parsed.length + ' 条训练，显示最近 ' + shown.length + ' 条</span>' +
      '<span class="hi-links"><a id="hi-all">全选</a><a id="hi-none">全不选</a></span>';
    box.appendChild(bar);

    shown.forEach(function (w) {
      var row = document.createElement('label');
      row.className = 'hi-row';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!selected[w.id];
      cb.onchange = function () { selected[w.id] = cb.checked; updateImportBtn(); };

      var main = document.createElement('div');
      main.className = 'hi-main';
      var meta = fmt(w.dur);
      if (w.hr) meta += ' · 心率 ' + w.hr + (w.hrMax ? '–' + w.hrMax : '');
      if (w.kcal) meta += ' · ' + w.kcal + ' kcal';
      if (w.dist) meta += ' · ' + w.dist + ' km';
      main.innerHTML =
        '<div class="hi-t"><b>' + esc(w.title) + '</b>' +
        '<span class="hi-d">' + fmtDT(w.end) + '</span></div>' +
        '<div class="hi-m">' + esc(meta) + (w.source ? ' · ' + esc(w.source) : '') + '</div>';

      row.appendChild(cb);
      row.appendChild(main);
      box.appendChild(row);
    });

    $('#hi-all').onclick = function (e) { e.preventDefault(); parsed.forEach(function (w) { selected[w.id] = true; }); renderPreview(); };
    $('#hi-none').onclick = function (e) { e.preventDefault(); parsed.forEach(function (w) { selected[w.id] = false; }); renderPreview(); };
    updateImportBtn();
  }

  function openSheet(opts) {
    opts = opts || {};
    var el = $('#hmodal');
    if (!el) return;
    if (opts.reset !== false) {
      parsed = []; selected = {}; lastImported = null;
      var list = $('#hi-list'); if (list) list.innerHTML = '';
      var fi = $('#hi-file'); if (fi) fi.value = '';
      var impBtn = $('#hi-import'); if (impBtn) impBtn.hidden = true;
      setStatus('', '');
    }
    el.classList.add('show');
    if (opts.hint) setStatus(opts.hint, '');
  }

  function closeSheet() {
    var el = $('#hmodal');
    if (el) el.classList.remove('show');
  }

  function handleFile(file) {
    setStatus('正在读取「' + file.name + '」…', '');
    var list = $('#hi-list'); if (list) list.innerHTML = '';
    $('#hi-import').hidden = true;

    var p = /\.zip$/i.test(file.name)
      ? readZipEntry(file, 'export.xml').then(function (blob) { return parseXmlBlob(blob, progress); })
      : parseXmlBlob(file, progress);

    function progress(n) { setStatus('已读取 ' + n + ' 条训练…', ''); }

    return p.then(function (list2) {
      if (!list2.length) throw new Error('没找到训练记录，请确认导出数据里包含「体能训练」');
      parsed = list2;
      initSelection(false);
      renderPreview();
      setStatus('解析完成：共 ' + list2.length + ' 条训练，已勾选 ' + countSel() + ' 条，可按需调整', 'ok');
    }).catch(function (e) {
      setStatus('导入失败：' + ((e && e.message) || e), 'err');
    });
  }

  function doImport() {
    if (!parsed.length) return;
    var sel = {}, n = 0;
    parsed.forEach(function (w) { if (selected[w.id]) { sel[w.id] = 1; n++; } });
    if (!n) { setStatus('请先勾选要导入的训练', 'err'); return; }

    var res = mergeWorkouts(parsed, sel);
    lastImported = res;
    var msg = '导入完成：新增 ' + res.added + ' 条，合并 ' + res.merged + ' 条';
    if (res.skipped) msg += '，跳过 ' + res.skipped + ' 条';
    setStatus(msg, 'ok');
    updateImportBtn();

    if (typeof root.renderHistory === 'function') root.renderHistory();
    setTimeout(function () {
      closeSheet();
      if (typeof root.toast === 'function') root.toast('已导入 Apple 健康数据 ✓');
      else if (typeof root.showSaved === 'function') root.showSaved();
    }, 900);
  }

  function checkHash() {
    var h = location.hash || '';
    var m = /(?:^#|&)hi=([^&]+)/.exec(h);
    if (!m) return false;
    var list = [];
    try {
      var raw = decodeURIComponent(m[1]);
      // 兼容 base64（快捷指令里常用）
      if (raw.charAt(0) !== '{' && raw.charAt(0) !== '[') {
        try { raw = decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))); } catch (e) { }
      }
      list = normalizeExternal(JSON.parse(raw));
    } catch (e) { list = []; }

    try { history.replaceState(null, '', location.pathname + location.search); } catch (e2) { }

    if (!list.length) return false;
    openSheet({ reset: true });
    parsed = list;
    initSelection(true);
    renderPreview();
    setStatus('已从快捷指令读取 ' + list.length + ' 条训练，确认后点「导入选中」', 'ok');
    return true;
  }

  function bind() {
    var choose = $('#hi-choose'), fileInput = $('#hi-file');
    if (choose && fileInput) {
      choose.onclick = function () { fileInput.value = ''; fileInput.click(); };
      fileInput.onchange = function () {
        var f = this.files && this.files[0];
        if (f) handleFile(f);
      };
    }

    var imp = $('#hi-import');
    if (imp) imp.onclick = doImport;

    var close = $('#hi-close');
    if (close) close.onclick = closeSheet;

    var modal = $('#hmodal');
    if (modal) modal.addEventListener('click', function (e) { if (e.target.id === 'hmodal') closeSheet(); });

    var b1 = $('#btn-hi-import');
    if (b1) b1.onclick = function () { openSheet({ reset: true }); };

    var b2 = $('#btn-hi-done');
    if (b2) b2.onclick = function () {
      openSheet({ reset: true, hint: '刚练完？直接选「健康」导出的 .zip，就会把心率 / 消耗合并到这次训练。' });
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(); checkHash(); });
  } else {
    bind();
    checkHash();
  }

  root.HI.openSheet = openSheet;

})(typeof window !== 'undefined' ? window : globalThis);
