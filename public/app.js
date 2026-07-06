// ====== DOM ELEMENTS ======
const linksInput = document.getElementById("links-input");
const extractBtn = document.getElementById("extract-links");
const clearLinksInputBtn = document.getElementById("clear-links-input");
const generateBtn = document.getElementById("generate-comment");
const linkList = document.getElementById("link-list");
const batchSizeInput = document.getElementById("batch-size");
const pacingSecondsInput = document.getElementById("pacing-seconds");
const pacingStatus = document.getElementById("pacing-status");
const overrideCooldownBtn = document.getElementById("override-cooldown");
const batchMeter = document.getElementById("batch-meter");

const loginPanel = document.getElementById("login-panel");
const loginUsernameInput = document.getElementById("login-username");
const loginPinInput = document.getElementById("login-pin");
const loginSubmitBtn = document.getElementById("login-submit");
const loginError = document.getElementById("login-error");
const appContent = document.getElementById("app-content");
const loggedInAs = document.getElementById("logged-in-as");
const logoutBtn = document.getElementById("logout-btn");

// ====== AUTH STATE ======
// Lightweight username+PIN identity - not real security, just enough to
// stop casual impersonation of a teammate's public X handle.
let currentUser = { username: null, pin: null };

function showLoggedIn(username, settings) {
  currentUser = { username, pin: loginPinInput.value.trim() };
  localStorage.setItem("yapassist_username", username);
  localStorage.setItem("yapassist_pin", currentUser.pin);

  if (settings) {
    batchSizeInput.value = settings.batchSize;
    pacingSecondsInput.value = settings.cooldownSeconds;
  }

  loggedInAs.textContent = `logged in as @${username}`;
  loginPanel.style.display = "none";
  appContent.style.display = "block";
  loginError.style.display = "none";

  restoreSession();
}

function showLoginError(message) {
  loginError.textContent = message;
  loginError.style.display = "block";
}

async function attemptLogin(username, pin) {
  try {
    const res = await fetch("/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, pin }),
    });
    const data = await res.json();

    if (data.ok) {
      showLoggedIn(username.trim().replace(/^@/, "").toLowerCase(), data.settings);
    } else if (data.reason === "wrong_pin") {
      showLoginError("Wrong PIN for that username. If this isn't your handle, pick a different one.");
    } else if (data.reason === "invalid_pin") {
      showLoginError("PIN must be 4-6 digits.");
    } else {
      showLoginError("Enter a username to continue.");
    }
  } catch (err) {
    console.error("Login request failed:", err);
    showLoginError("Couldn't reach the server. Is it running?");
  }
}

if (loginSubmitBtn) {
  loginSubmitBtn.addEventListener("click", () => {
    const username = loginUsernameInput.value.trim();
    const pin = loginPinInput.value.trim();
    if (!username) return showLoginError("Enter your X username.");
    if (!/^\d{4,6}$/.test(pin)) return showLoginError("PIN must be 4-6 digits.");
    attemptLogin(username, pin);
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    localStorage.removeItem("yapassist_username");
    localStorage.removeItem("yapassist_pin");
    currentUser = { username: null, pin: null };
    loginUsernameInput.value = "";
    loginPinInput.value = "";
    appContent.style.display = "none";
    loginPanel.style.display = "block";
  });
}

// Auto-login on page load if this device remembers a username+PIN
(function tryAutoLogin() {
  const savedUsername = localStorage.getItem("yapassist_username");
  const savedPin = localStorage.getItem("yapassist_pin");
  if (savedUsername && savedPin) {
    loginUsernameInput.value = savedUsername;
    loginPinInput.value = savedPin;
    attemptLogin(savedUsername, savedPin);
  }
})();

// Persist personal settings (batch size / cooldown) whenever changed
async function saveSettings() {
  if (!currentUser.username) return;
  try {
    await fetch("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: currentUser.username,
        pin: currentUser.pin,
        batchSize: parseInt(batchSizeInput.value, 10),
        cooldownSeconds: parseInt(pacingSecondsInput.value, 10),
      }),
    });
  } catch (err) {
    console.error("Failed to save settings:", err);
  }
}
batchSizeInput.addEventListener("change", saveSettings);
pacingSecondsInput.addEventListener("change", saveSettings);

