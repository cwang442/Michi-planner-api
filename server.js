const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN === "*" ? "*" : (origin || "*"),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = corsHeaders(origin);

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ status: "ok", message: "Michi Planner API" }));
    return;
  }

  // Main scan endpoint
  if (req.method === "POST" && req.url === "/scan") {
    if (!ANTHROPIC_KEY) {
      res.writeHead(500, headers);
      res.end(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }));
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch(e) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const { images } = body; // array of { base64, mediaType }
    if (!images || !images.length) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: "No images provided" }));
      return;
    }

    // Build image blocks (max 5)
    const imageBlocks = images.slice(0, 5).map(img => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.base64 }
    }));

    const prompt = `You are identifying Pokémon TCG cards from an image. Extract every card you can see.

For each card return:
- name: the card name exactly as printed or displayed
- set: the set or expansion name — look for it below the card name in app screenshots, or on the bottom of physical cards. ALWAYS include this if visible anywhere in the image.
- rarity: the rarity type (Illustration Rare, Special Illustration Rare, Art Rare, Ultra Rare, Double Rare, Hyper Rare, Super Rare, ACE SPEC Rare, Promo, Rare, Common) — use empty string if not visible
- price: price as a number string (e.g. "12.34") if shown, otherwise empty string

Return ONLY a valid JSON array, no markdown:
[{"name":"...","set":"...","rarity":"...","price":"..."}]

Read every card visible. For each one, carefully look for and include the set name — it is always somewhere in the image for app screenshots, and on the card itself for physical card photos.`;

    const payload = {
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: [...imageBlocks, { type: "text", text: prompt }]
      }]
    };

    try {
      const result = await callAnthropic(payload);
      const data = JSON.parse(result.body);

      if (data.error) {
        res.writeHead(result.status, headers);
        res.end(JSON.stringify({ error: data.error.message }));
        return;
      }

      const text = data.content?.find(b => b.type === "text")?.text || "";
      const match = text.replace(/```[a-z]*\n?/g, "").match(/\[[\s\S]*\]/);

      if (!match) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ cards: [], raw: text.slice(0, 200) }));
        return;
      }

      const cards = JSON.parse(match[0]);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ cards }));

    } catch(e) {
      res.writeHead(500, headers);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`Michi Planner API running on port ${PORT}`);
});
