# Working on Spotiky

The site is `index.html` (with `404.html` an exact copy, so every address like `/夜光` or
`/playlist/5mh夜歌` gets the same page) plus `collection.js`, which the page loads for
`spotiky.com/account` and for the label editor. The Cloudflare Worker is `preview-worker.js`,
deployed with `wrangler.jsonc`. Everything in `dev/` is for building and testing them.

## After changing the page

    cp index.html 404.html

When `collection.js` changes, bump `COLLECTION_JS = '/collection.js?v=…'` in `index.html` so
browsers don't keep the old copy.

## After changing the Worker

Edit `dev/codedata/worker.template.js`, never `preview-worker.js` itself, then build:

    python3 -I dev/codedata/build_worker.py preview-worker.js

The build fills in the hieroglyph signs, the Chinese characters, the emoji set and the English
blocklist (LDNOOBW, CC BY 4.0) from `dev/codedata/out`, `dev/emojiwork` and `dev/dl_badwords`.

## Tests

Worker (Node 22+, no installs; a stand-in D1 database runs the real SQL):

    cp preview-worker.js dev/tests/worker/worker.mjs
    cd dev/tests/worker && for t in test test_ids test_share test_accounts test_collection test_previews; do node $t.mjs; done

Browser (Playwright and Chrome):

    cd dev/tests
    NODE_PATH=$(npm root -g) node e2e_v2.js ../..
    NODE_PATH=$(npm root -g) node e2e_codes.js ../..
    NODE_PATH=$(npm root -g) node e2e_share.js ../.. shot.png ../fonts/hieroglyphs.woff2
    NODE_PATH=$(npm root -g) node e2e_collection.mjs ../.. [screenshot-folder]
    NODE_PATH=$(npm root -g) node e2e_autostart.js ../../index.html

`e2e_collection.mjs` runs the page against the real Worker code, so it needs the
`worker.mjs` copy above.

Setup script (a stand-in Wrangler and Chrome):

    node dev/tests/setup/run.mjs .

## Deploying

- The site: push to `main`; GitHub Pages serves it.
- Link previews: the Worker also runs on `spotiky.com/*` (the route in `wrangler.jsonc`), in
  front of GitHub Pages. GitHub Pages sends every page address (`/track/ID$13-44`, `/夜光83`,
  `/playlist/5mh夜歌`) as 404.html with status 404, and Discord and the other apps show no
  preview for a 404, so the Worker sends those pages with status 200 and the song's title,
  artist, cover and times in the `<head>`. Everything else passes straight through. Discord
  keeps a preview for about 30 minutes: to see a change sooner, share the link with `?v=2`.
- The Worker: `node setup.mjs --chrome-profile spotiky` deploys it (and skips setup steps
  already done). Or connect Workers Builds once with `node setup.mjs --connect --chrome-profile spotiky`,
  and every push that changes `preview-worker.js` or `wrangler.jsonc` deploys it.
- Secrets (`PEPPER`, `RESEND_API_KEY`) live only in Cloudflare. Never commit them.
