// ============================================================
// NONAKA FINANCIAL PARTNERS — INTRO PAGE
// Scroll reveal, nav scroll state, hero title entrance, the hero
// illustration (tilt, spotlight) and its rotating example insights.
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
    initNavScroll();
    initHeroTitle();
    initScrollReveal();
    initHeroInteractive();
    initHeroInsights();
    initHeroScene();
});

// The hero illustration is a Lottie animation (assest/hero-scene.json).
// Its card labels are live text in Geist, so wait for the font first —
// Lottie measures glyph widths once, at load, and would otherwise space
// them using the fallback font.
function initHeroScene() {
    const container = document.getElementById("hero-scene");
    if (!container || !window.lottie) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fontsReady = document.fonts
        ? Promise.all([document.fonts.load("400 11px Geist"), document.fonts.load("600 22px Geist")]).catch(() => {})
        : Promise.resolve();

    fontsReady.then(() => {
        const anim = window.lottie.loadAnimation({
            container,
            renderer: "svg",
            loop: true,
            autoplay: !reduceMotion,
            path: "assest/hero-scene.json",
        });
        // Reduced motion: a still of him mid-typing, cards settled.
        if (reduceMotion) anim.addEventListener("DOMLoaded", () => anim.goToAndStop(200, true));
    });
}

// Example insights only — illustrative, randomized every time they show,
// never a real user's data. Every template maps to a report category that
// actually exists in the portal (P&L/profit, revenue, cash flow, AR/
// invoices, AP/vendors, KPIs/health score, forecast, scenarios) — only the
// numbers, wording, and presentation are randomized, as agreed.
function rMoney(min, max) {
    return Math.round((min + Math.random() * (max - min)) / 10) * 10;
}
function rInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
}
function rDec(min, max, places) {
    return (min + Math.random() * (max - min)).toFixed(places);
}
function fmt(n) {
    return n.toLocaleString("en-US");
}

const HERO_INSIGHT_TEMPLATES = [
    { icon: "cash", text: () => `You made a profit of $${fmt(rMoney(6000, 42000))} this month.` },
    { icon: "chart", text: () => `Revenue increased by ${rInt(4, 26)}% this month.` },
    { icon: "chart", text: () => `Your cash flow improved by $${fmt(rMoney(1500, 15000))}.` },
    { icon: "chart", text: () => `Operating expenses decreased by ${rInt(3, 14)}%.` },
    { icon: "invoice", text: () => `You collected $${fmt(rMoney(4000, 30000))} in outstanding invoices.` },
    { icon: "cash", text: () => `Your profit margin increased to ${rInt(14, 34)}%.` },
    { icon: "invoice", text: () => `You have $${fmt(rMoney(5000, 26000))} in accounts receivable.` },
    { icon: "chart", text: () => `Cash runway: ${rDec(4, 12, 1)} months.` },
    { icon: "chart", text: () => `Revenue reached a new monthly high.` },
    { icon: "invoice", text: () => { const n = rInt(1, 5); return `${n} invoice${n > 1 ? "s" : ""} ${n > 1 ? "are" : "is"} overdue.`; } },
    { icon: "cash", text: () => `Your largest expense category this month: ${["Payroll", "Rent", "Software", "Inventory", "Marketing"][rInt(0, 4)]}.` },
    { icon: "chart", text: () => `Net income increased by ${rInt(5, 22)}%.` },
    { icon: "chart", text: () => `Revenue is trending ${rInt(3, 15)}% above last month.` },
    { icon: "score", text: () => `Your financial health score improved to ${rInt(68, 93)}.` },
    { icon: "cash", text: () => `You saved $${fmt(rMoney(1200, 9000))} compared with last month.` },
    { icon: "chart", text: () => `Projected revenue for next month: $${fmt(rMoney(20000, 90000))}.` },
    { icon: "invoice", text: () => `Accounts payable decreased by ${rInt(3, 12)}%.` },
    { icon: "cash", text: () => `Gross profit increased by $${fmt(rMoney(2000, 18000))}.` },
    { icon: "chart", text: () => `Your expenses are ${rInt(4, 18)}% below forecast.` },
    { icon: "score", text: () => `Forecast confidence: ${rInt(78, 96)}%.` },
];

