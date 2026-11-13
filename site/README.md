# The Warden page

`index.html` is the page for https://warden.lamportrobotics.com. One static file in the main site's type and
colours. It loads nothing but that site's own fonts and logo (`/site/fonts/switzer-*.woff2`, `/site/mark.svg`),
which are not copied into this repo: the server serves them from the main site's folder.

It is not deployed. To put it up:

1. DNS: an A record for `warden.lamportrobotics.com` to the server lamportrobotics.com is on (DNS only, like
   the others, so the server can get its own certificate).
2. `site/deploy.sh` copies the page to `/opt/lamportrobotics/warden/` and adds a site block for the hostname
   to the Caddyfile, after backing it up and only if the new one validates. It can run before the DNS record
   exists; the certificate arrives once the record does.

Before it goes up, check three lines against the product as it is that day: the status line under the buttons
(version, and whether it is in the Chrome Web Store), the first button's link, and the wallet versions in the
table's introduction (`pnpm test:wallets` prints them).
