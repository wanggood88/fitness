/* FIT3D：3D 卡通小人动作演示（Three.js 实时渲染 + 相机环绕）
   API：FIT3D.play('squat'|'pushup') → 返回 canvas（失败返回 null）；FIT3D.stop() */
window.FIT3D_VER = '2';
window.FIT3D = (function () {
  var renderer = null, scene = null, camera = null, timer = null, cv = null;
  var t = 0, updatePose = null, orbitCfg = null;
  var V3 = function (x, y, z) { return new THREE.Vector3(x, y, z); };

  function mat(c) { return new THREE.MeshToonMaterial({ color: c }); }
  var M = {};
  function mats() {
    M.head = mat(0xa3e635); M.body = mat(0x22d3a5); M.limb = mat(0x9fe23a);
    M.white = mat(0xf2f6ea); M.dark = mat(0x1a2410); M.gold = mat(0xfbbf24);
    M.shadow = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 });
    M.ground = new THREE.MeshBasicMaterial({ color: 0x161d29 });
    M.ring = new THREE.MeshBasicMaterial({ color: 0x2a3140 });
  }

  function limb(r, m) {
    var g = new THREE.Group();
    var cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 12, 1), m);
    var s1 = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m);
    var s2 = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m);
    g.add(cyl); g.add(s1); g.add(s2);
    g.userData = { cyl: cyl, s1: s1, s2: s2 };
    scene.add(g);
    return g;
  }
  function setLimb(g, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
    g.quaternion.setFromUnitVectors(V3(0, 1, 0), V3(dx / len, dy / len, dz / len));
    g.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    g.userData.cyl.scale.set(1, len, 1);
    g.userData.s1.position.set(0, -len / 2, 0);
    g.userData.s2.position.set(0, len / 2, 0);
  }
  function ball(r, m) { var b = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m); scene.add(b); return b; }
  function setBall(m, p) { m.position.set(p.x, p.y, p.z); }

  function ik2(a, b, l1, l2, pref) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    d = Math.min(d, l1 + l2 - 0.004);
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    var h = Math.sqrt(Math.max(l1 * l1 - d * d / 4, 0));
    var px = -dy / (d || 1e-6), py = dx / (d || 1e-6);
    var k1 = { x: mx + px * h, y: my + py * h }, k2 = { x: mx - px * h, y: my - py * h };
    if (pref === '>x') return k1.x > k2.x ? k1 : k2;
    if (pref === '>y') return k1.y > k2.y ? k1 : k2;
    return k1;
  }

  function buildStage() {
    var ground = new THREE.Mesh(new THREE.CircleGeometry(1.45, 40), M.ground);
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.002;
    scene.add(ground);
    var ring = new THREE.Mesh(new THREE.RingGeometry(1.43, 1.47, 40), M.ring);
    ring.rotation.x = -Math.PI / 2; ring.position.y = -0.001;
    scene.add(ring);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x1c2a1c, 1.15));
    var dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(2.5, 4, 1.5); scene.add(dir);
    var dir2 = new THREE.DirectionalLight(0xcfe8ff, 0.25);
    dir2.position.set(-2, 1.5, -2); scene.add(dir2);
  }

  function makeShadow(sx) {
    var sh = new THREE.Mesh(new THREE.CircleGeometry(1, 24), M.shadow);
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.003; sh.scale.set(sx, sx * 0.55, 1);
    scene.add(sh);
    return sh;
  }

  /* ---------- 深蹲 ---------- */
  function buildSquat() {
    var S = {};
    S.head = ball(0.17, M.head);
    S.eyeL = ball(0.042, M.white); S.eyeR = ball(0.042, M.white);
    S.pupL = ball(0.02, M.dark); S.pupR = ball(0.02, M.dark);
    S.torso = ball(0.16, M.body); S.torso.scale.set(0.95, 1.35, 0.8);
    S.hip = ball(0.13, M.head);
    S.thighL = limb(0.06, M.limb); S.thighR = limb(0.06, M.limb);
    S.shinL = limb(0.052, M.limb); S.shinR = limb(0.052, M.limb);
    S.footL = ball(0.075, M.white); S.footR = ball(0.075, M.white);
    S.footL.scale.set(1.25, 0.55, 0.85); S.footR.scale.set(1.25, 0.55, 0.85);
    S.armUL = limb(0.045, M.limb); S.armUR = limb(0.045, M.limb);
    S.armFL = limb(0.038, M.limb); S.armFR = limb(0.038, M.limb);
    S.handL = ball(0.052, M.white); S.handR = ball(0.052, M.white);
    S.ant = limb(0.016, M.limb); S.antBall = ball(0.045, M.gold);
    S.shadow = makeShadow(0.62);
    var T = 1.7;
    return function (tt) {
      var s = (1 - Math.cos(2 * Math.PI * (tt / T))) / 2;
      var lean = (4 + 22 * s) * Math.PI / 180;
      var hip = { x: 0.04 - 0.04 * s, y: 0.80 - 0.34 * s, z: 0 };
      var sh = { x: hip.x + 0.46 * Math.sin(lean), y: hip.y + 0.46 * Math.cos(lean), z: 0 };
      var hd = { x: sh.x + 0.30 * Math.sin(lean), y: sh.y + 0.30 * Math.cos(lean), z: 0 };
      [-1, 1].forEach(function (side) {
        var zL = side * 0.13, zA = side * 0.145;
        var ankle = { x: 0.30, y: 0.055, z: zA };
        var hipS = { x: hip.x, y: hip.y, z: zL };
        var knee = ik2(hipS, ankle, 0.40, 0.40, '>x');
        knee.z = zL;
        setLimb(side < 0 ? S.thighL : S.thighR, hipS, knee);
        setLimb(side < 0 ? S.shinL : S.shinR, knee, ankle);
        setBall(side < 0 ? S.footL : S.footR, { x: ankle.x + 0.09, y: 0.045, z: zA });
        var shJ = { x: sh.x, y: sh.y - 0.02, z: side * 0.155 };
        var wr = { x: shJ.x + 0.30, y: shJ.y - 0.07 - 0.05 * s, z: side * 0.10 };
        var el = ik2(shJ, wr, 0.19, 0.19, '<y');
        el.z = side * 0.14;
        setLimb(side < 0 ? S.armUL : S.armUR, shJ, el);
        setLimb(side < 0 ? S.armFL : S.armFR, el, wr);
        setBall(side < 0 ? S.handL : S.handR, { x: wr.x + 0.04, y: wr.y, z: wr.z });
      });
      setBall(S.head, hd);
      setBall(S.eyeL, { x: hd.x + 0.145, y: hd.y + 0.02, z: -0.062 });
      setBall(S.eyeR, { x: hd.x + 0.145, y: hd.y + 0.02, z: 0.062 });
      setBall(S.pupL, { x: hd.x + 0.175, y: hd.y + 0.02, z: -0.062 });
      setBall(S.pupR, { x: hd.x + 0.175, y: hd.y + 0.02, z: 0.062 });
      setBall(S.torso, { x: (sh.x + hip.x) / 2, y: (sh.y + hip.y) / 2, z: 0 });
      setBall(S.hip, hip);
      var aTop = { x: hd.x, y: hd.y + 0.15, z: 0 };
      setLimb(S.ant, aTop, { x: aTop.x, y: aTop.y + 0.09, z: 0 });
      setBall(S.antBall, { x: aTop.x, y: aTop.y + 0.12, z: 0 });
      S.shadow.position.x = hip.x + 0.1;
      S.shadow.material.opacity = 0.22 - 0.05 * s;
    };
  }

  /* ---------- 俯卧撑 ---------- */
  function buildPushup() {
    var S = {};
    S.head = ball(0.155, M.head);
    S.eyeL = ball(0.038, M.white); S.eyeR = ball(0.038, M.white);
    S.pupL = ball(0.018, M.dark); S.pupR = ball(0.018, M.dark);
    S.torso = limb(0.13, M.body);
    S.hip = ball(0.125, M.head);
    S.thighL = limb(0.055, M.limb); S.thighR = limb(0.055, M.limb);
    S.shinL = limb(0.05, M.limb); S.shinR = limb(0.05, M.limb);
    S.footL = ball(0.07, M.white); S.footR = ball(0.07, M.white);
    S.footL.scale.set(1.1, 0.55, 0.85); S.footR.scale.set(1.1, 0.55, 0.85);
    S.armUL = limb(0.042, M.limb); S.armUR = limb(0.042, M.limb);
    S.armFL = limb(0.036, M.limb); S.armFR = limb(0.036, M.limb);
    S.handL = ball(0.05, M.white); S.handR = ball(0.05, M.white);
    S.shadow = makeShadow(1.05);
    var T = 1.9, toe = { x: -0.92, y: 0.05, z: 0 }, L = 1.02;
    return function (tt) {
      var s = (1 - Math.cos(2 * Math.PI * (tt / T))) / 2;
      var phi = (23 - 18 * s) * Math.PI / 180;
      var sh = { x: toe.x + L * Math.cos(phi), y: toe.y + L * Math.sin(phi), z: 0 };
      var hip = { x: toe.x + 0.55 * L * Math.cos(phi), y: toe.y + 0.55 * L * Math.sin(phi), z: 0 };
      var hd = { x: sh.x + 0.235, y: sh.y + 0.095, z: 0 };
      [-1, 1].forEach(function (side) {
        var zL = side * 0.11, zA = side * 0.13, zH = side * 0.16;
        var ank = { x: toe.x, y: toe.y, z: zA };
        var hipS = { x: hip.x, y: hip.y, z: zL };
        var knee = { x: (hipS.x + ank.x) / 2 + 0.01, y: (hipS.y + ank.y) / 2 + 0.005, z: zL };
        setLimb(side < 0 ? S.thighL : S.thighR, hipS, knee);
        setLimb(side < 0 ? S.shinL : S.shinR, knee, ank);
        setBall(side < 0 ? S.footL : S.footR, { x: ank.x + 0.07, y: 0.04, z: zA });
        var hand = { x: 0.02, y: 0.045, z: zH };
        var shJ = { x: sh.x, y: sh.y - 0.01, z: side * 0.13 };
        var el = ik2(shJ, hand, 0.24, 0.24, '>y');
        el.z = side * 0.12;
        setLimb(side < 0 ? S.armUL : S.armUR, shJ, el);
        setLimb(side < 0 ? S.armFL : S.armFR, el, hand);
        setBall(side < 0 ? S.handL : S.handR, hand);
      });
      setLimb(S.torso, hip, sh);
      setBall(S.head, hd);
      setBall(S.eyeL, { x: hd.x + 0.13, y: hd.y + 0.015, z: -0.055 });
      setBall(S.eyeR, { x: hd.x + 0.13, y: hd.y + 0.015, z: 0.055 });
      setBall(S.pupL, { x: hd.x + 0.157, y: hd.y + 0.015, z: -0.055 });
      setBall(S.pupR, { x: hd.x + 0.157, y: hd.y + 0.015, z: 0.055 });
      S.shadow.position.x = (hip.x + sh.x) / 2 - 0.05;
      S.shadow.material.opacity = 0.24;
      S.shadow.scale.set(1.05, 0.4, 1);
    };
  }

  function orbit(tt) {
    var a = orbitCfg.a0 + tt * 0.62;
    var c = orbitCfg.center, R = orbitCfg.R, h = orbitCfg.h;
    camera.position.set(c.x + R * Math.sin(a), c.y + h, c.z + R * Math.cos(a));
    camera.lookAt(c.x, c.y, c.z);
  }

  function disposeScene() {
    if (!scene) return;
    scene.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    scene = null;
  }

  function play(name) {
    if (!window.THREE) return null;
    stop();
    cv = document.createElement('canvas');
    cv.width = 512; cv.height = 512;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
    } catch (e) { return null; }
    renderer.setClearColor(0x0d1117, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(512, 512, false);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    mats();
    buildStage();
    if (name === 'squat') {
      updatePose = buildSquat();
      orbitCfg = { center: { x: 0.1, y: 0.82, z: 0 }, R: 3.0, h: 0.6, a0: 0.55 };
    } else {
      updatePose = buildPushup();
      orbitCfg = { center: { x: -0.3, y: 0.15, z: 0 }, R: 2.6, h: 0.8, a0: 1.0 };
    }
    t = 0; updatePose(0); orbit(0);
    window.FIT3D_DEBUG = { scene: scene, camera: camera, renderer: renderer, errs: [] };
    try { renderer.render(scene, camera); } catch (e) { window.FIT3D_DEBUG.errs.push('init:' + String(e)); }
    timer = setInterval(function () {
      t += 0.04;
      try {
        if (updatePose) updatePose(t);
        orbit(t);
        renderer.render(scene, camera);
      } catch (e) { if (window.FIT3D_DEBUG) window.FIT3D_DEBUG.errs.push(String(e)); }
    }, 40);
    return cv;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    disposeScene();
    if (renderer) {
      try { renderer.dispose(); } catch (e) {}
      try { renderer.forceContextLoss && renderer.forceContextLoss(); } catch (e) {}
      renderer = null;
    }
    if (cv && cv.parentNode) cv.parentNode.removeChild(cv);
    cv = null; updatePose = null; camera = null;
  }

  return { play: play, stop: stop };
})();
