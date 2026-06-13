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

    const prompt = `You are identifying Pokémon TCG cards from an image. The image could be any of these:

1. A COLLECTR APP SCREENSHOT — shows a grid of cards with text below each one showing name, set, rarity, and CAD price. Read the text labels below each card image, not the card art itself. Extract every card visible.

2. A PHOTO OF A PHYSICAL CARD or cards — read the card name printed on the card, identify the set and rarity from the card design if visible.

3. A BINDER PAGE PHOTO — extract each card you can identify from the card art and any visible text.

4. A SINGLE CARD IMAGE — identify the one card shown.

For each card you can identify, extract:
- name: the card name (e.g. "Cleffa", "Team Rocket's Giovanni", "N's Zoroark ex")
- set: the set name if visible (e.g. "Destined Rivals", "SV: 151", "Perfect Order")
- rarity: the rarity if visible (Illustration Rare, Special Illustration Rare, Art Rare, Ultra Rare, Double Rare, Hyper Rare, Super Rare, ACE SPEC Rare, Promo, Rare, Common)
- price: CAD price as a number string if shown (e.g. "12.34"), otherwise empty string

Return ONLY a valid JSON array, no markdown, no explanation:
[{"name":"","set":"","rarity":"","price":""}]

Use empty string for any field not clearly visible. Return at least one entry even if you can only partially identify a card.`;

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
