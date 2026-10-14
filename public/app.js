// ============================================================
// YAPASSIST - AI REPLY GENERATOR
// Flow:
// X URL -> server-side oEmbed -> Gemini batch job -> replies
// ============================================================

// ============================================================
// DOM ELEMENTS
// ============================================================

const linksInput = document.getElementById("links-input");
const extractBtn = document.getElementById("extract-links");
const clearLinksInputBtn = document.getElementById("clear-links-input");
const generateBtn = document.getElementById("generate-comment");
const linkList = document.getElementById("link-list");

const batchSizeInput = document.getElementById("batch-size");
const pacingSecondsInput = document.getElementById("pacing-seconds");
const pacingStatus = document.getElementById("pacing-status");
const overrideCooldownBtn = document.getElementById("override-cooldown");

const loginPanel = document.getElementById("login-panel");
const loginError = document.getElementById("login-error");

const appContent = document.getElementById("app-content");
const loggedInAs = document.getElementById("logged-in-as");
const loggedInAsTop = document.getElementById("logged-in-as-top");
const logoutBtn = document.getElementById("logout-btn");

const progressFill = document.getElementById("progress-fill");
const progressPercent = document.getElementById("progress-percent");

// ============================================================
// AUTH STATE: GOOGLE SESSION
// ============================================================

let currentUser = {
    id: null,
    email: null,
    displayName: null,
    legacyUsername: null
};

function showLoggedIn(user) {
    currentUser = {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        legacyUsername: user.legacyUsername
    };

    batchSizeInput.value = 10;
    pacingSecondsInput.value = 30;

    linksInput.value = "";
    extractedLinks = [];
    linkCommentPairs = [];

    displayLinks();

    const accountLabel = user.legacyUsername
        ? `@${user.legacyUsername}`
        : user.displayName || user.email;

    loggedInAs.textContent = accountLabel;
    loggedInAsTop.textContent = accountLabel;

    loginPanel.style.display = "none";
    appContent.style.display = "block";

    loginError.style.display = "none";
}

function showLoginError(message) {
    loginError.textContent = message;
    loginError.style.display = "block";
}

async function checkGoogleSession() {
    try {
        const response = await fetch("/api/me");
        const data = await response.json();

        if (response.ok && data.ok && data.user) {
            showLoggedIn(data.user);
            return;
        }

        currentUser = {
            id: null,
            email: null,
            displayName: null,
            legacyUsername: null
        };

        appContent.style.display = "none";
        loginPanel.style.display = "block";

        const params = new URLSearchParams(window.location.search);

        if (params.get("login") === "failed") {
            showLoginError("Google sign-in failed. Please try again.");
            window.history.replaceState(
                {},
                "",
                window.location.pathname
            );
        }
    } catch (error) {
        console.error("Session check failed:", error);
        appContent.style.display = "none";
        loginPanel.style.display = "block";
        showLoginError(
            "Couldn't reach the server. Please refresh and try again."
        );
    }
}

if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
        try {
            const response = await fetch("/auth/logout", {
                method: "POST"
            });

            const data = await response.json();

            if (!response.ok || !data.ok) {
                throw new Error("Logout failed");
            }

            currentUser = {
                id: null,
                email: null,
                displayName: null,
                legacyUsername: null
            };

            linksInput.value = "";
            extractedLinks = [];
            linkCommentPairs = [];

            batchSizeInput.value = 10;
            pacingSecondsInput.value = 30;

            displayLinks();

            appContent.style.display = "none";
            loginPanel.style.display = "block";
        } catch (error) {
            console.error("Logout failed:", error);
            alert("Couldn't log out. Please try again.");
        }
    });
}

checkGoogleSession();


// ============================================================
// DATA STORAGE
// ============================================================
let extractedLinks = [];
let linkCommentPairs = [];

let liElements = [];
let activeBatchStart = 0;
let claimsInBatch = 0;
let batchLocked = false;
let cooldownUntil = 0;

