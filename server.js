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

    const prompt = `Identify every Pokémon TCG card visible in this image. The image may be anything: a screenshot from a collection app, a photo of physical cards, a binder page, a single card, or a card listing from any website or app.

For each card return these four fields:

name: The card's name as it appears on the card itself — words like "Psyduck", "Team Rocket's Giovanni", "N's Zoroark ex", "Eevee", "Mega Venusaur ex". Short and clean. No extra descriptions, no brackets, no product info.

set: The expansion or set the card is from. Look for it wherever it appears — printed on the card, shown in the app UI, listed below the card name, or visible anywhere in the image. Valid examples: "Destined Rivals", "Journey Together", "SV: 151", "Paradox Rift", "Twilight Masquerade", "Obsidian Flames", "Surging Sparks", "Shrouded Fable", "Mega Evolution", "Perfect Order". If you cannot find the set name anywhere in the image return empty string — never guess.

rarity: The rarity if shown anywhere in the image. One of: Illustration Rare, Special Illustration Rare, Art Rare, Ultra Rare, Double Rare, Hyper Rare, Super Rare, ACE SPEC Rare, Promo, Rare, Common. Empty string if not visible.

price: Any price shown for the card as a number string like "44.56". Empty string if no price is shown.

Return ONLY a valid JSON array with no markdown, no explanation:
[{"name":"","set":"","rarity":"","price":""}]`;

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
