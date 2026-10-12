// server.js
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const pgSession = require("connect-pg-simple")(session);
const { pool } = require("./db");

const app = express();
app.use(express.json({ limit: "2mb" }));

const isProduction = process.env.NODE_ENV === "production";

if (
  !process.env.SESSION_SECRET ||
  !process.env.GOOGLE_CLIENT_ID ||
  !process.env.GOOGLE_CLIENT_SECRET
) {
  throw new Error(
    "Missing SESSION_SECRET, GOOGLE_CLIENT_ID, or GOOGLE_CLIENT_SECRET."
  );
}

app.set("trust proxy", 1);

app.use(
  session({
    store: new pgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    name: "yapassist.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname, "public")));


function requireAuth(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user?.id) {
    return res.status(401).json({
      ok: false,
      reason: "not_signed_in",
      message: "Please sign in with Google."
    });
  }

  next();
}

/* ============================================================
   GOOGLE OAUTH
   ============================================================ */

const googleCallbackURL =
  process.env.GOOGLE_CALLBACK_URL ||
  "http://localhost:3000/auth/google/callback";

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query(
      `SELECT id, email, display_name, google_sub, legacy_username
       FROM app_users
       WHERE id = $1`,
      [id]
    );

    done(null, result.rows[0] || false);
  } catch (error) {
    done(error);
  }
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: googleCallbackURL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const googleSub = profile.id;
        const email = profile.emails?.[0]?.value?.toLowerCase() || null;
        const displayName = profile.displayName || null;

        // Existing Google identity: update its profile information.
        const existing = await pool.query(
          `SELECT id, email, display_name, google_sub, legacy_username
           FROM app_users
           WHERE google_sub = $1`,
          [googleSub]
        );

        if (existing.rows.length) {
          const updated = await pool.query(
            `UPDATE app_users
             SET email = COALESCE($1, email),
                 display_name = COALESCE($2, display_name),
                 updated_at = NOW()
             WHERE google_sub = $3
             RETURNING id, email, display_name, google_sub, legacy_username`,
            [email, displayName, googleSub]
          );

          return done(null, updated.rows[0]);
        }

        // Do not silently merge an existing account by email.
        // Legacy account linking will be handled separately.
        const created = await pool.query(
          `INSERT INTO app_users (email, display_name, google_sub)
           VALUES ($1, $2, $3)
           RETURNING id, email, display_name, google_sub, legacy_username`,
          [email, displayName, googleSub]
        );

        return done(null, created.rows[0]);
      } catch (error) {
        console.error("Google sign-in database error:", error.code || error.message);
        return done(error);
      }
    }
  )
);

/* Start Google sign-in */
app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: true,
  })
);

/* Google returns the user here */
app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/?login=failed",
    session: true,
  }),
  (req, res) => {
    res.redirect("/");
  }
);

/* Current signed-in user */
app.get("/api/me", (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ ok: false, reason: "not_signed_in" });
  }

  return res.json({
    ok: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      displayName: req.user.display_name,
      legacyUsername: req.user.legacy_username,
    },
  });
});

/* Sign out */
app.post("/auth/logout", (req, res, next) => {
  req.logout((logoutError) => {
    if (logoutError) return next(logoutError);

    req.session.destroy((sessionError) => {
      if (sessionError) return next(sessionError);

      res.clearCookie("yapassist.sid", {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
      });

      return res.json({ ok: true });
    });
  });
});


const PORT = process.env.PORT || 3000;

// ============================================================
// PHASE 1 CONFIGURATION
// ============================================================

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const GEMINI_BATCH_SIZE = 20;          // Change batch size here
const GEMINI_CONCURRENCY = 2;          // Concurrent Gemini requests per server
const OEMBED_CONCURRENCY = 4;          // Concurrent tweet reads
const MAX_ATTEMPTS = 3;                // Attempts for transient failures
const MAX_TWEETS_PER_JOB = 500;        // Safety cap, not the batch size
const MAX_TWEET_TEXT_LENGTH = 12000;
const JOB_TTL_MS = 60 * 60 * 1000;     // Retain completed jobs for 1 hour

// In-memory jobs are suitable only for Phase 1 / a single Render instance.
// Phase 2 should move job state to Redis or PostgreSQL.
const jobs = new Map();