let activeGenerationJobId = null;
let generationResultsSeen = new Set();


async function copyReplyText(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (error) {
        console.warn("Clipboard API failed; trying fallback.", error);
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";

    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let copied = false;

    try {
        copied = document.execCommand("copy");
    } catch (error) {
        console.error("Clipboard fallback failed:", error);
    } finally {
        textarea.remove();
    }

    return copied;
}
// ============================================================
// PACING CONTROLS
// ============================================================

function getBatchSize() {
    const value = parseInt(batchSizeInput?.value, 10);

    return Number.isFinite(value) && value > 0 ? value : 10;
}

function isOnCooldown() {
    return Date.now() < cooldownUntil;
}

function startCooldown() {
    const seconds = parseInt(pacingSecondsInput?.value, 10);
    const safeSeconds = Number.isFinite(seconds) && seconds > 0
        ? seconds
        : 0;

    cooldownUntil = Date.now() + safeSeconds * 1000;
}

function applyBatchLocks() {
    const size = getBatchSize();

    liElements.forEach((element, index) => {
        if (!element) return;
        if (element.dataset.claimed === "true") return;
        if (element.dataset.failed === "true") return;

        const inActiveWindow =
            index >= activeBatchStart &&
            index < activeBatchStart + size;

        element.classList.toggle(
            "locked",
            batchLocked || !inActiveWindow
        );
    });
}

function updatePacingUI() {
    const size = getBatchSize();

    const percent = size > 0
        ? Math.min(100, Math.round((claimsInBatch / size) * 100))
        : 0;

    if (pacingStatus) {
        if (batchLocked && !isOnCooldown()) {
            if (overrideCooldownBtn) overrideCooldownBtn.disabled = false;

            pacingStatus.textContent =
                "Batch limit reached — press override to continue";

            pacingStatus.style.color = "var(--danger)";
        } else if (batchLocked) {
            const remaining = Math.max(
                0,
                Math.ceil((cooldownUntil - Date.now()) / 1000)
            );

            if (overrideCooldownBtn) overrideCooldownBtn.disabled = true;

            pacingStatus.textContent =
                `Batch limit reached — ${remaining}s remaining`;

            pacingStatus.style.color = "var(--danger)";
        } else {
            if (overrideCooldownBtn) overrideCooldownBtn.disabled = true;

            pacingStatus.textContent =
                `${claimsInBatch} of ${size} replies sent`;

            pacingStatus.style.color = "var(--teal)";
        }
    }

    if (progressFill) {
        progressFill.style.width = `${percent}%`;
    }

    if (progressPercent) {
        progressPercent.textContent = `${percent}%`;
    }

    applyBatchLocks();
}

setInterval(updatePacingUI, 500);

if (overrideCooldownBtn) {
    overrideCooldownBtn.addEventListener("click", () => {
        if (!batchLocked || isOnCooldown()) return;

        batchLocked = false;
        claimsInBatch = 0;
        activeBatchStart += getBatchSize();

        updatePacingUI();
    });
}

function registerClaim() {
    claimsInBatch++;

    if (claimsInBatch >= getBatchSize()) {
        batchLocked = true;
        startCooldown();
    }

    updatePacingUI();
}

function preservePacingState() {
    return {
        activeBatchStart,
        claimsInBatch,
        batchLocked,
        cooldownUntil
    };
}

// ============================================================
// X LINK EXTRACTION
// ============================================================

function extractLinks(text) {
    if (!text) return [];

    const urlRegex =
        /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s)]+/gi;

    const matches = text.match(urlRegex) || [];

    const cleaned = matches
        .map(url => url.replace(/[.,)\]}]+$/g, ""))
        .filter(url => /\/status\/\d{3,30}/i.test(url));

    return [...new Set(cleaned)];
}

function extractTweetId(link) {
    const match = String(link || "").match(/\/status\/(\d+)/i);
    return match ? match[1] : null;
}

