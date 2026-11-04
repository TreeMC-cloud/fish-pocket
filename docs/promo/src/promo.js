// Deterministic timeline: everything on screen is a pure function of `t`,
// so render.py can seek to any frame. App footage is real simulator frames
// (see README.md); only the camera, captions and transitions are added here.
'use strict';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') || 'zh';
document.documentElement.lang = lang;
// Plate mode (see README.md): without the raw captures, the phone footage comes
// from a previous master, one JPEG per 1/60 s, masked to the phone's half of
// the frame. Everything else, captions included, is rendered fresh.
const PLATE = params.get('plate');
const PLATE_FPS = 60;

const COPY = {
  zh: {
    s1s: '在 iPhone 和 iPad 上\n本机运行 DeepSeek Harness',
    s2: '不用电脑，\n随时随地写代码。', s2s: '大肥鱼就跑在你的手机里，\n读代码、改文件、跑命令，锁屏也不停。',
    s4a: '说一句话。', s4b: '它写代码、\n克隆仓库、\n跑起来。', s4c: '要动手的命令，\n先问你。', s4d: '结果和改动，\n手机上看。',
    s5: '不是远程终端。', s5s: 'Node 和 git，就跑在 App 里。',
    s6: 'iPad 上，就是一台开发机', s6s: '侧栏、对话、工作台同屏，每个页面都是 SwiftUI 原生',
    s7: '切到后台，\n灵动岛\n替你盯着。',
    l: ['不需要电脑。', '不是遥控器。', '手机就是开发机。'],
    s9s: '把大肥鱼装进口袋', s9o: '开源 · MIT · 欢迎 Star',
    fine: '界面为 iOS 模拟器实录，Agent 回复为演示脚本；模型调用需要联网\n独立社区项目，与深度求索（DeepSeek）不存在隶属、合作、授权或背书关系\n吉祥物基于社区二创鲸鱼娘（上善无形、ZipZipPipe），按 CC BY-NC-SA 4.0 使用',
  },
  en: {
    s1s: 'DeepSeek Harness, running natively\non your iPhone and iPad',
    s2: 'No laptop.\nJust your phone.', s2s: 'Reads code, edits files, runs commands,\nright on your phone. Even when it’s locked.',
    s4a: 'Just ask.', s4b: 'It writes code,\nclones repos,\nand runs them.', s4c: 'Risky commands\nwait for your OK.', s4d: 'Review the results\non your phone.',
    s5: 'Not a remote terminal.', s5s: 'Node and git, running inside the app.',
    s6: 'On iPad, it’s your dev machine', s6s: 'Sidebar, chat and workbench side by side, every screen native SwiftUI',
    s7: 'Leave the app.\nThe Dynamic Island\nkeeps watch.',
    l: ['No laptop needed.', 'Not a remote control.', 'Just your phone.'],
    s9s: 'Put the big fish in your pocket', s9o: 'Open source · MIT · Star it on GitHub',
    fine: 'App footage recorded in the iOS Simulator; agent replies are scripted for this demo; model calls need a network connection\nIndependent community project, not affiliated with, authorized or endorsed by DeepSeek\nMascot based on the community whale-girl character (上善无形, ZipZipPipe), CC BY-NC-SA 4.0',
  },
}[lang];