// ============================================================
// EXISTING JSON STORAGE
// ============================================================

const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!data.users) data.users = {};
    if (!data.claims) data.claims = {};
    return data;
  } catch {
    return { users: {}, claims: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function normalizeUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

function authenticate(usernameInput, pinInput) {
  const username = normalizeUsername(usernameInput);
  const pin = String(pinInput || "").trim();
  const data = loadData();
  const user = data.users[username];

  // This intentionally preserves the existing Phase 1 auth design.
  // Replace with hashed credentials and sessions in Phase 2.
  return username && user && user.pin === pin
    ? { username, user }
    : null;
}

// ============================================================
// EXISTING LOGIN / SETTINGS / CLAIM ROUTES
// ============================================================

app.post("/auth", (req, res) => {
  const username = normalizeUsername(req.body.username);
  const pin = String(req.body.pin || "").trim();

  if (!username) {
    return res.status(400).json({ ok: false, reason: "missing_username" });
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ ok: false, reason: "invalid_pin" });
  }

  const data = loadData();
  const existing = data.users[username];

  if (!existing) {
    data.users[username] = {
      pin,
      batchSize: 10,
      cooldownSeconds: 30,
    };
    saveData(data);
    return res.json({
      ok: true,
      created: true,
      settings: data.users[username],
    });
  }

  if (existing.pin !== pin) {
    return res.status(401).json({ ok: false, reason: "wrong_pin" });
  }

  return res.json({
    ok: true,
    created: false,
    settings: {
      batchSize: existing.batchSize,
      cooldownSeconds: existing.cooldownSeconds,
    },
  });
});


app.post("/settings", requireAuth, async (req, res) => {
  const { batchSize, cooldownSeconds } = req.body;

  const result = await pool.query(
    `UPDATE app_users
     SET
       batch_size = CASE
         WHEN $1::numeric BETWEEN 1 AND 100
         THEN $1::integer
         ELSE batch_size
       END,
       cooldown_seconds = CASE
         WHEN $2::numeric BETWEEN 0 AND 3600
         THEN $2::integer
         ELSE cooldown_seconds
       END,
       updated_at = NOW()
     WHERE id = $3
     RETURNING batch_size, cooldown_seconds`,
    [batchSize, cooldownSeconds, req.user.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({
      ok: false,
      reason: "user_not_found"
    });
  }

  return res.json({
    ok: true,
    settings: {
      batchSize: result.rows[0].batch_size,
      cooldownSeconds: result.rows[0].cooldown_seconds
    }
  });
});


app.post("/check-claims", requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body.tweetIds)
    ? [...new Set(
        req.body.tweetIds
          .map((id) => String(id))
          .filter((id) => /^\d{3,30}$/.test(id))
      )].slice(0, 500)
    : [];

  if (!ids.length) {
    return res.json({ ok: true, claims: {} });
  }

  try {
    const result = await pool.query(
      `SELECT tweet_id, claimed_at
       FROM claims
       WHERE user_id = $1
         AND tweet_id = ANY($2::text[])`,
      [req.user.id, ids]
    );

    const claims = {};

    for (const row of result.rows) {
      claims[row.tweet_id] = {
        claimedAt: new Date(row.claimed_at).getTime()
      };
    }

    return res.json({ ok: true, claims });
  } catch (error) {
    console.error("Checking claims failed:", error.message);

    return res.status(500).json({
      ok: false,
      reason: "claims_check_failed"
    });
  }
});

app.post("/claim", requireAuth, async (req, res) => {
  const tweetId = String(req.body.tweetId || "");

  if (!/^\d{3,30}$/.test(tweetId)) {
    return res.status(400).json({
      ok: false,
      reason: "invalid_tweet_id"
    });
  }

  try {
    await pool.query(
      `INSERT INTO claims (user_id, tweet_id, claimed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, tweet_id)
       WHERE user_id IS NOT NULL
       DO NOTHING`,
      [req.user.id, tweetId]
    );

    return res.json({ ok: true });
  } catch (error) {
    console.error("Recording claim failed:", error.message);

    return res.status(500).json({
      ok: false,
      reason: "claim_save_failed"
    });
  }
});