// ============================================================
// TWEET READING THROUGH THE SERVER'S OEMBED ENDPOINT
// ============================================================

async function fetchTweetsText(links) {
    const results = {};
    let nextIndex = 0;
    const concurrency = 4;

    async function worker() {
        while (true) {
            const index = nextIndex++;

            if (index >= links.length) return;

            const link = links[index];
            const tweetId = extractTweetId(link);

            if (!tweetId) {
                results[tweetId || link] = null;
                continue;
            }

            try {
                const response = await fetch(
                    `/oembed?url=${encodeURIComponent(link)}`
                );

                const data = await response.json();

                if (!response.ok || !data.ok || !data.text) {
                    throw new Error(
                        data.message || "Could not read this X post."
                    );
                }

                results[tweetId] = {
                    tweetId,
                    text: data.text
                };
            } catch (error) {
                console.error("oEmbed read failed:", link, error);
                results[tweetId] = null;
            }
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(concurrency, links.length) },
            () => worker()
        )
    );

    return results;
}

// ============================================================
// SINGLE-REPLY GENERATION FOR THE RETRY BUTTON
// ============================================================


async function generateAIReply(tweetText) {
    const response = await fetch("/generate-reply", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            tweetText: tweetText
        })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(data.message || data.reason || "Failed to generate reply");
    }

    return data.comment;
}

// ============================================================
// GENERATION STATUS
// ============================================================

let generationStatus = document.getElementById("generation-status");

if (!generationStatus && linkList?.parentElement) {
    generationStatus = document.createElement("p");
    generationStatus.id = "generation-status";
    generationStatus.className = "text-sm";
    generationStatus.style.margin = "12px 0";
    generationStatus.style.color = "var(--muted)";

    linkList.parentElement.insertBefore(generationStatus, linkList);
}

function setGenerationStatus(message) {
    if (generationStatus) {
        generationStatus.textContent = message;
    }
}

// ============================================================
// CLAIM HISTORY
// ============================================================


async function recordClaim(tweetId) {
    try {
        const response = await fetch("/claim", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
           body: JSON.stringify({ tweetId: String(tweetId) })
        });

        const data = await response.json();

        if (!response.ok || !data.ok) {
            throw new Error(data.message || "Could not save claim.");
        }

        return data;
    } catch (error) {
        console.error("Claim-save request failed:", error);

        return {
            ok: false,
            reason: "claim_save_failed"
        };
    }
}


async function recordClaim(tweetId) {
    try {
        const response = await fetch("/claim", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ tweetId: String(tweetId) })
        });

        const data = await response.json();

        if (!response.ok || !data.ok) {
            throw new Error(data.message || "Could not record claim.");
        }

        return data;
    } catch (error) {
        console.error("Claim request failed:", error);
        return {
            ok: false,
            reason: "network_error"
        };
    }
}


async function checkSharedClaims(tweetIds) {
    if (!Array.isArray(tweetIds) || tweetIds.length === 0) {
        return {};
    }

    const response = await fetch("/check-claims", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ tweetIds })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(
            data.reason || "Could not check claim history."
        );
    }

    return data.claims || {};
}


// ============================================================
// SERVER-SIDE JOB POLLING
// ============================================================

function addFinishedJobItems(job) {
    let addedAny = false;

    for (const item of job.items || []) {
        if (item.status !== "completed" && item.status !== "failed") {
            continue;
        }

        const key = String(item.id);

        if (generationResultsSeen.has(key)) {
            continue;
        }

        generationResultsSeen.add(key);
        addedAny = true;

        if (item.status === "completed") {
            linkCommentPairs.push({
                id: key,
                link: item.url,
                tweetText: item.tweetText || "",
                comment: item.comment,
                replyUrl: item.replyUrl,
                source: "AI",
                claimed: false,
                failed: false
            });
        } else {
            linkCommentPairs.push({
                id: key,
                link: item.url,
                tweetText: item.tweetText || "",
                comment: "",
                source: "Failed",
                claimed: false,
                failed: true,
                error: item.error || "Generation failed."
            });
        }
    }

    if (addedAny) {
        displayLinks(preservePacingState());
    }
}