const $ = id => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const mix = (a, b, p) => a + (b - a) * p;
const outExpo = p => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
const outCubic = p => 1 - Math.pow(1 - p, 3);
const inOut = p => (p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const outBack = p => { const c = 1.45; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };

// Scene boundaries, in seconds. audio.py reads the same cue times.
// s4 lands on the fourth bar of the music.
const T = { s2: 2.6, s4: 7.2, s5: 16.4, s6: 21.4, s7: 25.2, s8: 28.4, s9: 31.2, end: 36 };
window.DURATION = T.end;

// Static text.
for (const [id, key] of [['s1s', 's1s'], ['s2t', 's2'], ['s2s', 's2s'], ['s4a', 's4a'], ['s4b', 's4b'], ['s4c', 's4c'], ['s4d', 's4d'], ['s5t', 's5'], ['s5s', 's5s'], ['s6t', 's6'], ['s6s', 's6s'], ['s7t', 's7'], ['s9s', 's9s'], ['s9o', 's9o'], ['s9f', 'fine']]) $(id).textContent = COPY[key];
$('s1t').textContent = 'Fish Pocket';
$('s9t').textContent = 'Fish Pocket';
$('urlpill').textContent = 'github.com/imsai-sh/fish-pocket';
['l1', 'l2', 'l3'].forEach((id, i) => { $(id).textContent = COPY.l[i]; });
if (lang === 'en') {
  $('s2t').style.fontSize = '96px';
  $('s5t').style.fontSize = '72px';
  $('s4a').style.fontSize = $('s4b').style.fontSize = $('s4c').style.fontSize = $('s4d').style.fontSize = '84px';
  $('s7t').style.fontSize = '70px';
  $('s9s').style.fontSize = '36px';
  $('s2s').style.fontSize = '33px';
  $('s6t').style.fontSize = '72px';
  $('s6s').style.fontSize = '32px';
}

// --- Phone ------------------------------------------------------------------
const SCREEN_AR = 2622 / 1206;
class Phone {
  // `plated`: footage comes from captures, so in plate mode the screen stays black under the plate.
  constructor(parent, width, plated = true) {
    this.plated = plated;
    const bez = width * 0.026;
    const h = (width - bez * 2) * SCREEN_AR + bez * 2;
    this.w = width; this.h = h; this.bez = bez;
    const el = this.el = document.createElement('div');
    el.className = 'phone';
    Object.assign(el.style, { width: width + 'px', height: h + 'px' });
    const r = width * 0.155;
    el.innerHTML = `<div class="body" style="border-radius:${r}px"></div>
      <div class="screen" style="inset:${bez}px;border-radius:${r - bez}px"><img class="a"><img class="b"><div class="tap"></div></div>`;
    parent.appendChild(el);
    this.a = el.querySelector('.a'); this.b = el.querySelector('.b'); this.ring = el.querySelector('.tap');
    this.sw = width - bez * 2;
  }
  // `x`,`y`: phone centre; origin: transform-origin as a fraction of the phone.
  place(x, y, scale = 1, rot = 0, ox = .5, oy = .5) {
    const dx = x - this.w / 2, dy = y - this.h / 2;
    Object.assign(this.el.style, { transformOrigin: `${ox * 100}% ${oy * 100}%`, transform: `translate(${dx}px,${dy}px) rotate(${rot}deg) scale(${scale})` });
  }
  // Fractional frame index: neighbouring captures cross-fade so stepped footage reads as motion.
  frame(take, f) {
    const i = Math.max(1, Math.floor(f)), frac = f - Math.floor(f);
    const url = n => `frames/${take}/${String(n).padStart(5, '0')}.jpg`;
    return this.show(url(i), url(i + 1), frac);
  }
  still(path) { return this.show(path, path, 0); }
  show(a, b, frac) {
    if (PLATE && this.plated) return;
    if (this.a.getAttribute('src') !== a) this.a.setAttribute('src', a);
    if (frac > 0.02) {
      if (this.b.getAttribute('src') !== b) this.b.setAttribute('src', b);
      this.b.style.opacity = frac; this.b.style.display = 'block';
    } else this.b.style.display = 'none';
    pending.push(this.a.decode().catch(() => {}));
    if (frac > 0.02) pending.push(this.b.decode().catch(() => {}));
  }
  // Touch indicator at screen fractions (real taps leave no mark on screen).
  tap(fx, fy, p) {
    if (PLATE || p <= 0 || p >= 1) { this.ring.style.display = 'none'; return; }
    const d = this.sw * 0.17;
    Object.assign(this.ring.style, {
      display: 'block', width: d + 'px', height: d + 'px', left: fx * this.sw - d / 2 + 'px', top: fy * this.sw * SCREEN_AR - d / 2 + 'px',
      background: `rgba(12,12,13,${.2 * (1 - p)})`, border: `3px solid rgba(12,12,13,${.7 * (1 - p)})`, transform: `scale(${mix(.55, 1.5, outCubic(p))})`,
    });
  }
}

// --- iPad (landscape) ---------------------------------------------------------
const IPAD_AR = 2420 / 1668;
class Tablet {
  constructor(parent, width) {
    const bez = width * 0.027;
    const h = (width - bez * 2) / IPAD_AR + bez * 2;
    this.w = width; this.h = h;
    const el = this.el = document.createElement('div');
    el.className = 'phone';
    Object.assign(el.style, { width: width + 'px', height: h + 'px' });
    const r = width * 0.042;
    el.innerHTML = `<div class="body" style="border-radius:${r}px"></div>
      <div class="screen" style="inset:${bez}px;border-radius:${r - bez}px"><img class="a"></div>`;
    parent.appendChild(el);
    this.a = el.querySelector('.a');
  }
  place(x, y, scale = 1, rot = 0) { Phone.prototype.place.call(this, x, y, scale, rot); }
  still(path) {
    if (this.a.getAttribute('src') !== path) this.a.setAttribute('src', path);
    pending.push(this.a.decode().catch(() => {}));
  }
}

// Plate: previous master's frame at `t`, shown only on one side of a soft edge at
// x0 → x1 (feathered through empty background, so the seam is invisible).
const plates = {};
function plate(scene, t, x0, x1, keepRight) {
  if (!PLATE) return;
  let el = plates[scene];
  if (!el) {
    el = plates[scene] = document.createElement('img');
    el.className = 'plate';
    const g = keepRight ? `transparent ${x0}px, #000 ${x1}px` : `#000 ${x0}px, transparent ${x1}px`;
    el.style.maskImage = el.style.webkitMaskImage = `linear-gradient(to right, ${g})`;
    $(scene).appendChild(el);
  }
  const src = `${PLATE}/${String(Math.round(t * PLATE_FPS) + 1).padStart(5, '0')}.jpg`;
  if (el.getAttribute('src') !== src) el.setAttribute('src', src);
  pending.push(el.decode().catch(() => {}));
}

// Piecewise-linear time → capture frame.
function timeline(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) return mix(keys[i - 1][1], keys[i][1], seg(t, keys[i - 1][0], keys[i][0]));
  return keys[keys.length - 1][1];
}

