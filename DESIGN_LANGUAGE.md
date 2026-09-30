# GoPieNg design language

**A compact network-operations console — Liminal structure, GoPieNg chroma.**

This is the reference for the GoPieNg web UI (`web/`): the target for the
layout and chrome overhaul, and the rulebook for UI work after it. "Today" and
"current" below mean `main` at `f8079fe`.

GoPieNg should look like something an operator uses to manipulate a live
network, not another SaaS admin panel. It takes the Liminal family's structural
grammar — a 192/48px sidebar, a thin workspace toolbar, section bands, hairline
rows, a 4px grid, small radii, no decorative shadows — so it plainly belongs
with Liminal, Temary and Evident in spacing, navigation, hierarchy and
controls. It keeps its own chroma, so nobody mistakes it for the same
application with a different logo.

The budget:

- **Preserve ~80% of the color identity and interaction model.**
- **Replace ~80% of the layout and chrome.**

Less UI surrounding the data — not less personality in the data.

The hierarchy, top to bottom:

```
GLOBAL             192 / 48 sidebar — identity, navigation, theme, health
WORKSPACE          40px search/tool band
NETWORK            38px structural row; 16px/depth indentation inside a 248px
                   address region; description | owner | account | settings | action
DETAIL             32px hosts / available prefixes / activity / users
INLINE PANELS      8×12 padding, hairline boundaries, no card-within-card
EXCEPTION SURFACES warning / confirmation plates, intentionally distinctive
```

Network rows at 38px and detail rows at 32px give the tree slightly more
visual authority than the data beneath it without wasting space.

## 1. Principles

1. **Data first.** Remove chrome before adding any. Rows, hairlines and
   alignment carry the structure.
2. **Rows are the unit.** Networks, hosts, available subnets, activity and
   users share one row grammar.
3. **Color is semantic.** Each hue means one thing everywhere (§3.1). No
   accent is decoration.
4. **Bands, not cards.** Subordinate panels are full-width bands that belong
   to their parent row. Nothing is a card inside a card.
5. **Elevation means floating.** Only toasts, menus, the mobile drawer and
   modal plates cast a shadow.
6. **Operate in place.** Allocation, hosts and settings open inline under
   their network; the operator never leaves the tree to act on it.
7. **Say what it does.** An explicit `Hosts | Networks` selector, not an
   unlabeled switch; `Available`, not `e`.
8. **Stay small.** Hand-built HTML, CSS and ES modules, a handful of
   primitives, no framework.

## 2. What stays

- The near-black canvas and the six semantic hues: cyan addresses, yellow
  subdivision, blue hosts, green allocation, purple ownership, red danger.
- JetBrains Mono for technical data, system sans for everything else (§3.5).
- The nested tree with inline expansion: allocation, available subnets, hosts
  and settings open in place.
- The flush-right yellow `open` and blue `hosts` row controls — narrower and
  quieter, not removed.
- The yellow/blue row washes, slightly reduced.
- Search behavior: IP-ordered matches, the `1/12` counter, arrow/Enter/Esc
  keys, highlight-and-scroll.
- The red warning plate and delete confirmation — refined, not normalized
  (§9.1).
- The light theme's clean white/gray foundation, with stronger semantic hues.

Everything else about layout and chrome changes; §13.1 maps each current piece
to its replacement.

## 3. Tokens

Component CSS references semantic tokens only. It never names a palette value
or knows which theme is active. Dark is the `:root` default, and
`[data-theme="light"]` redefines the same tokens.

### 3.1 Color

**Semantic hues**