// ====== SESSION PERSISTENCE ======
// Saves the in-progress queue (generated comments + claimed status) and
// batch/pacing state under your account, so reloading the page - or logging
// in from another device - picks up right where you left off.
let sessionRestoring = false; // guard so restore doesn't immediately re-save over itself

async function saveSession() {
  if (!currentUser.username || sessionRestoring) return;
  try {
    await fetch("/session/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: currentUser.username,
        pin: currentUser.pin,
        session: {
          linksInputText: linksInput.value,
          linkCommentPairs,
          activeBatchStart,
          claimsInBatch,
          batchLocked,
          cooldownUntil,
        },
      }),
    });
  } catch (err) {
    console.error("Failed to save session:", err);
  }
}

async function restoreSession() {
  if (!currentUser.username) return;
  try {
    const res = await fetch("/session/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: currentUser.username, pin: currentUser.pin }),
    });
    const data = await res.json();
    if (!data.ok || !data.session) return;

    sessionRestoring = true;

    const s = data.session;
    if (s.linksInputText) linksInput.value = s.linksInputText;
    if (Array.isArray(s.linkCommentPairs) && s.linkCommentPairs.length) {
      linkCommentPairs = s.linkCommentPairs;
      extractedLinks = linkCommentPairs.map((p) => p.link);
      displayLinks({
        activeBatchStart: s.activeBatchStart || 0,
        claimsInBatch: s.claimsInBatch || 0,
        batchLocked: !!s.batchLocked,
        cooldownUntil: s.cooldownUntil || 0,
      });
    }

    sessionRestoring = false;
  } catch (err) {
    console.error("Failed to restore session:", err);
  }
}

// ====== DATA STORAGE ======
let extractedLinks = [];
let linkCommentPairs = [];
let liElements = []; // one per linkCommentPairs entry, in order

// ====== PACING CONTROLS (batch gate) ======
// A fixed number of links are open at a time. Once that batch is fully
// claimed, everything locks. The countdown is a MINIMUM wait - once it
// hits zero the Override button becomes pressable, but the next batch
// only opens when you actually press it. Nothing auto-resumes.
let activeBatchStart = 0; // index of first link in the current open batch
let claimsInBatch = 0;
let batchLocked = false;
let cooldownUntil = 0;

