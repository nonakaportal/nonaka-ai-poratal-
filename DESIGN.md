# Design System: Nonaka Financial Partners (NFP Portal)

> This is the design spec — the actual direction, already implemented in
> the real app (`frontend/css/tokens.css`, `style.css`, `js/charts.js`,
> and the simplified sidebar in `js/app.js`). Kept here as the reference
> record of what was decided and why, and as the brief to reuse if
> prompting Google Stitch or anyone else for new screens later.

## 1. Visual Theme & Atmosphere

A calm, reassuring financial companion for someone new to running a
business — not an enterprise SaaS dashboard. The mood is warm and
approachable, closer to a well-designed banking app for individuals than
a technical analytics tool. Nothing should feel urgent, dense, or
intimidating on first look. Confidence comes from clarity and generous
space, not from density of information or dramatic visual effects.

**Taste sliders (deliberately dialed down from typical "premium" defaults
— this is intentional, not a default to override):**
- **Density: 3/10** (Art Gallery Airy, leaning balanced) — few things per
  screen, generous breathing room. A nervous first-time owner should never
  feel like they're looking at a cockpit.
- **Variance: 2/10** (Predictable Symmetric) — consistent, expected
  layouts. This is not the place for asymmetric editorial flair; a
  first-time user needs to immediately know where to look.
- **Motion: 2/10** (Static/Restrained) — subtle fades and gentle hover
  feedback only. No spring-physics bounce, no perpetual looping
  micro-animations, no cinematic scroll choreography. Motion should
  never call attention to itself.

## 2. Color Palette & Roles

Single warm accent, warm-tinted neutrals throughout (not cool blue-gray).
Green/red is kept for financial up/down — a universal financial
expectation; the accent below is separate from those.

- **Warm Amber** (`#D9954B`) — Primary accent: buttons, active nav state,
  focus rings, links. Warm and optimistic rather than cold or corporate.
  Used sparingly — a line, never a flood.
- **Warm Charcoal** (`#211D19` card / `#1A1611` page) — Dark-mode
  background. Warm-tinted near-black, not the cool navy-black common in
  "tech tool" dashboards.
- **Warm Cream** (`#FAF6F0`) — Light-mode primary background. Soft and
  warm, not clinical white.
- **Warm near-white text** (`#F3ECE4` dark-mode / `#2B2620`-family
  light-mode) — Primary text, never pure black or pure white.
- **Muted Clay** (`#8C8175`-family) — Secondary/muted text, warm gray
  family only — never mix warm and cool grays in the same interface.
- **Positive Green** (`#6FA37E` dark / `#3E7A54` light, desaturated) —
  kept convention for "up"/good financial movement.
- **Negative Rust** (`#C4726B` dark / `#B8564E` light, desaturated) —
  kept convention for "down"/attention-needed, softened so it reads as
  "notice this" rather than "emergency."

**Bans:** no purple/blue "AI tool" accent (the app's original `#9184d9`
was exactly this, and has been replaced everywhere — tokens, chart
colors, hardcoded gradients, all retinted), no pure black or pure white,
no neon glow (all `box-shadow` glow effects were removed from buttons,
nav dots, sliders, and focus states — only the two genuine focus *rings*,
which have zero blur, were kept for accessibility), no more than one
accent color, no cool grays mixed with warm ones.

## 3. Typography Rules

