// Posts a song's clip to a Discord webhook as a real audio attachment, so the message gets
// Discord's own player. The webhook URL stays in this browser and never reaches Spotiky.

const SITE = "https://spotiky.com";
const WEBHOOK_KEY = "spotiky-discord-webhook";
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[\w-]{50,}\/?$/;

const webhookGet = () => { try { return localStorage.getItem(WEBHOOK_KEY) || ""; } catch (e) { return ""; } };
const webhookSet = url => { try { url ? localStorage.setItem(WEBHOOK_KEY, url) : localStorage.removeItem(WEBHOOK_KEY); } catch (e) {} };

function discordRow() {
  const row = document.createElement("div");
  row.className = "discord-row";
  const post = document.createElement("button");
  post.className = "secondary";
  post.type = "button";
  post.textContent = "🔊 Send to Discord";
  post.addEventListener("click", () => sendToDiscord());
  const set = document.createElement("button");
  set.className = "copy-discord";
  set.type = "button";
  set.textContent = webhookGet() ? "Change webhook" : "Add a webhook";
  set.addEventListener("click", () => askWebhook());
  row.append(post, set);
  return row;
}

function askWebhook(then) {
  const url = prompt("Paste a Discord webhook URL.\n\nServer settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.", webhookGet());
  if (url == null) return;
  const clean = url.trim();
  if (!WEBHOOK_RE.test(clean)) return alert("That doesn't look like a webhook URL. It starts with https://discord.com/api/webhooks/");
  webhookSet(clean);
  if (share) renderShare();
  if (then) then();
}

const clipWords = (s, e) => (e > s ? `Clip ${formatTime(s)}–${formatTime(e)}` : s ? `From ${formatTime(s)}` : "Whole song");

async function sendToDiscord() {
  if (!webhookGet()) return askWebhook(sendToDiscord);
  if (!share || !share.target || share.target.type !== "track") return setStatus("Send a single song to Discord, not a playlist yet");
  if (share.busy) return;

  const id = share.target.id;
  const [a, b] = (share.suffix || "").split("-");
  let start = a ? parseTime(a) : 0;
  let end = b ? parseTime(b) : 0;
  const script = SCRIPTS.find(s => share[s]);
  const code = script ? linkCode(script) : null;
  const page = code ? `${SITE_BASE}/${code}${share.suffix}` : `${SITE_BASE}/track/${id}`;

  share.busy = true;
  setStatus("Cutting the clip…");

  const meta = await fetch(`${SITE}/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`)
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  const label = clipWords(start, end);
  const name = ((meta && meta.title) || "Spotiky")
    .replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 70) || "Spotiky";
  const file = `${meta && meta.author_name ? meta.author_name.slice(0, 40) + " - " : ""}${name}`;

  const grab = async (from, to) => {
    const q = new URLSearchParams();
    if (from) q.set("s", from);
    if (to) q.set("e", to);
    q.set("n", file);
    return fetch(`${SITE}/audio/${id}.mp3?${q}`);
  };

  let res = await grab(start, end);
  let blob = res.ok ? await res.blob() : null;
  if (blob && blob.size > 9.5e6) {           // over Discord's limit: keep the first 3 minutes
    end = start + 180;
    res = await grab(start, end);
    blob = res.ok ? await res.blob() : null;
  }
  const source = res.headers.get("X-Spotiky-Source") || "";

  const embed = {
    author: meta && meta.author_name ? { name: meta.author_name, url: meta.author_url } : undefined,
    title: (meta && meta.title) || "A song on Spotiky",
    url: page,
    description: `${clipWords(start, end)}\n[Open on Spotiky](${page})`,
    color: 0x1db954,
    image: meta && meta.thumbnail_url ? { url: meta.thumbnail_url } : undefined,
    footer: { text: blob ? `Spotiky · ${clipWords(start, end).toLowerCase()}` : "Spotiky · no audio for this song" },
  };
  const payload = { username: "Spotiky", embeds: [embed] };
  const fd = new FormData();
  if (blob) {
    payload.attachments = [{ id: 0, filename: `${file}.mp3`, description: clipWords(start, end) }];
    fd.append("files[0]", blob, `${file}.mp3`);
  }
  fd.append("payload_json", JSON.stringify(payload));

  const hook = webhookGet();
  const url = `${hook}${hook.includes("?") ? "&" : "?"}wait=true`;
  let out = await fetch(url, { method: "POST", body: fd });
  if (out.status === 429) {
    const wait = (await out.json().catch(() => ({}))).retry_after || 2;
    await new Promise(r => setTimeout(r, wait * 1000));
    out = await fetch(url, { method: "POST", body: fd });
  }
  share.busy = false;

  if (out.ok) return setStatus(blob ? `Sent ${clipWords(start, end).toLowerCase()} to Discord` : "Sent to Discord, without audio: no clip for this song");
  if (out.status === 401 || out.status === 404) {
    webhookSet("");
    if (share) renderShare();
    return setStatus("That webhook is gone. Add a new one.");
  }
  setStatus(out.status === 413 ? "Discord says that file is too big." : `Discord didn't take it (${out.status}). Try again in a moment.`);
}
