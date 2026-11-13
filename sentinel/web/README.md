# The Sentinel page

One static page at `warden.lamportrobotics.com/sentinel/`: sign in with a wallet, see the watched wallets,
choose where alerts go, answer alerts, link Warden, and see the plan. It talks to the Sentinel service on the
same site, under `/sentinel/api`.

| File | Job |
|---|---|
| `index.html` | The page and its policy: no script runs but `app.js`, and it connects to nothing but this site. |
| `sentinel.css` | The same look as the Warden page. |
| `src/app.ts` | Everything it does. |

`pnpm build:web` writes `sentinel/web/dist`.

How it is kept simple to trust:

- **No cookie.** The session is a token in this tab's `sessionStorage`, sent as a bearer header. Closing the
  tab signs out.
- **No markup from anywhere.** Every string from the service or a wallet goes on the page as text. An alert
  whose sentence holds an `<img onerror>` shows as those characters.
- **Sign-in is a wallet signature** over a text that names this site. Wallets with the sign-in feature write
  the text themselves and show the site; for the others the page asks for a message signature over the same
  words. Either way it moves nothing.
- **Removing asks twice**, with a button that changes its words, not a browser dialog.
- **The paid plan is described as it is.** The page says what the plan gives today and that rescue itself is
  not available yet, whether or not checkout is open.

`test/browser/sentinel-page.test.ts` runs the built page in Chromium against the real service, with Warden
installed and a Wallet Standard wallet that signs with a real key.

Not here yet: arming a wallet for rescue, and a way to pay in SOL or USDC.
