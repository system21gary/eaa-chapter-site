# Outreach

A print walkthrough of the site for **Ted Simons**, chapter president —
following up on the conversation we had about giving 1699 a proper website.

**`EAA-1699-website-walkthrough.pdf`** is the thing to send or print. Twelve
pages: where it came from, what a visitor sees, the Members Corner, the Tool
Locker and its lending workflow, how joining works, why it took an evening
rather than a winter, how members' details are looked after, and what's needed
from the chapter to finish it.

It's written peer to peer — a member showing another member what's been built.
It isn't a sales document and doesn't pitch anything; the tooling that produced
the site gets named twice, in passing, because "this took one evening" is not a
credible claim without saying how.

## Regenerating it

Needs a running dev server with the demo content seeded, and a Chrome binary.

```bash
npm run seed                      # demo content
npm run dev                       # leave running in another terminal
node scripts/smoke.mjs            # sets the admin password the capture signs in with
node outreach/capture.mjs         # screenshots -> outreach/shots/
node outreach/make-pdf.mjs        # brochure.html -> the PDF
```

Point `CHROME_PATH` at a Chrome/Chromium binary if the default isn't right, and
`PUPPETEER_ROOT` at wherever `puppeteer-core` is installed.

## How the screenshots are framed

`capture.mjs` gives every shot a viewport height matching the aspect ratio it's
placed at in the brochure, plus a scroll offset. The site header is sticky, so
scrolling past the page heading still leaves the navigation in frame — that's
what makes a shot read as *a page* rather than as a band of dark blue.

Every screenshot runs the full width of the text column. A screenshot placed at
half width shrinks the site's own type to roughly 3pt on paper, which nobody can
read.

## Contents

| | |
|---|---|
| `brochure.html` | Source. US Letter, print CSS, no web fonts and no emoji so it renders identically wherever it's printed. |
| `capture.mjs` | Screenshot capture. |
| `make-pdf.mjs` | HTML → PDF, and fails loudly if an image didn't load. |
| `shots/` | Generated screenshots. Safe to delete and regenerate. |

## Note

This folder is about the site but isn't part of it — nothing here is served,
and the app doesn't reference it. If the chapter ever takes the repository over,
this is the one directory to drop.
