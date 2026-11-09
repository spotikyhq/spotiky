#!/usr/bin/env node
// Sets up Spotiky's Cloudflare Worker from your own computer:   node setup.mjs
// Run it in the folder with preview-worker.js and wrangler.jsonc. Running it again is safe:
// every step that's already done is skipped.
//
//   1. Signs you into Cloudflare in your browser (through Wrangler, Cloudflare's own tool)
//   2. Finds the D1 database "spotiky", or makes it, and writes its ID into wrangler.jsonc
//   3. Deploys preview-worker.js with the AI and DB bindings from wrangler.jsonc
//   4. Gives the Worker a PEPPER if it has none: random, made on this computer, with a copy
//      in spotiky-PEPPER-backup.txt in your home folder. An existing PEPPER is never replaced.
//   5. Gives the Worker your Resend API key if it has none (you paste it; it isn't shown)
//   6. Checks the live Worker: the database answers, and sign-in is ready
//
// Nothing secret is written to this folder, so the folder is safe to upload to GitHub.
// Needs Node.js 22.12 or newer (what Wrangler needs).
//   --new-resend-key   replace the Worker's Resend key
// The Resend key can also come from the RESEND_API_KEY environment variable.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const WORKER = "spotiky-preview";
const DATABASE = "spotiky";
const WORKER_URL = process.env.SPOTIKY_WORKER_URL || "https://spotiky-preview.spotikyhq.workers.dev";
const CONFIG = "wrangler.jsonc";
const BACKUP = join(homedir(), "spotiky-PEPPER-backup.txt");
const NEW_RESEND_KEY = process.argv.includes("--new-resend-key");

const say = text => console.log(text);
const step = text => console.log(`\n▸ ${text}`);
function stop(text) {
  console.error(`\n✗ ${text}`);
  process.exit(1);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  stop(`Wrangler needs Node.js 22.12 or newer, and this is ${process.versions.node}. Get the LTS version from nodejs.org.`);
}
if (!existsSync("preview-worker.js") || !existsSync(CONFIG)) {
  stop(`Run this in the folder that has preview-worker.js and ${CONFIG}.`);
}

