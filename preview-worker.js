// Spotiky Worker. Runs on Cloudflare Workers, not GitHub Pages.
// Live at https://spotiky-preview.spotikyhq.workers.dev
//
//   /?id=TRACK_ID        a track's preview MP3 and song name: { preview_url, name, source }
//   /codes?c=夜光,𓇰𓇶     the song each Spotiky code stands for: { "夜光": {type, id}, "𓇰𓇶": null }
//
// Previews: Spotify's Web API now returns preview_url: null, so this loads the
// public embed page (open.spotify.com/embed/track/ID) and pulls the preview MP3
// link out of its HTML. It needs no secrets.
//
// Codes live in a Workers KV namespace bound to this Worker as CODES. Each key is
// a code (Chinese characters or hieroglyphs) and each value is JSON like
//   {"type":"track","id":"7gaA3wERFkFkgivjwbSvkG"}
// The Worker only reads codes for now. Creating them comes with the Share button.

const CODE_RE = /^[\p{Script=Han}\p{Script=Egyptian_Hieroglyphs}]{1,6}$/u;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/codes") return codes(url, env);
    return preview(url);
  },
};

async function codes(url, env) {
  if (!env.CODES) {
    return json({ error: "Codes aren't set up on this Worker yet" }, 503);
  }
  const list = [...new Set((url.searchParams.get("c") || "").split(",").map(c => c.trim()).filter(Boolean))];
  if (!list.length || list.length > 50) {
    return json({ error: "Pass 1 to 50 codes, separated by commas, as ?c=" }, 400);
  }
  const out = {};
  await Promise.all(list.map(async code => {
    out[code] = null;
    if (!CODE_RE.test(code)) return;
    try {
      out[code] = await env.CODES.get(code, "json");
    } catch (err) {
      out[code] = null;   // a value that isn't valid JSON counts as no song
    }
  }));
  return json(out, 200, { "Cache-Control": "public, max-age=60" });
}

async function preview(url) {
  const trackId = url.searchParams.get("id");

  if (!trackId || !/^[a-zA-Z0-9]{22}$/.test(trackId)) {
    return json({ error: "Missing or invalid track id" }, 400);
  }

  try {
    const embedRes = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!embedRes.ok) {
      return json({ error: "Could not load embed page" }, 502);
    }

    const html = await embedRes.text();
    let previewUrl = null;

    const match1 = html.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[a-zA-Z0-9]+/);
    if (match1) previewUrl = match1[0];

    if (!previewUrl) {
      const nextDataMatch = html.match(/"audioPreview":\s*{\s*"url":\s*"([^"]+)"/);
      if (nextDataMatch) previewUrl = nextDataMatch[1];
    }

    let name = null;
    const nameMatch = html.match(/<title>([^<]+)<\/title>/);
    if (nameMatch) {
      name = nameMatch[1].replace(" | Spotify", "").trim();
    }

    return json({
      preview_url: previewUrl,
      name: name,
      source: previewUrl ? "embed" : null,
    });
  } catch (err) {
    return json({ error: "Server error", details: err.message }, 500);
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}