// Rising wave reveal: `p` 0 → 1 uncovers the element from the bottom up.
function waveClip(el, p, phase = 0) {
  if (p >= 1) { el.style.clipPath = 'none'; return; }
  const pts = [], n = 48, base = mix(1160, -90, inOut(p));
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * 1920;
    const y = base + Math.sin(i / n * 7 + phase + p * 6) * 34 + Math.sin(i / n * 15 + phase * 2) * 13;
    pts.push(`${x}px ${y}px`);
  }
  pts.push('1920px 1080px', '0px 1080px');
  el.style.clipPath = `polygon(${pts.join(',')})`;
}

// Captions rise in and leave upward.
function caption(el, t, a, b, rise = 36) {
  const shown = t >= a - .01 && t <= b + .36;
  el.style.display = shown ? 'block' : 'none';
  if (!shown) return;
  const i = outExpo(seg(t, a, a + .7)), o = inOut(seg(t, b, b + .34));
  el.style.opacity = i * (1 - o);
  el.style.transform = `translateY(${(1 - i) * rise - o * 26}px)`;
}

// --- Cast -------------------------------------------------------------------
const CHAT = '../../assets/chat.png';
const p2 = new Phone($('s2'), 470);
const p4 = new Phone($('s4'), 450);
const p5 = new Phone($('s5'), 450);
const ASSET = '../../assets/';
const tab6 = new Tablet($('s6'), 1120), p6 = new Phone($('s6'), 330, false);
const p7 = new Phone($('s7'), 800);