// Runs Wrangler through npx. quiet: keep its output to read it here. input: text it reads.
function wrangler(args, { quiet = false, input } = {}) {
  const res = spawnSync("npx", ["--yes", "wrangler@4", ...args], {
    encoding: "utf8",
    input,
    stdio: quiet || input !== undefined ? "pipe" : "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (res.error) stop(`Couldn't run npx, which comes with Node.js: ${res.error.message}`);
  return { ok: res.status === 0, out: res.stdout || "", err: res.stderr || "" };
}

// The JSON in Wrangler's output, skipping any notices printed around it
function jsonIn(text) {
  for (let i = 0; i < text.length; i++) {
    const close = text[i] === "[" ? "]" : text[i] === "{" ? "}" : null;
    if (!close) continue;
    const end = text.lastIndexOf(close);
    if (end <= i) continue;
    try { return JSON.parse(text.slice(i, end + 1)); } catch (err) { /* not JSON yet */ }
  }
  return null;
}

function failed(what, res) {
  const text = (res.err || res.out).trim();
  if (/more than one account/i.test(text)) {
    stop(`${what}: your Cloudflare login has more than one account. Add the right one to ${CONFIG} as\n` +
      `  "account_id": "...",\n(the Account ID is on the right side of Workers & Pages in the dashboard), then run this again.`);
  }
  stop(`${what}:\n${text}`);
}

// Reads one line without showing it, for the API key
function askHidden(question) {
  return new Promise(resolve => {
    const tty = Boolean(process.stdin.isTTY);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
    process.stdout.write(question);
    if (tty) rl._writeToOutput = () => {};   // don't echo what's typed or pasted
    rl.question("", answer => {
      resolve(answer.trim());   // before close(), whose handler below answers "" when input just ends
      if (tty) process.stdout.write("\n");
      rl.close();
    });
    rl.on("close", () => resolve(""));
  });
}

// ---- 1. Cloudflare sign-in ------------------------------------------------------------
step("Cloudflare sign-in");
if (wrangler(["whoami", "--json"], { quiet: true }).ok) {
  say("  Already signed in.");
} else {
  say("  Your browser will open so you can sign in to Cloudflare.");
  if (!wrangler(["login"]).ok) stop("The Cloudflare sign-in didn't finish. Run this again.");
}

// ---- 2. The database ----------------------------------------------------------------
step(`Database "${DATABASE}"`);
function findDatabase() {
  const res = wrangler(["d1", "list", "--json"], { quiet: true });
  const list = jsonIn(res.out);
  if (!res.ok || !Array.isArray(list)) failed("Couldn't list your D1 databases", res);
  return list.find(d => d && d.name === DATABASE);
}
let db = findDatabase();
if (db) {
  say("  Found it.");
} else {
  const res = wrangler(["d1", "create", DATABASE], { quiet: true });
  if (!res.ok) failed("Couldn't make the database", res);
  db = findDatabase();
  if (!db) stop("The database was made but doesn't show up yet. Run this again in a minute.");
  say("  Made it. The Worker makes its tables the first time it's used.");
}
const dbId = db.uuid || db.id;
const config = readFileSync(CONFIG, "utf8");
const withId = config.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${dbId}$2`);
if (withId !== config) {
  writeFileSync(CONFIG, withId);
  say(`  Wrote its ID into ${CONFIG}. Upload that file to GitHub too.`);
}

// ---- 3. Deploy ----------------------------------------------------------------------
step(`Deploying the Worker "${WORKER}"`);
say("  If Wrangler lists differences from what was set in the dashboard (like the old CODES");
say("  storage going away) and asks whether to continue, answer y.");
if (!wrangler(["deploy"]).ok) stop("The deploy didn't go through. Fix what Wrangler says above, then run this again.");

// ---- 4 and 5. Secrets ---------------------------------------------------------------
step("Secrets");
const listed = wrangler(["secret", "list", "--name", WORKER, "--format", "json"], { quiet: true });
const secrets = jsonIn(listed.out);
if (!listed.ok || !Array.isArray(secrets)) failed("Couldn't list the Worker's secrets", listed);
const has = new Set(secrets.map(s => s && s.name));

function putSecret(name, value) {
  const res = wrangler(["secret", "put", name, "--name", WORKER], { input: value });
  if (!res.ok) failed(`Couldn't set ${name}`, res);
}

if (has.has("PEPPER")) {
  say("  PEPPER is set, and stays as it is. (A new one would cut everyone off from their accounts and playlists.)");
} else if (existsSync(BACKUP)) {
  const saved = readFileSync(BACKUP, "utf8").match(/^PEPPER=(\S+)\s*$/m);
  if (!saved) stop(`${BACKUP} has no PEPPER= line. Fix it or move it away, then run this again.`);
  putSecret("PEPPER", saved[1]);
  say(`  PEPPER put back from ${BACKUP}.`);
} else {
  const pepper = randomBytes(32).toString("base64url");
  writeFileSync(BACKUP,
    `Spotiky's PEPPER, the secret on the Cloudflare Worker "${WORKER}" (set ${new Date().toISOString().slice(0, 10)}).\n` +
    "Keep a copy somewhere safe, like a password manager. Never change it and never upload it:\n" +
    "the Worker needs this exact value to recognize accounts and their playlists.\n\n" +
    `PEPPER=${pepper}\n`, { mode: 0o600 });
  putSecret("PEPPER", pepper);
  say(`  PEPPER made and set. A copy is in ${BACKUP}: put it in a password manager.`);
}

let resendSkipped = false;
if (has.has("RESEND_API_KEY") && !NEW_RESEND_KEY) {
  say("  RESEND_API_KEY is set.");
} else {
  const key = (process.env.RESEND_API_KEY || await askHidden("  Paste your Resend API key (starts with re_; it won't show), or press Enter to skip: ")).trim();
  if (!key) {
    resendSkipped = true;
    say("  Skipped: sign-in stays off until the Worker has a Resend key. Run this again once you have one.");
  } else {
    if (!key.startsWith("re_")) say("  That doesn't start with re_, so check it's the right key. Setting it anyway.");
    putSecret("RESEND_API_KEY", key);
    say("  RESEND_API_KEY set.");
  }
}

// ---- 6. Live checks -----------------------------------------------------------------
step("Checking the live Worker");
async function call(path, init) {
  try {
    const res = await fetch(WORKER_URL + path, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    return { status: 0, body: null };
  }
}
const pause = ms => new Promise(r => setTimeout(r, ms));

// Looking up a code reaches the database (and makes the tables the first time)
let codes;
for (let i = 0; i < 5; i++) {
  codes = await call(`/codes?c=${encodeURIComponent("夜光")}`);
  if (codes.status === 200) break;
  await pause(3000);
}
if (codes.status === 200 && codes.body && "夜光" in codes.body) say("  ✓ Codes and playlists work: the database answers.");
else if (codes.status === 0) say(`  ? Couldn't reach ${WORKER_URL}. Open ${WORKER_URL}/codes?c=x in a browser to check it.`);
else say(`  ✗ The database didn't answer (${codes.status}${codes.body && codes.body.error ? ": " + codes.body.error : ""}).`);

// An address that isn't one gets "Enter a valid email address" only once the database, PEPPER
// and the Resend key are all in place, and no email goes out
let signIn;
for (let i = 0; i < 5; i++) {
  signIn = await call("/auth/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "not-an-address" }) });
  if (signIn.status === 400 || resendSkipped) break;
  await pause(3000);
}
if (signIn.status === 400) say("  ✓ Sign-in is ready on the Worker: database, PEPPER and Resend key are all there.");
else if (signIn.status === 0) say("  ? Couldn't reach the Worker to check sign-in.");
else say(`  ✗ Sign-in isn't ready yet${resendSkipped ? " (no Resend key)" : ""}.`);

say(`
What's left:
  • Resend: at resend.com/domains, spotiky.com has to show Verified. If it isn't there yet:
    Add domain → spotiky.com → Sign in to Cloudflare, which adds the DNS records for you.
  • GitHub: upload index.html, 404.html, preview-worker.js and ${CONFIG}.
  • Optional: Worker → Settings → Builds → Connect, and pick the spotiky repo. After that,
    uploading preview-worker.js to GitHub deploys the Worker by itself.
  • Then sign in on spotiky.com with your email. If the code doesn't arrive, run
    npx wrangler tail ${WORKER}   and try again: it shows why Resend said no.
  • The old CODES storage (KV) isn't used anymore. Delete it in the dashboard whenever you like.`);
