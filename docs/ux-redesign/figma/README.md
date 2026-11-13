# The Figma file

**File:** https://www.figma.com/design/oGUAW2tcWji76y18nHTHBx ("bizinsights — simpler app (design system +
prototype)"), in the drafts of the Figma account the connector is signed in to.

Built on 2026-11-11 through the Figma connector. Figma's Starter plan allows **20 connector calls a
month** (a View seat has the same limit on any plan), and the build used them, so the file is unfinished.

**Update, 2026-11-13.** The Automations and Create automation screens (07, 08; also in
`wire-prototype.js`) show the Automations hub, which was removed from the app with Customer Messaging
(SMS) and Email integrations. The file was not changed.

## What is in it

| Page | Contents |
|---|---|
| Start here · foundations | Empty. The cover and the colour, type and spacing sheet were not reached. |
| Components | 42 icons (the app's own Lucide icons) and 20 components, each with its states. |
| Screens · prototype | 14 desktop screens at 1440 px. |

**Tokens** (Figma variables, each with the app's CSS name as its code syntax): 24 primitive colours, 28
semantic colours (`color/bg`, `color/accent`, `color/danger-soft` and so on, taken from
`apps/web/src/app/globals.css`), 9 spacing steps (4 to 48), 4 radii (8, 12, 16, full). 9 text styles in
Inter, the app's font: display, page title, section title, two figure sizes, body, body strong, label,
caption. 2 shadow styles. One mode only: the Starter plan has no second mode, so there is no dark set.

**Components:** Button (4 styles × default, hover, disabled), Badge (5 tones), Chip, Tab, Input (default,
focus, error, disabled), Select (closed, open), Toggle, Checkbox, Nav item (page, current page, group
closed, group open), Metric card (up, down, flat, loading), Insight row (3 tones), Action row, Disclosure
("More detail", closed and open), State block (empty, loading, error, success), Integration card
(connected, not connected, needs attention), Table row (header, body), Modal, Step (done, current, next),
Top bar, Sidebar (the short menu of pull request 361).

**Screens:** 01 Home · 02 Sales & Orders · 03 Abandoned checkouts · 04 Products · 05 Profit & Loss ·
06 Advertising · 07 Automations · 08 Create automation · 09 Integrations · 10 Connect Google Ads (dialog) ·
11 Team & Access · 12 Invite someone (dialog) · 13 Download a report (dialog) · 14 Home, first visit.

Figures are sample ones for "Demo Store" and add up across screens (sales A$35,584.50, 122 orders, net
sales A$33,912.20, expenses A$21,940.10, net profit A$11,972.10).

## What is missing

1. **The click-through.** No screen is linked to another yet. [wire-prototype.js](wire-prototype.js) holds
   the links (about 170: the menu on every screen, tabs, buttons, dialogs) and the two starting points. It
   was written and sent, and Figma refused it at the limit, so it has never run.
2. **Dialog backdrops** on screens 10, 12 and 13 are solid navy and hide the page behind. The same script
   makes them see-through.
3. **Tablet and phone screens**, a board of the empty, loading and error states on a real page, and the
   foundations sheet. Not designed in Figma. The State block component covers the states one card at a time.
4. Seen by screenshot: both component sheets, Home, Abandoned checkouts, Profit & Loss, Automations, Create
   automation, Invite someone. **Not looked at:** Sales & Orders, Products, Advertising, Integrations, Connect
   Google Ads, Team & Access, Download a report, Home first visit (the limit came first).

## Node ids, for whoever continues

Pages: start `0:1`, components `1:4`, screens `1:5`. Screens: home `7:2`, sales `7:467`, abandoned `7:810`,
products `9:1182`, profit `9:1563`, advertising `9:1998`, automations `9:2442`, create automation `9:2797`,
integrations `10:2661`, connect Google Ads `10:3030`, team `10:3082`, invite `10:3389`, download report
`10:3488`, first visit `10:3618`. Components: Sidebar `4:264`, Top bar `4:244`, Button set `3:27`, Metric
card set `3:207`, Table row set `4:207`, State block set `4:140`.

Things learned while building: a file on the Starter plan holds 3 pages; nodes hidden inside an instance
are found only after `figma.skipInvisibleInstanceChildren = false`; one text property shared by a
component set gives every variant the same default wording, so variant-specific words are plain text
layers named `Title`, `Body`, `C1`… and are set by layer name.