const HERO_TOAST_STYLES = ["insight-style-a", "insight-style-b", "insight-style-c"];

const HERO_SCREEN_ICONS = {
    chart: '<path d="M3 17l5-5 3 3 6-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    invoice: '<path d="M6 3h9l3 3v15H6z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 9h6M9 12h6M9 15h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    cash: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v8M9.5 10a2.5 2 0 012.5-1.5c1.5 0 2.5.8 2.5 1.8s-1 1.5-2.5 1.7-2.5.7-2.5 1.7 1 1.8 2.5 1.8a2.5 2 0 002.5-1.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
    score: '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6-4.5-4.1 6-.7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
};

function initHeroInsights() {
    const toast = document.getElementById("hero-insight-toast");
    const toastIcon = document.getElementById("hero-insight-toast-icon");
    const toastText = document.getElementById("hero-insight-toast-text");
    if (!toast) return;

    const REFRESH_EVERY_MS = 5000;
    const FIRST_DELAY_MS = 1600;
    const CROSSFADE_MS = 180;

    let lastIndex = -1;

    const applyContent = () => {
        let index = lastIndex;
        while (index === lastIndex) {
            index = Math.floor(Math.random() * HERO_INSIGHT_TEMPLATES.length);
        }
        lastIndex = index;

        const template = HERO_INSIGHT_TEMPLATES[index];
        HERO_TOAST_STYLES.forEach(cls => toast.classList.remove(cls));
        toast.classList.add(HERO_TOAST_STYLES[rInt(0, HERO_TOAST_STYLES.length - 1)]);
        if (toastIcon) toastIcon.innerHTML = HERO_SCREEN_ICONS[template.icon];
        if (toastText) toastText.textContent = template.text();
    };

    // First appearance: pop the card in with content already set.
    const showFirst = () => {
        applyContent();
        toast.classList.add("is-visible");
    };

    // Every refresh after that: the card itself never leaves — only its
    // icon/text/color cross-fade to the next insight. Reads as one
    // continuous live feed rather than repeated pop-in/pop-out.
    const refresh = () => {
        toast.classList.add("is-refreshing");
        setTimeout(() => {
            applyContent();
            toast.classList.remove("is-refreshing");
        }, CROSSFADE_MS);
    };

    // Fully automatic — the portal surfaces insights on its own, no click
    // needed.
    setTimeout(() => {
        showFirst();
        setInterval(refresh, REFRESH_EVERY_MS);
    }, FIRST_DELAY_MS);
}

function initHeroTitle() {
    const title = document.getElementById("hero-title");
    if (!title) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        title.classList.add("is-in");
        return;
    }

    // rAF (not a fixed timeout) so the class flips on the frame after
    // first paint — otherwise the browser can coalesce it with the
    // initial style and skip the transition entirely.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        title.classList.add("is-in");
    }));
}

function initNavScroll() {
    const nav = document.getElementById("intro-nav");
    if (!nav) return;

    const update = () => {
        nav.classList.toggle("scrolled", window.scrollY > 12);
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
}

function initHeroInteractive() {
    const wrap = document.getElementById("hero-illustration-wrap");
    const inner = document.getElementById("hero-illustration-inner");
    if (!wrap || !inner) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia("(hover: none)").matches) return; // touch devices

    wrap.addEventListener("mouseenter", () => wrap.classList.add("is-hovering"));

    wrap.addEventListener("mousemove", (e) => {
        const rect = inner.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;

        // Tilt: small range, centered on the cursor position.
        const rotateY = (x - 0.5) * 14;
        const rotateX = (0.5 - y) * 10;
        inner.style.transform = `rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg)`;

        // Spotlight glow follows the cursor within the card.
        wrap.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
        wrap.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    });

    wrap.addEventListener("mouseleave", () => {
        wrap.classList.remove("is-hovering");
        inner.style.transform = "rotateX(0deg) rotateY(0deg)";
    });
}

function initScrollReveal() {
    const targets = document.querySelectorAll(".reveal");
    if (!targets.length) return;

    // Respect the OS-level reduced-motion preference: reveal everything
    // immediately instead of animating it in.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        targets.forEach(el => el.classList.add("in-view"));
        return;
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add("in-view");
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });

    targets.forEach(el => observer.observe(el));
}