function getBatchSize() {
  const n = parseInt(batchSizeInput.value, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

function isOnCooldown() {
  return Date.now() < cooldownUntil;
}

function startCooldown() {
  const secs = parseInt(pacingSecondsInput.value, 10);
  const safeSecs = Number.isFinite(secs) && secs > 0 ? secs : 0;
  cooldownUntil = Date.now() + safeSecs * 1000;
}

// Render the segmented meter for the current batch (filled = claimed so far)
function renderBatchMeter() {
  if (!batchMeter) return;
  const size = getBatchSize();
  batchMeter.innerHTML = "";
  for (let i = 0; i < size; i++) {
    const seg = document.createElement("div");
    seg.className = "meter-segment";
    if (i < claimsInBatch) {
      seg.classList.add(batchLocked ? "locked" : "filled");
    }
    batchMeter.appendChild(seg);
  }
}

// Lock/unlock the actual link rows based on batch window + lock state
function applyBatchLocks() {
  const size = getBatchSize();
  liElements.forEach((li, i) => {
    if (li.dataset.claimed === "true") return; // leave claimed rows alone

    const inActiveWindow = i >= activeBatchStart && i < activeBatchStart + size;
    const shouldLock = batchLocked || !inActiveWindow;

    li.classList.toggle("locked", shouldLock);
  });
}

function updatePacingUI() {
  if (batchLocked && !isOnCooldown()) {
    // Countdown finished, but batch stays closed until Override is pressed
    overrideCooldownBtn.disabled = false;
    pacingStatus.textContent = "batch limit reached — press override to continue";
    pacingStatus.style.color = "var(--danger)";
  } else if (batchLocked) {
    const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
    overrideCooldownBtn.disabled = true;
    pacingStatus.textContent = `batch limit reached — ${remaining}s remaining`;
    pacingStatus.style.color = "var(--danger)";
  } else {
    overrideCooldownBtn.disabled = true;
    const size = getBatchSize();
    pacingStatus.textContent = `${claimsInBatch}/${size} used this batch`;
    pacingStatus.style.color = "var(--teal)";
  }

  renderBatchMeter();
  applyBatchLocks();
}

setInterval(updatePacingUI, 500);

if (overrideCooldownBtn) {
  overrideCooldownBtn.addEventListener("click", () => {
    if (!batchLocked || isOnCooldown()) return; // guard: only usable once countdown is done
    batchLocked = false;
    claimsInBatch = 0;
    activeBatchStart += getBatchSize();
    updatePacingUI();
    saveSession();
  });
}

// Called every time a link is actually claimed (reply opened)
function registerClaim() {
  claimsInBatch++;
  if (claimsInBatch >= getBatchSize()) {
    batchLocked = true;
    startCooldown();
  }
  updatePacingUI();
}

// ====== GENERIC / FALLBACK COMMENTS ======
// Used when categorization can't confidently match a tweet, or the
// oEmbed fetch fails (deleted/protected tweet, rate limit, etc).
const genericComments = [
  "The project’s execution has been consistently impressive.",
  "Growth trends here are showing strong momentum.",
  "The roadmap looks realistic and achievable.",
  "Execution speed has exceeded expectations.",
  "Progress updates show tangible results.",
  "The team is clearly committed to long-term success.",
  "Momentum is building steadily over time.",
  "Strategic partnerships will likely accelerate growth.",
  "The roadmap shows a clear path to milestones.",
  "Market adoption is showing positive signals.",
  "Execution quality has been consistent throughout.",
  "Progress is being delivered on schedule.",
  "The team’s focus on long-term goals is evident.",
  "The project is scaling effectively.",
  "Roadmap milestones are ambitious but realistic.",
  "Strong momentum is visible across updates.",
  "Execution and vision are well aligned.",
  "The project shows resilience in challenging markets.",
  "Growth metrics indicate a positive trajectory.",
  "The team is demonstrating high accountability.",
];

// ====== CATEGORY-SPECIFIC COMMENT BANKS ======
// Mix of straight/professional lines and lighter, humorous ones.
// Emojis (where used) are facial expressions only.
const categoryComments = {
  announcement: [
    "Big moves like this usually set the tone for what's next.",
    "Launches like this are worth keeping an eye on.",
    "This kind of announcement tends to shift momentum fast.",
    "Solid timing on this rollout.",
    "This is the kind of update that gets a project noticed.",
    "Clean launch, curious how adoption tracks from here.",
    "This puts the project in a good spot heading forward.",
    "Okay this actually snuck up on me, wasn't expecting it this soon 👀",
    "Every time I think I'm caught up, another launch drops lol",
  ],
  product: [
    "The technical direction here is genuinely solid.",
    "This kind of infra work is what separates real builders.",
    "Good to see the product side getting this much attention.",
    "This integration should make a real difference in usability.",
    "The build quality on this is clear.",
    "This feature closes a gap a lot of users have been asking about.",
    "Solid engineering decision here.",
    "The kind of feature you don't notice until it's missing elsewhere 😅",
    "Underrated update, this is doing more work than people realize.",
  ],
  growth: [
    "These numbers are trending in a genuinely good direction.",
    "Adoption curves like this are worth tracking closely.",
    "That's meaningful growth for this stage of the project.",
    "The metrics back up the momentum here.",
    "This kind of traction doesn't happen by accident.",
    "Steady growth like this is a good sign for what's ahead.",
    "The numbers speak for themselves here.",
    "Charts looking healthier than my sleep schedule 😂",
    "Slow and steady apparently does win sometimes.",
  ],
  community: [
    "The community energy around this is genuinely strong.",
    "This is the kind of engagement that builds real loyalty.",
    "Good to see the community showing up like this.",
    "This kind of culture is hard to manufacture.",
    "The community's response says a lot here.",
    "This is a good reminder of why the community matters so much.",
    "The replies here are more entertaining than the actual post lol",
    "This community shows up harder than some paid teams 😄",
  ],
  market: [
    "Interesting move given current market conditions.",
    "Worth watching how this plays out against the broader market.",
    "This kind of price action tends to draw attention fast.",
    "The market seems to be reacting to this already.",
    "Timing relative to the market here is notable.",
    "Market really said not today and did its own thing 😅",
  ],
  question: [
    "Good question, curious to see how the team responds.",
    "This is worth a real answer, not just a quick reply.",
    "Interesting angle to raise here.",
    "This is the kind of question that gets overlooked too often.",
    "Fair point, would like to see more clarity on this.",
    "Ngl this is the question everyone's been avoiding lol",
  ],
  gm: [
    "GM ☀️",
    "GM, hope the charts are kind to you today.",
    "GM to everyone still up refreshing this app at 2am 😅",
    "GM, another day another timeline to scroll through.",
    "GM 🙂 let's see what today breaks or builds.",
    "GM, coffee first then chaos.",
    "GM fam, ready for whatever today throws at us.",
  ],
  gn: [
    "GN 🌙",
    "GN, may your bags be green when you wake up.",
    "GN everyone, closing tabs before I close my eyes.",
    "GN, today was a lot lol.",
    "GN 😴 see you on the timeline tomorrow.",
    "GN, resting up for tomorrow's inevitable chaos.",
  ],
  // Used when a tweet is a poll / "this or that" / clearly playful format,
  // regardless of what topic category it also matched.
  playful: [
    "Okay this is actually a hard pick 😅",
    "No way I have to choose, both slap.",
    "This is the real test of the community right here lol",
    "I already know the replies are gonna be chaos 😂",
    "Tough one, gonna lurk the replies before I commit.",
    "This kind of post always brings out the real ones lol",
    "Can't believe this is the debate we're having today 😄",
    "Not me actually thinking about this longer than I should.",
  ],
};

// ====== KEYWORD MAP FOR CATEGORIZATION ======
const categoryKeywords = {
  announcement: ["launch", "launching", "live now", "mainnet", "release", "released", "drop", "dropping", "listing", "listed", "introducing", "unveil"],
  product: ["feature", "protocol", "upgrade", "integration", "infrastructure", "built", "building", "sdk", "api", "smart contract", "architecture"],
  growth: ["users", "volume", "tvl", "adoption", "milestone", "growth", "active", "transactions", "onboarded", "scaling"],
  community: ["fam", "community", "vibes", "together", "family", "shoutout", "collab", "partners", "ecosystem"],
  market: ["price", "chart", "pump", "ath", "market cap", "mcap", "trading", "liquidity", "bullish", "bearish"],
  question: ["?"],
  gm: ["gm", "good morning", "morning fam", "rise and grind"],
  gn: ["gn", "good night", "goodnight", "night fam", "off to bed"],
};

// Cleaner display form for keywords that read awkwardly raw (acronyms, etc.)
const keywordLabels = {
  tvl: "TVL",
  api: "API",
  sdk: "SDK",
  ath: "ATH",
  mcap: "market cap",
  "smart contract": "smart contract",
  "live now": "launch",
};

// Comment templates with a {kw} slot filled by the actual matched keyword,
// so the reply references what the tweet is really about instead of a
// purely generic line from the category's static pool.
const categoryTemplates = {
  announcement: [
    "This kind of {kw} is exactly what gets a project noticed.",
    "The timing on this {kw} looks solid.",
    "Curious how adoption tracks after this {kw}.",
  ],
  product: [
    "This kind of {kw} work is what separates real builders.",
    "The {kw} focus here is genuinely what stands out.",
    "Good {kw} decisions like this compound over time.",
  ],
  growth: [
    "That {kw} trend is worth tracking closely.",
    "Solid {kw} numbers for this stage of the project.",
    "The {kw} here backs up the momentum.",
  ],
  market: [
    "That {kw} move is worth watching closely.",
    "Interesting {kw} action given current conditions.",
  ],
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Score tweet text against each category, return { category, score, keyword }
// where keyword is the specific matched term (used for word-correlated replies).
// Uses word-boundary matching so short keywords (e.g. "ath", "api") don't
// false-positive inside unrelated words (e.g. "path", "capital").
function categorizeTweet(text) {
  if (!text) return { category: "generic", score: 0, keyword: null };

  let bestCategory = "generic";
  let bestScore = 0;
  let bestKeyword = null;

  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    let score = 0;
    let matched = [];
    for (const kw of keywords) {
      const isMatch =
        kw === "?"
          ? text.includes("?")
          : new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i").test(text);

      if (isMatch) {
        score++;
        matched.push(kw);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
      // Prefer the longest matched keyword - usually the most specific/meaningful
      bestKeyword = matched.sort((a, b) => b.length - a.length)[0] || null;
    }
  }

  return bestScore > 0
    ? { category: bestCategory, score: bestScore, keyword: bestKeyword }
    : { category: "generic", score: 0, keyword: null };
}

// Detect format/tone signals that keyword matching alone can't judge -
// e.g. a "this or that" poll dressed up in community language.
function detectFormatSignals(text) {
  if (!text) return { playful: false, hype: false };

  const playful =
    /\bvs\.?\b|this\s+or\s+that|would\s+you\s+rather|pick\s+one|\bpoll\b|either\s*\/?\s*or/i.test(text) ||
    (text.match(/[\u{1F600}-\u{1F64F}]/gu) || []).length >= 2;

  const hype =
    /!{2,}/.test(text) ||
    /\b[A-Z]{4,}\b/.test(text.replace(/https?:\/\/\S+/g, "")); // ignore URLs when checking for shouting caps

  return { playful, hype };
}

// ====== GENERIC TOPIC EXTRACTION ======
// This is the fallback that actually scales: instead of relying on a fixed
// keyword list (which only covers typical "web3 growth" vocabulary), pull
// the real subject straight out of the tweet - a proper noun phrase, a
// hashtag, or a mentioned project - so replies stay grounded in whatever
// the tweet is actually about, no matter the niche.

// Turn "WOO_WorldCup2026" or "_WOO_X" into readable "WOO World Cup 2026" / "WOO X"
function humanizeTag(raw) {
  let s = raw.replace(/^[#@_]+/, "").replace(/_+$/, "");
  s = s.split("_").join(" ");
  s = s.replace(/([a-z])([A-Z])/g, "$1 $2"); // camelCase -> spaced
  s = s.replace(/([a-zA-Z])(\d)/g, "$1 $2"); // letter/digit boundary -> spaced
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function extractTopic(text) {
  if (!text) return null;

  // 1. Proper noun phrases - two or more consecutive capitalized words
  // (e.g. "GenLayer Points", "Community Development Agreement").
  // Requiring 2+ words filters out ordinary sentence-starting capitals.
  const properNounRegex = /\b[A-Z][a-zA-Z0-9]*(?:\s+(?:&|and)\s+[A-Z][a-zA-Z0-9]*|\s+[A-Z][a-zA-Z0-9]*)+\b/g;
  const properMatches = (text.match(properNounRegex) || [])
    .map((m) => m.trim())
    .filter((m) => {
      const wordCount = m.split(/\s+/).length;
      return wordCount >= 2 && wordCount <= 5;
    })
    .sort((a, b) => b.length - a.length);

  if (properMatches.length) return properMatches[0];

  // 2. Hashtags - almost always the actual campaign/topic name
  const hashtagMatch = text.match(/#(\w+)/);
  if (hashtagMatch) {
    const label = humanizeTag(hashtagMatch[1]);
    if (label.length >= 3) return label;
  }

  // 3. Mentioned project/handle as last resort
  const mentionMatch = text.match(/@(\w+)/);
  if (mentionMatch) {
    const label = humanizeTag(mentionMatch[1]);
    if (label.length >= 3) return label;
  }

  return null;
}

// Topic-agnostic templates - work for ANY subject since the {topic} slot
// is filled dynamically. This is what keeps replies from feeling repetitive
// across completely different kinds of tweets (contests, infra news,
// philosophical threads, etc).
const topicTemplates = [
  "The {topic} angle here is genuinely worth paying attention to.",
  "This kind of {topic} move doesn't happen without real intent behind it.",
  "Solid effort on the {topic} front here.",
  "Not gonna lie, the {topic} take caught my attention 👀",
  "This is a creative way to approach {topic}.",
  "The {topic} execution here stands out.",
  "Curious to see where this {topic} goes from here.",
  "This kind of {topic} energy is what gets noticed.",
  "Didn't expect the {topic} angle, but it works 😄",
  "Good use of {topic} here honestly.",
  "This {topic} take is more thought-out than most replies I see lol",
];

function pickComment(category, signals, keyword, topic) {
  // Priority order:
  // 1. GM/GN - distinct greeting format, always use the dedicated bank
  // 2. Playful format (polls, "this or that") - tone override
  // 3. Extracted topic - the general-purpose fix, works for ANY subject
  // 4. Category keyword match - narrower, web3-specific vocabulary
  // 5. Generic fallback - last resort

  if (category === "gm" || category === "gn") {
    const pool = categoryComments[category];
    return { comment: pool[Math.floor(Math.random() * pool.length)], source: category };
  }

  if (signals && signals.playful) {
    const pool = categoryComments.playful;
    return { comment: pool[Math.floor(Math.random() * pool.length)], source: "playful" };
  }

  // Topic extraction covers far more ground than the fixed keyword lists,
  // so it takes priority most of the time even when a category also matched.
  if (topic && Math.random() < 0.75) {
    const template = topicTemplates[Math.floor(Math.random() * topicTemplates.length)];
    return { comment: template.replace("{topic}", topic), source: `topic:"${topic}"` };
  }

  const templates = categoryTemplates[category];
  if (keyword && templates && templates.length && Math.random() < 0.6) {
    const label = keywordLabels[keyword] || keyword;
    const template = templates[Math.floor(Math.random() * templates.length)];
    return { comment: template.replace("{kw}", label), source: `${category} · "${keyword}"` };
  }

  const pool = categoryComments[category] && categoryComments[category].length
    ? categoryComments[category]
    : genericComments;

  return {
    comment: pool[Math.floor(Math.random() * pool.length)],
    source: category === "generic" ? "generic" : category,
  };
}

// Fetch tweet text via our server's oEmbed proxy
async function fetchTweetText(link) {
  try {
    const res = await fetch(`/oembed?url=${encodeURIComponent(link)}`);
    const data = await res.json();
    if (data.ok) return data.text;
    return null;
  } catch (err) {
    console.error("Failed to fetch oEmbed for", link, err);
    return null;
  }
}

// Ask the server to refine/replace the candidate comment using AI,
// for cases the rule-based pass can't judge confidently.
async function refineComment(tweetText, category, comment) {
  try {
    const res = await fetch("/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tweetText, category, comment }),
    });
    const data = await res.json();
    if (data.ok && data.comment) return data.comment;
    return null; // fall back to the rule-based comment silently
  } catch (err) {
    console.error("Refine request failed:", err);
    return null;
  }
}

// ====== FUNCTIONS ======

// Extract only X/Twitter links that point to a tweet/status
function extractLinks(text) {
  if (!text) return [];

  const urlRegex = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s)]+/gi;
  const rawMatches = text.match(urlRegex) || [];

  const cleaned = rawMatches
    .map(url => url.replace(/[.,)\]]+$/g, ""))
    .filter(Boolean)
    .filter(url => {
      const numericIdAtEnd = /\/\d{3,20}(?:$|[?#])/;
      const iWebStatus = /\/i\/web\/status\/\d{3,20}/;
      return numericIdAtEnd.test(url) || iWebStatus.test(url);
    });

  return [...new Set(cleaned)];
}

function extractTweetId(link) {
  const match = link.match(/status\/(\d+)/);
  return match ? match[1] : null;
}

// Ask the server which of these tweet IDs are already claimed by anyone
// on the team, so we don't send you to reply to something a teammate
// already handled.
async function checkSharedClaims(tweetIds) {
  try {
    const res = await fetch("/check-claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tweetIds }),
    });
    const data = await res.json();
    return data.claims || {};
  } catch (err) {
    console.error("check-claims request failed:", err);
    return {}; // fail open - better to show all links than to block everything
  }
}

// Record that this tweet has been replied to, so teammates see it as claimed.
async function recordClaim(tweetId) {
  try {
    const res = await fetch("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: currentUser.username,
        pin: currentUser.pin,
        tweetId,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error("claim request failed:", err);
    return { ok: false, reason: "network_error" };
  }
}

// Clear the displayed links
const clearLinkList = () => {
  linkList.innerHTML = "";
};

// Pick a distinct color per category/source so the queue reads as lively
// and scannable, not one flat color for everything.
function getTagColor(source) {
  const s = (source || "").toLowerCase();
  if (s.startsWith("topic:")) return { bg: "rgba(20, 184, 166, 0.18)", fg: "#2dd4bf" };
  if (s === "ai") return { bg: "rgba(168, 85, 247, 0.18)", fg: "#c084fc" };
  if (s === "playful") return { bg: "rgba(217, 70, 239, 0.18)", fg: "#e879f9" };
  if (s === "gm") return { bg: "rgba(234, 179, 8, 0.18)", fg: "#facc15" };
  if (s === "gn") return { bg: "rgba(99, 102, 241, 0.18)", fg: "#818cf8" };
  if (s.includes("announcement")) return { bg: "rgba(59, 130, 246, 0.18)", fg: "#60a5fa" };
  if (s.includes("product")) return { bg: "rgba(168, 85, 247, 0.18)", fg: "#c084fc" };
  if (s.includes("growth")) return { bg: "rgba(34, 197, 94, 0.18)", fg: "#4ade80" };
  if (s.includes("community")) return { bg: "rgba(236, 72, 153, 0.18)", fg: "#f472b6" };
  if (s.includes("market")) return { bg: "rgba(249, 115, 22, 0.18)", fg: "#fb923c" };
  return { bg: "rgba(63, 167, 150, 0.18)", fg: "#3fa796" }; // generic fallback
}

// Display clickable links styled as console rows, with category tag chips.
// Locking/unlocking is entirely driven by the batch-gate system (see
// applyBatchLocks / updatePacingUI above) - this function just builds the rows.
// restoredState (optional) lets a reload/re-login resume exactly where the
// batch was left off, instead of always starting a fresh batch at 0.
const displayLinks = (restoredState) => {
  clearLinkList();
  liElements = [];

  if (restoredState) {
    activeBatchStart = restoredState.activeBatchStart;
    claimsInBatch = restoredState.claimsInBatch;
    batchLocked = restoredState.batchLocked;
    cooldownUntil = restoredState.cooldownUntil;
  } else {
    activeBatchStart = 0;
    claimsInBatch = 0;
    batchLocked = false;
    cooldownUntil = 0;
  }

  linkCommentPairs.forEach((pair, index) => {
    const li = document.createElement("li");
    li.className = "link-row p-3 flex items-center justify-between gap-2";

    const linkText = document.createElement("span");
    linkText.className = "truncate flex-1";

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = pair.source;
    const tagColor = getTagColor(pair.source);
    tag.style.background = tagColor.bg;
    tag.style.color = tagColor.fg;

    if (pair.claimed) {
      // Restoring a link that was already claimed before reload - render
      // it as claimed immediately, no click handler needed.
      li.dataset.claimed = "true";
      linkText.textContent = pair.link + " ✓ claimed";
      li.classList.add("claimed");
      li.appendChild(linkText);
    } else {
      li.dataset.claimed = "false";
      linkText.textContent = pair.link;
      li.appendChild(linkText);
      li.appendChild(tag);

      li.addEventListener("click", function handler() {
        if (li.classList.contains("locked")) return; // batch gate guard

        const tweetIdMatch = pair.link.match(/status\/(\d+)/);
        if (!tweetIdMatch) return alert("Invalid X link format.");
        const tweetId = tweetIdMatch[1];

        window.open(
          `https://twitter.com/intent/tweet?in_reply_to=${tweetId}&text=${encodeURIComponent(pair.comment)}`,
          "_blank"
        );

        pair.claimed = true;
        li.dataset.claimed = "true";
        linkText.textContent = pair.link + " ✓ claimed";
        tag.remove();
        li.classList.add("claimed");
        li.removeEventListener("click", handler);

        registerClaim();
        saveSession();

        // Record it server-side so teammates see this as already handled.
        // The reply tab already opened above regardless of this result.
        recordClaim(tweetId).then((result) => {
          if (result && result.ok === false && result.reason === "already_claimed") {
            linkText.textContent = pair.link + ` ✓ claimed (note: @${result.claimedBy} also had this one)`;
          }
        });
      });
    }

    linkList.appendChild(li);
    liElements[index] = li;
  });

  updatePacingUI();
};

// Set to true only if you have ANTHROPIC_API_KEY configured server-side
// and want AI refinement for edge cases the rules can't resolve.
const AI_REFINEMENT_ENABLED = false;

// ====== EVENT LISTENERS ======

// Extract links from textarea
extractBtn.addEventListener("click", () => {
  extractedLinks = extractLinks(linksInput.value);
  alert(`Extracted ${extractedLinks.length} links.`);
});

if (clearLinksInputBtn) {
  clearLinksInputBtn.addEventListener("click", () => {
    linksInput.value = "";
    linksInput.focus();
  });
}

// ==== GENERATE COMMENT BUTTON ====
generateBtn.addEventListener("click", async () => {
  if (!extractedLinks.length) {
    alert("No links extracted yet!");
    return;
  }

  generateBtn.disabled = true;
  const originalLabel = generateBtn.textContent;
  generateBtn.textContent = "Checking team claims...";

  // Skip anything a teammate (or you, from another device) already replied to.
  const tweetIdMap = extractedLinks.map((link) => ({ link, tweetId: extractTweetId(link) }));
  const validTweetIds = tweetIdMap.filter((x) => x.tweetId).map((x) => x.tweetId);
  const claims = await checkSharedClaims(validTweetIds);

  const skipped = [];
  const linksToProcess = tweetIdMap
    .filter(({ tweetId }) => {
      if (tweetId && claims[tweetId]) {
        skipped.push({ tweetId, claimedBy: claims[tweetId].username });
        return false;
      }
      return true;
    })
    .map((x) => x.link);

  linkCommentPairs = [];

  for (const link of linksToProcess) {
    generateBtn.textContent = "Reading tweet...";
    const tweetText = await fetchTweetText(link);

    const { category, score, keyword } = categorizeTweet(tweetText);
    const signals = detectFormatSignals(tweetText);
    const topic = extractTopic(tweetText);
    let { comment, source } = pickComment(category, signals, keyword, topic);
    let refined = false;

    // AI is off by default (no cost). If ever enabled, only spend a call
    // when nothing else - not even topic extraction - found anything to go on.
    const needsRefinement = AI_REFINEMENT_ENABLED && tweetText && score === 0 && !topic;

    if (needsRefinement) {
      generateBtn.textContent = "Refining...";
      const aiComment = await refineComment(tweetText, category, comment);
      if (aiComment) {
        comment = aiComment;
        refined = true;
        source = "AI";
      }
    }

    linkCommentPairs.push({ link, comment, source: refined ? "AI" : source, claimed: false });
  }

  generateBtn.disabled = false;
  generateBtn.textContent = originalLabel;

  linksInput.value = ""; // ready for the next batch of links to be pasted

  displayLinks();
  saveSession();

  if (skipped.length) {
    const byWhom = [...new Set(skipped.map((s) => `@${s.claimedBy}`))].join(", ");
    alert(`Skipped ${skipped.length} tweet(s) already claimed by: ${byWhom}`);
  }
});