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
  var mu = null, objUrl = null, msBound = false;
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
      var p = null;
      try { p = el.play(); } catch (e) {}
      if (p && p.catch) p.catch(function () { playing = false; syncAll(); });
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
    errStreak++;
    var t = tracks[cur];
    var lab = mid('mbar-title');
    if (lab && t) lab.textContent = '⚠️ 无法播放：' + t.name;
    if (errStreak >= Math.max(1, tracks.length)) {
      errStreak = 0;
      if (mu) { try { mu.pause(); } catch (e) {} }
      playing = false; syncAll();
      return;
    }
    playNext();
  }

  /* ---------- Media Session（锁屏/控制中心） ---------- */
  function msMeta(name) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: name || '训练音乐', artist: '健身提醒', album: 'Workout',
        artwork: [{ src: 'icon-180.png', sizes: '180x180', type: 'image/png' }]
      });
    } catch (e) {}
  }
  function msBind() {
    if (msBound || !('mediaSession' in navigator)) return;
    msBound = true;
    var N = navigator.mediaSession;
    try { N.setActionHandler('play', function () { api.togglePlay(); }); } catch (e) {}
    try { N.setActionHandler('pause', function () { api.setPaused(true); }); } catch (e) {}
    try { N.setActionHandler('previoustrack', function () { api.prev(); }); } catch (e) {}
    try { N.setActionHandler('nexttrack', function () { api.next(); }); } catch (e) {}
  }
  function msState(s) { try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s; } catch (e) {} }

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
  }
  function setPaused(p) {
    if (!mu || cur < 0) return;
    if (p) { try { mu.pause(); } catch (e) {} }
    else { var q = null; try { q = mu.play(); } catch (e) {} if (q && q.catch) q.catch(function () {}); }
  }
  function togglePlay() {
    if (!tracks.length) return;
    if (playing) { setPaused(true); return; }
    if (cur < 0) { loadTrack(0, true); return; }
    setPaused(false);
  }
  function next() { if (tracks.length) { msBind(); playNext(); } }
  function prev() {
    if (!tracks.length) return;
    if (mu && mu.currentTime > 3) { try { mu.currentTime = 0; } catch (e) {} return; }
    loadTrack(cur - 1, true);
  }

  /* ---------- 顶部/训练页音乐条 ---------- */
  function syncAll() {
    var bar = mid('mbar');
    var t = tracks[cur];
    var lab = mid('mbar-title');
    if (lab) lab.textContent = t ? (t.name + ' · ' + (cur + 1) + '/' + tracks.length) : '—';
    var on = mid('ic-mplay'), off = mid('ic-mpause');
    if (on) on.hidden = playing;
    if (off) off.hidden = !playing;
    var vOn = mid('ic-mvol'), vOff = mid('ic-mmut');
    if (vOn) vOn.hidden = mute;
    if (vOff) vOff.hidden = !mute;
    if (bar) bar.hidden = !tracks.length || (!workoutMode && !previewMode);
    msState(playing ? 'playing' : 'paused');
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
    tracks.forEach(function (t, i) {
      var row = document.createElement('div');
      row.className = 'mm-row' + ((previewMode || workoutMode) && i === cur ? ' cur' : '');
      var pb = document.createElement('button');
      pb.className = 'mm-play';
      pb.innerHTML = (i === cur && playing) ? SVG_PAUSE : SVG_PLAY;
      pb.onclick = function () {
        if (i === cur && playing) { previewMode = false; setPaused(true); renderSheet(); }
        else { previewMode = true; workoutMode = false; loadTrack(i, true); }
      };
      var nm = document.createElement('div'); nm.className = 'mm-name'; nm.textContent = t.name;
      var sz = document.createElement('span'); sz.className = 'mm-size'; sz.textContent = fmtSize(t.size);
      var db = document.createElement('button'); db.className = 'mm-del'; db.innerHTML = SVG_TRASH;
      db.onclick = function () {
        mReq('readwrite', function (st) { return st.delete(t.id); }).then(function () {
          return refresh();
        }).then(renderSheet).catch(function () {});
      };
      row.appendChild(pb); row.appendChild(nm); row.appendChild(sz); row.appendChild(db);
      box.appendChild(row);
    });
  }
  window.__mmRender = renderSheet;
  function openSheet() {
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
    [].slice.call(fl).forEach(function (f) {
      if (!f) return;
      var ext = (f.name || '').toLowerCase().split('.').pop();
      /* Android 全量文件选择器会给出任意类型，非音频直接跳过 */
      if (!((f.type && f.type.indexOf('audio/') === 0) || MIME[ext])) { skipped++; return; }
      var nm = (f.name || '音乐').replace(/\.(mp3|m4a|mp4|wav|aac|flac|ogg|oga|wma|aiff?|caf)$/i, '').slice(0, 40) || '音乐';
      if ((!f.type || f.type === 'application/octet-stream') && MIME[ext]) {
        try { f = new Blob([f], { type: MIME[ext] }); } catch (e) {}
      }
      var id = 'm' + Date.now() + Math.random().toString(36).slice(2, 7);
      jobs.push(mReq('readwrite', function (st) { return st.put({ name: nm, size: f.size || 0, blob: f }, id); }));
    });
    return Promise.all(jobs).then(refresh).then(function () {
      var err = mid('mm-err');
      if (err) err.textContent = jobs.length ? ('已导入 ' + jobs.length + ' 首 ✓' + (skipped ? '（跳过 ' + skipped + ' 个非音频）' : '')) : (skipped ? '没有可导入的音频文件' : '');
      setTimeout(function () { if (err) err.textContent = ''; }, 2500);
    }).catch(function () {
      var err = mid('mm-err');
      if (err) err.textContent = '导入失败，请重试';
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
    if ((b = mid('mm-add'))) b.onclick = function () { mid('mm-file').click(); };
    if ((b = mid('mm-file'))) b.onchange = function () {
      if (this.files && this.files.length) addFiles(this.files);
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
    if ((b = mid('mbar-prev'))) b.onclick = prev;
    if ((b = mid('mbar-next'))) b.onclick = next;
    if ((b = mid('mbar-play'))) b.onclick = togglePlay;
    if ((b = mid('mbar-mute'))) b.onclick = function () {
      mute = !mute;
      localStorage.setItem('fit_music_mute', mute ? '1' : '0');
      if (mu) try { mu.muted = mute; } catch (e) {}
      syncAll();
    };
    refresh();
    msBind();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.FITMUSIC = {
    startWorkout: startWorkout,
    stopWorkout: stopWorkout,
    setPaused: setPaused,
    togglePlay: togglePlay,
    next: next,
    prev: prev,
    hasTracks: function () { return tracks.length > 0; },
    _dbg: function () {
      return { n: tracks.length, cur: cur, playing: playing, workout: workoutMode, preview: previewMode,
        paused: mu ? mu.paused : null, t: mu ? mu.currentTime : null, bar: mid('mbar') ? !mid('mbar').hidden : null,
        title: mid('mbar-title') ? mid('mbar-title').textContent : null, err: errStreak, muEl: mu };
    },
    _import: addFiles
  };
})();
