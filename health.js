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
      distUnit: km ? 'km' : '',
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

  /**
   * 枚举 zip 内全部条目。
   * 国产厂商的导出包（小米/华为/vivo/OPPO）结构复杂：里面是若干 CSV 或 Excel，
   * 靠文件名猜不出主数据文件，所以改成全部列出来再逐个判断内容。
   */
  function listZipEntries(file) {
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
      if (cdOff === 0xffffffff || count === 0xffff) throw new Error('暂不支持 ZIP64，请先在「文件」App 里解压，再选择里面的文件');

      return file.slice(cdOff, cdOff + cdSize).arrayBuffer().then(function (cb) {
        var cd = new DataView(cb), p = 0, n, out = [];
        for (n = 0; n < count; n++) {
          if (cd.getUint32(p, true) !== 0x02014b50) break;
          var method = u16(cd, p + 10);
          var compSize = u32(cd, p + 20);
          var nameLen = u16(cd, p + 28);
          var extraLen = u16(cd, p + 30);
          var commLen = u32(cd, p + 32);
          var lho = u32(cd, p + 42);
          var name = new TextDecoder('utf-8').decode(new Uint8Array(cb, p + 46, nameLen));
          out.push({ name: name, lho: lho, compSize: compSize, method: method });
          p += 46 + nameLen + extraLen + commLen;
        }
        return out;
      });
    });
  }

  /** 读出 zip 中某个条目的内容（自动处理 deflate 解压） */
  function readZipEntryByName(file, entry) {
    return file.slice(entry.lho, entry.lho + 30).arrayBuffer().then(function (lb) {
      var lh = new DataView(lb);
      if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('zip 文件头损坏');
      var start = entry.lho + 30 + u16(lh, 26) + u16(lh, 28);
      var data = file.slice(start, start + entry.compSize);
      if (entry.method === 0) return data;
      if (entry.method !== 8) throw new Error('不支持的压缩方式');
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('当前浏览器不支持直接解压，请先在「文件」App 里解压，再选择里面的文件');
      }
      return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    });
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

  /* ---------------- 国产厂商导出的表格（CSV / TSV）解析 ----------------
     华为运动健康、小米运动健康、欢太健康、vivo 健康 都支持把运动记录导出成
     CSV（小米是 SPORT_*.csv，华为/OPPO/vivo 常见表头为中文）。
     各家表头差异很大，所以这里做「列名模糊匹配」而不是写死字段顺序。
     表头里同时带单位，例如「距离(米)」「时长(分钟)」「消耗(千卡)」。 */

  // 把一行 CSV 拆成字段（支持双引号包裹、字段内逗号与转义引号）
  function splitCsvLine(line, sep) {
    var out = [], cur = '', i = 0, q = false;
    while (i < line.length) {
      var c = line.charAt(i);
      if (q) {
        if (c === '"') {
          if (line.charAt(i + 1) === '"') { cur += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        cur += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === sep) { out.push(cur); cur = ''; i++; continue; }
      cur += c; i++;
    }
    out.push(cur);
    return out;
  }

  // 猜测分隔符：优先逗号，其次制表符
  function guessSep(line) {
    var c = (line.match(/,/g) || []).length;
    var t = (line.match(/\t/g) || []).length;
    return t > c ? '\t' : ',';
  }

  function cleanHeader(h) {
    return String(h || '')
      .replace(/^\uFEFF/, '')
      .replace(/[（(].*?[)）]/g, '')   // 去掉「(米)」这类单位后缀
      .replace(/[\s_\-]+/g, '')
      .toLowerCase();
  }

  // 列名 → 语义字段
  var CSV_COLS = [
    ['start', ['开始时间', '运动开始时间', '运动时间', '开始日期', 'starttime', 'startdate', 'start', 'date']],
    ['end', ['结束时间', '运动结束时间', 'endtime', 'enddate', 'end']],
    ['dur', ['时长', '运动时长', '持续时间', '用时', 'duration', 'sporttime', 'sporttimeminutes', 'minutes', 'sec', '秒']],
    ['type', ['运动类型', '运动名称', '运动项目', '项目', '类型', 'type', 'sporttype', 'activity', '运动']],
    ['kcal', ['消耗', '消耗热量', '卡路里', '热量', 'calories', 'calorie', 'kcal', 'totalenergyburned', '能量']],
    ['dist', ['距离', '总距离', '运动距离', 'distance', 'totaldistance']],
    ['distUnit', ['距离单位', 'distanceunit', 'unit']],
    ['hr', ['平均心率', '心率', 'avheartrate', 'avgheartrate', 'heartrate', '平均心率bpm', 'hr']],
    ['hrMax', ['最大心率', '最高心率', 'maxheartrate', 'hrMax', 'maxhr']],
    ['steps', ['步数', '总步数', 'steps', 'stepcount', 'totalsteps']]
  ];

  function matchCsvCol(h) {
    var c = cleanHeader(h);
    if (!c) return '';
    var i, j, list, key;
    for (i = 0; i < CSV_COLS.length; i++) {
      list = CSV_COLS[i][1];
      for (j = 0; j < list.length; j++) {
        key = cleanHeader(list[j]);
        if (!key) continue;
        if (c === key) return CSV_COLS[i][0];
      }
    }
    // 再做包含匹配（表头可能有前后缀，如「本次消耗(千卡)」）
    for (i = 0; i < CSV_COLS.length; i++) {
      list = CSV_COLS[i][1];
      for (j = 0; j < list.length; j++) {
        key = cleanHeader(list[j]);
        if (key.length >= 2 && c.indexOf(key) >= 0) return CSV_COLS[i][0];
      }
    }
    return '';
  }

  // 从表头判断单位：距离列的表头里带「米」还是「公里」
  function distUnitFromHeader(h) {
    var s = String(h || '');
    if (/公里|千米|\bkm\b/i.test(s)) return 'km';
    if (/\bmi\b|英里/i.test(s)) return 'mi';
    return 'm';
  }

  // 厂商的运动类型名 → Apple 风格 type（复用前端的 ACT 表拿到中文标题）
  function vendorTypeToApple(t) {
    var s = String(t || '').trim();
    if (!s) return 'HKWorkoutActivityTypeOther';
    var map = [
      [/跑步|户外跑|road.?run|run/i, 'HKWorkoutActivityTypeRunning'],
      [/健走|步行|走路|走|walk/i, 'HKWorkoutActivityTypeWalking'],
      [/骑行|单车|自行车|自行车|骑行|cycle|cycl|biking/i, 'HKWorkoutActivityTypeCycling'],
      [/游泳|swim/i, 'HKWorkoutActivityTypeSwimming'],
      [/力量|举重|器械|撸铁|weight|strength|gym/i, 'HKWorkoutActivityTypeTraditionalStrengthTraining'],
      [/瑜伽|yoga/i, 'HKWorkoutActivityTypeYoga'],
      [/普拉提|pilates/i, 'HKWorkoutActivityTypePilates'],
      [/椭圆|elliptic/i, 'HKWorkoutActivityTypeElliptical'],
      [/划船|row/i, 'HKWorkoutActivityTypeRowing'],
      [/爬楼|爬楼梯|楼梯|stair/i, 'HKWorkoutActivityTypeStairClimbing'],
      [/跳绳|jump.?rope/i, 'HKWorkoutActivityTypeJumpRope'],
      [/拉伸|柔韧|flexib|stretch/i, 'HKWorkoutActivityTypeFlexibility'],
      [/hiit|间歇|高强度/i, 'HKWorkoutActivityTypeHighIntensityIntervalTraining'],
      [/徒步|登山|爬山|hiking/i, 'HKWorkoutActivityTypeHiking'],
      [/羽毛球|badminton/i, 'HKWorkoutActivityTypeBadminton'],
      [/网球|tennis/i, 'HKWorkoutActivityTypeTennis'],
      [/篮球|basketball/i, 'HKWorkoutActivityTypeBasketball'],
      [/足球|soccer/i, 'HKWorkoutActivityTypeSoccer'],
      [/动感单车|团课|课程|exercise|training|健身/i, 'HKWorkoutActivityTypeOther']
    ];
    for (var i = 0; i < map.length; i++) {
      if (map[i][0].test(s)) return map[i][1];
    }
    return 'HKWorkoutActivityTypeOther';
  }

  /**
   * 解析 CSV / TSV 文本为训练记录数组。
   * 只取含「开始时间 + 时长(或结束时间)」的行，避免把日常活动表也当训练。
   */
  function parseCsvText(text) {
    if (!text) return [];
    // 去掉 BOM，统一换行
    text = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var lines = text.split('\n').filter(function (l) { return l.trim().length; });
    if (!lines.length) return [];

    var sep = guessSep(lines[0]);
    var head = splitCsvLine(lines[0], sep);
    var cols = {}, i, j;
    for (i = 0; i < head.length; i++) {
      var key = matchCsvCol(head[i]);
      if (key && !cols[key]) cols[key] = i;
    }
    // 至少要能定位开始时间，否则这个文件不是运动记录
    if (cols.start === undefined) return [];

    // 仅有「开始/结束时间」不足以说明是运动记录（睡眠表、每日汇总表也有）。
    // 必须再命中一个运动语义列：运动类型 / 时长 / 消耗 / 距离 / 心率。
    var sportsHit = ['type', 'dur', 'kcal', 'dist', 'hr', 'hrMax'].some(function (k) {
      return cols[k] !== undefined;
    });
    if (!sportsHit) return [];

    // 睡眠表误判防护：表头里出现睡眠相关词，但没有运动类型/消耗/距离/心率时跳过
    var headTxt = head.join(' ');
    var sleepish = /睡眠|深睡|浅睡|快睡|rem|入睡|awake|wake/i.test(headTxt);
    var movesish = cols.type !== undefined || cols.kcal !== undefined ||
      cols.dist !== undefined || cols.hr !== undefined || cols.hrMax !== undefined;
    if (sleepish && !movesish) return [];

    var distIsKm = cols.dist !== undefined ? distUnitFromHeader(head[cols.dist]) : 'm';

    function cell(row, k) {
      if (cols[k] === undefined) return '';
      return String(row[cols[k]] === undefined ? '' : row[cols[k]]).trim();
    }

    var out = [];
    for (j = 1; j < lines.length; j++) {
      var row = splitCsvLine(lines[j], sep);
      if (!row.length) continue;

      var startRaw = cell(row, 'start');
      var start = parseAppleDate(startRaw);
      if (!start) continue;

      var end = 0;
      if (cols.end !== undefined) end = parseAppleDate(cell(row, 'end'));

      var dur = 0;
      var durRaw = cell(row, 'dur');
      if (durRaw) {
        // 「1小时30分」「45:30」「90」都能解析
        dur = parseDurText(durRaw);
        if (dur && dur < 1000 && !/[:时]/.test(durRaw)) {
          // 只有纯数字时，判断是秒还是分钟：时长超过 10 小时按秒，否则按分钟
          if (dur <= 240) dur *= 60;
        }
      }
      if (!end && start && dur) end = start + dur * 1000;
      if (!dur && start && end) dur = Math.round((end - start) / 1000);
      if (!end) continue;
      if (dur < 60) continue;   // 忽略太短的碎片

      var dist = num(cell(row, 'dist'));
      var du = distIsKm;
      if (cols.distUnit !== undefined) {
        var u = cleanHeader(cell(row, 'distUnit'));
        if (/km|公里|千米/.test(u)) du = 'km';
        else if (/mi|英里/.test(u)) du = 'mi';
        else if (/m|米/.test(u)) du = 'm';
      }

      var w = {
        type: vendorTypeToApple(cell(row, 'type')),
        title: cell(row, 'type') || '',
        start: start, end: end, dur: dur,
        kcal: num(cell(row, 'kcal')),
        hr: num(cell(row, 'hr')), hrMax: num(cell(row, 'hrMax')),
        dist: dist, distUnit: du,
        source: '运动健康导出'
      };
      var nw = normalizeWorkout(w);
      if (nw) out.push(nw);
    }
    return out;
  }

  /** 从厂商导出的 zip 包里找出运动记录 CSV 并解析 */
  function parseVendorZip(file) {
    return listZipEntries(file).then(function (entries) {
      var cands = entries.filter(function (e) {
        if (/\/$/.test(e.name)) return false;
        return /\.csv$|\.tsv$|\.txt$/i.test(e.name) && e.compSize > 0;
      });
      // 优先带 SPORT / sport / 运动 关键字的条目
      cands.sort(function (a, b) {
        function score(n) {
          var s = 0;
          if (/sport/i.test(n)) s += 10;
          if (/运动|record|workout|锻炼/i.test(n)) s += 6;
          if (/activity|step|sleep|heart/i.test(n)) s -= 4;
          return s;
        }
        return score(b.name) - score(a.name);
      });

      if (!cands.length) throw new Error('压缩包里没有找到 CSV 数据文件');

      // 逐个尝试，直到解析出运动记录
      var idx = 0;
      function tryNext() {
        if (idx >= cands.length) return Promise.resolve([]);
        var e = cands[idx++];
        return readZipEntryByName(file, e).then(function (blob) {
          return blob.text().then(function (txt) {
            var list = parseCsvText(txt);
            if (list.length) return list;
            return tryNext();
          });
        }).catch(function () { return tryNext(); });
      }
      return tryNext();
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

  /* ---------------- 安卓健康（Health Connect） ---------------- */

  /**
   * 原生桥接层。原生侧（MainActivity.java）暴露 AndroidBridge.healthStatus /
   * requestHealthPermissions / readHealthData / openHealthSettings，
   * 并通过 window.__onHealthStatus / __onHealthPermissions / __onHealthData 回调。
   */
  var AH = {
    /** 安卓壳且桥可用 */
    has: function () {
      return !!(root.AndroidBridge && typeof root.AndroidBridge.healthStatus === 'function');
    },

    /** 调原生方法，用一次性全局回调包装成 Promise */
    _call: function (fn, cbName, arg) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        root[cbName] = function (o) {
          if (settled) return;
          settled = true;
          resolve(o || {});
        };
        try {
          if (arg === undefined) root.AndroidBridge[fn]();
          else root.AndroidBridge[fn](arg);
        } catch (e) {
          settled = true;
          root[cbName] = null;
          reject(e);
        }
      });
    },

    /** 健康数据服务状态：{available, sdkStatus, granted, missing} */
    status: function () {
      return AH._call('healthStatus', '__onHealthStatus');
    },

    /** 弹出系统授权界面 */
    requestPermissions: function () {
      return AH._call('requestHealthPermissions', '__onHealthPermissions');
    },

    /** 读取最近 N 天的健康数据 */
    read: function (days) {
      return AH._call('readHealthData', '__onHealthData', days || 30);
    },

    /** 打开系统「健康数据」设置页（永久拒绝授权时的兜底） */
    openSettings: function () {
      try { root.AndroidBridge.openHealthSettings(); } catch (e) { }
    }
  };

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
    parseCsvText: parseCsvText,
    parseVendorZip: parseVendorZip,
    listZipEntries: listZipEntries,
    vendorTypeToApple: vendorTypeToApple,
    activityTitle: activityTitle,
    activityMap: ACT,
    androidHealth: AH
  };

  /* ================= 以下为界面部分（无 DOM 时跳过） ================= */
  if (typeof document === 'undefined') return;

  var parsed = [];
  var selected = {};
  var lastImported = null;
  var androidMode = false;      // 当前弹层是否处于「安卓健康」模式
  var androidDays = 30;        // 读取天数
  var androidVendorApps = [];  // 已检测到的厂商健康 App

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

  /* ---------------- 安卓健康（Health Connect）界面 ---------------- */

  function setAndroidMode(on) {
    androidMode = !!on;
    var m = $('#hmodal');
    if (m) m.classList.toggle('mode-android', androidMode);
    var t = $('#hi-title');
    if (t) t.textContent = androidMode ? '📱 导入安卓健康数据' : '❤️ 导入 Apple 健康';
    var blk = $('#hi-android-block');
    if (blk) blk.hidden = !androidMode;
    var b = $('#btn-android-health');
    if (b) b.classList.toggle('on', androidMode);
  }

  function showAndroidSettings(on) {
    var b = $('#ah-settings');
    if (b) b.hidden = !on;
  }

  function androidSummary(data) {
    var bits = [];
    if (data.steps) bits.push('步数 ' + Math.round(data.steps));
    if (data.weightKg) bits.push('体重 ' + (Math.round(data.weightKg * 10) / 10) + ' kg');
    if (data.sleepMinutes) bits.push('睡眠 ' + Math.round(data.sleepMinutes / 60 * 10) / 10 + ' 小时');
    return bits.length ? '（' + bits.join(' · ') + '）' : '';
  }

  /** 拉取并渲染安卓健康数据 */
  function androidFetch(days) {
    setStatus('正在读取健康数据…', '');
    AH.read(days).then(function (data) {
      // 原生读不到厂商 App 信息时，用状态阶段拿到的兜底
      if (data && !data.vendorApps && androidVendorApps.length) {
        data.vendorApps = androidVendorApps.slice();
      }
      if (!data || !data.ok) {
        setStatus('读取失败：' + ((data && data.error) || '未知错误'), 'err');
        return;
      }
      var list = normalizeExternal(data.workouts || []);
      if (!list.length) {
        setStatus('最近 ' + days + ' 天里没有读到训练记录。' + androidSummary(data) +
          '\n\n' + vendorHint(data) +
          '请往下拉，改用「方式二」导入运动 App 导出的文件。', 'err');
        parsed = [];
        renderPreview();
        highlightVendorPath();
        return;
      }
      parsed = list;
      initSelection(false);
      renderPreview();
      setStatus('已读取 ' + list.length + ' 条训练' + androidSummary(data) + '，已勾选 ' + countSel() + ' 条，可按需调整', 'ok');
    }).catch(function (e) {
      setStatus('读取失败：' + ((e && e.message) || e), 'err');
    });
  }

  /** 检查服务 → 授权 → 读取 */
  function androidLoad(days) {
    androidDays = days || 30;
    showAndroidSettings(false);
    setStatus('正在检查健康数据服务…', '');
    AH.status().then(function (st) {
      androidVendorApps = (st && st.vendorApps) || [];
      if (!st || !st.available) {
        setStatus('本机没有可用的「健康共享」服务。Android 14 及以上系统自带；更早的机型需先安装「Health Connect」应用。\n\n' +
          '如果你是国产手机（小米 / 华为 / OPPO / vivo），建议直接用下方的「方式二」导入运动 App 导出的文件。', 'err');
        showAndroidSettings(true);
        highlightVendorPath();
        return;
      }
      var missing = st.missing || [];
      // 即使能授权，若本机装的是国行健康 App，也要提前告知读取可能为空
      if (missing.length) {
        setStatus('需要授权读取健康数据，请在弹出的系统窗口中点「允许」。', '');
        AH.requestPermissions().then(function (r) {
          var m2 = (r && r.missing) || [];
          if (m2.length) {
            setStatus('还有 ' + m2.length + ' 项权限没授权。可在系统「健康数据」设置里手动打开。', 'err');
            showAndroidSettings(true);
          } else {
            androidFetch(androidDays);
          }
        }).catch(function (e) {
          setStatus('授权失败：' + ((e && e.message) || e), 'err');
          showAndroidSettings(true);
        });
        return;
      }
      androidFetch(androidDays);
    }).catch(function (e) {
      setStatus('检查失败：' + ((e && e.message) || e), 'err');
    });
  }

  /** 根据已安装的厂商健康 App，给出针对性提示 */
  function vendorHint(data) {
    var apps = (data && data.vendorApps) || [];
    if (apps.length) {
      return '检测到你装了「' + apps.join('」「') + '」。手机自带的厂商健康 App 国行版不会把数据写进系统「健康共享」' +
        '（它们走各自的私有生态），但 Keep、咕咚这类第三方健身 App 的数据是可以写进去的。' +
        '如果你的训练都记在这些厂商 App 里，这里读不到是正常的。\n\n';
    }
    return '手机自带的厂商健康 App（小米运动健康 / 华为运动健康 / 欢太健康 / vivo 健康）国行版' +
      '通常不写进系统「健康共享」，所以这里可能是空的；' +
      '但 Keep、咕咚这类第三方健身 App 的数据可以直接读到。\n\n';
  }

  /** 把「方式二」区块高亮出来，引导用户改走文件导入 */
  function highlightVendorPath() {
    var box = $('#ah-vendor-box');
    if (box) box.classList.add('hl');
    var btn = $('#ah-choose');
    if (btn && btn.scrollIntoView) {
      try { btn.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
    }
  }

  /** 处理用户选择的厂商导出文件（.csv / .zip / .txt） */
  function handleVendorFile(file) {
    setStatus('正在读取「' + file.name + '」…', '');
    var listBox = $('#hi-list');
    if (listBox) listBox.innerHTML = '';
    var impBtn = $('#hi-import');
    if (impBtn) impBtn.hidden = true;

    var p = /\.zip$/i.test(file.name)
      ? parseVendorZip(file)
      : file.text().then(function (txt) { return parseCsvText(txt); });

    return p.then(function (list) {
      if (!list.length) {
        throw new Error('这个文件里没有识别到运动记录。国产 App 的导出格式各不相同，如果导出的是 Excel(.xlsx)，请先用 WPS 或 Excel 另存为 CSV 再导入');
      }
      parsed = list;
      initSelection(false);
      renderPreview();
      setStatus('已识别 ' + list.length + ' 条训练，已勾选 ' + countSel() + ' 条，可按需调整', 'ok');
    }).catch(function (e) {
      setStatus('导入失败：' + ((e && e.message) || e), 'err');
    });
  }

  /** 打开安卓健康导入弹层 */
  function openAndroidSheet() {
    if (!AH.has()) return;
    setAndroidMode(true);
    openSheet({ reset: true });
    androidLoad(30);
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
    setAndroidMode(false);
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
      toast(androidMode ? '已导入安卓健康数据 ✓' : '已导入 Apple 健康数据 ✓');
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
    if (b1) b1.onclick = function () { setAndroidMode(false); openSheet({ reset: true }); };

    /* 安卓健康入口（仅安卓壳内显示） */
    var ab = $('#btn-android-health');
    if (ab) {
      ab.hidden = !AH.has();
      ab.onclick = function () { openAndroidSheet(); };
    }

    var abd = $('#btn-android-health-done');
    if (abd) {
      abd.hidden = !AH.has();
      abd.onclick = function () { openAndroidSheet(); };
    }

    var ahPerm = $('#ah-perm');
    if (ahPerm) ahPerm.onclick = function () { androidLoad(androidDays); };

    var ahRead = $('#ah-read');
    if (ahRead) ahRead.onclick = function () { androidLoad(androidDays); };

    var ahSel = $('#ah-days');
    if (ahSel) ahSel.onchange = function () { androidDays = parseInt(ahSel.value, 10) || 30; };

    var ahSet = $('#ah-settings');
    if (ahSet) ahSet.onclick = function () { AH.openSettings(); };

    /* 国产厂商导出文件导入 */
    var avChoose = $('#ah-choose'), avFile = $('#ah-file');
    if (avChoose && avFile) {
      avChoose.onclick = function () { avFile.value = ''; avFile.click(); };
      avFile.onchange = function () {
        var f = this.files && this.files[0];
        if (f) handleVendorFile(f);
      };
    }

    var b2 = $('#btn-hi-done');
    if (b2) b2.onclick = function () { quickImport(); };

    var clip = $('#hi-clip');
    if (clip) clip.onclick = function () { quickImport(); };

    /* 运动 App 导出的 CSV（小米 / 华为 / OPPO 等），任何平台都能用 */
    var csvChoose = $('#hi-choose-csv'), csvFile = $('#hi-file-csv');
    if (csvChoose && csvFile) {
      csvChoose.onclick = function () { csvFile.value = ''; csvFile.click(); };
      csvFile.onchange = function () {
        var f = this.files && this.files[0];
        if (f) handleVendorFile(f);
      };
    }

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
  root.HI.openAndroidSheet = openAndroidSheet;

})(typeof window !== 'undefined' ? window : globalThis);
