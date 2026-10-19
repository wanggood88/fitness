/* fit-v21 训练音乐：本机导入音频（IndexedDB fit_music_v1），训练时循环播放
   支持上一首/下一首/暂停/静音/随机，锁屏与控制中心走 Media Session（iOS 15+） */
'use strict';
(function () {
  function mid(id) { return document.getElementById(id); }
  /* 弹层内 JS 动态创建的按钮用同体系单色 SVG（与 .cicon 一致） */
  var SVG_PLAY = '<svg class="cicon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 2.9v10.2c0 1 1.05 1.55 1.85 1.02l7.9-5.1c.75-.48.75-1.55 0-2.03l-7.9-5.1C5.65 1.35 4.6 1.9 4.6 2.9z"/></svg>';
  var SVG_PAUSE = '<svg class="cicon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2.2" width="3.6" height="11.6" rx="1.6"/><rect x="9.4" y="2.2" width="3.6" height="11.6" rx="1.6"/></svg>';
  var SVG_TRASH = '<svg class="cicon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 4.6h9.6M6.1 4.3V3.4c0-.61.5-1.1 1.1-1.1h1.6c.6 0 1.1.49 1.1 1.1v.9M4.6 4.9l.47 6.8c.06.8.72 1.42 1.52 1.42h2.82c.8 0 1.46-.62 1.52-1.42l.47-6.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  /* ---------- IndexedDB（独立于演示媒体的 fit_media_v1） ---------- */
  function mdb() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open('fit_music_v1', 1);
      rq.onupgradeneeded = function () {
        try { rq.result.createObjectStore('tracks'); } catch (e) {}
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function mReq(mode, fn) {
    return mdb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = null, rq = null;
        try { tx = db.transaction('tracks', mode); rq = fn(tx.objectStore('tracks')); }
        catch (e) { db.close(); rej(e); return; }
        tx.oncomplete = function () { var v = rq ? rq.result : undefined; db.close(); res(v); };
        tx.onerror = function () { db.close(); rej(tx.error || new Error('idb')); };
      });
    });
  }
  function listTracks() {
    return mdb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx, st, rk, rv;
        try { tx = db.transaction('tracks', 'readonly'); st = tx.objectStore('tracks'); rk = st.getAllKeys(); rv = st.getAll(); }
        catch (e) { db.close(); rej(e); return; }
        tx.oncomplete = function () {
          db.close();
          var ks = rk.result || [], vs = rv.result || [], out = [];
          for (var i = 0; i < ks.length; i++) {
            out.push({ id: ks[i], name: (vs[i] && vs[i].name) || String(ks[i]), size: (vs[i] && vs[i].size) || 0, blob: (vs[i] && vs[i].blob) || null });
          }
          res(out);
        };
        tx.onerror = function () { db.close(); rej(tx.error || new Error('idb')); };
      });
    });
  }

  /* ---------- 状态 ---------- */
  var tracks = [], cur = -1, playing = false, workoutMode = false, previewMode = false, errStreak = 0;
  var mu = null, objUrl = null, msBound = false, loadGen = 0;
  var seekDrag = false, seekDragT = 0;
  /* APK 原生壳里走 AndroidBridge（原生 MediaSession 通知），屏蔽 Web MediaSession 避免双会话 */
  var NATIVE_MS = false;
  try { NATIVE_MS = !!(window.AndroidBridge && window.AndroidBridge.msUpdate); } catch (e) {}
  var vol = parseFloat(localStorage.getItem('fit_music_vol'));
  if (isNaN(vol)) vol = 0.8;
  vol = Math.max(0, Math.min(1, vol));
  var mute = localStorage.getItem('fit_music_mute') === '1';
  var shuffle = localStorage.getItem('fit_music_shuffle') === '1';

  function ensureAudio() {
    if (mu) return mu;
    mu = new Audio();
    mu.preload = 'auto';
    mu.volume = vol; mu.muted = mute;
    mu.addEventListener('ended', onEnded);
    mu.addEventListener('error', onError);
    mu.addEventListener('timeupdate', syncSeek);
    mu.addEventListener('loadedmetadata', function () { syncSeek(); msPos(); });
    mu.addEventListener('seeked', function () { syncSeek(); msPos(); });
    mu.addEventListener('playing', function () { msPos(); });
    mu.addEventListener('pause', function () { msPos(); });
    mu.addEventListener('ratechange', function () { msPos(); });
    mu.addEventListener('playing', function () { errStreak = 0; playing = true; syncAll(); });
    mu.addEventListener('pause', function () { if (mu && !mu.ended) { playing = false; syncAll(); } });
    return mu;
  }
  function loadTrack(i, autoplay) {
    if (!tracks.length) return;
    cur = ((i % tracks.length) + tracks.length) % tracks.length;
    var t = tracks[cur];
    var el = ensureAudio();
    try { el.pause(); } catch (e) {}
    if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) {} objUrl = null; }
    if (!t.blob) { onError(); return; }
    try { objUrl = URL.createObjectURL(t.blob); } catch (e) { onError(); return; }
    el.src = objUrl;
    try { el.load(); } catch (e) {}
    if (autoplay) {
      var gen = ++loadGen, p = null;
      try { p = el.play(); } catch (e) {}
      if (p && p.catch) p.catch(function () {
        if (gen !== loadGen) return; /* 已切到别的曲子，忽略旧请求 */
        playing = false; syncAll();
        if (el.error) onError();
      });
    }
    syncAll(); msMeta(t.name);
  }
  function onEnded() {
    playing = false;
    if (!workoutMode) { previewMode = false; syncAll(); if (window.__mmRender) window.__mmRender(); return; }
    playNext();
  }
  function playNext() {
    if (!tracks.length) return;
    var i;
    if (shuffle && tracks.length > 1) {
      do { i = Math.floor(Math.random() * tracks.length); } while (i === cur);
    } else i = cur + 1;
    loadTrack(i, true);
  }
  function onError() {
    if (!tracks.length) return;
    if (mu && mu.error && mu.error.code === 1) return; /* 切歌导致的中止不算错 */
    errStreak++;
    var t = tracks[cur];
    if (errStreak >= Math.max(1, tracks.length)) {
      errStreak = 0;
      if (mu) { try { mu.pause(); } catch (e) {} }
      playing = false; syncAll();
      /* pause 事件异步触发的 syncAll 会覆写标题，警告延后写 */
      setTimeout(function () { setTitle(t ? ('⚠️ 无法播放：' + t.name) : '⚠️ 音乐无法播放'); }, 120);
      return;
    }
    setTitle('⚠️ 跳过：' + (t ? t.name : '?'));
    playNext();
  }

  /* ---------- Media Session（锁屏/控制中心） ---------- */
  function msMeta(name) {
    if (NATIVE_MS || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: name || '训练音乐', artist: '健身提醒', album: 'Workout',
        artwork: [{ src: 'icon-180.png', sizes: '180x180', type: 'image/png' }]
      });
    } catch (e) {}
  }
  function msBind() {
    if (msBound || NATIVE_MS || !('mediaSession' in navigator)) return;
    msBound = true;
    var N = navigator.mediaSession;
    try { N.setActionHandler('play', function () { togglePlay(); }); } catch (e) {}
    try { N.setActionHandler('pause', function () { setPaused(true); }); } catch (e) {}
    try { N.setActionHandler('previoustrack', function () { prev(); }); } catch (e) {}
    try { N.setActionHandler('nexttrack', function () { next(); }); } catch (e) {}
    try { N.setActionHandler('seekto', function (d) { if (mu && d && isFinite(d.seekTime)) { var t = Math.max(0, d.seekTime); if (isFinite(mu.duration)) t = Math.min(t, mu.duration); try { mu.currentTime = t; } catch (e) {} } }); } catch (e) {}
    try { N.setActionHandler('seekbackward', function (d) { if (mu) { try { mu.currentTime = Math.max(0, mu.currentTime - ((d && d.seekOffset) || 10)); } catch (e) {} } }); } catch (e) {}
    try { N.setActionHandler('seekforward', function (d) { if (mu) { var t = mu.currentTime + ((d && d.seekOffset) || 10); if (isFinite(mu.duration)) t = Math.min(t, mu.duration); try { mu.currentTime = t; } catch (e) {} } }); } catch (e) {}
  }
  function msState(s) { if (NATIVE_MS) return; try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s; } catch (e) {} }
  /* 通知栏/锁屏进度条：由系统按 playbackRate 插值推进，播/停/拖时重设基准 */
  function msPos() {
    if (NATIVE_MS || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!mu) return;
    var d = mu.duration;
    if (!isFinite(d) || d <= 0) return;
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.max(0, Math.min(mu.currentTime || 0, d)), playbackRate: mu.playbackRate || 1 }); } catch (e) {}
  }
  /* APK 原生媒体通知：把标题/播放态/进度推给 AndroidBridge（约 4Hz，通知栏 seekbar 数据源） */
  function msBridgePush() {
    var B = window.AndroidBridge;
    if (!B || !B.msUpdate) return;
    var t = tracks[cur], d = mu ? mu.duration : 0;
    try {
      B.msUpdate(JSON.stringify({
        title: t ? t.name : '', playing: !!playing,
        active: tracks.length > 0 && (workoutMode || previewMode || playing),
        pos: mu ? Math.max(0, mu.currentTime || 0) : 0,
        dur: isFinite(d) ? d : 0
      }));
    } catch (e) {}
  }

  /* ---------- 训练流程接入 ---------- */
  function startWorkout() {
    workoutMode = true; previewMode = false;
    if (!tracks.length) return;
    var bar = mid('mbar'); if (bar) bar.hidden = false;
    msBind();
    if (cur < 0) cur = 0;
    if (!playing) loadTrack(cur, true); else msMeta(tracks[cur].name);
  }
  function stopWorkout() {
    workoutMode = false; previewMode = false;
    var bar = mid('mbar'); if (bar) bar.hidden = true;
    if (mu) { try { mu.pause(); } catch (e) {} }
    playing = false; msState('paused'); syncAll();
    try { if ('mediaSession' in navigator) navigator.mediaSession.metadata = null; } catch (e) {}
    try { if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) navigator.mediaSession.setPositionState(); } catch (e) {}
  }
  function setPaused(p) {
    if (!mu || cur < 0) return;
    if (p) { try { mu.pause(); } catch (e) {} }
    else { var q = null; try { q = mu.play(); } catch (e) {} if (q && q.catch) q.catch(function () {}); }
  }
  function setMuted(m) {
    mute = !!m;
    localStorage.setItem('fit_music_mute', mute ? '1' : '0');
    if (mu) try { mu.muted = mute; } catch (e) {}
    syncAll();
  }
  function togglePlay() {
    if (!tracks.length) return;
    if (playing) { setPaused(true); return; }
    if (cur < 0) { loadTrack(0, true); return; }
    setPaused(false);
  }
  function next() {
    if (!tracks.length) return;
    msBind();
    /* 手动「下一首」：多于一首时随机抽，不依赖弹层的顺序/随机开关 */
    var i = cur;
    if (tracks.length > 1) { do { i = Math.floor(Math.random() * tracks.length); } while (i === cur); }
    loadTrack(i, true);
  }
  function prev() {
    if (!tracks.length) return;
    if (mu && mu.currentTime > 3) { try { mu.currentTime = 0; } catch (e) {} return; }
    loadTrack(cur - 1, true);
  }

  /* ---------- 播放进度条 ---------- */
  function fmtT(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function syncSeek() {
    var sk = mid('mbar-seek'); if (!sk) return;
    var bar = mid('mbar'); if (!bar || bar.hidden || seekDrag) return;
    var d = mu ? mu.duration : 0, t = mu ? mu.currentTime : 0, tl = mid('mbar-time');
    if (!isFinite(d) || d <= 0) { sk.value = 0; sk.style.setProperty('--fill', '0%'); if (tl) tl.textContent = ''; return; }
    var p = Math.max(0, Math.min(1000, Math.round(t / d * 1000)));
    sk.value = p; sk.style.setProperty('--fill', (p / 10) + '%');
    if (tl) tl.textContent = fmtT(t) + ' / ' + fmtT(d);
    msBridgePush();
  }

  /* ---------- 顶部/训练页音乐条 ---------- */
  function setTitle(s) {
    var lab = mid('mbar-title'); if (!lab) return null;
    var inn = lab.querySelector('.mt-in');
    if (!inn) { lab.innerHTML = ''; inn = document.createElement('span'); inn.className = 'mt-in'; lab.appendChild(inn); }
    var n = lab.firstChild;
    while (n) { var nx = n.nextSibling; if (n !== inn) lab.removeChild(n); n = nx; }
    inn.textContent = s;
    return inn;
  }
  function syncAll() {
    var bar = mid('mbar');
    var t = tracks[cur];
    var lab = mid('mbar-title');
    if (lab) {
      var inn = setTitle(t ? (t.name + ' · ' + (cur + 1) + '/' + tracks.length) : '—');
      var bar2 = mid('mbar');
      if (inn && bar2 && !bar2.hidden) setTimeout(function () {
        var tw = 0;
        try {
          /* span 盒子被容器钳制、Range/Canvas 在部分内核全不可信：
             用绝对定位游离节点量真实 DOM 布局宽度（left:-9999px 解除钳制） */
          var meas = setTitle._meas;
          if (!meas) {
            meas = document.createElement('div');
            meas.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;display:inline-block;padding:0;margin:0;border:0;';
            document.body.appendChild(meas);
            setTitle._meas = meas;
          }
          var cl = getComputedStyle(lab);
          meas.style.font = (cl.fontWeight || '400') + ' ' + cl.fontSize + ' ' + cl.fontFamily;
          meas.textContent = inn.textContent;
          tw = meas.offsetWidth;
        } catch (e) { tw = inn.scrollWidth; }
        var over = tw - lab.clientWidth;
        if (over > 6) {
          lab.classList.add('run');
          inn.style.setProperty('--mt-dist', '-' + (over + 8) + 'px');
          inn.style.setProperty('--mt-dur', Math.max(5, Math.min(14, over / 15)) + 's');
        } else lab.classList.remove('run');
      }, 50);
    }
    var on = mid('ic-mplay'), off = mid('ic-mpause');
    /* SVGElement 无 hidden IDL 属性，.hidden= 只是 expando 不落属性，必须 setAttribute */
    if (on) { if (playing) on.setAttribute('hidden',''); else on.removeAttribute('hidden'); }
    if (off) { if (playing) off.removeAttribute('hidden'); else off.setAttribute('hidden',''); }
    if (bar) bar.hidden = !tracks.length || (!workoutMode && !previewMode);
    msState(playing ? 'playing' : 'paused');
    syncSeek();
    msBridgePush();
    if (window.__mmRender) window.__mmRender();
  }
  function fmtSize(n) {
    if (!n) return '';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* ---------- 音乐库弹层 ---------- */
  function refresh() {
    return listTracks().then(function (ts) {
      tracks = ts;
      if (cur >= tracks.length) {
        cur = tracks.length ? 0 : -1;
        if (mu && cur < 0) { try { mu.pause(); } catch (e) {} playing = false; }
      }
      syncAll();
    }).catch(function () {});
  }
  function renderSheet() {
    var box = mid('mm-list');
    if (!box) return;
    box.innerHTML = '';
    if (!tracks.length) {
      box.innerHTML = '<div class="mm-empty">还没有音乐。点下方按钮，从「文件」App 选几首 mp3 / m4a / wav（Apple Music 正版歌有版权保护，无法导入）</div>';
      return;
    }
    var sq = mid('mm-search');
    var q = (sq && sq.value ? sq.value : '').trim().toLowerCase();
    var shown = [];
    tracks.forEach(function (t, i) {
      if (!q || (t.name || '').toLowerCase().indexOf(q) > -1) shown.push(i);
    });
    if (!shown.length) {
      var esc = q.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      box.innerHTML = '<div class="mm-empty">没有匹配「' + esc + '」的歌曲</div>';
      return;
    }
    shown.forEach(function (i) {
      var t = tracks[i];
      var row = document.createElement('div');
      row.className = 'mm-row' + ((previewMode || workoutMode) && i === cur ? ' cur' : '');
      var pb = document.createElement('button');
      pb.className = 'mm-play';
      pb.innerHTML = (i === cur && playing) ? SVG_PAUSE : SVG_PLAY;
      /* 整行可点：点歌名即播放该曲——随机模式下也是点哪首播哪首 */
      row.onclick = function () { playRow(i); };
      var nm = document.createElement('div'); nm.className = 'mm-name'; nm.textContent = t.name;
      var sz = document.createElement('span'); sz.className = 'mm-size'; sz.textContent = fmtSize(t.size);
      var db = document.createElement('button'); db.className = 'mm-del'; db.innerHTML = SVG_TRASH;
      db.onclick = function (e) {
        e.stopPropagation();
        mReq('readwrite', function (st) { return st.delete(t.id); }).then(function () {
          return refresh();
        }).then(renderSheet).catch(function () {});
      };
      row.appendChild(pb); row.appendChild(nm); row.appendChild(sz); row.appendChild(db);
      box.appendChild(row);
    });
  }
  function playRow(i) {
    if (i === cur && playing) { setPaused(true); renderSheet(); }
    else { previewMode = !workoutMode; loadTrack(i, true); }
  }
  window.__mmRender = renderSheet;
  function openSheet() {
    var s = mid('mm-search'); if (s) s.value = '';
    refresh().then(renderSheet);
    syncVolUI();
    mid('mmsheet').classList.add('show');
  }
  function closeSheet() {
    mid('mmsheet').classList.remove('show');
    if (previewMode) { previewMode = false; setPaused(true); }
  }
  function addFiles(fl) {
    var MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf' };
    var jobs = [];
    var skipped = 0;
    var types = [];
    [].slice.call(fl || []).forEach(function (f) {
      if (!f) return;
      var ext = (f.name || '').toLowerCase().split('.').pop();
      /* Android 全量文件选择器会给出任意类型，非音频直接跳过 */
      var mime = (f.type && f.type.indexOf('audio/') === 0) ? f.type : MIME[ext];
      if (!mime) { skipped++; if (types.length < 2) types.push(((f.name || '').slice(0, 14) || '?') + ':' + (f.type || ext || '?')); return; }
      var nm = (f.name || '音乐').replace(/\.(mp3|m4a|mp4|wav|aac|flac|ogg|oga|wma|aiff?|caf)$/i, '').slice(0, 40) || '音乐';
      var id = 'm' + Date.now() + Math.random().toString(36).slice(2, 7);
      /* 先读进内存再落库：部分 WebView 对选择器给的 File（content:// 惰性 blob）直接存 IDB 会失败 */
      var p = (f.arrayBuffer ? f.arrayBuffer() : Promise.reject(new Error('文件不可读')))
        .catch(function () { return null; })
        .then(function (buf) {
          var blob = buf ? new Blob([buf], { type: mime }) : f;
          return mReq('readwrite', function (st) { return st.put({ name: nm, size: buf ? blob.size : (f.size || 0), blob: blob }, id); });
        });
      jobs.push(p);
    });
    return Promise.all(jobs).then(refresh).then(function () {
      var err = mid('mm-err'), msg;
      if (jobs.length && tracks.length) msg = '已导入 ' + jobs.length + ' 首 ✓' + (skipped ? '（跳过 ' + skipped + ' 个非音频）' : '');
      else if (jobs.length) msg = '写入成功但读取失败，请重启应用再试';
      else if (skipped) msg = '没有可导入的音频文件：' + (types.join(' / ') || skipped + ' 个');
      else msg = '没有取到文件';
      if (err) err.textContent = msg;
      setTimeout(function () { if (err && err.textContent === msg) err.textContent = ''; }, 4000);
    }).catch(function (e) {
      var err = mid('mm-err');
      var msg = '导入失败：' + (e && e.message ? e.message : '存储错误');
      if (err) err.textContent = msg;
      setTimeout(function () { if (err && err.textContent === msg) err.textContent = ''; }, 5000);
    });
  }
  function syncVolUI() {
    var r = mid('mm-vol'), lab = mid('mm-vol-lab'), sh = mid('mm-shuf');
    if (r) r.value = Math.round(vol * 100);
    if (lab) lab.textContent = Math.round(vol * 100) + '%';
    if (sh) sh.textContent = shuffle ? '随机' : '顺序';
  }

  /* ---------- 初始化绑定 ---------- */
  function init() {
    var b;
    if ((b = mid('btn-music'))) b.onclick = openSheet;
    if ((b = mid('mm-close'))) b.onclick = closeSheet;
    var sh = mid('mmsheet');
    if (sh) sh.addEventListener('click', function (e) { if (e.target === sh) closeSheet(); });
    if ((b = mid('mm-add'))) b.onclick = function () {
      if (window.AndroidBridge && AndroidBridge.pickAudio) AndroidBridge.pickAudio();
      else mid('mm-file').click();
    };
    if ((b = mid('mm-file'))) b.onchange = function () {
      if (this.files && this.files.length) addFiles(this.files);
      else {
        var err = mid('mm-err');
        if (err) { err.textContent = '没有取到文件'; setTimeout(function () { if (err) err.textContent = ''; }, 3000); }
      }
      this.value = '';
    };
    if ((b = mid('mm-vol'))) b.oninput = function () {
      vol = Math.max(0, Math.min(1, (+this.value || 0) / 100));
      if (mu) try { mu.volume = vol; } catch (e) {}
      localStorage.setItem('fit_music_vol', String(vol));
      var lab = mid('mm-vol-lab'); if (lab) lab.textContent = Math.round(vol * 100) + '%';
    };
    if ((b = mid('mm-shuf'))) b.onclick = function () {
      shuffle = !shuffle;
      localStorage.setItem('fit_music_shuffle', shuffle ? '1' : '0');
      syncVolUI();
    };
    if ((b = mid('mm-search'))) b.oninput = function () { renderSheet(); };
    if ((b = mid('mbar-prev'))) b.onclick = prev;
    if ((b = mid('mbar-next'))) b.onclick = next;
    if ((b = mid('mbar-play'))) b.onclick = togglePlay;
    if ((b = mid('mbar-list'))) b.onclick = openSheet;
    if ((b = mid('mbar-seek'))) {
      b.addEventListener('input', function () {
        seekDrag = true;
        clearTimeout(seekDragT); seekDragT = setTimeout(function () { seekDrag = false; syncSeek(); }, 1000);
        var d = mu ? mu.duration : 0, tl = mid('mbar-time');
        if (isFinite(d) && d > 0) {
          this.style.setProperty('--fill', (this.value / 10) + '%');
          if (tl) tl.textContent = fmtT(this.value / 1000 * d) + ' / ' + fmtT(d);
        }
      });
      b.addEventListener('change', function () {
        clearTimeout(seekDragT); seekDragT = 0; seekDrag = false;
        var d = mu ? mu.duration : 0;
        if (isFinite(d) && d > 0 && mu) { try { mu.currentTime = this.value / 1000 * d; } catch (e) {} }
        syncSeek();
      });
    }
    /* 静音统一由右上角声音开关控制（fit_sound），音乐条不再单独静音 */
    mute = localStorage.getItem('fit_sound') === '0';
    if (mu) try { mu.muted = mute; } catch (e) {}
    refresh();
    msBind();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.FITMUSIC = {
    startWorkout: startWorkout,
    stopWorkout: stopWorkout,
    setPaused: setPaused,
    setMuted: setMuted,
    openSheet: openSheet,
    togglePlay: togglePlay,
    next: next,
    prev: prev,
    seek: function (t) {
      if (!mu || !isFinite(t)) return;
      var x = Math.max(0, t);
      if (isFinite(mu.duration)) x = Math.min(x, mu.duration);
      try { mu.currentTime = x; } catch (e) {}
    },
    hasTracks: function () { return tracks.length > 0; },
    _dbg: function () {
      return { n: tracks.length, cur: cur, playing: playing, workout: workoutMode, preview: previewMode,
        paused: mu ? mu.paused : null, t: mu ? mu.currentTime : null, bar: mid('mbar') ? !mid('mbar').hidden : null,
        title: mid('mbar-title') ? mid('mbar-title').textContent : null, err: errStreak, muEl: mu };
    },
    _import: addFiles
  };
})();
