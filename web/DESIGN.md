# projectBV dashboard — design intention

Reconstructed from the existing code (ui.js tokens + the Remote/Monitor/Logger/Files
tool pages). Written because no record existed; this is the standard later tools and
later design passes are judged against.

## One-sentence intent
An internal fleet-rescue console for **one technical operator** — controls and live
state, nothing else. No marketing, no explainer copy, no hand-holding.

## Audience & feel
- Single technical operator doing remote rescue with nobody at the target PC.
- Dense, information-first, calm. Dark surfaces, one warm accent. It should read like
  an ops tool, not a product landing page. If a screen would need a sentence to explain
  what a control does, the control is wrong, not the sentence missing.

## Density stance
Growth means **packing more capability in per tool**, not spreading out or adding
chrome. New tools are added as registry entries (`tools/index.js`); each tool owns a
fleet sidebar + a working main pane. Do not introduce explanatory prose to fill space.

## Decisions (the de facto system — keep using it)
- **Tokens:** everything comes from `c.*` in `ui.js` (panel, ghost, primary, h2, input,
  th, td, dot, empty, sub) and CSS vars (--accent #ffd200, --accent-ink, --bad, --dim,
  --line, --panel, --panel2, --text, --ok). No hardcoded hex in pages. (Note: Remote
  still hardcodes `#ff5c5c` at panels — should become `var(--bad)`.)
- **Layout:** `grid minmax(220px,280px) 1fr`, fleet sidebar left, main right with
  `minWidth:0`. Files/Monitor follow this; Remote uses a fixed 280px — minmax is the
  newer, preferred form.
- **Marks:** one SVG per tool, 100x100 viewBox, `fill:none stroke:#ffd200 stroke-width:7
  stroke-linejoin:round`. filesLogoSvg conforms.
- **Accent discipline:** yellow accent = the one primary action per screen; `var(--bad)`
  = destructive only. Everything else is ghost/dim.
- **Confirmation:** Monitor uses a themed `<Ask>` modal; Remote+Files use raw
  `window.confirm()`. This is a live inconsistency — see below.

## Feature prominence (tiers)
Per screen, one tier-1. Record new features here at the tier they *earn*, not because
they are new.

| Tool / element | Tier | Why |
|---|---|---|
| Remote live view/control | 1 | central, used constantly |
| Monitor processes/perf | 1 | central, used constantly |
| Files **listing table** | 1 | the point of the tool; full width |
| Files toolbar actions | 2 | one-click, always visible, quieter (ghost) |
| Files breadcrumb / path | 2 | navigation, dim |
| Files **transfer queue** | 2 | appears only when transfers exist — correct |
| arm / switch-on (device off) | 1 (contextual) | the only thing to do when off → primary |
| switch-off (device on) | 3 | rarely touched → ghost, top-right |
| Files search | 2 | supports browsing, hidden at root |
| Files **Go-to-path** jump box | 2 | navigation shortcut to a known path; always visible below the toolbar. Sits as a second full-width input above Search — watch the stacked-input weight |
| Files Delete | 2, destructive | var(--bad) styling, far-right of toolbar |

## What would violate this intent
- Adding explainer/marketing copy to a working pane.
- A second primary (yellow) action competing on one screen.
- Off-theme chrome: raw OS `prompt()`/`confirm()`, unstyled controls, emoji standing in
  for the SVG mark system.
- Hardcoded colors instead of tokens.
- A tool that abandons the sidebar+main layout or the mark style.

## Open drift to resolve as the app grows (4 tools now)
1. **Two confirmation patterns.** Promote Monitor's `<Ask>` into a shared `ui.js`
   component (with a text-input variant) and retire raw `prompt()`/`confirm()`.
2. **Glyphs in Files.** RESOLVED for the listing — folder/file rows now use an inline
   yellow-stroke SVG `<Icon>` (astral-emoji tofu risk gone). STILL OPEN: the transfer
   labels use plain BMP arrows `↓`/`↑` (low tofu risk) and the toolbar uses `↰ Up` /
   `↻ Refresh` (`↰` is the riskier glyph). Prefer words or tiny SVG on those too.
   Note: the `<Icon>` strokes every listing row in var(--accent) yellow — that is a lot
   of accent in a dense table; consider var(--dim) for the marks so yellow stays the
   one-action colour.