let pending = [];
const vis = (id, on) => { $(id).style.display = on ? 'block' : 'none'; };

window.renderAt = async function renderAt(t) {
  pending = [];
  const ORDER = ['s2', 's4', 's5', 's6', 's7', 's8', 's9'];
  const WAVE = .9; // incoming scene rises over the previous one
  ORDER.forEach((id, i) => {
    const start = i ? T[id] : 0, next = T[ORDER[i + 1]] ?? T.end;
    vis(id, t >= start - 1e-6 && t < next + WAVE);
    $(id).style.zIndex = i + 1;
  });

  // Opening: the first frame is the poster, so it is complete at t = 0.
  // The same phone then goes to the lock screen with the task still running.
  if (t < T.s4 + WAVE) {
    const l = t - T.s2;
    const zoom = inOut(seg(l, 1.5, 3.2));
    const drift = mix(1, 1.02, seg(t, 0, T.s2));
    p2.place(1400, 548 + zoom * -320, drift * mix(1, 1.52, zoom), 0, .5, .8);
    const out = inOut(seg(l, -.45, -.05));
    $('s1g').style.opacity = 1 - out;
    $('s1g').style.transform = `translateY(${out * -26}px)`;
    if (l < 0) p2.show(CHAT, 'frames/lock/00001.jpg', seg(l, -.35, 0));
    else if (l < 3.4) p2.frame('lock', timeline(l, [[.05, 1], [.4, 6], [3.4, 170]]));
    else { // running → finished: the real completed state of the same card.
      const d = seg(l, 3.4, 3.7);
      p2.show(`frames/lock/00170.jpg`, 'frames/lock-done.jpg', d < .02 ? 0.03 : d);
    }
    plate('s2', t, 960, 1030, true);
    caption($('s2t'), t, T.s2 + .15, T.s4 - .1);
    caption($('s2s'), t, T.s2 + .45, T.s4 - .1);
  }

  // S4: a real agent run, cut down to about ten seconds.
  if (t >= T.s4 && t < T.s5 + WAVE) {
    const l = t - T.s4;
    waveClip($('s4'), seg(l, 0, WAVE), 2.4);
    // Hook frame numbers come from scene-change detection on the take.
    const f = timeline(l, [
      [.6, 8], [1.35, 20], [1.75, 26], [2.2, 38], [2.55, 43],
      [5.1, 146], [5.5, 151], [7.05, 160], [7.1, 298], [7.5, 305],
      [9.05, 372], [10, 400],
    ]);
    p4.frame('agent3', f);
    const inP = outExpo(seg(l, .3, 1.1));
    const zoom = inOut(seg(l, 5.0, 5.7)) * (1 - inOut(seg(l, 7.2, 7.9)));
    p4.place(1360, mix(1300, 546, inP) + zoom * -300, mix(1, 1.42, zoom), 0, .5, .78);
    plate('s4', t, 1000, 1060, true);
    p4.tap(.815, .92, seg(l, 2.3, 2.75));       // send
    if (l < 2) p4.tap(.72, .854, seg(l, 1.3, 1.75)); // suggestion chip
    if (l > 6.8 && l < 7.5) p4.tap(.72, .937, seg(l, 6.85, 7.3)); // allow
    caption($('s4a'), t, T.s4 + .9, T.s4 + 2.7);
    caption($('s4b'), t, T.s4 + 2.88, T.s4 + 4.95);
    caption($('s4c'), t, T.s4 + 5.13, T.s4 + 7.2);
    caption($('s4d'), t, T.s4 + 7.38, T.s5 + 2);
  }

  // S5: proof it runs on the device.
  if (t >= T.s5 && t < T.s6 + WAVE) {
    const l = t - T.s5;
    waveClip($('s5'), seg(l, 0, WAVE), 3.8);
    const f = timeline(l, [[.3, 2], [1.1, 12], [1.5, 13], [1.9, 14], [2.1, 15], [2.2, 16], [2.85, 27], [3.0, 28], [3.35, 29], [3.5, 38], [6, 50]]);
    p5.frame('term3', f);
    const inP = outExpo(seg(l, .25, 1.05));
    const zoom = inOut(seg(l, 1.0, 2.0));
    p5.place(mix(-300, 500, inP), 540 + zoom * 372, mix(1, 1.66, zoom), 0, .5, .14);
    plate('s5', t, 890, 960, false);
    caption($('s5t'), t, T.s5 + .6, T.s6 + 2);
    const v = 'ios arm64';
    $('s5v').textContent = v.slice(0, Math.floor(seg(l, 2.2, 2.6) * v.length + .001));
    const g = "Cloning into 'Hello-World'... done.";
    $('s5g').textContent = g.slice(0, Math.floor(seg(l, 3.5, 3.9) * g.length + .001));
    caption($('s5s'), t, T.s5 + 3.7, T.s6 + 2);
  }

  // S6: iPad, with the iPhone beside it. Real screenshots from docs/assets.
  if (t >= T.s6 && t < T.s7 + WAVE) {
    const l = t - T.s6;
    waveClip($('s6'), seg(l, 0, WAVE), .6);
    const a = outExpo(seg(l, .35, 1.25)), b = outExpo(seg(l, .6, 1.45));
    const drift = l * 6;
    tab6.place(850, mix(1500, 668 - drift, a), mix(.94, 1, a));
    p6.place(mix(1600, 1490, b), mix(1500, 712 - drift * 1.4, b), 1, mix(7, 0, b));
    tab6.still(ASSET + 'ipad.png');
    p6.still(ASSET + 'terminal.png');
    caption($('s6t'), t, T.s6 + .55, T.s7 + 2);
    caption($('s6s'), t, T.s6 + .8, T.s7 + 2);
  }

  // S7: Dynamic Island.
  if (t >= T.s7 && t < T.s8 + WAVE) {
    const l = t - T.s7;
    waveClip($('s7'), seg(l, 0, WAVE), 5);
    const f = timeline(l, [[.3, 2], [1.5, 13], [1.65, 14], [1.95, 17], [3.2, 40]]);
    p7.frame('island', f);
    const inP = outExpo(seg(l, .25, 1.15));
    p7.place(590, mix(1900, 860, inP), mix(1.05, 1, inP), 0);
    plate('s7', t, 1005, 1075, false);
    caption($('s7t'), t, T.s7 + .7, T.s8 + 2);
  }

  // S8: three beats.
  if (t >= T.s8 && t < T.s9 + WAVE) {
    const l = t - T.s8;
    waveClip($('s8'), seg(l, 0, WAVE * .8), 1.5);
    ['l1', 'l2', 'l3'].forEach((id, i) => {
      const at = .55 + i * .68, p = outExpo(seg(l, at, at + .5));
      const el = $(id), active = i === 2 || l < at + .68;
      el.style.opacity = p * (active ? 1 : .36);
      el.style.transform = `translateX(${(1 - p) * -60}px)`;
    });
  }

  // S9: end card.
  if (t >= T.s9) {
    const l = t - T.s9;
    waveClip($('s9'), seg(l, 0, WAVE), 3.1);
    const pop = outBack(seg(l, .4, 1.05));
    $('s9m').style.transform = `translateY(${Math.sin(l * 1.9) * 6}px) scale(${pop})`;
    $('s9m').style.opacity = seg(l, .4, .6);
    caption($('s9t'), t, T.s9 + .6, T.end + 9);
    caption($('s9s'), t, T.s9 + .8, T.end + 9);
    caption($('urlpill'), t, T.s9 + 1.05, T.end + 9);
    caption($('s9o'), t, T.s9 + 1.25, T.end + 9);
    caption($('s9f'), t, T.s9 + 1.6, T.end + 9);
  }

  await Promise.all(pending);
};
