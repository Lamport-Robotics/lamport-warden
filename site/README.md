# The Warden page

`index.html` is the page for https://warden.lamportrobotics.com, and `privacy/index.html` is the privacy policy
at `/privacy/` (the same text as `PRIVACY.md`; change both together). One static file in the main site's type and
colours. It loads nothing but that site's own fonts and logo (`/site/fonts/switzer-*.woff2`, `/site/mark.svg`),
which are not copied into this repo: the server serves them from the main site's folder.

`try/` is the practice page at `/try/`: a practice wallet made in the page, and eight requests a real site
might make of it, so that anyone (a store reviewer, a visitor with no crypto) can watch what Warden does.
The page is the wallet and the site at once, so it can say whether the wallet was ever asked; it never looks
inside Warden. Nothing is sent anywhere. Its script bundles the wallet libraries, so it is built
(`pnpm build:web`, into `try/dist`), and `site/deploy.sh` builds and copies it. It borrows the Sentinel
page's stylesheet (`/sentinel/sentinel.css`). `test/try-scenarios.test.ts` hands each request to the engine
and checks that what the page promises beside the button is what the engine does;
`test/browser/try-page.test.ts` presses every button in Chromium, with the extension and without it.

It is live (first put up on 2026-11-13). The pieces:

1. DNS: an A record for `warden.lamportrobotics.com` to the server lamportrobotics.com is on (DNS only, like
   the others, so the server gets its own certificate).
2. `site/deploy.sh` copies the page to `/opt/lamportrobotics/warden/` and, the first time, adds a site block
   for the hostname to the Caddyfile, after backing it up and only if the new one validates. To publish a
   change to the page, run it again: it replaces the page and leaves the server's configuration alone.

Before each publish, check three lines against the product as it is that day: the status line under the buttons
(version, and whether it is in the Chrome Web Store), the first button's link, and the wallet versions in the
table's introduction (`pnpm test:wallets` prints them).