| Token | Means | Used for | Dark | Light |
|---|---|---|---|---|
| `--accent-network` | address, primary network interaction | CIDRs, host addresses, log prefixes, wordmark, selected mask, primary buttons, focus ring, active-nav marker | `#4ecdc4` | `#0f766e` |
| `--accent-subdivide` | subdivision | container-network wash, `open`, `Subdivide` | `#f7dc6f` | `#854d0e` |
| `--accent-host` | host access | leaf-network wash, `hosts`, the `Hosts` search mode | `#5dade2` | `#1d4ed8` |
| `--accent-alloc` | allocation, success | preferred masks, `Assign next`, `Add`, `Assign`, server-ok dot, search match (solid only for a band's default action, §7.1) | `#58d68d` | `#047857` |
| `--accent-identity` | owner, identity | owner column, usernames | `#af7ac5` | `#7c3aed` |
| `--danger` | destructive, alert | delete, errors, offline state | `#e74c3c` | `#dc2626` |

Dark values are unchanged. Four light values move one step deeper (from
`#0d9488`, `#d97706`, `#2563eb`, `#059669`): today's light cyan, yellow and
green measure 3.2–3.8:1 on white, and the yellow `open` label 2.2:1 on its
fill. The new values clear 4.5:1 on `--surface` and `--surface-raised`, and
for `open` and `hosts` on their row-action fills.

**Neutrals**

| Token | Used for | Dark | Light | Replaces |
|---|---|---|---|---|
| `--surface` | canvas, work surface, toolbar, input wells | `#0d0d0d` | `#ffffff` | `--bg-0` |
| `--surface-raised` | sidebar, bands | `#141414` | `#f8f9fa` | `--bg-1` |
| `--surface-hover` | row and control hover | `#1a1a1a` | `#e9ecef` | `--bg-2` |
| `--surface-active` | active nav row, selected segment, inline-edit hover | `#242424` | `#dee2e6` | `--bg-3` |
| `--border` | structural lines, control outlines | `#333333` | `#ced4da` | `--border` |
| `--border-subtle` | row hairlines | `#242424` | `#e9ecef` | — |
| `--text` | primary text | `#f5f5f5` | `#212529` | `--text-0` |
| `--text-secondary` | descriptions, body copy | `#cccccc` | `#495057` | `--text-1` |
| `--text-muted` | labels, meta, placeholders, account | `#888888` | `#646c74` | `--text-2` |
| `--text-on-accent` | labels on accent fills | `#0d0d0d` | `#ffffff` | `--bg-0` |
| `--danger-fill` | red fills carrying white text: offline banner, destructive hover | `#c0392b` | `#dc2626` | — |

`--border-subtle` reuses existing grays so row hairlines sit quieter than
structural lines. Beyond the four light accents, the only new values are light
`--text-muted` (`#6c757d` is 4.45:1 on `--surface-raised`; `#646c74` is 5.06:1)
and dark `--danger-fill` (white on `#e74c3c` is 3.8:1; on `#c0392b`, 5.4:1).

**Derived** — mixed once here with `color-mix(in srgb, …)`, never re-mixed in
components.

| Token | Mix | Used for |
|---|---|---|
| `--wash-subdivide` | 4% `--accent-subdivide` | container-network rows (today 5%) |
| `--wash-host` | 4% `--accent-host` | leaf-network rows (today 5%) |
| `--fill-subdivide`, `--fill-subdivide-strong` | 12%, 20% `--accent-subdivide` over `--surface` | `open` at rest; on hover and while expanded |
| `--fill-host`, `--fill-host-strong` | 12%, 20% `--accent-host` over `--surface` | `hosts` at rest; on hover and while expanded |
| `--wash-match` | 20% `--accent-alloc` | current search match, with a 2px inset `--accent-alloc` ring |
| `--wash-new` | 30% `--accent-network` | host just allocated, until the next click |
| `--wash-used` | 10% `--accent-network` | used addresses in the *All addresses* view |
| `--wash-danger` | 10% `--danger` | inline errors (sign-in) |

**Alarm plate** — theme-invariant (§9.1). The plate is its own visual object,
not theme chrome: it sits on a 70% black scrim and looks the same in both
themes. `Delete` uses these tokens; `Cancel` is deliberately neutral (§9.1).

| Token | Value |
|---|---|
| `--plate-bg` | `#2a1f1f` |
| `--plate-border` | `#d9534f` |
| `--plate-text` | `#f5c6c6` |
| `--plate-muted` | `#aa8888` |
| `--plate-danger` | `#c9302c` (white label 5.3:1; today's `#d9534f` gives 3.96:1) |
| `--plate-danger-hover` | `#b02a27` |
| `--plate-glow` | `rgb(217 83 79 / 0.4)` |

### 3.2 Spacing: the 4px grid

The 4px base grid fits the Liminal language and keeps GoPieNg dense without
feeling cramped. One rule covers almost all of it:

> **4px inside things, 8px between related things, 16px between groups,
> 24px between concepts.**

| Token | Size | Use |
|---|---:|---|
| `--space-1` | 4px | icon/text micro-gap, tight inline spacing |
| `--space-2` | 8px | normal control gaps, row internals |
| `--space-3` | 12px | compact section padding |
| `--space-4` | 16px | normal panel/page padding |
| `--space-5` | 20px | larger section separation |
| `--space-6` | 24px | major section break |
| `--space-8` | 32px | rare large separation |

Every padding, margin and gap comes from this scale or from a dimension in
§3.3. No `rem` or `em` spacing: today's scattered `0.6rem`, `0.75rem 1rem`,
`1rem`, `1.25rem` and `1.5rem` values all collapse onto 4/8/12/16/24. Applied
consistently, that alone makes the UI look deliberate.

```css
/* today */
.tree-row { gap: 0.5rem; padding: 0.6rem 0; min-height: 44px; }
.host-panel { padding: 0.75rem 1rem; }
.settings-panel { padding: 1rem; }

/* target */
.tree-row {
  gap: var(--space-2);                      /* 8px */
  min-height: var(--row-h);                 /* 38px */
  padding: var(--space-1) var(--space-2);   /* 4px 8px */
}
.host-panel,
.settings-panel,
.alloc-bar {
  padding: var(--space-2) var(--space-3);   /* 8px 12px */
}
```

§5.1 refines the tree row further: a grid layout, and no right padding so the
row actions sit flush.

### 3.3 Dimensions

| Element | Value | Token |
|---|---|---|
| Sidebar, expanded / collapsed | 192px / 48px | `--sidebar-w`, `--sidebar-w-collapsed` |
| Sidebar nav row | 36px | `--nav-row-h` |
| Sidebar horizontal padding; icon → label gap | 8px; 8px | |
| Gap between sidebar sections | 16px | |
| Workspace toolbar | 40px | `--toolbar-h` |
| Workspace outer padding | 16px desktop; 12px ≤ 768px; 8px ≤ 480px | `--workspace-pad` |
| Work surface max width | 1600px | `--surface-max` |
| Tree/network row | 38px (range 36–40); 44px on coarse pointers | `--row-h` |
| Tree indentation | 16px per level (today 20px) | `--indent` |
| Row horizontal padding; row internal gap | 8px; 8px | |
| CIDR → description, visually | 12–16px minimum | |
| Section band and subordinate band padding | 8px 12px | |
| Table cells | 6px 8px; 2px 8px around a 28px control, so table rows stay 32px | |
| Form controls; normal buttons | 32px | `--control-h` |
| Small controls and buttons | 28px | `--control-h-sm` |
| Icon buttons | 28 × 28px | |
| Button horizontal padding | 8px small; 12px normal | |
| Button group gap | 4px | |
| Adjacent form fields | 8px | |
| Label → control | 4px | |
| Form row → next form row | 12px | |
| Major section → next section | 20–24px | |

Tree columns:

| Token | Value | Why |
|---|---|---|
| `--col-address` | 248px | indent + disclosure + CIDR: a full-length IPv4 prefix (`255.255.255.255/32`, 140px in 13px mono) at depth 4 still gets a 16px gap before its description |
| `--col-owner`, `--col-account` | 120px each | |
| `--col-actions` | 100px | 36px settings slot + 64px primary slot |

### 3.4 Radii and elevation

| Token | Value | For |
|---|---|---|
| — | 0 | surface, sidebar, toolbar, rows, bands, row actions, mobile drawer |
| `--radius-sm` | 3px | 28px controls: segments, mask chips, icon buttons, small buttons; inline-edit hover |
| `--radius` | 4px | 32px controls: inputs, selects, buttons; sidebar nav rows |
| `--radius-float` | 6px | toasts, menus, modal plates |

Shadows are reserved for things that float: `--shadow-float`
(`0 8px 24px`, black at 45% dark / 12% light) for toasts, menus and the mobile
drawer; the plate glow for modal plates; a danger glow for error toasts.
Nothing on the page itself casts a shadow. (The inset ring on a search match
is an outline, not elevation.)

### 3.5 Typography

Two families, split by content:

- **Sans** — the existing system stack: descriptions, controls, labels, help,
  user-management prose, modal copy.
- **Mono** — JetBrains Mono at 400 and 600, the only weights loaded:
  addresses, prefixes, masks (`/24`), search counters (`1/12`), host counts
  and sizes, status readouts (`ok`, `err`), the `> ipam` wordmark.

If an operator might compare it character by character, it's mono.

| Token | Size | Use |
|---|---|---|
| `--font-xs` | 11px | section labels, table headers: uppercase, 600, +0.06em tracking, `--text-muted` |
| `--font-sm` | 12px | owner, account, row actions, toolbar controls, counters, help text, sidebar status and username |
| `--font-md` | 13px | row content (CIDR in mono 600), buttons, inputs, nav labels |
| `--font-base` | 14px | root size; forms, prose, the wordmark |
| `--font-lg` | 16px | modal body, error toasts |

- Single-line row text uses a 20px line height (6 + 20 + 6 = 32px table
  rows); prose keeps 1.5.
- Timestamps and counters set in sans use `font-variant-numeric: tabular-nums`.
- Weights: sans 400/500/600; mono 400/600.
- Never truncate an address. Descriptions, owners and accounts ellipsize and
  keep the full text in `title`.

### 3.6 Motion

- Transition only the property that changes: `color`, `background-color`,
  `border-color`, `opacity`, `transform`, and the sidebar's `width`. Never
  `transition: all` (today on `button` and `.btn-del`).
- 120ms ease-out for hover, color and the disclosure chevron; 160ms for the
  sidebar and drawer; 200ms for toasts.
- Content never animates: rows, bands and tables appear in place.
- Under `prefers-reduced-motion: reduce`, drop slide and rotate transitions and
  switch the six `scrollIntoView({ behavior: 'smooth' })` calls to `'auto'`.

## 4. Shell

The global menu moves from the top bar into a sidebar; search moves into a
thin toolbar at the top of the workspace; the page content sits on a bare
work surface.

### 4.1 Sidebar

```
 expanded · 192px         collapsed · 48px
┌──────────────────┐      ┌────┐
│ > ipam          ‹│      │ >  │
│                  │      │    │
│ ◫  Browse        │      │ ◫  │
│ ≡  Activity      │      │ ≡  │
│ ♙  Users         │      │ ♙  │
│                  │      │    │
│                  │      │    │
│ ● server ok      │      │ ●  │
│ ccappuccio       │      │    │
│ administrator    │      │    │
│ ☾  Dark          │      │ ☾  │
│ ↪  Sign out      │      │ ↪  │
└──────────────────┘      └────┘
```

Glyphs in these sketches stand in for inline SVG icons (§7.3).

- `--surface-raised`, a 1px `--border` on the right, full viewport height,
  sticky. Horizontal padding 8px; 16px between the brand row, the nav and the
  footer.
- **Brand row** — 40px, the toolbar's height, so the wordmark and the page
  title share a line: `> ipam` in mono 600 `--accent-network`, with a collapse
  icon button at the right.
- **Nav** — `Browse`, `Activity`, and `Users` for administrators or `Account`
  for everyone else. Routes stay `#browse`, `#logs` and `#users`, so existing
  links keep working.
- **Footer**, pinned to the bottom — server state, username, theme, sign out.

Nav rows are 36px with `--radius` corners and 8px horizontal padding: a 16px
icon, an 8px gap, a 13px sans label.

| State | Treatment |
|---|---|
| Rest | icon and label `--text-muted` |
| Hover | `--surface-hover`; icon and label `--text` |
| Active | `--surface-active`, a 2px `--accent-network` marker on the left edge, label `--text`, icon `--accent-network`, `aria-current="page"` |

Footer rows:

- **Server state** — an 8px dot and a mono 12px readout (`server ok`, `auth`,
  `err`). The dot is `--accent-alloc` when healthy, `--danger` on error and
  `--text-muted` when unknown or signed out.
- **Identity** — the signed-in username (12px, `--accent-identity`), with the
  role beneath it in 11px `--text-muted`. The footer is about who is signed
  in; the role is secondary.
- **Theme** — a nav row naming the current theme: moon + `Dark` or
  sun + `Light`. Replaces the pill switch.
- **Sign out** — a nav row with a sign-out icon.

Collapsed (48px):

- Labels hide. Icons don't move: 8px sidebar padding plus 8px row padding puts
  them at the same x in both states, centered in the 48px rail.
- Icon-only rows keep their names as `aria-label` and `title`; the status dot
  keeps its readout in `title`.
- The wordmark shrinks to its `>` prompt, which becomes the expand control.
- The identity rows hide; the username moves into the sign-out tooltip
  (`Sign out ccappuccio`).
- The state persists in `localStorage` next to `theme`. Between 769 and
  1024px the sidebar starts collapsed unless the user has chosen otherwise.

At ≤ 768px the sidebar becomes an overlay drawer (192px, `--shadow-float`)
over a scrim, opened from a menu icon button at the left of the toolbar. It
closes on Esc, a scrim click or navigation; focus moves into it on open and
back to the menu button on close.

### 4.2 Workspace toolbar

- 40px, sticky at the top of the workspace, `--surface` background, a 1px
  `--border` rule below.
- Horizontal padding matches the workspace padding, and the content box shares
  the surface's max width, so the page title lines up with the start of the
  row hairlines and the tools end where the row actions end.
- Left: the page title in section-label style (§6.2) — `NETWORKS`,
  `ACTIVITY`, `USERS`, `ACCOUNT`.
- Right: page tools. Only Browse has any. Search is contextual to the IPAM
  workspace — too operational to bury in navigation — so it lives here, not in
  the sidebar and not on other pages.
- Toolbar controls use the small size (28px), leaving 6px above and below.

The search cluster keeps today's behavior; only its presentation changes.

| Part | Spec |
|---|---|
| Input | 240px, mono 12px; the placeholder follows the mode (`search hosts…`, `search networks…`) |
| Mode selector | segmented `Hosts \| Networks`, 12px sans. The selected segment gets `--surface-active` and its semantic label color (`--accent-host`, `--accent-network`). Two `aria-pressed` buttons; switching clears results, as today |
| Counter | mono 12px `--text-muted` with a fixed min-width (≈ 40px) so nothing jitters: `…`, `0`, `3/12`; `err` in `--danger`; `aria-live="polite"` |
| Previous, next | 28 × 28 icon buttons (chevron up, chevron down) with `aria-label`s |

Parts sit 8px apart; previous and next form a 4px button group.

Keys are unchanged except for one fix: `Enter` or `↓` goes to the next match,
`↑` to the previous one, and `Esc` clears the query, results and highlights.
`Shift+Enter` becomes previous — the current tooltip already promises it, but
every `Enter` moves forward.

### 4.3 Work surface

- No outer card and no page `h2` — the toolbar names the page. Content sits
  directly on `--surface`.
- Padding `--workspace-pad`. Width is fluid up to `--surface-max` (1600px) and
  anchored to the sidebar rather than centered, so rows start at the same x on
  every page.
- Sections within a page sit 20–24px apart.

Browse, end to end:

```
 NETWORKS                      [ search hosts…     ] [Hosts|Networks]  1/8  ↑ ↓
───────────────────────────────────────────────────────────────────────────────
 ▾ 10.0.0.0/8         Core addressing      network    infrastructure  ⚙ │ open
   ▾ 10.20.0.0/16     Central Oregon       chris      yellowknife     ⚙ │ open
     ▸ 10.20.8.0/24   Tower management     noc        network           │ hosts
     ▸ 10.20.9.0/24   Subscribers          access     yellowknife       │ hosts
└── address ─────────┘└── description ────┘└─ owner ─┘└── account ───┘└actions┘
```

Every row has a `--border-subtle` hairline beneath it. Descriptions, owners and
accounts align across depths, and the settings slot stays reserved on rows
that don't use it.

## 5. Rows

Rows are the primary visual unit. Every list — networks, hosts, available
subnets, activity, users — uses one grammar: a fixed height, 8px horizontal
padding and internal gap, one `--border-subtle` hairline below, and no boxes
inside. No zebra striping; the host table's odd/even fills go.

### 5.1 Network rows

```css
.tree-row {
  display: grid;
  grid-template-columns:
    minmax(var(--col-address), max-content)  /* indent + disclosure + CIDR */
    minmax(0, 1fr)                           /* description */
    var(--col-owner) var(--col-account) var(--col-actions);
  align-items: center;
  column-gap: var(--space-2);
  min-height: var(--row-h);
  /* no right padding: row actions sit flush */
  padding: var(--space-1) 0 var(--space-1) var(--space-2);
}
.tree-address { padding-left: calc(var(--depth) * var(--indent)); }
```

- JS sets only `--depth` on the row (`style="--depth: 2"`), replacing today's
  computed `padding-left: ${depth * 20 + 8}px`. CSS owns the geometry.
- The address column absorbs the indentation, so description, owner and
  account align down the whole tree. A row whose address doesn't fit widens
  its own address cell: alignment yields, the address is never truncated.
- The actions column is the same width on every row, and rows without a
  settings control leave that slot empty. (Today the ⚙ pushes owner and
  account left on administrators' container rows.)
- Row actions sit flush right and span the full row height, cancelling the
  row's vertical padding.
- Indentation carries nesting. If tree guides are ever added, they are 1px
  `--border-subtle` lines — never boxes or backgrounds.

| Cell | Content | Style |
|---|---|---|
| Disclosure | chevron, rotated 90° when open | 28 × 28 icon button, 12px icon, `--text-muted`, `aria-expanded` |
| CIDR | `10.20.8.0/24` | mono 13px 600, `--accent-network` |
| Description | inline-editable | sans 13px, `--text-secondary`, ellipsis |
| Owner | inline-editable | sans 12px, `--accent-identity`, ellipsis |
| Account | inline-editable | sans 12px, `--text-muted`, ellipsis |
| Actions | settings slot (36px) + primary slot (64px) | row actions (§7.1) |

| State | Treatment |
|---|---|
| Container network (subdivide) | `--wash-subdivide` |
| Leaf network | `--wash-host` |
| Hover | `--surface-hover` in place of the wash |
| Expanded | chevron rotated; the primary action reads `close` on its strong fill; `aria-expanded="true"` |
| Search match | `--wash-match` and a 2px inset `--accent-alloc` ring |

Children of an open container sit on the canvas with hairlines only — no extra
background or border block. `Loading…` and `No subnets allocated yet` are muted
12px rows at the child depth.

### 5.2 Inline editing

- At rest, editable text is plain text. On hover (editors only) it gets a
  `--surface-active` background with `--radius-sm`; nothing is a persistent
  pill.
- Empty editable cells are empty at rest; today's gray placeholder bars go.
  On row hover or focus they show their field name (`owner`, `account`) in
  `--text-muted`.
- Editing swaps in a 28px input sized to the cell. `Enter` saves and `Esc`
  cancels, as today.
- Editable cells are focusable and open with `Enter`. Today they are
  click-only spans.

### 5.3 Other rows

Tree rows are 38px; every other row is 32px.

| Row | Columns |
|---|---|
| Host | address (mono 13px `--accent-network`, 144px) · description (inline-editable) · `del` |
| Available subnet | CIDR (mono `--accent-network`) · `Assign` (`--accent-alloc`) · `Subdivide` (`--accent-subdivide`; cyan today) |
| Activity | time (tabular numerals, `--text-muted`, no wrap) · user (`--accent-identity`) · prefix (mono `--accent-network`) · action (`--text-secondary`) |
| User | username · roles · status · role select, `enable`/`disable`, `del` |

Text cells are padded 6px 8px (6 + 20px line + 6). Cells holding a 28px
control — `del`, `Assign`, a role select, an inline edit — drop to 2px 8px, so
the row stays 32px.

Tabular data stays in `<table>`: header cells use the section-label style over
a `--border` rule, and body rows use `--border-subtle` hairlines.

## 6. Bands

### 6.1 Subordinate bands

Allocation, available subnets, hosts and network settings open inline beneath
their network. They belong to the parent row; they are not cards inserted
into cards. Their inline behavior is excellent for an IPAM and stays.

- Full tree width, square, `--surface-raised`, one `--border-subtle` hairline
  below. No outline, radius or shadow.
- Padding 8px 12px. The left padding also carries the child indentation,
  `(depth + 1) × 16px`, so a band visibly nests under its parent.
- An optional header line: a section label (`AVAILABLE /24 · 37`,
  `ALLOWED SIZES · 172.20.0.0/16`) and a close icon button, 8px above the
  body.
- Inside a band there are rows and inline controls, never another box. Fields
  sit 8px apart, label → control 4px, button groups 4px, groups 16px, form
  row → form row 12px.

| Band | Opens from | Layout |
|---|---|---|
| Allocation | top of an open container's children (creators) | description input (240px) · `Size` · mask selector · `Assign next` · … `Available` |
| Available subnets | `Available` in the allocation band | header, then available-subnet rows; max 300px with its own scroll, as today |
| Hosts | `hosts` on a leaf network | IP input (mono, 144px) · description input · `Add` · … `All addresses`; then host rows |
| Network settings | the settings row action (administrators, containers) | header, 12px help line, mask grid, `All` `None` `Common` · … `Save` |

- **Allocation.** The mask selector is a 4px-gap group of 28px mono chips:
  preferred sizes (up to parent + 4) labeled in `--accent-alloc`, others in
  `--text-muted`, the selected size filled with `--accent-network`.
  `Assign next` is the band's allocate button. The `e` button becomes an
  `Available` toggle (list icon, `aria-expanded`).
- **Hosts.** `Add` is an allocate button. The `E` button becomes an
  `All addresses` toggle (grid icon); in that view used addresses carry
  `--wash-used` and free ones an italic `available` placeholder, as today.
  Search-driven expansion uses the same builder; today it renders a bare
  `table.hosts-table` without the add form or table styles.
- **Settings.** The `.mask-option` tiles become plain 28px checkbox rows in
  the existing auto-fill grid (`minmax(140px, 1fr)`, 4px gap): checkbox,
  `/23` in mono `--accent-network`, `(512 hosts)` in `--text-muted`, and
  `--surface-hover` on hover.
- **Available subnets.** The bordered `.avail-item` boxes become simple
  separated rows (§5.3).

### 6.2 Section bands

A section band labels a region of a page: 8px 12px padding, an 11px uppercase
label (600, +0.06em tracking, `--text-muted`), optional tools at the right, and
a `--border` rule below. The workspace toolbar is the page's top section band,
fixed at 40px. Within pages, section bands divide sections — `YOUR PASSWORD`
on Users, `PASSWORD` on Account.

## 7. Controls and icons

### 7.1 Buttons

| Variant | Size | Look | Used for |
|---|---|---|---|
| Quiet | 32px, or small 28px | transparent, 1px `--border`, `--text-secondary`; hover `--surface-hover`, `--text` | `All`, `None`, `Common`, `enable`/`disable`, band toggles |
| Primary | 32px | `--accent-network` fill, `--text-on-accent` | `Save`, `Sign in`, `Add user`, `Change password` |
| Allocate | 32px | `--accent-alloc` fill, `--text-on-accent` | the one default action per band: `Assign next`, `Add` |
| Outlined accent | 28px | 1px accent border and label; hover adds a 12% accent fill | `Assign` (alloc), `Subdivide` (subdivide) |
| Destructive | 28px | quiet at rest; hover `--danger-fill`, white label | `del`; filled only inside the confirm plate |
| Icon | 28 × 28px | transparent, 16px icon in `--text-muted`; hover `--surface-hover`, `--text` | disclosure, previous/next, close, collapse, menu |
| Segmented | 28px | 1px `--border` outline, `--radius-sm`, 8px per segment; selected segment `--surface-active` | `Hosts \| Networks`, mask sizes |
| Row action | full row height, 64px | square, 1px `--border-subtle` left edge, 12px 500 label | `open`/`close`, `hosts`/`close`; settings (36px, icon) |

Horizontal padding is 12px on 32px buttons and 8px on 28px ones.

Green stays restrained: ordinary allocation choices — mask chips, `Assign` on
each available prefix — are green text or border with at most a subtle fill.
Only a band's preferred/default action (`Assign next`, `Add`) is solid green,
so a screen full of valid choices never turns into a wall of green slabs.

Row actions stay flush right, full height and colored — they are part of
GoPieNg's identity — but narrower (64px, from 80px or more) and less
button-like (12% fill, from 20%):

- `open` / `close`: `--fill-subdivide` with an `--accent-subdivide` label;
  `--fill-subdivide-strong` on hover and while expanded.
- `hosts` / `close`: `--fill-host` with an `--accent-host` label;
  `--fill-host-strong` on hover and while expanded.
- Settings: transparent, `--text-muted` icon, `--surface-hover` on hover.
- Fixed widths, so `open` ⇄ `close` never moves anything.

Filled buttons brighten on hover (`filter: brightness(1.1)`, as today) and
keep at least 4.5:1 label contrast in every state.

### 7.2 Inputs and focus

- 32px (28px in the toolbar and for inline edits), a `--surface` well, 1px
  `--border`, 13px text, `--text-muted` placeholders.
- Focus: border `--accent-network`, as today.
- Addresses and prefixes are typed in mono (search, host IP).
- Checkboxes: 16px, `accent-color: var(--accent-network)`.
- Everything else focusable gets
  `:focus-visible { outline: 2px solid var(--accent-network); outline-offset: 1px }`.
  Flush elements (row actions, sidebar rows, segments) use
  `outline-offset: -2px`.

### 7.3 Icons

- Small inline SVGs: 16 × 16 viewBox, 1.5px stroke, `stroke="currentColor"`,
  `fill="none"`, round caps and joins, `aria-hidden="true"` (the control
  carries the label). Drawn at 16px, or 12px for the tree disclosure.
- One module, `web/js/icons.js`, holds the path data and an `icon(name)`
  builder using `createElementNS`, since `el()` creates HTML elements, not
  SVG. `embed.go` already embeds `js/*.js`.
- No icon fonts, emoji or Unicode glyphs as icons. Retire `▶ ▼` (disclosure),
  `▲ ▼` (search), `⚙` (settings) and `×` (close).

| Icon | For |
|---|---|
| `browse` (hierarchy) | Browse |
| `activity` (pulse) | Activity |
| `users`, `user` | Users, Account |
| `chevron-left`, `chevron-right` | sidebar collapse; tree disclosure (rotates) |
| `chevron-up`, `chevron-down` | search previous, next |
| `settings` (sliders) | network settings |
| `list`, `grid` | `Available`, `All addresses` |
| `close` | band close |
| `moon`, `sun` | theme |
| `sign-out`, `menu` | sign out, mobile drawer |

## 8. Pages

**Browse** — toolbar `NETWORKS` with search; root networks as tree rows with
their bands (§4.3). With nothing to show, a muted `No networks found` row.

**Activity** — renamed from *Logs*; the route stays `#logs`. A header row and
activity rows on the surface, no card.

**Users** (administrators) — an add-user band at the top (username, password,
role, `Add user`), then user rows. The administrator's own password form,
today a `<details>` at the top of the page, becomes a collapsible
`YOUR PASSWORD` section band after the list.

**Account** (everyone else; the nav label was *User*) — a `PASSWORD` section
band with three 32px fields and `Change password`, then the role as a muted
read-only line.

**Sign in** — outside the shell, as today: no sidebar or toolbar. A bare 320px
column on the canvas, with no card, anchored at the modal plates' height
(~28–32% from the top): `GoPieNg` in mono 600 `--accent-network`, the muted
`IP Address Management` subtitle, stacked 32px fields 12px apart, a full-width
primary `Sign in`, and errors in `--danger` on `--wash-danger`.

**Render errors** — a band with the message in `--danger`, instead of an
`Error` card.

## 9. Modals, toasts and alerts

### 9.1 Modal plates: keep the weird ones

The red/brown warning plate is one of the few places where breaking the
general rules gives GoPieNg character. Refine it; don't normalize it.

```
┌────────────────────────────────────┐   ┌────────────────────────────────────┐
│ WARNING                            │   │ DELETE                             │
│ 10.20.8.17 already responds        │   │ Delete host 10.20.8.17 "core-sw2"? │
│                                    │   │                                    │
│ Esc or click anywhere to dismiss   │   │             [ Cancel ]  [ Delete ] │
└────────────────────────────────────┘   └────────────────────────────────────┘
```

| Property | Value |
|---|---|
| Width | 360–440px (today: `max-width: 90%` around `2rem 3rem` padding); full width minus 16px gutters on small screens |
| Placement | ~28–32% from the top (overlay `padding-top: 30vh`), not dead center |
| Padding | 20px |
| Surface | `--plate-bg`, 2px `--plate-border`, `--radius-float`, `0 8px 32px var(--plate-glow)` |
| Heading | 11px uppercase, `--plate-muted`: `WARNING`, `DELETE` |
| Heading → body | 8px |
| Body | 16px sans 500 (today 17.5px), `--plate-text`, left-aligned; addresses in mono |
| Body → action row | 20px |
| Buttons | 32px, 8px apart, right-aligned |
| Scrim | `rgb(0 0 0 / 0.7)` in both themes |

- **Warning** (`showWarningModal`): no buttons. A 12px `--plate-muted` hint,
  `Esc or click anywhere to dismiss`, replaces the centered
  `(click anywhere to dismiss)` suffix.
- **Delete confirmation** (`showConfirmModal`): the same plate with a compact
  action row — `Cancel`, then `Delete`. `Cancel` is deliberately boring:
  `--surface-raised`, `--text`, `--border-subtle` in either theme, with no
  pink or red. `Delete` gets the red treatment (`--plate-danger`, white).
  `Cancel` takes focus on open, as today. `Esc` and a scrim click cancel.
- **Both:** `role="dialog"` with `aria-modal="true"` (`role="alertdialog"` for
  the confirmation), labelled by the heading and described by the body. Focus
  moves into the plate, `Tab` stays inside it, and focus returns to the
  invoking control on close. The scrim shows a pointer cursor only where a
  click dismisses.

### 9.2 Toasts

- Bottom-right, 16px from the edges, 8px apart, at most 400px wide,
  `--radius-float`, `--shadow-float`.
- Keep the escalation: `info` is compact (8px 12px, 13px text, a 1px
  `--accent-network` border, 3.5s); `error` is bigger (16px 20px, 16px text,
  a 2px `--danger` border on a 15% danger wash, a danger glow, 8s).
- `pushToast` also accepts `warning`, which nothing calls. It is yellow today,
  and yellow means subdivision; a warning tier, if ever needed, is a quieter
  danger treatment.
- Retire `notify()` in `util.js`: it is unused and styled with hard-coded
  inline colors.

### 9.3 Offline banner

A full-width `--danger-fill` bar with a white 600 label across the top of the
viewport, `role="alert"`, as today. The sidebar's server-state row should
agree with it.

## 10. Responsive

| Width | Behavior |
|---|---|
| > 1024px | sidebar expanded (192px) by default |
| 769–1024px | sidebar collapsed (48px) by default; a stored choice wins |
| ≤ 768px | the sidebar becomes a drawer; the toolbar wraps to two 40px lines (menu, title … counter, previous, next / search, `Hosts \| Networks`); owner and account columns hide, as today; the address column drops its fixed width; the tree scrolls horizontally inside the surface when a row is wider than the screen; band controls stack; workspace padding 12px |
| ≤ 480px | workspace padding 8px; the match counter stays visible (today it hides) |

On coarse pointers (`@media (pointer: coarse)`), at any width: rows 44px, row
actions at least 44px tall, controls at least 40px — the touch sizes today's
mobile rules already use.

Today's horizontal-scroll rule targets `.tree`, but the tree container is
`.net-tree`, so it never applies.

## 11. Accessibility

- Text contrast is at least 4.5:1 in both themes, including small accent text
  (CIDRs, owners, row-action labels) and labels on fills (§3.1).
- Everything is keyboard-reachable, inline-editable cells included, with a
  visible `:focus-visible` ring (§7.2).
- Disclosure buttons and row actions set `aria-expanded` and point at their
  children or band with `aria-controls`.
- Icon-only controls — collapsed sidebar rows, previous/next, close, menu —
  have an `aria-label` and a `title`.
- Landmarks: `<nav aria-label="Primary">` with `aria-current="page"`,
  `<main>`, and `role="search"` on the search cluster.
- The search counter is `aria-live="polite"`; error toasts and the offline
  banner are `role="alert"`.
- Dialogs follow §9.1; motion follows §3.6.

## 12. Constraints

- No Tailwind, React, component framework, CSS-in-JS or design-system
  dependency. The hand-built vanilla frontend is about the right size.
- No build step: `web/embed.go` embeds `index.html`, `css/*.css` and
  `js/*.js` as they are.
- The system is a small set of primitives — shell (sidebar, toolbar,
  surface), row, band, section band, button, icon — expressed as classes in
  `web/css/styles.css` and `el()`-style builders in the existing modules.
- Keep the system-sans/JetBrains Mono split. No new fonts, no icon font.
- Don't restyle GoPieNg to look like Liminal. Share its structure, not its
  palette.

## 13. Migration

The overhaul described here has been applied to `web/`. This section records
what changed from `f8079fe`, for reviewers and for anyone reading older code.

### 13.1 Map

| Today | Becomes |
|---|---|
| `.app-header`: logo, nav, search, status, user, logout, theme | `.sidebar` + `.toolbar` |
| Text nav `Browse` / `Logs` / `User(s)` | sidebar rows `Browse` / `Activity` / `Users` or `Account` |
| `.header-search` with `.search-toggle` (`.toggle-track`, `.toggle-thumb`) | toolbar search cluster with a `Hosts \| Networks` selector |
| `.search-nav` `▲` `▼` | chevron icon buttons |
| `.status`, `.user-badge`, `.logout-btn`, `.theme-toggle` pill | sidebar footer rows |
| `.main-content`: centered, max 1200px, `1.5rem` padding | `.surface`: fluid to 1600px, 16px padding |
| `.card` (8px radius), `.tree-card`, `.card h2` | removed; toolbar title and section bands |
| `.tree-row`: 44px, `0.6rem` padding, `depth * 20 + 8` indent | grid row, 38px, `--depth` × 16px |
| `.tree-toggle` `▶` `▼` | chevron icon button with `aria-expanded` |
| `.owner-text:empty`, `.account-text:empty` gray bars | empty at rest; field-name hint on hover or focus |
| `.btn-open`, `.btn-hosts`: 80px+, 20% fill | 64px row actions, 12% fill |
| `.btn-settings` `⚙` | settings icon in a reserved slot |
| `.alloc-bar`, `.avail-subnets`, `.host-panel`, `.settings-panel` | bands |
| `.avail-item` bordered boxes | separated rows |
| `.mask-option` tiles | plain checkbox rows |
| `.btn-edit-mode` `e`, `E` | `Available`, `All addresses` toggles |
| `.host-table` zebra fills | hairline rows |
| `.btn-close` `×` | close icon button |
| Logs and Users tables inside `.card` | rows on the surface |
| `.login-card` | bare sign-in column |
| `.warning-modal`: centered, `2rem 3rem`, centered text, click-only | anchored plate, 20px padding, left-aligned, keyboard and ARIA |
| `transition: all 0.15s` on `button` and `.btn-del` | property-specific transitions |
| Radii 0/3/4/6/8/10px | 0/3/4/6px |
| `--bg-0…3`, `--border`, `--text-0…2`, `--cyan` … `--purple` | semantic tokens (§3.1) |
| `rem` spacing throughout | `--space-*` (§3.2) |

### 13.2 Defects the overhaul absorbs

Found while reviewing `f8079fe`; each goes away under the new primitives.

- `var(--text)` is used (`.header-search .search-input`, `.search-nav:hover`,
  `.confirm-cancel`) but never defined. The semantic `--text` token defines it.
- The API status dot never turns red: `app.js` puts `error` on the
  `#apiStatus` container, while the CSS targets `.status-dot.error`.
- The mobile horizontal-scroll rule targets `.tree`; the container is
  `.net-tree`.
- Search-driven host expansion renders a bare `table.hosts-table`, with no add
  form and no host-table styles.
- `#searchPrev` promises `Shift+Enter` in its tooltip, but every `Enter` moves
  forward.
- The confirm overlay shows a pointer cursor but ignores clicks.
- In the light theme the confirm `Cancel` renders plate pink on `--bg-3` gray
  (1.2:1). It becomes a neutral button.
- Owner and account columns shift left on rows with the settings control.
- Inline-editable cells can't be reached by keyboard.

### 13.3 Order of work

1. Semantic tokens: re-point every rule. No visual change except the
   light-theme contrast fixes.
2. Shell: sidebar, toolbar, surface; remove the outer cards.
3. Rows: grid, 38px height, 16px indentation, row actions, inline-edit
   affordances.
4. Bands: allocation, available subnets, hosts, settings.
5. Activity, Users/Account and Sign in on the same primitives.
6. Modal plates: anchoring, spacing, keyboard, ARIA.
7. Icons: replace the remaining glyphs.
8. Responsive and accessibility pass (§10, §11).
9. Update the README's *UI Usage* section, which describes the gear icon and
   the green size buttons.

Each step lands as its own reviewable change; the token step makes the rest
mostly mechanical.
