# Design architecture

A map of every screen of bizinsights as it is on 2026-10-30 (main at `f7f6bb45`), written as a
brief for a simpler redesign. Nothing in the product was changed to make it.

**Note, 2026-11-13.** The map predates the removal of Customer Messaging (SMS), Email integrations
and the Automations hub on 2026-11-13 and still shows them (the XML, `index.html` and the
screenshots under `07-messaging`, `09-email` and `10-automations`). Those screens are no longer
in the app.

| File | What it is |
| --- | --- |
| [bizinsights-design-architecture.xml](bizinsights-design-architecture.xml) | The map. Frames, the signed-in shell (sidebar, top bar, search, bell), every screen area by area (route, source file, purpose, sections in order with their visible wording, buttons, states, a complexity rating), the cross-cutting findings, the competitor research with sources, and the proposed simpler structure. |
| [index.html](index.html) | The same XML as a browsable page with the screenshots. Open it in a browser. |
| `screenshots/` | One full-page screenshot per screen: `{area}/{page-id}--desktop.jpg` (1440 px) and `--mobile.jpg` (390 px) for the main screens. |

Public screens were captured from https://bizinsights.io. Signed-in screens were captured from a
private local copy of the app filled with sample data (the "Demo Boutique" store from
`.claude/demo-seed.mjs`, the Google Ads demo account and four sample employees), never from a real
merchant's account. Screens that need a real outside service (a WhatsApp phone, an AWS SMS sender,
a mailbox) show their not-connected state.

To change a screen's entry, edit the XML. `index.html` embeds a copy of it (so it opens straight
from disk), so copy the edit into the page afterwards:

```bash
node docs/design-architecture/render.mjs
```
