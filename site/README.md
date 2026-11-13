# The Warden page

`index.html` is the page for https://warden.lamportrobotics.com. One static file in the main site's type and
colours. It loads nothing but that site's own fonts and logo (`/site/fonts/switzer-*.woff2`, `/site/mark.svg`),
which are not copied into this repo: the server serves them from the main site's folder.

It is not deployed. To put it up:

1. DNS: an A record for `warden.lamportrobotics.com` to the server lamportrobotics.com is on (DNS only, like
   the others, so the server can get its own certificate).
2. On the server, copy `index.html` to `/opt/lamportrobotics/warden/index.html`.
3. Add this block to the Caddyfile and reload Caddy:

   ```
   warden.lamportrobotics.com {
     encode zstd gzip
     header {
       Strict-Transport-Security "max-age=31536000"
       X-Content-Type-Options "nosniff"
       X-Frame-Options "DENY"
       Referrer-Policy "strict-origin-when-cross-origin"
       -Server
     }
     # the main site's fonts and logo
     @shared path /site/fonts/* /site/mark.svg
     handle @shared {
       root * /opt/lamportrobotics/site
       header Cache-Control "public, max-age=86400"
       file_server
     }
     handle {
       root * /opt/lamportrobotics/warden
       header Cache-Control "no-cache"
       file_server
     }
   }
   ```

Before it goes up, check three lines against the product as it is that day: the status line under the buttons
(version, and whether it is in the Chrome Web Store), the first button's link, and the wallet versions in the
table's introduction (`pnpm test:wallets` prints them).
