const express = require("express");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json());
app.use(express.static("public")); // serve frontend files

// ====== SIMPLE JSON STORAGE ======
// Small internal team tool - a JSON file is enough, no real database needed.
// Structure:
// {
//   users: { [username]: { pin, batchSize, cooldownSeconds } },
//   claims: { [username]: { [tweetId]: claimedAt } }   <- per-account history,
//     NOT a global lock. Different accounts replying to the same tweet is
//     normal (many people can reply to one viral tweet) - the only thing
//     to prevent is the SAME account replying to the same tweet twice.
// }
const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!data.claims) data.claims = {};
    return data;
  } catch (err) {
    return { users: {}, claims: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function normalizeUsername(raw) {
  return (raw || "").trim().toLowerCase().replace(/^@/, "");
}

// ====== AUTH (username + PIN, set on first use) ======
// Not real security - just enough to stop casual impersonation of a
// teammate's public X handle on a small internal tool.
app.post("/auth", (req, res) => {
  const username = normalizeUsername(req.body.username);
  const pin = (req.body.pin || "").trim();

  if (!username) return res.json({ ok: false, reason: "missing_username" });
  if (!/^\d{4,6}$/.test(pin)) return res.json({ ok: false, reason: "invalid_pin" });

  const data = loadData();
  const existing = data.users[username];

  if (!existing) {
    // First time this username has been used - claim it with this PIN
    data.users[username] = { pin, batchSize: 10, cooldownSeconds: 30 };
    saveData(data);
    return res.json({ ok: true, created: true, settings: data.users[username] });
  }

  if (existing.pin !== pin) {
    return res.json({ ok: false, reason: "wrong_pin" });
  }

  res.json({ ok: true, created: false, settings: existing });
});

// ====== PERSONAL SETTINGS ======
app.post("/settings", (req, res) => {
  const username = normalizeUsername(req.body.username);
  const pin = (req.body.pin || "").trim();
  const { batchSize, cooldownSeconds } = req.body;

  const data = loadData();
  const user = data.users[username];

  if (!user || user.pin !== pin) {
    return res.json({ ok: false, reason: "auth_failed" });
  }

  if (Number.isFinite(batchSize) && batchSize > 0) user.batchSize = batchSize;
  if (Number.isFinite(cooldownSeconds) && cooldownSeconds >= 0) user.cooldownSeconds = cooldownSeconds;

  saveData(data);
  res.json({ ok: true, settings: user });
});

// ====== PER-ACCOUNT CLAIM TRACKING ======
// Checks whether THIS logged-in account has already replied to each tweet ID.
// Other accounts' claims are irrelevant here on purpose - different people
// replying to the same tweet is normal and expected.
app.post("/check-claims", (req, res) => {
  const username = normalizeUsername(req.body.username);
  const pin = (req.body.pin || "").trim();
  const tweetIds = Array.isArray(req.body.tweetIds) ? req.body.tweetIds : [];

  const data = loadData();
  const user = data.users[username];

  if (!user || user.pin !== pin) {
    return res.json({ ok: false, reason: "auth_failed" });
  }

  const myClaims = data.claims[username] || {};
  const claims = {};
  tweetIds.forEach((id) => {
    if (myClaims[id]) claims[id] = { claimedAt: myClaims[id] };
  });

  res.json({ ok: true, claims });
});

app.post("/claim", (req, res) => {
  const username = normalizeUsername(req.body.username);
  const pin = (req.body.pin || "").trim();
  const { tweetId } = req.body;

  if (!tweetId) return res.json({ ok: false, reason: "missing_tweet_id" });

  const data = loadData();
  const user = data.users[username];

  if (!user || user.pin !== pin) {
    return res.json({ ok: false, reason: "auth_failed" });
  }

  if (!data.claims[username]) data.claims[username] = {};
  data.claims[username][tweetId] = Date.now();
  saveData(data);
  res.json({ ok: true });
});

// Link extraction function
const extractLinks = (text) => {
  const urlRegex = /(https?:\/\/)?(x\.com\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  return matches ? [...new Set(matches)] : [];
};

// POST endpoint to extract links
app.post("/extract", (req, res) => {
  const text = req.body.text || "";
  const links = extractLinks(text);
  res.json({ links });
});

// ====== oEmbed PROXY ======
// Frontend can't call publish.twitter.com directly without CORS issues,
// so we fetch it server-side and pass back the clean data.
app.get("/oembed", async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: "Missing url param" });
  }

  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(
      url
    )}&omit_script=1`;

    const response = await fetch(oembedUrl);

    if (!response.ok) {
      // Tweet might be deleted, protected, or invalid - not a server error
      return res.status(200).json({ ok: false, reason: `status ${response.status}` });
    }

    const data = await response.json();

    // The oEmbed html looks like:
    //   <blockquote><p>actual tweet text</p>&mdash; Display Name (@handle) <a>date</a></blockquote>
    // Stripping all tags on the whole blockquote merges the person's display
    // name into the "tweet text" (e.g. "Crypto Guru"), which then gets
    // mistaken for the tweet's actual topic. Only pull text from inside the
    // <p> tag - that's the real tweet body - and ignore everything after it.
    const rawHtml = data.html || "";
    const paragraphMatch = rawHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const bodyHtml = paragraphMatch ? paragraphMatch[1] : rawHtml;

    const text = bodyHtml
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&mdash;/g, "-")
      .replace(/&ndash;/g, "-")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))) // catches &#8230; (…), &#8217; (') etc.
      .replace(/\s+/g, " ")
      .trim();

    res.json({
      ok: true,
      author_name: data.author_name || "",
      text,
    });
  } catch (err) {
    console.error("oEmbed fetch failed:", err.message);
    res.status(200).json({ ok: false, reason: "fetch_failed" });
  }
});

// ====== AI REFINEMENT (fallback for ambiguous/playful tweets) ======
// Only called when rule-based matching has low confidence or the tweet
// shows format signals (polls, all-caps hype, etc.) that keyword matching
// can't judge well. Requires ANTHROPIC_API_KEY to be set.
app.post("/refine", async (req, res) => {
  const { tweetText, category, comment } = req.body || {};

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.json({ ok: false, reason: "no_api_key" });
  }
  if (!tweetText) {
    return res.json({ ok: false, reason: "no_tweet_text" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        system:
          "You write a single short reply for an X (Twitter) reply, matching the tone of the tweet it responds to. Rules: one sentence only, no hashtags, at most one emoji and only if it's a facial expression, natural casual human tone, never sound like marketing copy or AI. Match the tweet's actual tone - playful/joke tweets get a playful reply, serious or technical tweets get a genuine reply. Return ONLY the reply text, nothing else - no quotes, no preamble.",
        messages: [
          {
            role: "user",
            content: `Tweet: "${tweetText}"\n\nRule-based category guess: ${category}\nCandidate reply: "${comment}"\n\nIf the candidate reply genuinely fits this tweet's tone and content, return it unchanged. If it doesn't fit, write a better one-line reply instead.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      return res.json({ ok: false, reason: `status ${response.status}` });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((c) => c.type === "text");

    if (!textBlock) {
      return res.json({ ok: false, reason: "no_text_block" });
    }

    res.json({ ok: true, comment: textBlock.text.trim() });
  } catch (err) {
    console.error("Refine failed:", err.message);
    res.json({ ok: false, reason: "fetch_failed" });
  }
});

// Optional homepage route
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));