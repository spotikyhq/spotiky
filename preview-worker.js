// Spotiky preview Worker. Runs on Cloudflare Workers, not GitHub Pages.
// Live at https://spotiky-preview.spotikyhq.workers.dev/?id=TRACK_ID
// and returns { preview_url, name, source }.
//
// Spotify's Web API now returns preview_url: null, so this loads the public
// embed page (open.spotify.com/embed/track/ID) and pulls the preview MP3 link
// out of its HTML. It needs no secrets or bindings.

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
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