app.post("/extract", (req, res) => {
  const text = String(req.body.text || "");
  const matches = text.match(
    /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s)]+/gi
  ) || [];

  const links = [...new Set(
    matches
      .map((url) => url.replace(/[.,)\]}]+$/g, ""))
      .filter((url) => extractTweetId(url))
  )];

  return res.json({ links });
});

// ============================================================
// URL VALIDATION
// ============================================================

function extractTweetId(url) {
  const match = String(url || "").match(/\/status\/(\d+)/i);
  return match ? match[1] : null;
}

function validateXUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    const host = parsed.hostname.toLowerCase();

    if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host)) {
      return null;
    }

    const tweetId = extractTweetId(parsed.pathname);
    if (!tweetId) return null;

    return {
      url: `https://x.com/${tweetId}`, // replaced below with canonical URL
      originalUrl: parsed.toString(),
      tweetId,
    };
  } catch {
    return null;
  }
}

// ============================================================
// OEMBED READER — NO TWITTERAPI.IO
// ============================================================

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

function extractTextFromOembedHtml(html) {
  const paragraphs = [...String(html || "").matchAll(
    /<p\b[^>]*>([\s\S]*?)<\/p>/gi
  )];

  if (!paragraphs.length) return "";

  // The first paragraph usually contains the post text.
  return decodeHtml(
    paragraphs[0][1]
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?[^>]+>/g, "")
  )
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchOembedTweet(rawUrl) {
  const validated = validateXUrl(rawUrl);
  if (!validated) {
    throw new Error("Invalid X post URL.");
  }

  const endpoint =
    `https://publish.twitter.com/oembed?omit_script=true&url=${
      encodeURIComponent(validated.originalUrl)
    }`;

  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const requestStartedAt = Date.now();
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      console.log(
  `[YAPASSIST DEBUG] oEmbed HTTP ${response.status} in ${
    ((Date.now() - requestStartedAt) / 1000).toFixed(2)
  }s`
);

      if (!response.ok) {
        const error = new Error(`oEmbed returned HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfter = response.headers.get("retry-after");

        if (
          response.status === 429 ||
          response.status >= 500
        ) {
          throw error;
        }

        throw Object.assign(error, { permanent: true });
      }

      const data = await response.json();
      const text = extractTextFromOembedHtml(data.html);

      if (!text) {
        throw Object.assign(
          new Error("oEmbed returned no readable post text."),
          { permanent: true }
        );
      }

      return {
        id: validated.tweetId,
        url: validated.originalUrl,
        tweetText: text.slice(0, MAX_TWEET_TEXT_LENGTH),
        author: data.author_name || "",
      };
    } catch (error) {
      lastError = error;
      if (error.permanent) break;

      if (attempt < MAX_ATTEMPTS - 1) {
        await backoff(attempt, error.retryAfter);
      }
    }
  }

  throw lastError || new Error("Could not read this X post.");
}

app.get("/oembed", async (req, res) => {
  try {
    const tweet = await fetchOembedTweet(req.query.url);
    return res.json({
      ok: true,
      text: tweet.tweetText,
      tweetId: tweet.id,
      author_name: tweet.author,
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      reason: "oembed_failed",
      message: error.message,
    });
  }
});

// ============================================================
// CONCURRENCY + RETRIES
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt, retryAfterHeader) {
  let delay = Math.min(1000 * (2 ** attempt), 15000);
  const retryAfterSeconds = Number(retryAfterHeader);

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    delay = Math.min(retryAfterSeconds * 1000, 30000);
  }

  // Jitter avoids many concurrent retries firing simultaneously.
  delay += Math.floor(Math.random() * 300);
  return sleep(delay);
}

function createSemaphore(limit) {
  let active = 0;
  const waiting = [];

  return {
    async acquire() {
      if (active < limit) {
        active++;
        return;
      }
      await new Promise((resolve) => waiting.push(resolve));
      active++;
    },
    release() {
      active--;
      const next = waiting.shift();
      if (next) next();
    },
  };
}

const geminiSemaphore = createSemaphore(GEMINI_CONCURRENCY);

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function runWorker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { ok: false, error: error.message };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => runWorker()
    )
  );

  return results;
}

// ============================================================
// GEMINI STRUCTURED OUTPUT
// ============================================================

const replySchema = {
  type: "OBJECT",
  properties: {
    results: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          comment: { type: "STRING" },
        },
        required: ["id", "comment"],
      },
    },
  },
  required: ["results"],
};

async function callGemini(items, variationSeed) {
  await geminiSemaphore.acquire();

  try {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${
        encodeURIComponent(GEMINI_MODEL)
      }:generateContent`;

    const input = items.map((item) => ({
      id: item.id,
      tweetText: item.tweetText,
      variationHint: item.variationHint,
    }));

    const geminiStartedAt = Date.now();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: `
Y## CONVERSATIONAL JUDGMENT: RESPOND LIKE A REAL PERSON

Your job is not to have a clever comment for every post. Your job is to participate naturally in the conversation.

Before writing a reply, decide what a real person would most likely do in that situation. They might ask for clarification, admit they don't know something, laugh at a joke, return a greeting, share an opinion, disagree, express curiosity, or add a useful thought.

Do not force an observation, lesson, question, or opinion into every reply.

### 1. ASK QUESTIONS WHEN YOU DON'T KNOW

This is one of the most important rules.

Never pretend to know a project, acronym, product, person, feature, or concept simply to sound knowledgeable. If the post mentions something unfamiliar and the context doesn't explain it, show genuine curiosity and ask the author to explain.

Do not make up familiarity. Do not assume what an acronym means. Do not manufacture an opinion about something you don't understand.

Example:

Post:
"Have you heard about AVC on the platform?"

Good replies:
- "What's AVC? Can you tell me more about it? I'm interested."
- "I haven't come across it yet. What's it about?"
- "First time I'm seeing this. What does it do?"

Choose the version that best fits the conversation. Do not reuse the same question every time.

If the post already explains the concept clearly, don't ask the author to repeat information they have provided. Engage with what is actually there.

### 2. QUESTIONS ARE A VALID RESPONSE, NOT A LAST RESORT

When a post introduces an unfamiliar idea, makes a claim without enough context, announces a feature without explaining how it works, or leaves an interesting detail unanswered, consider asking a genuine follow-up question.

Examples:

Post:
"We've been working on something new for the last six months."

Reply:
"Six months is a long time to keep something under wraps. What are you building?"

Post:
"Our new product is designed to make onchain trading easier."

Reply:
"What part of the trading experience are you trying to fix first?"

Post:
"We just added a new feature to the app."

Reply:
"What's the biggest difference users will notice?"

These are examples of judgment, not mandatory templates. Ask only when the question makes sense.

### 3. RETURN GREETINGS NATURALLY

When somebody says GM, GN, good morning, or another greeting, respond to the greeting when that is the natural thing to do.

Examples:

Post:
"GM guys ☀️"

Replies:
- "GM bro ☀️"
- "GM, how's your morning going?"
- "GM! What's everyone working on today?"

Post:
"GM guys, have you tried our new trading feature?"

Reply:
"GM bro. What's different about the new feature?"

You don't need to explain the importance of community or turn every greeting into a motivational statement. A simple greeting is often enough.

### 4. LET FUNNY POSTS BE FUNNY

When a post is genuinely funny, respond naturally. You can laugh, appreciate the joke, play along, or add a witty reaction.

Examples:

Post:
"I opened X for five minutes and somehow lost two hours."

Replies:
- "You're very funny 😂"
- "And somehow we keep doing it 😭"
- "Five minutes on X is never actually five minutes."

Post:
"My portfolio has decided to teach me humility."

Reply:
"Your portfolio said character development is mandatory 😂"

Use humor only when it fits. Don't turn serious, sensitive, or personal posts into jokes. Emojis are allowed when they feel natural, but never use 🚀.

### 5. HAVE YOUR OWN OPINION

You are not required to agree with the author. You can be positive, skeptical, bullish, bearish, critical, curious, or undecided.

If you agree, explain what you agree with when there's something useful to add.

If you disagree, say so naturally and explain why. Challenge the idea, not the person.

If you see a weakness in a product or argument, you can point it out respectfully. Don't praise everything simply because the post is about a project.

Examples:

Post:
"This new feature will completely change trading."

Reply:
"I'm curious to see it in action, but what does it solve that traders can't already do?"

Post:
"This project has no competition."

Reply:
"I'd be careful with that claim. What gives it an advantage over the alternatives?"

Post:
"We've finally launched the product we've been building."

Reply:
"Congrats on getting it out. Now I'm curious to see how people actually use it."

Do not manufacture criticism to appear independent, and do not manufacture enthusiasm to sound supportive. Let the content determine your position.

### 6. ENGAGE WITH PROJECT POSTS SPECIFICALLY

When someone discusses a project, respond to the actual product, feature, problem, announcement, or claim.

Depending on the post, you can:
- Ask what a feature does or how it works.
- Point out a useful implication.
- Raise a reasonable concern.
- Share a relevant perspective.
- Express genuine interest.
- Ask what comes next.
- Acknowledge progress without exaggerated praise.
- Explain why you think an idea is promising or unconvincing.

Do not automatically praise every announcement. Do not call every launch exciting, every update a game changer, or every product revolutionary.

If you don't understand what the project is doing, ask. Curiosity is better than pretending.

### 7. SOMETIMES A SHORT REACTION IS ENOUGH

Not every post needs analysis.

Examples:
- A funny post may deserve a laugh.
- A greeting may deserve a greeting.
- A surprising fact may deserve a quick question.
- A simple achievement may deserve a brief acknowledgment.
- A complicated technical claim may deserve a thoughtful response.
- An unclear announcement may deserve a request for more information.

Match the response to the moment. Do not make simple posts unnecessarily complicated.

### 8. NEVER ASSUME, NEVER FAKE IT

Do not claim you have heard of something unless the available context supports that claim.

Do not invent product knowledge, personal experience, familiarity with a team, or facts about an announcement.

When information is missing, ask for it. When a claim is unclear, seek clarification. When you have enough information to form an opinion, express it honestly and naturally.

### FINAL PRINCIPLE

The goal is not to produce a comment for every post that sounds impressive. The goal is to produce the response that makes the most sense for that conversation.

Sometimes that means sharing an insight. Sometimes it means asking, "What's that about?" Sometimes it means laughing. Sometimes it means saying GM back. Sometimes it means disagreeing.

Choose naturally. Never force a response style just to fill the space.
            `.trim(),
          }],
        },
        contents: [{
          role: "user",
          parts: [{
            text: JSON.stringify({
              task: "Write one relevant reply for every supplied post.",
              variationSeed,
              items: input,
            }),
          }],
        }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: Math.min(8192, 300 + items.length * 100),
          responseMimeType: "application/json",
          responseSchema: replySchema,
        },
      }),
      signal: AbortSignal.timeout(60000),
    });
    console.log(
  `[YAPASSIST TIMING] Gemini API request: ${
    ((Date.now() - geminiStartedAt) / 1000).toFixed(2)
  }s for ${items.length} posts`
);

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(
        data?.error?.message || `Gemini returned HTTP ${response.status}`
      );
      error.status = response.status;
      error.retryAfter = response.headers?.get?.("retry-after");
      throw error;
    }

    const raw = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();

    if (!raw) throw new Error("Gemini returned an empty response.");

    const parsed = JSON.parse(raw);

    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error("Gemini response did not match the expected schema.");
    }

    // Validate each record independently; never trust model output blindly.
    const allowedIds = new Set(items.map((item) => String(item.id)));
    const validated = new Map();

    for (const item of parsed.results) {
      if (
        !item ||
        typeof item.id !== "string" ||
        !allowedIds.has(item.id) ||
        typeof item.comment !== "string" ||
        !item.comment.trim()
      ) {
        continue;
      }

      // Ignore duplicate IDs and prevent one result overwriting another.
      if (!validated.has(item.id)) {
        validated.set(item.id, item.comment.trim().slice(0, 1000));
      }
    }

    return validated;
  } finally {
    geminiSemaphore.release();
  }
}