- **Primary font:** `Outfit` — a warm, humanist geometric sans-serif,
  replacing `Inter` everywhere (CSS `--font-sans`/`--font-mono`, the
  Google Fonts `<link>`, and the hardcoded `Chart.js` font string, which
  doesn't read the CSS variable and needed its own edit).
- **Headlines:** confident but not shouting — moderate size, normal
  tracking, sentence case (not Title Case).
- **Body text:** relaxed line-height, generous size — this is financial
  information people need to trust, not skim.
- **Numbers:** tabular figures for alignment (unchanged — the app already
  did this correctly), one font throughout, no separate monospace face.
- **No jargon-first labels.** Every number's headline is the
  plain-English version; the accounting term, if shown, is small and
  secondary — implemented app-wide on Overview, Forecast, Scenarios, and
  the sidebar (e.g. "Customers owe you (Accounts Receivable)").

## 4. Component Stylings

- **Buttons:** amber accent fill/outline for primary, gentle background
  tint for secondary. Rounded corners (`--radius-btn` raised to 12px).
  Hover uses a background tint only — no glow.
- **Cards:** used only where they genuinely group related numbers,
  generous padding, warm-tinted shadow, rounded corners matching buttons.
  Overview stays at 6 headline cards, not a wall of metrics.
- **Inputs:** label above field, warm-tinted border, amber focus *ring*
  (solid, not a blur/glow — kept for accessibility).
- **Loading states:** the spinner was kept (calmed slightly, 0.9s not
  0.7s rotation) rather than fully replaced — full replacement with
  skeleton shapes on every button across the app was judged lower
  priority than the more visually loud fixes; worth a future pass.
- **Error states:** plain, calm, specific language (already the app's
  existing convention — e.g. "This reset link is invalid or has
  expired").

## 5. Layout Principles

- **Predictable, single reading order** on the Overview page — CSS Grid,
  contained at a comfortable max-width.
- **Sidebar simplified**: the former 7-group structure (Overview,
  Reports, Operations, Business Performance, Financial Intelligence,
  NFP AI, Workspace) is now 6 groups — "Business Performance" and
  "Financial Intelligence" merged into one "Insights" group, "Operations"
  renamed "Customers & Bills," "NFP AI" renamed "Ask NFP AI." Every page
  stays reachable at the same click-depth; only the grouping and naming
  changed. Reports stays its own separate section on purpose — advanced
  users still need full P&L/Balance Sheet/Cash Flow detail, it's just not
  the default first screen.
- **Mobile**: unchanged from the app's existing responsive rules
  (single-column collapse, no horizontal scroll) — not touched in this
  pass, worth a dedicated review later.

## 6. Motion & Interaction

- Page fade trimmed from 280ms to 220ms.
- The floating decorative orbs on the login screen were removed entirely
  — perpetual background motion on a nervous new user's very first
  screen was judged the single worst offender against the calm-motion
  goal.
- The "typing…" indicator in AI chat changed from a bouncing `scale()`
  animation to a gentle opacity fade — same information, calmer motion.
- All glow effects (`box-shadow` with blur > 0) removed from: primary
  buttons, nav dots, the topbar AI button, the health-score card, the
  scenario slider thumb, the AI send button, onboarding step indicators,
  and generic button hover states. Genuine 0-blur focus *rings* were
  deliberately kept — that's an accessibility requirement, not a "glow."

## 7. What Was Actually Changed (implementation record)

Files touched, in order: `tokens.css` (full palette + font + radius),
`index.html` (font link, cache-bust bumps), `glassmorphism.css` (one
glow removed), `style.css` (the bulk — glow removal, hardcoded cool
hex colors retinted, orb animation removed, typing-dot animation
calmed), `charts.js` (hardcoded chart colors + font, previously
independent of the CSS tokens entirely), `app.js` (`NAV_GROUPS`
restructure only — no page IDs changed, so no routing broke).

**Verified**, not just asserted: syntax-checked after every file, live
screenshots taken via Playwright of the login screen in both dark and
light theme before declaring it done.

## 8. Anti-Patterns (kept as a permanent checklist for future screens)

- No purple/blue "AI tool" accent color
- No cold navy-black surfaces — warm-tinted dark instead
- No dense, cockpit-style screens — this is a daily 60-second check
- No aggressive asymmetric/editorial layouts
- No perpetual motion, spring-bounce, or cinematic scroll effects
- No alarm-red error states for routine mistakes (wrong password, typo)
- No accounting jargon as a primary headline on daily-use screens
- No generic AI copywriting ("Elevate," "Unleash," "Next-Gen")
- No fabricated business-specific content (a persona like "Sarah's
  Bakery" is fine for *inspiration* when prompting a design tool, but
  never something that ends up hardcoded in the real app — this app
  serves many different business types with real QuickBooks data)
