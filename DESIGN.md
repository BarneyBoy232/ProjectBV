# Design intent

Captured from the shipped projectBV console, not invented. The identity is already
mature and consistent; this file records it so later work conforms instead of
drifting. Source of truth for tokens: `web/src/index.css` (CSS variables) and
`web/src/ui.js` (the `c` style object). Use those — never raw hex, never ad-hoc
spacing.

## Feel

A calm, dark, single-operator control room. Dense but unhurried: panels are well
spaced, text is quiet, and nothing competes for attention except the one action that
matters on a given screen. No marketing voice, no onboarding, no explainer copy — one
operator who knows the tool.

## Palette (CSS variables, dark)

- `--bg` #0e0f11 — page behind the panels
- `--panel` #17191c / `--panel2` #1e2125 — surfaces; panel2 is the nested/inset tone
- `--line` #2a2e33 — borders and dividers
- `--text` #e9ebee / `--dim` #9aa1a9 — primary and secondary text
- `--accent` #ffd200 (`--accent-ink` #1a1a00 on top of it) — the single highlight
- `--ok` #5cd67a / `--bad` #ff5c5c — success / danger
- chart hues (`--chart-*`) identify a metric by colour before its label

## The one rule that governs the accent

**Yellow (`--accent`) marks exactly one thing per screen** — the single primary
action. It is stated in `index.css` and it is the rule most easily broken. A column
or row of yellow buttons is a violation, and it is worse when the yellow sits on the
more dangerous action. Everything secondary is a ghost button (`c.ghost`: transparent,
`--line` border). Danger uses `--bad` on a ghost, not a fill.

## Building blocks (from `c` in ui.js)

- `c.panel` — a surface: `--panel`, `--line` border, radius 12, padding 20
- Nested boxes inside a panel use radius 10 (correct, not drift)
- `c.input` — field on `--panel2`, radius 8
- `c.primary` — the filled yellow button; at most one per screen
- `c.ghost` — the default button
- `c.h2` / `c.sub` / `c.label` — headings and quiet secondary text
- `c.th` / `c.td` — table cells; `c.dot(on)` — the green/grey status dot
- `ago(ms)` — relative time label

## Per-tool layout idiom

Each tool is one page. Most use `.tool-grid` — a 280px device list beside the working
pane, stacking below ~820px. A tool that is not device-browsing (the Agent API tool)
is a single column of stacked `c.panel` sections, capped near the shell's own width
(~1080) so tables are not cramped while space sits empty. Any scrolling region inside
a panel (a long log) is height-capped and scrolls internally, like every sibling.

## Safety posture (Agent API tool specifically)

This tool hands administrative power to an AI, so its UI carries that weight honestly:

- The **more dangerous** action is the **more guarded** one. Arming a device (which
  lets an AI act on it) confirms; disarming is instant and frictionless.
- Arm is a neutral ghost button, never the yellow accent — the accent must not make
  the privilege-granting action the most inviting thing on the page.
- A choice with real stakes (a key's capability: everything vs read-only) is shown as
  visible radios, never hidden inside a collapsed dropdown.

## Violations to watch

- Yellow on more than one thing per screen (or on a dangerous action)
- Raw hex or ad-hoc padding instead of the tokens
- A dangerous action easier to trigger than its safe counterpart
- An unbounded list growing a panel without its own scroll cap