async function callGeminiWithTransientRetries(items, seed) {
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await callGemini(items, seed);
    } catch (error) {
      lastError = error;

      const retryable =
        error.status === 429 ||
        error.status >= 500 ||
        error.name === "TimeoutError" ||
        error.name === "AbortError" ||
        error instanceof SyntaxError;

      if (!retryable || attempt === MAX_ATTEMPTS - 1) break;

      await backoff(attempt, error.retryAfter);
    }
  }

  throw lastError || new Error("Gemini request failed.");
}

// ============================================================
// JOB HELPERS
// ============================================================

function touchJob(job) {
  job.updatedAt = Date.now();
}

function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    total: job.total,
    read: job.read,
    completed: job.completed,
    failed: job.failed,
    progress: job.total
      ? Math.round((job.completed / job.total) * 100)
      : 0,
    items: [...job.items.values()],
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function publicJobFromRows(jobRow, itemRows) {
  const items = itemRows.map((row) => ({
    id: row.tweet_id,
    url: row.tweet_url,
    status: row.status,
    tweetText: row.tweet_text,
    comment: row.reply_text,
    replyUrl: row.reply_url,
    error: row.error_message,
    attempts: row.attempts,
    readOk: Boolean(row.tweet_text),
  }));

  const total = Number(jobRow.total);
  const completed = Number(jobRow.completed_count);
  const failed = Number(jobRow.failed_count);

  return {
    jobId: jobRow.id,
    status: jobRow.status,
    stage: jobRow.stage,
    total,
    read: Number(jobRow.read_count),
    completed,
    failed,
    progress: total ? Math.round((completed / total) * 100) : 0,
    items,
    error: null,
    createdAt: new Date(jobRow.created_at).getTime(),
    updatedAt: new Date(jobRow.updated_at).getTime(),
  };
}

