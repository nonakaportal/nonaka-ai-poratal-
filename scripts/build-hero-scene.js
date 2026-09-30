// ============================================================
// NONAKA FINANCIAL PARTNERS — HERO SCENE (LOTTIE)
// Writes frontend/assest/hero-scene.json: the welcome-page hero, a
// person typing under floating finance cards who reaches for his mug
// and takes a sip every 6 s.
//
//   node scripts/build-hero-scene.js
//
// The output is plain Lottie, so it also opens in Glaxnimate (free)
// for hand edits. Pick one source of truth: once the JSON has been
// edited in Glaxnimate, re-running this script overwrites that work.
// ============================================================

const fs = require("fs");
const path = require("path");

const W = 640, H = 520, FPS = 30, END = 540; // 18 s loop

// ---------- primitives ----------
const r2 = v => Math.round(v * 100) / 100;
const hex = h => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => r2(v / 255)).concat(1);
};
const stat = k => ({ a: 0, k });
const LIN = { i: { x: 1, y: 1 }, o: { x: 0, y: 0 } };
const vec = v => (Array.isArray(v) ? v : [v]);

// Drop keys that a straight line between their neighbours already
// reproduces within `tol` (Ramer–Douglas–Peucker over time).
function simplify(keys, tol) {
    if (keys.length < 3 || keys.some(k => k[2])) return keys;
    const keep = new Array(keys.length).fill(false);
    keep[0] = keep[keys.length - 1] = true;
    const stack = [[0, keys.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        let worst = -1, at = -1;
        const [ta, va] = keys[a], [tb, vb] = keys[b];
        for (let i = a + 1; i < b; i++) {
            const f = (keys[i][0] - ta) / (tb - ta);
            const vi = vec(keys[i][1]), A = vec(va), B = vec(vb);
            const err = Math.max(...vi.map((x, d) => Math.abs(x - (A[d] + (B[d] - A[d]) * f))));
            if (err > worst) { worst = err; at = i; }
        }
        if (worst > tol) { keep[at] = true; stack.push([a, at], [at, b]); }
    }
    return keys.filter((_, i) => keep[i]);
}

// keys: [[frame, value, hold?], ...] — linear between keys (motion is
// sampled densely, so easing lives in the sampling functions below).
function anim(keys, tol = 0.12) {
    keys = simplify(keys, tol);
    if (keys.length === 1 || keys.every(k => JSON.stringify(k[1]) === JSON.stringify(keys[0][1]))) return stat(keys[0][1]);
    return {
        a: 1,
        k: keys.map(([t, v, hold], i) => {
            const k = { t, s: vec(v).map(r2) };
            if (i < keys.length - 1) {
                if (hold) k.h = 1; else Object.assign(k, LIN);
            }
            return k;
        }),
    };
}
function sample(t0, t1, step, f, tol) {
    const keys = [];
    for (let t = t0; t < t1; t += step) keys.push([t, f(t)]);
    keys.push([t1, f(t1)]);
    return anim(keys, tol);
}
const TAU = Math.PI * 2;
const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = x => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;
const lerp2 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

// Piecewise pose track: [[frame, value], ...] eased between keys.
function track(keys) {
    return t => {
        if (t <= keys[0][0]) return keys[0][1];
        for (let i = 1; i < keys.length; i++) {
            const [t1, v1] = keys[i];
            if (t <= t1) {
                const [t0, v0] = keys[i - 1];
                const e = ease((t - t0) / (t1 - t0));
                return Array.isArray(v0) ? lerp2(v0, v1, e) : lerp(v0, v1, e);
            }
        }
        return keys[keys.length - 1][1];
    };
}

// ---------- shapes ----------
const tr = (o = {}) => ({
    ty: "tr", nm: "Transform",
    p: o.p || stat([0, 0]), a: o.a || stat([0, 0]), s: o.s || stat([100, 100]),
    r: o.r || stat(0), o: o.o || stat(100), sk: stat(0), sa: stat(0),
});
const gr = (nm, it, t) => ({ ty: "gr", nm, it: [...it, t || tr()], np: it.length, bm: 0 });
const fl = (c, o = 100) => ({ ty: "fl", nm: "Fill", c: stat(hex(c)), o: typeof o === "object" ? o : stat(o), r: 1, bm: 0 });
const st = (c, w, o = 100, lc = 2) => ({ ty: "st", nm: "Stroke", c: stat(hex(c)), o: stat(o), w: stat(w), lc, lj: 2, ml: 4, bm: 0 });
const rc = (x, y, w, h, r = 0) => ({ ty: "rc", nm: "Rect", d: 1, p: stat([x + w / 2, y + h / 2]), s: stat([w, h]), r: stat(r) });
const el = (cx, cy, w, h) => ({ ty: "el", nm: "Ellipse", d: 1, p: stat([cx, cy]), s: stat([w, h]) });
const tm = (s, e) => ({ ty: "tm", nm: "Trim", s: typeof s === "object" ? s : stat(s), e: typeof e === "object" ? e : stat(e), o: stat(0), m: 1 });

// Absolute SVG path subset (M L H V C Q Z) -> Lottie bezier paths.
function sh(d) {
    const toks = d.match(/[MLHVCQZ]|-?\d*\.?\d+/g);
    const out = [];
    let i = 0, cmd = null, cur = [0, 0], P = null;
    const num = () => parseFloat(toks[i++]);
    const flush = () => {
        if (!P || !P.v.length) return;
        const n = P.v.length;
        if (P.c && n > 1 && P.v[0][0] === P.v[n - 1][0] && P.v[0][1] === P.v[n - 1][1]) {
            P.i[0] = P.i[n - 1]; P.v.pop(); P.i.pop(); P.o.pop();
        }
        out.push({ ty: "sh", nm: "Path", ks: stat({ i: P.i, o: P.o, v: P.v, c: P.c }) });
    };
    const add = (p, inT = [0, 0]) => { P.v.push(p); P.i.push(inT); P.o.push([0, 0]); cur = p; };
    while (i < toks.length) {
        if (/[A-Z]/.test(toks[i])) {
            cmd = toks[i++];
            if (cmd === "Z") { P.c = true; continue; }
            if (cmd === "M") { flush(); P = { v: [], i: [], o: [], c: false }; }
        }
        if (cmd === "M" || cmd === "L") { add([num(), num()]); if (cmd === "M") cmd = "L"; }
        else if (cmd === "H") add([num(), cur[1]]);
        else if (cmd === "V") add([cur[0], num()]);
        else if (cmd === "C") {
            const c1 = [num(), num()], c2 = [num(), num()], p = [num(), num()];
            P.o[P.o.length - 1] = [c1[0] - cur[0], c1[1] - cur[1]];
            add(p, [c2[0] - p[0], c2[1] - p[1]]);
        } else if (cmd === "Q") {
            const c = [num(), num()], p = [num(), num()];
            P.o[P.o.length - 1] = [(c[0] - cur[0]) * 2 / 3, (c[1] - cur[1]) * 2 / 3];
            add(p, [(c[0] - p[0]) * 2 / 3, (c[1] - p[1]) * 2 / 3]);
        }
    }
    flush();
    return out;
}
// A filled/stroked shape as one group.
const shape = (nm, geom, ...paint) => gr(nm, [...(Array.isArray(geom) ? geom : [geom]), ...paint]);

// ---------- layers ----------
let IND = 0;
const layers = []; // bottom-most first; reversed on output

function base(nm, ty, o) {
    const pivot = o.pivot || [0, 0];
    const L = {
        ddd: 0, ind: ++IND, ty, nm, sr: 1,
        ks: {
            o: o.o || stat(100), r: o.r || stat(0),
            p: o.p || stat([pivot[0], pivot[1], 0]), a: stat([pivot[0], pivot[1], 0]),
            s: o.s || stat([100, 100, 100]),
        },
        ao: 0, ip: 0, op: END, st: 0, bm: 0,
    };
    if (o.parent) L.parent = o.parent.ind;
    layers.push(L);
    return L;
}
const layer = (nm, shapes, o = {}) => Object.assign(base(nm, 4, o), { shapes });
const nullLayer = (nm, o = {}) => base(nm, 3, o);

const FONTS = {
    list: [
        { fName: "Geist-Regular", fFamily: "Geist", fStyle: "Regular", fWeight: "400", ascent: 72, fOrigin: "n", fPath: "" },
        { fName: "Geist-SemiBold", fFamily: "Geist", fStyle: "SemiBold", fWeight: "600", ascent: 72, fOrigin: "n", fPath: "" },
    ],
};
function text(nm, str, x, y, size, color, o = {}) {
    const L = base(nm, 5, { pivot: [0, 0], p: stat([x, y, 0]), parent: o.parent });
    L.t = {
        d: { k: [{ t: 0, s: {
            s: size, f: o.bold ? "Geist-SemiBold" : "Geist-Regular", t: str,
            j: o.center ? 2 : 0, tr: 0, lh: size * 1.2, ls: 0, fc: hex(color).slice(0, 3),
        } }] },
        p: {}, m: { g: 1, a: stat([0, 0]) }, a: [],
    };
    return L;
}

// ---------- palette ----------
const C = {
    bg: "#121530", glow: "#1D2250", room: "#181C3D", roomLine: "#222851",
    card: "#1B1F45", cardEdge: "#343B7C", label: "#AEB4E8", value: "#F4F5FF", up: "#3DDC97",
    purple: "#8B7BFF", violet: "#6D5DFC", lilac: "#B59CFF", pink: "#E58BD8", cyan: "#50D8E9",
    sweater: "#F6B93B", sweaterShade: "#E39B21", sweaterEdge: "#CF8716", collar: "#F7F4EC",
    skin: "#F6CBA8", skinShade: "#E4A983", hair: "#161936", hairLight: "#2B3163",
    eye: "#1B1D3A", mouth: "#8E3B35", blush: "#F29B9B",
    chair: "#3445A8", chairDark: "#27358A", laptop: "#1D2042", laptopEdge: "#2F3461",
    desk: "#2A2F5E", deskFront: "#171A38", leaf1: "#2FAE74", leaf2: "#22915E", leaf3: "#3CC285",
    pot: "#E9EAF6", mug: "#F4F4FA", mugShade: "#D6D8EA", bean: "#262A4D", coffee: "#5A3A28",
    book1: "#3E4DB5", book2: "#5B67D6", paper: "#DCDDFB", paperInk: "#2D3180", lamp: "#262B55",
};

// ============================================================
// SCENE
// ============================================================

// --- room ---
layer("Background", [
    shape("Glow inner", el(300, 290, 280, 230), fl("#252B66", 45)),
    shape("Glow outer", el(300, 300, 440, 360), fl(C.glow, 55)),
    shape("Wall", rc(0, 0, W, H), fl(C.bg)),
]);
layer("Room", [
    // right window with soft city lights
    shape("Lights", [el(548, 262, 6, 6), el(598, 276, 5, 5), el(560, 332, 7, 7), el(606, 344, 5, 5), el(590, 318, 4, 4)], fl("#3A4390", 80)),
    shape("Window bars", [rc(575, 236, 3, 128), rc(530, 298, 92, 3)], fl(C.roomLine)),
    shape("Window", rc(530, 236, 92, 128, 8), fl(C.room)),
    // left shelf with books
    shape("Shelf L", [rc(18, 196, 124, 6, 2), rc(18, 262, 124, 6, 2)], fl(C.roomLine)),
    shape("Books L1", [rc(28, 162, 12, 34, 2), rc(42, 170, 10, 26, 2), rc(54, 158, 14, 38, 2), rc(96, 172, 12, 24, 2)], fl("#232A5C")),
    shape("Books L2", [rc(30, 230, 14, 32, 2), rc(46, 236, 10, 26, 2), rc(80, 226, 16, 36, 2), rc(100, 234, 10, 28, 2)], fl("#1F2553")),
]);

// --- lamp ---
layer("Lamp", [
    shape("Bulb", el(320, 43, 30, 7), fl("#FFE7A8", 85)),
    shape("Shade", sh("M 302 20 L 338 20 L 352 42 L 288 42 Z"), fl(C.lamp)),
    shape("Cord", sh("M 320 0 L 320 22"), st(C.lamp, 2.5)),
    shape("Light cone", sh("M 292 40 L 348 40 L 440 300 L 200 300 Z"), fl("#BEC2FF", 5)),
]);

// --- floating cards ---
function floatCard(nm, cx, cy, period, phase, amp = 5, tilt = 0) {
    return nullLayer(nm, {
        pivot: [cx, cy],
        p: sample(0, END, 6, t => [cx, cy + amp * Math.sin(TAU * t / period + phase), 0]),
        r: sample(0, END, 6, t => tilt + 0.8 * Math.sin(TAU * t / period + phase + 1.2)),
    });
}
const cardBox = (x, y, w, h) => [
    shape("Card sheen", rc(x + 1, y + 1, w - 2, 20, 11), fl("#FFFFFF", 3)),
    shape("Card", rc(x, y, w, h, 12), fl(C.card, 94), st(C.cardEdge, 1.2)),
];
const upArrow = (x, y) => shape("Up arrow", sh(`M ${x} ${y} L ${x + 4} ${y - 6} L ${x + 8} ${y} Z`), fl(C.up));

// Total Revenue — line chart that draws itself every 9 s
{
    const P = floatCard("Card · Total Revenue", 112, 84, 180, 0);
    const pts = [[44, 128], [64, 121], [84, 124], [104, 111], [124, 115], [146, 99], [166, 103], [182, 86]];
    const line = "M " + pts.map(p => p.join(" ")).join(" L ");
    const trimS = anim([[0, 0], [250, 0], [268, 100], [270, 0, true], [520, 0], [538, 100], [540, 0]]);
    const trimE = anim([[0, 0], [40, 100], [268, 100], [270, 0, true], [310, 100], [538, 100], [540, 0]]);
    const dotO = anim([[0, 0], [36, 0], [44, 100], [248, 100], [256, 0], [306, 0], [314, 100], [518, 100], [526, 0], [540, 0]]);
    layer("Revenue card", [
        gr("End dot", [el(182, 86, 7, 7), fl(C.lilac)], tr({ o: dotO })),
        shape("Line", sh(line), tm(trimS, trimE), st(C.purple, 2.4)),
        shape("Area", sh(line + " L 182 132 L 44 132 Z"), fl(C.violet, 22)),
        upArrow(44, 96),
        ...cardBox(30, 28, 164, 112),
    ], { parent: P });
    text("Revenue label", "Total Revenue", 44, 50, 11, C.label, { parent: P });
    text("Revenue value", "$12,480", 44, 77, 22, C.value, { parent: P, bold: true });
    text("Revenue change", "12%", 56, 96, 11, C.up, { parent: P, bold: true });
}

// animated bar: grows from its baseline
function bar(nm, x, bottom, w, h, color, period, phase) {
    const cx = x + w / 2;
    return gr(nm, [rc(x, bottom - h, w, h, 2), fl(color)], tr({
        a: stat([cx, bottom]), p: stat([cx, bottom]),
        s: sample(0, END, 3, t => [100, 72 + 28 * (0.5 + 0.5 * Math.sin(TAU * t / period + phase))], 0.6),
    }));
}

// Net Income
{
    const P = floatCard("Card · Net Income", 270, 90, 135, 1.3);
    const cols = [C.violet, C.purple, C.lilac, C.pink, "#F59BB0"];
    const hs = [14, 20, 27, 35, 44];
    layer("Net Income card", [
        ...hs.map((h, i) => bar(`Bar ${i + 1}`, 272 + i * 11, 128, 7, h, cols[i], 90, i * 0.9)),
        upArrow(220, 102),
        ...cardBox(206, 40, 128, 100),
    ], { parent: P });
    text("Net Income label", "Net Income", 220, 62, 11, C.label, { parent: P });
    text("Net Income value", "$3,240", 220, 86, 20, C.value, { parent: P, bold: true });
    text("Net Income change", "18%", 232, 102, 11, C.up, { parent: P, bold: true });
}

// Cash Flow
{
    const P = floatCard("Card · Cash Flow", 404, 96, 108, 2.4);
    const hs = [18, 26, 20, 34, 28, 42, 50];
    const cols = [C.violet, C.purple, C.violet, C.lilac, C.purple, C.pink, C.lilac];
    layer("Cash Flow card", [
        ...hs.map((h, i) => bar(`Bar ${i + 1}`, 364 + i * 13, 128, 8, h, cols[i], 72, i * 0.7)),
        shape("Baseline", sh("M 360 129.5 L 448 129.5"), st(C.cardEdge, 1)),
        ...cardBox(348, 52, 112, 88),
    ], { parent: P });
    text("Cash Flow label", "Cash Flow", 362, 74, 11, C.label, { parent: P });
}

// Expenses — slowly turning donut
{
    const P = floatCard("Card · Expenses", 546, 159, 180, Math.PI);
    const ring = (nm, s, e, color) => gr(nm, [el(0, 0, 32, 32), tm(s, e), st(color, 7, 100, 1)]);
    const legend = (y, w, color) => [
        shape("Dot", el(552, y, 6, 6), fl(color)),
        shape("Bar", rc(560, y - 2, w, 4, 2), fl(C.cardEdge)),
    ];
    layer("Expenses card", [
        ...legend(160, 34, C.purple), ...legend(172, 26, C.pink), ...legend(184, 18, C.cyan),
        gr("Donut", [
            ring("Share 1", 0, 45, C.purple),
            ring("Share 2", 47, 72, C.pink),
            ring("Share 3", 74, 98, C.cyan),
            gr("Track", [el(0, 0, 32, 32), st("#2B3163", 7)]),
        ], tr({ p: stat([522, 172]), r: anim([[0, 0], [END, 360]]) })),
        ...cardBox(484, 118, 124, 82),
    ], { parent: P });
    text("Expenses label", "Expenses", 498, 140, 11, C.label, { parent: P });
}

// $ badge
{
    const P = floatCard("Badge · Dollar", 88, 224, 90, 0.5, 6);
    layer("Dollar badge", [shape("Badge", rc(68, 204, 40, 40, 10), fl("#3A3F9E"), st("#5A61C9", 1.2))], { parent: P });
    text("Dollar sign", "$", 88, 232, 22, C.value, { parent: P, bold: true, center: true });
}

// P&L sheet
{
    const P = floatCard("Sheet · P&L", 463, 268, 135, 2.1, 6, 6);
    const rows = [44, 36, 44, 30, 40];
    layer("P&L sheet", [
        shape("Rows", rows.map((w, i) => rc(440, 258 + i * 10, w, 4, 2)), fl("#9EA3E8", 75)),
        shape("Sheet", rc(430, 226, 66, 84, 7), fl(C.paper)),
    ], { parent: P });
    text("P&L title", "P&L", 440, 247, 13, C.paperInk, { parent: P, bold: true });
}

// --- chair ---
layer("Chair", [
    shape("Back shade", sh("M 352 262 L 356 262 C 374 262 386 274 386 292 L 386 424 L 356 424 C 364 380 364 300 352 262 Z"), fl(C.chairDark)),
    shape("Back", rc(214, 262, 172, 170, 30), fl(C.chair)),
]);

// --- the person ---
// Body parts hang off a torso null that breathes; arms are posed by
// joint positions (shoulder → elbow → hand) sampled every 2 frames.
const torso = nullLayer("Torso", {
    pivot: [300, 426],
    s: sample(0, END, 9, t => { const b = 0.5 + 0.5 * Math.sin(TAU * t / 135); return [100 + 0.4 * b, 100 + 0.9 * b, 100]; }),
});

layer("Body", [
    shape("Collar rib", sh("M 280 306 Q 300 330 320 306"), st(C.sweaterShade, 3)),
    shape("Collar", sh("M 284 305 Q 300 324 316 305 L 311 303 Q 300 314 289 303 Z"), fl(C.collar)),
    shape("Shade", sh("M 344 314 C 364 330 366 372 362 426 L 342 426 C 350 380 352 340 344 314 Z"), fl(C.sweaterShade)),
    shape("Sweater", sh("M 238 426 C 234 372 236 330 256 314 C 266 306 280 304 290 304 L 310 304 C 320 304 334 306 344 314 C 364 330 366 372 362 426 Z"), fl(C.sweater)),
], { parent: torso });
layer("Neck", [
    shape("Neck", rc(290, 278, 20, 32, 6), fl(C.skinShade)),
], { parent: torso });

// head: typing bob, a small tilt toward the mug while sipping
// The coffee break repeats every 6 s (three times per 18 s loop). All
// sip timing is in frames within one 180-frame cycle: ~2 s of typing,
// then reach, lift, sip, put down, and back to the keys by the cycle end.
const CYCLE = 180;
const SIP = { reach: 64, grab: 86, lift: 89, atMouth: 112, sipEnd: 134, down: 156, release: 159, home: 178 };
const cyc = t => t % CYCLE;
const cycles = f => [0, 1, 2].flatMap(c => f(c * CYCLE));
const sipTiltC = track([[0, 0], [102, 0], [114, 3.5], [132, 3.5], [146, 0], [CYCLE, 0]]);
const sipTilt = t => sipTiltC(cyc(t));
// eyes: shut while sipping, plus a blink in every other typing stretch
const shut = cycles(b => [[b + 111, b + 132], ...(b === CYCLE ? [] : [[b + 30, b + 35]])]).sort((x, y) => x[0] - y[0]);
const eyeKeys = (openV, shutV) => anim([[0, openV, true], ...shut.flatMap(([a, z]) => [[a, shutV, true], [z, openV, true]]), [END, openV]]);
const eyesOpenO = eyeKeys(100, 0);
const eyesShutO = eyeKeys(0, 100);
const glance = anim([[0, [0, 0]], ...cycles(b => [[b + 48, [0, 0]], [b + 54, [2.2, 0.6]], [b + 74, [2.2, 0.6]], [b + 82, [0, 0]]]), [END, [0, 0]]]);
layer("Head", [
    shape("Blush", [el(272, 266, 12, 8), el(328, 266, 12, 8)], fl(C.blush, 40)),
    shape("Mouth", sh("M 291 272 Q 300 279 309 272"), st(C.mouth, 2.6)),
    shape("Nose", sh("M 300 256 Q 296.5 263 301 265"), st(C.skinShade, 2)),
    gr("Eyes shut", [...sh("M 278 253 Q 284 257 290 253 M 310 253 Q 316 257 322 253"), st(C.eye, 2.4)], tr({ o: eyesShutO })),
    gr("Eyes open", [
        shape("Shine", [el(285.6, 249.6, 2.4, 2.4), el(317.6, 249.6, 2.4, 2.4)], fl("#FFFFFF")),
        shape("Pupils", [el(284, 252, 7, 9.5), el(316, 252, 7, 9.5)], fl(C.eye)),
    ], tr({ o: eyesOpenO, p: glance })),
    shape("Brows", sh("M 276 239 Q 284 234.5 292 237.5 M 308 237.5 Q 316 234.5 324 239"), st(C.hair, 2.6)),
    shape("Fringe", sh("M 260 218 C 280 232 312 228 330 206 C 326 224 312 234 294 236 C 280 236 268 230 260 218 Z"), fl(C.hair)),
    shape("Hair shine", sh("M 286 190 Q 300 182 316 186"), st(C.hairLight, 3)),
    shape("Hair", [
        el(282, 188, 32, 28), el(306, 182, 36, 30), el(329, 190, 30, 26), el(345, 207, 22, 26), el(261, 203, 26, 28),
        ...sh("M 256 248 C 250 214 262 192 286 186 C 300 180 324 180 336 190 C 350 200 352 224 345 248 C 340 232 334 222 326 216 C 310 226 284 228 265 220 C 261 228 258 238 256 248 Z"),
    ], fl(C.hair)),
    shape("Face", el(300, 245, 84, 92), fl(C.skin)),
    shape("Ears", [el(258, 250, 14, 20), el(342, 250, 14, 20)], fl(C.skinShade)),
], {
    parent: torso, pivot: [300, 290],
    r: sample(0, END, 6, t => 1.2 * Math.sin(TAU * t / 108) + sipTilt(t)),
});

// --- desk and props ---
layer("Desk", [
    shape("Edge light", sh("M 0 426.5 L 640 426.5"), st("#3A4180", 1)),
    shape("Top", rc(0, 426, W, 10), fl(C.desk)),
    shape("Front", rc(0, 436, W, H - 436), fl(C.deskFront)),
]);
// A light aluminium lid, so it separates from the dark room and the
// yellow sweater behind it.
layer("Laptop", [
    shape("Logo", el(294, 380, 16, 16), fl("#8F95D6")),
    shape("Lid shade", sh("M 332 337.4 L 370 336 L 366 422 L 328 422 Z"), fl("#B6BBE2")),
    shape("Lid", sh("M 232 339.6 L 364 336 Q 370 336 370 342 L 366 422 L 222 422 L 226 345.6 Q 226 339.8 232 339.6 Z"), fl("#D3D6F2"), st("#EEF0FF", 1.5)),
    // The keyboard faces him, so from this side it sits behind the lid:
    // only the back edge of the base shows, as wide as the lid.
    shape("Base edge", rc(221, 420, 146, 7, 2), fl("#A3A8D8")),
    shape("Shadow", el(294, 428, 176, 6), fl("#0B0D22", 55)),
]);
layer("Plant", [
    shape("Leaf 3", sh("M 152 386 C 146 356 148 330 158 306 C 167 332 163 360 152 386 Z"), fl(C.leaf3)),
    shape("Leaf 2", sh("M 152 386 C 176 370 186 344 182 320 C 164 336 154 360 152 386 Z"), fl(C.leaf2)),
    shape("Leaf 1", sh("M 152 386 C 128 372 118 346 124 320 C 142 334 152 360 152 386 Z"), fl(C.leaf1)),
], { pivot: [152, 388], r: sample(0, END, 9, t => 2.5 * Math.sin(TAU * t / 180)) });
layer("Pot and books", [
    shape("Pot rim", rc(128, 384, 48, 8, 3), fl("#D3D5EC")),
    shape("Pot", sh("M 132 390 L 172 390 L 166 426 L 138 426 Z"), fl(C.pot)),
    shape("Pages", [rc(44, 414, 64, 2), rc(52, 403, 52, 2)], fl(C.pot, 70)),
    shape("Book top", rc(50, 398, 56, 12, 3), fl(C.book2)),
    shape("Book base", rc(40, 410, 72, 16, 3), fl(C.book1)),
    shape("Phone", rc(478, 420, 44, 6, 2), fl("#0D0F22")),
    shape("Phone glint", rc(484, 421, 12, 1.5, 1), fl("#3A4180")),
]);

// --- arms ---
const deg = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const LU = 66, LF = 60; // nominal upper-arm and forearm lengths
const S_L = [244, 322], S_R = [356, 322];
const REST_L = { E: [214, 382], H: [254, 414] }; // hands rest on the keys, behind the lid
const REST_R = { E: [386, 382], H: [346, 414] };
const MUG_GRIP = [452, 412]; // the mug's handle, where the hand closes

// typing: short taps alternating hands, faded out around the coffee break
const ramp = (t, a, b) => clamp01((t - a) / (b - a));
const envR = t => { const u = cyc(t); return u <= SIP.reach ? Math.min(ramp(u, 0, 10), 1 - ramp(u, SIP.reach - 10, SIP.reach)) : 0; };
const envL = t => { const u = cyc(t); return 1 - ramp(u, 84, 94) + ramp(u, 160, 172); };
const tap = (t, phase) => [
    3 * Math.sin(TAU * t / 90 + phase),
    -5 * Math.max(0, Math.sin(TAU * t / 12 + phase)),
];

// The coffee arm is posed by joint angles (deg) and lengths (px), not by
// sliding joint positions: each move swings the forearm around the elbow,
// so the arm can't fold up on itself mid-motion. A move eases in and out
// and only comes to rest at the mug, at his mouth and back on the keys —
// its middle pose is passed through, never stopped at.
const poseAt = (E, H) => ({ a1: deg(S_R, E), l1: dist(S_R, E), a2: deg(E, H), l2: dist(E, H) });
const P_REST = poseAt(REST_R.E, REST_R.H);
const P_GRIP = poseAt([404, 370], MUG_GRIP);
const P_MOUTH = poseAt([390, 338], [340, 288]);
const P_MOUTH_UP = poseAt([389, 336], [338, 285]); // tips the mug a touch higher mid-sip
const P_REACH = { a1: 40, l1: 66, a2: 90, l2: 44 }; // hand clears the lid, just above the desk
const P_RISE = { a1: 36, l1: 62, a2: -50, l2: 50 }; // mug coming up beside his face
const easeSine = x => 0.5 - 0.5 * Math.cos(Math.PI * x);
// quadratic through three values: from (k=0), via (k=0.5), to (k=1)
const through = (a, v, b, k) => a * (1 - k) * (1 - 2 * k) + v * 4 * k * (1 - k) + b * k * (2 * k - 1);
const MOVES = [
    [SIP.reach, SIP.grab, P_REST, P_REACH, P_GRIP],
    [SIP.lift, SIP.atMouth, P_GRIP, P_RISE, P_MOUTH],
    [SIP.atMouth, SIP.sipEnd, P_MOUTH, P_MOUTH_UP, P_MOUTH],
    [SIP.sipEnd, SIP.down, P_MOUTH, P_RISE, P_GRIP],
    [SIP.release, SIP.home, P_GRIP, P_REACH, P_REST],
];
function rightPose(u) {
    let pose = P_REST;
    for (const [t0, t1, from, via, to] of MOVES) {
        if (u >= t1) { pose = to; continue; }
        if (u > t0) {
            const k = easeSine((u - t0) / (t1 - t0));
            pose = Object.fromEntries(Object.keys(from).map(key => [key, through(from[key], via[key], to[key], k)]));
        }
        break;
    }
    const r1 = pose.a1 * Math.PI / 180, r2 = pose.a2 * Math.PI / 180;
    const E = [S_R[0] + pose.l1 * Math.cos(r1), S_R[1] + pose.l1 * Math.sin(r1)];
    return { E, H: [E[0] + pose.l2 * Math.cos(r2), E[1] + pose.l2 * Math.sin(r2)] };
}

function armJoints(side, t) {
    if (side === "R") {
        const j = tap(t, 0), e = envR(t);
        const { E: E0, H: H0 } = rightPose(cyc(t));
        return { S: S_R, E: [E0[0] + j[0] * 0.55 * e, E0[1] + j[1] * 0.55 * e], H: [H0[0] + j[0] * e, H0[1] + j[1] * e] };
    }
    const j = tap(t, Math.PI), e = envL(t);
    return {
        S: S_L,
        E: [REST_L.E[0] + j[0] * 0.55 * e, REST_L.E[1] + j[1] * 0.55 * e],
        H: [REST_L.H[0] + j[0] * e, REST_L.H[1] + j[1] * e],
    };
}

// rotation keys with unwrapping so a pass through ±180° never spins
function unwrapKeys(keys) {
    for (let i = 1; i < keys.length; i++) {
        while (keys[i][1] - keys[i - 1][1] > 180) keys[i][1] -= 360;
        while (keys[i][1] - keys[i - 1][1] < -180) keys[i][1] += 360;
    }
    return anim(keys);
}

function buildArm(side) {
    const frames = [];
    for (let t = 0; t < END; t += 2) frames.push(t);
    frames.push(END);
    const J = frames.map(t => [t, armJoints(side, t)]);

    const sleeve = len => [
        shape("Sleeve", sh(`M 0 0 L ${len} 0`), st(C.sweater, 24)),
        shape("Sleeve edge", sh(`M 0 0 L ${len} 0`), st(C.sweaterEdge, 27)),
    ];
    layer(`Arm ${side} · upper`, sleeve(LU), {
        parent: torso,
        p: stat([...(side === "R" ? S_R : S_L), 0]),
        r: unwrapKeys(J.map(([t, j]) => [t, deg(j.S, j.E)])),
        s: anim(J.map(([t, j]) => [t, [dist(j.S, j.E) / LU * 100, 100, 100]]), 0.4),
    });
    layer(`Arm ${side} · forearm`, [
        shape("Cuff", sh(`M ${LF - 7} 0 L ${LF} 0`), st(C.sweaterShade, 22, 100, 1)),
        ...sleeve(LF),
    ], {
        parent: torso,
        p: anim(J.map(([t, j]) => [t, [...j.E, 0]])),
        r: unwrapKeys(J.map(([t, j]) => [t, deg(j.E, j.H)])),
        s: anim(J.map(([t, j]) => [t, [Math.max(dist(j.E, j.H) - 6, 20) / LF * 100, 100, 100]]), 0.4),
    });
    return J;
}

// --- mug: sits on the desk, rides in the right hand during the sip ---
const MUG_TILT_C = track([[0, 0], [100, 0], [112, -24], [132, -28], [146, 0], [CYCLE, 0]]);
const MUG_TILT = t => MUG_TILT_C(cyc(t));
function mugLayer(J) {
    const onDesk = t => cyc(t) <= SIP.lift || cyc(t) >= SIP.down;
    layer("Mug", [gr("Mug art", [
        shape("Bean line", sh("M 433 408.5 Q 431.5 413 433 417.5"), st(C.mug, 1.2)),
        shape("Bean", [el(433, 413, 7, 10)], fl(C.bean)),
        shape("Coffee", el(433, 397, 24, 4.5), fl(C.coffee)),
        shape("Shade", sh("M 436 397 L 446 397 L 444 422 Q 443.5 426 439.5 426 L 436 426 Z"), fl(C.mugShade)),
        shape("Body", sh("M 420 396 L 446 396 L 444 422 Q 443.5 426 439.5 426 L 426.5 426 Q 422.5 426 422 422 Z"), fl(C.mug)),
        shape("Handle", el(449, 411, 12, 16), st(C.mug, 4)),
    ], tr({ p: stat([-6, 0]) }))], {
        pivot: MUG_GRIP,
        p: anim(J.map(([t, j]) => [t, onDesk(t) ? [...MUG_GRIP, 0] : [...j.H, 0]])),
        r: sample(0, END, 2, MUG_TILT),
    });
    // steam only while the mug rests on the desk
    const puff = (x, delay) => gr("Puff", [...sh(`M ${x} 390 C ${x - 4} 385 ${x + 4} 381 ${x} 376`), st("#FFFFFF", 2.2)], tr({
        p: sample(0, END, 6, t => [0, -10 * (((t + delay) % 60) / 60)]),
        o: sample(0, END, 6, t => { const k = ((t + delay) % 60) / 60; return 55 * Math.sin(Math.PI * k); }),
    }));
    layer("Steam", [puff(422, 0), puff(432, 30)], {
        o: anim([...cycles(b => [[b, 100], [b + SIP.reach, 100], [b + 72, 0], [b + SIP.release, 0], [b + 176, 100]]), [END, 100]]),
    });
}

function handLayer(side, J) {
    layer(`Hand ${side}`, [
        shape("Knuckles", sh("M 2 -6 L 2 6"), st(C.skinShade, 1.2, 70)),
        shape("Thumb", el(-3, side === "R" ? -8 : 8, 9, 8), fl(C.skin)),
        shape("Palm", el(2, 0, 20, 17), fl(C.skin)),
    ], {
        parent: torso,
        p: anim(J.map(([t, j]) => [t, [...j.H, 0]])),
        r: unwrapKeys(J.map(([t, j]) => [t, deg(j.E, j.H)])),
    });
}

const JL = buildArm("L");
handLayer("L", JL);
const JR = (() => {
    const frames = [];
    for (let t = 0; t < END; t += 2) frames.push(t);
    frames.push(END);
    return frames.map(t => [t, armJoints("R", t)]);
})();
// The hand goes behind the mug: it reaches round to the handle rather
// than across the cup, and the handle ring then reads as fingers through it.
buildArm("R");
handLayer("R", JR);
mugLayer(JR);

// He sits behind the laptop: lift its layer above the arms, hands and
// mug so the lid covers his hands on the keys (the mug's path clears it).
layers.push(...layers.splice(layers.findIndex(l => l.nm === "Laptop"), 1));

// ============================================================
const out = {
    v: "5.12.2", fr: FPS, ip: 0, op: END, w: W, h: H,
    nm: "NFP hero · typing and a coffee break", ddd: 0,
    assets: [], fonts: FONTS,
    layers: layers.slice().reverse(),
    markers: cycles(b => [{ tm: b + SIP.reach, cm: "sip", dr: SIP.home - SIP.reach }]),
};
const dest = path.join(__dirname, "..", "frontend", "assest", "hero-scene.json");
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`wrote ${path.relative(process.cwd(), dest)} — ${layers.length} layers, ${(fs.statSync(dest).size / 1024).toFixed(1)} KB`);