async function pollGenerationJob(jobId) {
    while (activeGenerationJobId === jobId) {
        const response = await fetch(
            `/jobs/${encodeURIComponent(jobId)}/poll`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({})
            }
        );

        const data = await response.json();

        if (!response.ok || !data.ok || !data.job) {
            throw new Error(
                data.message ||
                data.reason ||
                "Could not retrieve job progress."
            );
        }

        const job = data.job;
        addFinishedJobItems(job);

        const processed = (job.completed || 0) + (job.failed || 0);

        setGenerationStatus(
            `Stage: ${job.stage} · ` +
            `Processed ${processed}/${job.total} · ` +
            `Read ${job.read}/${job.total} · ` +
            `Replies ${job.completed} · ` +
            `Failed ${job.failed}`
        );

        generateBtn.textContent =
            `Generating ${processed}/${job.total}...`;

        if (job.status === "completed" || job.status === "failed") {
            if (job.status === "failed") {
                throw new Error(
                    job.error || "The generation job failed."
                );
            }

            return job;
        }

        // This only controls UI polling. It does not delay server-side batches.
        await new Promise(resolve => setTimeout(resolve, 800));
    }

    return null;
}

// ============================================================
// GENERATE BUTTON
// ============================================================

if (generateBtn) {
    generateBtn.addEventListener("click", async () => {
        if (!extractedLinks.length) {
            alert("No links extracted yet!");
            return;
        }

        if (!currentUser.id) {
    alert("Please sign in with Google again.");
    return;
}

        if (activeGenerationJobId) {
            alert("A generation job is already running.");
            return;
        }

        generateBtn.disabled = true;
        const originalLabel = generateBtn.textContent;

        try {
            generateBtn.textContent = "Checking claim history...";
            setGenerationStatus("Checking which posts still need replies...");

            const tweetIdMap = extractedLinks.map(link => ({
                link,
                tweetId: extractTweetId(link)
            }));

            const validTweetIds = tweetIdMap
                .filter(item => item.tweetId)
                .map(item => item.tweetId);

            const claims = await checkSharedClaims(validTweetIds);
            const skipped = [];

            const linksToProcess = tweetIdMap
                .filter(({ tweetId }) => {
                    if (tweetId && claims[tweetId]) {
                        skipped.push(tweetId);
                        return false;
                    }

                    return true;
                })
                .map(item => item.link);

            if (!linksToProcess.length) {
                setGenerationStatus(
                    `Nothing to generate. Skipped ${skipped.length} ` +
                    "post(s) already marked as replied to."
                );

                alert(
                    `Skipped ${skipped.length} tweet(s) you've already replied to.`
                );

                return;
            }

            linkCommentPairs = [];
            generationResultsSeen = new Set();
            displayLinks();

            generateBtn.textContent = "Starting job...";
            setGenerationStatus(
                `Submitting ${linksToProcess.length} posts to the server...`
            );

           
const createResponse = await fetch("/jobs", {
    method: "POST",
    headers: {
        "Content-Type": "application/json"
    },
    body: JSON.stringify({
        links: linksToProcess,
    })
});


            const createData = await createResponse.json();

            if (!createResponse.ok || !createData.ok || !createData.jobId) {
                throw new Error(
                    createData.message ||
                    createData.reason ||
                    "Could not start the generation job."
                );
            }

            activeGenerationJobId = createData.jobId;

            generateBtn.textContent =
                `Generating 0/${createData.total}...`;

            const job = await pollGenerationJob(createData.jobId);

            if (job) {
                setGenerationStatus(
                    `Finished: ${job.completed} replies generated, ` +
                    `${job.failed} failed out of ${job.total}.` +
                    (skipped.length
                        ? ` Skipped ${skipped.length} already-claimed post(s).`
                        : "")
                );

                if (job.failed > 0) {
                    alert(
                        `Generated ${job.completed} of ${job.total} replies. ` +
                        `${job.failed} failed. Use Retry on failed rows.`
                    );
                } else if (skipped.length) {
                    alert(
                        `Generated ${job.completed} replies. ` +
                        `Skipped ${skipped.length} already-claimed post(s).`
                    );
                }
            }
        } catch (error) {
            console.error("YAPASSIST generation failed:", error);

            setGenerationStatus(`Generation error: ${error.message}`);
            alert(error.message || "Generation failed.");
        } finally {
            activeGenerationJobId = null;
            generateBtn.disabled = false;
            generateBtn.textContent = originalLabel;
        }
    });
}