/*
 * Persist job counters and every item's latest state in one transaction.
 * The job and its items must already have been inserted.
 */

async function persistJob(job) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE jobs
       SET status = $1,
           stage = $2,
           total = $3,
           read_count = $4,
           completed_count = $5,
           failed_count = $6,
           worker_id = $7,
           lease_expires_at = CASE
             WHEN $1 = 'running'
             THEN NOW() + INTERVAL '2 minutes'
             ELSE NULL
           END,
           updated_at = NOW()
       WHERE id = $8
         AND user_id = $9`,
      [
        job.status,
        job.stage,
        job.total,
        job.read,
        job.completed,
        job.failed,
        job.workerId || null,
        job.id,
        job.userId,
      ]
    );

    if (updated.rowCount !== 1) {
      throw new Error("Job record was not found while saving progress.");
    }

    const items = [...job.items.values()].map((item) => ({
      tweet_id: String(item.id),
      status: item.status,
      tweet_text: item.tweetText || null,
      reply_text: item.comment || null,
      reply_url: item.replyUrl || null,
      attempts: item.attempts || 0,
      error_message: item.error || null,
    }));

    await client.query(
      `UPDATE job_items AS ji
       SET status = x.status,
           tweet_text = x.tweet_text,
           reply_text = x.reply_text,
           reply_url = x.reply_url,
           attempts = x.attempts,
           error_message = x.error_message,
           updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         tweet_id text,
         status text,
         tweet_text text,
         reply_text text,
         reply_url text,
         attempts integer,
         error_message text
       )
       WHERE ji.job_id = $2
         AND ji.tweet_id = x.tweet_id`,
      [JSON.stringify(items), job.id]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  touchJob(job);
}

async function processJob(job) {
  console.log(`[YAPASSIST DEBUG] Started processing job ${job.id}`);
  console.log(`[YAPASSIST DEBUG] Started processing job ${job.id}`);
  job.status = "running";
  job.stage = "reading";
  touchJob(job);
  await persistJob(job);
const readStageStartedAt = Date.now();
  // Stage 1: Read posts from X through oEmbed.
  await mapLimit(
    job.input,
    OEMBED_CONCURRENCY,
    async (entry) => {
      const state = job.items.get(entry.id);

      try {
        const tweet = await fetchOembedTweet(entry.url);

        state.tweetText = tweet.tweetText;
        state.author = tweet.author;
        state.readOk = true;
        state.status = "queued";
        state.error = null;
      } catch (error) {
        state.status = "failed";
        state.error = `Tweet read failed: ${error.message}`;
        job.failed++;
      } finally {
        job.read++;
        touchJob(job);

                // Progress is persisted after the reading stage completes.
      }
    }
  );


  const readable = job.input.filter((entry) => {
    const state = job.items.get(entry.id);
    return state && state.readOk && state.tweetText;
  });

    console.log(
    `[YAPASSIST TIMING] Job ${job.id} | ` +
    `X reading: ${((Date.now() - readStageStartedAt) / 1000).toFixed(2)}s | ` +
    `Readable: ${readable.length}/${job.total}`
  );

  job.stage = "generating";
  touchJob(job);
  await persistJob(job);

  const chunks = [];

  for (let i = 0; i < readable.length; i += GEMINI_BATCH_SIZE) {
    chunks.push(readable.slice(i, i + GEMINI_BATCH_SIZE));
  }
  const generationStageStartedAt = Date.now();
  await mapLimit(
    chunks,
    GEMINI_CONCURRENCY,
    async (chunk, chunkIndex) => {
      let pending = chunk.map((entry) => {
        const state = job.items.get(entry.id);
        state.status = "running";

        return {
          id: entry.id,
          url: entry.url,
          tweetText: state.tweetText,
          variationHint: [
            "Variation key:",
            crypto.randomBytes(4).toString("hex"),
            "Choose a natural response angle that fits this specific post.",
            "Avoid formulaic wording and avoid repeating common openings.",
          ].join(" "),
        };
      });

      await persistJob(job);

      for (
        let attempt = 0;
        attempt < MAX_ATTEMPTS && pending.length;
        attempt++
      ) {
        // Record attempts for the items being submitted.
        for (const item of pending) {
          const state = job.items.get(item.id);
          state.attempts = (state.attempts || 0) + 1;
        }

        try {
          const replies = await callGeminiWithTransientRetries(
            pending,
            `${job.id}:${chunkIndex}:${attempt}`
          );

          const missing = [];

          for (const item of pending) {
            const comment = replies.get(String(item.id));
            const state = job.items.get(item.id);

            if (comment) {
              state.comment = comment;
              state.status = "completed";
              state.replyUrl =
               `https://x.com/intent/tweet?in_reply_to=${
                encodeURIComponent(item.id)
                }&text=${encodeURIComponent(comment)}`;
              state.error = null;
              job.completed++;
            } else {
              missing.push(item);
            }
          }

          pending = missing;
        } catch (error) {
          if (attempt === MAX_ATTEMPTS - 1) {
            for (const item of pending) {
              const state = job.items.get(item.id);

              state.status = "failed";
              state.error = `Gemini failed: ${error.message}`;
              job.failed++;
            }

            pending = [];
          }
        }

        touchJob(job);
        await persistJob(job);

        if (pending.length && attempt < MAX_ATTEMPTS - 1) {
          await backoff(attempt);
        }
      }

      for (const item of pending) {
        const state = job.items.get(item.id);

        if (state.status !== "failed") {
          state.status = "failed";
          state.error = "Gemini did not return a valid reply after retries.";
          job.failed++;
        }
      }

      touchJob(job);
      await persistJob(job);
    }
  );
  console.log(
    `[YAPASSIST TIMING] Job ${job.id} | ` +
    `Gemini generation stage: ${((Date.now() - generationStageStartedAt) / 1000).toFixed(2)}s`
  );
  job.status = "completed";
  job.stage = "done";
  job.workerId = null;
  touchJob(job);
  await persistJob(job);
}

/* ============================================================
   CREATE JOB + POLL JOB
   ============================================================ */

app.post("/jobs", requireAuth, async (req, res) => {
  console.log("[YAPASSIST DEBUG] POST /jobs reached");
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      ok: false,
      reason: "missing_gemini_api_key",
    });
  }

  if (!Array.isArray(req.body.links) || req.body.links.length === 0) {
    return res.status(400).json({
      ok: false,
      reason: "no_links",
    });
  }

  const validated = [];
  const seen = new Set();

  for (const raw of req.body.links) {
    const item = validateXUrl(raw);

    if (!item || seen.has(item.tweetId)) continue;

    seen.add(item.tweetId);

    validated.push({
      id: item.tweetId,
      url: item.originalUrl,
    });
  }

  if (!validated.length) {
    return res.status(400).json({
      ok: false,
      reason: "no_valid_x_links",
    });
  }

  if (validated.length > MAX_TWEETS_PER_JOB) {
    return res.status(400).json({
      ok: false,
      reason: "too_many_links",
      maximum: MAX_TWEETS_PER_JOB,
    });
  }

  const id = crypto.randomUUID();
  const userId = String(req.user.id);

  const job = {
    id,
    userId,
    status: "queued",
    stage: "queued",
    total: validated.length,
    read: 0,
    completed: 0,
    failed: 0,
    input: validated,
    items: new Map(
      validated.map((entry) => [
        entry.id,
        {
          id: entry.id,
          url: entry.url,
          status: "queued",
          readOk: false,
          tweetText: null,
          comment: null,
          replyUrl: null,
          error: null,
          attempts: 0,
        },
      ])
    ),
    workerId: `worker-${process.pid}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
  };

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO jobs
         (id, user_id, status, stage, total, read_count,
          completed_count, failed_count, worker_id,
          lease_expires_at, created_at, updated_at)
       VALUES
         ($1, $2, 'queued', 'queued', $3, 0, 0, 0,
          $4, NOW() + INTERVAL '2 minutes', NOW(), NOW())`,
      [id, userId, validated.length, job.workerId]
    );

    for (const entry of validated) {
      await client.query(
        `INSERT INTO job_items
           (job_id, tweet_id, tweet_url, status, attempts, updated_at)
         VALUES ($1, $2, $3, 'queued', 0, NOW())`,
        [id, entry.id, entry.url]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not create job:", error.message);

    return res.status(500).json({
      ok: false,
      reason: "job_creation_failed",
    });
  } finally {
    client.release();
  }

  jobs.set(id, job);

  // Background work; the HTTP response returns without waiting for Gemini.
  processJob(job).catch(async (error) => {
    console.error("YAPASSIST job failed:", id, error.message);

    job.status = "failed";
    job.stage = "failed";
    job.workerId = null;
    job.error = "The job stopped unexpectedly. Please retry failed items.";
    touchJob(job);

    try {
      await persistJob(job);
    } catch (persistError) {
      console.error("Could not save failed job:", persistError.message);
    }
  });

  return res.status(202).json({
    ok: true,
    jobId: id,
    total: job.total,
    batchSize: GEMINI_BATCH_SIZE,
  });
});

app.post("/jobs/:jobId/poll", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, status, stage, total, read_count,
              completed_count, failed_count, created_at, updated_at
       FROM jobs
       WHERE id = $1
         AND user_id = $2`,
      [req.params.jobId, req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        reason: "job_not_found",
      });
    }

    const jobRow = result.rows[0];

    const itemResult = await pool.query(
      `SELECT tweet_id, tweet_url, status, tweet_text,
              reply_text, reply_url, attempts, error_message
       FROM job_items
       WHERE job_id = $1
       ORDER BY id ASC`,
      [jobRow.id]
    );

    return res.json({
      ok: true,
      job: publicJobFromRows(jobRow, itemResult.rows),
    });
  } catch (error) {
    console.error("Polling job failed:", error.message);

    return res.status(500).json({
      ok: false,
      reason: "job_poll_failed",
    });
  }
});


