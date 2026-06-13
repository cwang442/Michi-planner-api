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

    const prompt = `You are reading text from an image containing Pokémon TCG cards. Read only what is literally visible in the image — do NOT use your knowledge of Pokémon cards to guess or fill in any fields.

For each card visible, extract:
- name: the card name as printed
- set: the set name as printed in the image. In app screenshots it appears on the line directly below the card name, before the rarity line. On physical cards and binder photos it appears at the bottom edge of the card. If the set name is not clearly readable in the image, use empty string. NEVER guess or infer the set from your knowledge of the card.
- rarity: only if clearly printed (Illustration Rare, Special Illustration Rare, Art Rare, Ultra Rare, Double Rare, Hyper Rare, Super Rare, ACE SPEC Rare, Promo, Rare, Common) — empty string if not visible
- price: number string if shown (e.g. "256.92"), empty string if not shown

CRITICAL: The set field must contain ONLY text visible in the image. Never use "XY", "Team Rocket Returns", "Roaring Skies", "Gym Heroes", "Base Set", "Jungle", or any set name you infer from knowing the card — only what is printed in this specific image.
Condition words like "Near Mint", "Lightly Played", "Holofoil" are never set names.

Return ONLY a valid JSON array, no markdown:
[{"name":"...","set":"...","rarity":"...","price":"..."}]`;

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