// ============================================================
// UI
// ============================================================

function clearLinkList() {
    if (linkList) {
        linkList.innerHTML = "";
    }
}

function displayLinks(restoredState) {
    clearLinkList();
    liElements = [];

    if (!linkList) return;

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
        li.className = "link-row p-3 flex items-center gap-2";

        const linkText = document.createElement("span");
        linkText.className = "truncate flex-1";

        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = pair.failed ? "Failed" : "AI";
        tag.style.background = pair.failed
            ? "rgba(239, 68, 68, 0.18)"
            : "rgba(168, 85, 247, 0.18)";
        tag.style.color = pair.failed ? "#f87171" : "#c084fc";

        const statusText = document.createElement("span");
        statusText.className = "text-xs";
        statusText.style.color = "var(--muted)";

        const skipBtn = document.createElement("button");
        skipBtn.className = "skip-btn";
        skipBtn.type = "button";
        skipBtn.title = "Remove from queue";
        skipBtn.textContent = "✕";

        skipBtn.addEventListener("click", event => {
            event.stopPropagation();
            linkCommentPairs.splice(index, 1);
            displayLinks(preservePacingState());
        });

        // --------------------------------------------------------
        // FAILED ROW + RETRY
        // --------------------------------------------------------

        if (pair.failed) {
            li.dataset.failed = "true";
            linkText.textContent = pair.link;
            statusText.textContent = pair.error || "Generation failed";

            const retryBtn = document.createElement("button");
            retryBtn.className = "retry-btn";
            retryBtn.type = "button";
            retryBtn.textContent = "Retry";

            retryBtn.addEventListener("click", async event => {
                event.stopPropagation();

                retryBtn.disabled = true;
                retryBtn.textContent = "Retrying...";

                try {
                    const tweetMap = await fetchTweetsText([pair.link]);
                    const tweetId = extractTweetId(pair.link);
                    const tweetText = tweetMap[tweetId]?.text;

                    if (!tweetText) {
                        throw new Error("Could not read this X post.");
                    }

                    const comment = await generateAIReply(tweetText);

                    if (!comment) {
                        throw new Error("Gemini did not return a reply.");
                    }

                    linkCommentPairs[index] = {
                        id: tweetId,
                        link: pair.link,
                        comment,
                        source: "AI",
                        claimed: false,
                        failed: false,
                        tweetText,
                        replyUrl:
                            `https://twitter.com/intent/tweet?in_reply_to=` +
                            `${encodeURIComponent(tweetId)}&text=` +
                            `${encodeURIComponent(comment)}`
                    };

                    displayLinks(preservePacingState());
                } catch (error) {
                    console.error("Retry failed:", error);

                    pair.error = error.message || "Generation failed.";
                    retryBtn.disabled = false;
                    retryBtn.textContent = "Retry";
                    statusText.textContent = pair.error;
                }
            });

            li.appendChild(linkText);
            li.appendChild(tag);
            li.appendChild(statusText);
            li.appendChild(retryBtn);
            li.appendChild(skipBtn);

            linkList.appendChild(li);
            liElements[index] = li;
            return;
        }

        // --------------------------------------------------------
        // CLAIMED ROW
        // --------------------------------------------------------

        if (pair.claimed) {
            li.dataset.claimed = "true";
            linkText.textContent = `${pair.link} ✓ claimed`;
            statusText.textContent = "claimed";
            li.classList.add("claimed");

            li.appendChild(linkText);
            li.appendChild(statusText);
        } else {
            // ----------------------------------------------------
            // ACTIVE ROW
            // ----------------------------------------------------

            li.dataset.claimed = "false";
            linkText.textContent = pair.link;
            statusText.textContent = "active";

            li.appendChild(linkText);
            li.appendChild(tag);
            li.appendChild(statusText);
            li.appendChild(skipBtn);


    li.addEventListener("click", async function handler() {
    if (li.classList.contains("locked")) return;

    const tweetId = extractTweetId(pair.link);

    if (!tweetId) {
        alert("Invalid X link format.");
        return;
    }

    const isAndroid = /Android/i.test(navigator.userAgent);

    if (isAndroid) {
    // Open a new tab immediately while the click is still active.
    const xTab = window.open("about:blank", "_blank");

    // Copy the AI reply.
    const copied = await copyReplyText(pair.comment || "");

    if (!copied) {
        if (xTab) xTab.close();
        statusText.textContent =
            "Copy failed. Please copy the reply manually.";
        return;
    }

    if (!xTab) {
        statusText.textContent =
            "Popup blocked. Allow popups for YAPASSIST and try again.";
        return;
    }

    xTab.opener = null;
    xTab.location.href = pair.link;

    statusText.textContent =
        "Copied ✓ Open the post and paste your reply.";

    // Only record the claim after the user confirms replying.
    const repliedBtn = document.createElement("button");
    repliedBtn.type = "button";
    repliedBtn.className = "retry-btn";
    repliedBtn.textContent = "I replied";

    repliedBtn.addEventListener("click", async event => {
        event.stopPropagation();

        repliedBtn.disabled = true;
        repliedBtn.textContent = "Saving...";

        const result = await recordClaim(tweetId);

        if (!result || !result.ok) {
            repliedBtn.disabled = false;
            repliedBtn.textContent = "I replied";
            statusText.textContent =
                "Couldn't save the claim. Try again.";
            return;
        }

        pair.claimed = true;
        li.dataset.claimed = "true";
        linkText.textContent = `${pair.link} ✓ claimed`;
        statusText.textContent = "claimed";

        tag.remove();
        skipBtn.remove();
        repliedBtn.remove();
        li.classList.add("claimed");
        li.removeEventListener("click", handler);

        registerClaim();
    });

    li.appendChild(repliedBtn);
    li.removeEventListener("click", handler);
    return;
}

    // Preserve the existing reply-intent flow on iPhone and desktop.
    const replyUrl = pair.replyUrl ||
        `https://x.com/intent/tweet?in_reply_to=` +
        `${encodeURIComponent(tweetId)}&text=` +
        `${encodeURIComponent(pair.comment || "")}`;

    window.open(replyUrl, "_blank", "noopener,noreferrer");

    pair.claimed = true;
    li.dataset.claimed = "true";
    linkText.textContent = `${pair.link} ✓ claimed`;
    statusText.textContent = "claimed";

    tag.remove();
    skipBtn.remove();
    li.classList.add("claimed");
    li.removeEventListener("click", handler);

    registerClaim();
    recordClaim(tweetId);
});
       }

        linkList.appendChild(li);
        liElements[index] = li;
    });

    updatePacingUI();
}

// ============================================================
// EXTRACT BUTTON
// ============================================================

if (extractBtn) {
    extractBtn.addEventListener("click", () => {
        extractedLinks = extractLinks(linksInput.value);

        alert(`Extracted ${extractedLinks.length} links.`);
    });
}

// ============================================================
// CLEAR INPUT
// ============================================================

if (clearLinksInputBtn) {
    clearLinksInputBtn.addEventListener("click", () => {
        linksInput.value = "";
        linksInput.focus();
    });
}