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

  // 兼容：2024-01-01 10:52:06 +0800 / 2024-01-01T10:52:06+08:00 /
  //       2026年10月22日 15:00 / 2026/10/22 15:00 / 毫秒或秒时间戳
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  function parseAppleDate(s) {
    if (!s) return 0;
    s = String(s).trim();
    if (!s) return 0;
    if (/^\d{13}$/.test(s)) return +s;
    if (/^\d{10}$/.test(s)) return +s * 1000;

    var y = 0, mo = 1, d = 1, h = 0, mi = 0, se = 0, tz = '', m;

    m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*([+-]\d{2}:?\d{2}|Z)?$/.exec(s);
    if (m) {
      y = +m[1]; mo = +m[2]; d = +m[3];
      h = +(m[4] || 0); mi = +(m[5] || 0); se = +(m[6] || 0);
      tz = m[7] || '';
    }
    if (!y) {
      m = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(上午|下午|AM|PM)?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
      if (m) {
        y = +m[1]; mo = +m[2]; d = +m[3];
        h = +(m[5] || 0); mi = +(m[6] || 0); se = +(m[7] || 0);
        if (m[4] && /下午|PM/i.test(m[4]) && h < 12) h += 12;
        if (m[4] && /上午|AM/i.test(m[4]) && h === 12) h = 0;
      }
    }
    if (y) {
      if (tz === 'Z') return Date.parse(y + '-' + pad2(mo) + '-' + pad2(d) + 'T' + pad2(h) + ':' + pad2(mi) + ':' + pad2(se) + 'Z');
      if (tz) {
        var z = tz.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
        var tzr = Date.parse(y + '-' + pad2(mo) + '-' + pad2(d) + 'T' + pad2(h) + ':' + pad2(mi) + ':' + pad2(se) + z);
        if (isFinite(tzr)) return tzr;
      }
      return new Date(y, mo - 1, d, h, mi, se).getTime();
    }
    var t2 = Date.parse(s);
    return isFinite(t2) ? t2 : 0;
  }

  // 兼容「52分钟」「1小时20分」这类时长文本
  function parseDurText(v) {
    if (typeof v === 'number') return v;
    var s = String(v == null ? '' : v);
    var hh = /(\d+(?:\.\d+)?)\s*(?:小时|时|h)/i.exec(s);
    var mm = /(\d+(?:\.\d+)?)\s*(?:分钟|分|min|m)(?![a-z])/i.exec(s);
    var ss = /(\d+(?:\.\d+)?)\s*(?:秒|s)(?![a-z])/i.exec(s);
    if (hh || mm || ss) {
      return Math.round((hh ? +hh[1] * 3600 : 0) + (mm ? +mm[1] * 60 : 0) + (ss ? +ss[1] : 0));
    }
    return num(v);
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

  /* ---------------- 最小 ZIP 读取（定位健康导出的主 xml） ----------------
     中文系统的 iOS 导出里主文件叫「导出.xml」，英文系统叫 export.xml；
     还有些版本目录名也不同。这里扫描全部条目，按优先级选：
     1) 以 export.xml / 导出.xml 结尾  2) 其余 .xml 里压缩体积最大的那个 */
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  function pickEntryName(name) {
    var n = name.toLowerCase();
    if (/(^|\/)(export|导出)\.xml$/.test(n)) return 2;
    if (/\.xml$/.test(n) && !/(^|\/)导出说明\.pdf$/i.test(name)) return 1;
    return 0;
  }

  function readZipEntry(file) {
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
      if (cdOff === 0xffffffff || count === 0xffff) throw new Error('暂不支持 ZIP64，请先在「文件」App 里解压，再选择里面的 xml 文件');

      return file.slice(cdOff, cdOff + cdSize).arrayBuffer().then(function (cb) {
        var cd = new DataView(cb), p = 0, n;
        var best = null; // {name, lho, compSize, method, score}
        for (n = 0; n < count; n++) {
          if (cd.getUint32(p, true) !== 0x02014b50) break;
          var method = u16(cd, p + 10);
          var compSize = u32(cd, p + 20);
          var nameLen = u16(cd, p + 28);
          var extraLen = u16(cd, p + 30);
          var commLen = u16(cd, p + 32);
          var lho = u32(cd, p + 42);
          var name = new TextDecoder('utf-8').decode(new Uint8Array(cb, p + 46, nameLen));
          var score = pickEntryName(name);
          if (score > 0 && (!best || score > best.score || (score === best.score && compSize > best.compSize))) {
            best = { name: name, lho: lho, compSize: compSize, method: method, score: score };
          }
          p += 46 + nameLen + extraLen + commLen;
        }
        if (!best) throw new Error('zip 里没有找到健康导出的 xml 数据文件');
        return file.slice(best.lho, best.lho + 30).arrayBuffer().then(function (lb) {
          var lh = new DataView(lb);
          if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('zip 文件头损坏');
          var start = best.lho + 30 + u16(lh, 26) + u16(lh, 28);
          var data = file.slice(start, start + best.compSize);
          if (best.method === 0) return data;
          if (best.method !== 8) throw new Error('不支持的压缩方式');
          if (typeof DecompressionStream === 'undefined') {
            throw new Error('当前浏览器不支持直接解压，请先在「文件」App 里解压，再选择里面的 xml 文件');
          }
          return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
        });
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
      // 有开始/结束时间就以它为准（快捷指令里的「时长」常是「52分钟」这种文本）
      var dur = (start && end && end > start) ? Math.round((end - start) / 1000)
        : parseDurText(it.dur || it.duration || it.secs);
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

  // 从任意文本里解析：纯 JSON / 被文字包裹的 JSON / base64（快捷指令常这么传）
  function parsePayload(text) {
    if (!text) return [];
    var t = String(text).trim();
    if (!t) return [];
    var cands = [t];
    var i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i >= 0 && j > i) cands.push(t.slice(i, j + 1));
    var k = t.indexOf('['), l = t.lastIndexOf(']');
    if (k >= 0 && l > k) cands.push(t.slice(k, l + 1));
    var c;
    for (c = 0; c < cands.length; c++) {
      try { return normalizeExternal(JSON.parse(cands[c])); } catch (e) { }
    }
    try {
      var raw = decodeURIComponent(escape(atob(t.replace(/-/g, '+').replace(/_/g, '/'))));
      return normalizeExternal(JSON.parse(raw));
    } catch (e2) { }
    return [];
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
    parsePayload: parsePayload,
    parseDurText: parseDurText,
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
      ? readZipEntry(file).then(function (blob) { return parseXmlBlob(blob, progress); })
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
      toast('已导入 Apple 健康数据 ✓');
    }, 900);
  }

  function toast(msg) {
    var el = document.getElementById('saved-tip');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 1900);
  }

  // 一键导入：读剪贴板 → 自动导入最近 24 小时的训练
  function quickImport() {
    if (!(navigator.clipboard && navigator.clipboard.readText)) {
      openSheet({ reset: true, hint: '当前环境不支持读剪贴板，请改用「导出文件」导入。' });
      return;
    }
    var p;
    try { p = navigator.clipboard.readText(); } catch (e) { p = Promise.reject(e); }

    p.then(function (txt) {
      var list = parsePayload(txt);
      if (!list.length) {
        openSheet({ reset: true, hint: '剪贴板里没有健康数据。先运行一次「健康同步」快捷指令，再回来点这里。' });
        return;
      }
      var cutoff = Date.now() - 24 * 3600 * 1000;
      var recent = list.filter(function (w) { return w.end >= cutoff; });
      if (!recent.length) {
        openSheet({ reset: true });
        parsed = list;
        initSelection(false);
        renderPreview();
        setStatus('剪贴板里没有最近 24 小时的数据，请手动勾选要导入的训练', '');
        return;
      }
      var sel = {};
      recent.forEach(function (w) { sel[w.id] = 1; });
      var res = mergeWorkouts(list, sel);
      var main = recent.slice().sort(function (a, b) { return b.end - a.end; })[0];
      var n = res.added + res.merged;
      setStatus('已导入 ' + n + ' 条：' + (main.title || '训练') +
        (main.dur ? ' · ' + fmt(main.dur) : '') +
        (main.hr ? ' · 心率 ' + main.hr : '') +
        (main.kcal ? ' · ' + main.kcal + ' kcal' : ''), 'ok');
      toast('已导入 ' + n + ' 条健康数据 ✓');
    }).catch(function (e) {
      var msg = (e && e.message) || '';
      openSheet({
        reset: true,
        hint: /denied|permission|not allowed/i.test(msg)
          ? '系统拒绝了剪贴板访问：请在弹出的提示里选「允许粘贴」，或改用导出文件。'
          : '读取剪贴板失败，请改用「导出文件」导入。'
      });
    });
  }

  function checkHash() {
    var h = location.hash || '';
    var m = /(?:^#|&)hi=([^&]+)/.exec(h);
    if (!m) return false;
    var auto = /(?:^#|&)auto=1(?:&|$)/.test(h);
    var list = [];
    try { list = parsePayload(decodeURIComponent(m[1])); } catch (e) { list = []; }

    try { history.replaceState(null, '', location.pathname + location.search); } catch (e2) { }

    if (!list.length) return false;

    if (auto) {
      var cutoff = Date.now() - 24 * 3600 * 1000;
      var recent = list.filter(function (w) { return w.end >= cutoff; });
      var use = recent.length ? recent : list.slice(-1);
      var sel = {};
      use.forEach(function (w) { sel[w.id] = 1; });
      var res = mergeWorkouts(list, sel);
      var n = res.added + res.merged;
      toast(n ? '已自动导入 ' + n + ' 条健康数据 ✓' : '健康数据已是最新 ✓');
      return true;
    }

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
    if (b2) b2.onclick = function () { quickImport(); };

    var clip = $('#hi-clip');
    if (clip) clip.onclick = function () { quickImport(); };

    var pasteGo = $('#hi-paste-go');
    if (pasteGo) pasteGo.onclick = function () {
      var ta = $('#hi-paste');
      var list = parsePayload(ta ? ta.value : '');
      if (!list.length) { setStatus('这段文本里没有识别到健康数据', 'err'); return; }
      parsed = list;
      initSelection(false);
      renderPreview();
      setStatus('已识别 ' + list.length + ' 条训练，确认后点「导入选中」', 'ok');
    };

    var tpl = $('#hi-copy-tpl');
    if (tpl) tpl.onclick = function () {
      var t = '{"workouts":[{"title":"力量训练","start":"开始日期","end":"结束日期","kcal":312,"hr":132}]}';
      function ok() { tpl.textContent = '已复制 ✓'; setTimeout(function () { tpl.textContent = '📋 复制 JSON 模板'; }, 1600); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(ok, function () { });
      } else {
        var ta = document.createElement('textarea');
        ta.value = t; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); ok(); } catch (e) { }
        ta.remove();
      }
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