// ============================================================
// SINGLE REPLY ENDPOINT — FOR EXISTING RETRY BUTTONS
// ============================================================

app.post("/generate-reply", requireAuth, async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      ok: false,
      reason: "missing_gemini_api_key",
    });
  }

  const tweetText = String(req.body.tweetText || "").trim();
  const id = String(req.body.id || "single-reply");

  if (!tweetText) {
    return res.status(400).json({ ok: false, reason: "no_tweet_text" });
  }

  try {
    const replies = await callGeminiWithTransientRetries(
      [{
        id,
        tweetText: tweetText.slice(0, MAX_TWEET_TEXT_LENGTH),
        variationHint: crypto.randomBytes(4).toString("hex"),
      }],
      crypto.randomUUID()
    );

    const comment = replies.get(id);

    if (!comment) {
      return res.status(502).json({
        ok: false,
        reason: "missing_reply",
      });
    }

    return res.json({ ok: true, comment });
  } catch (error) {
    console.error("Single Gemini reply failed:", error.message);
    return res.status(502).json({
      ok: false,
      reason: "gemini_api_error",
      message: error.message,
    });
  }
});

// ============================================================
// HOMEPAGE + CLEANUP
// ============================================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`YAPASSIST running on port ${PORT}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  console.log(`Gemini batch size: ${GEMINI_BATCH_SIZE}`);
});