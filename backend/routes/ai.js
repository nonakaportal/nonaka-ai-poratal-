const express = require("express");

const router = express.Router();

const financialContext = require("../services/ai/financial-context.service");
const aiService = require("../services/ai/ai.service");
const { requireOrgAccess } = require("../middleware/auth.middleware");

// Every route below reads or generates data scoped to an organizationId.
// requireOrgAccess verifies the caller is authenticated and actually
// belongs to that organization before any of it runs.
router.use(requireOrgAccess);

// ============================================================
// SHARED ERROR HANDLING
//
// Every AI route needs to distinguish three failure modes for the
// frontend: no Claude key configured yet, QuickBooks not connected,
// and everything else. All three need different UI treatment.
// ============================================================

function handleAIError(error, res, label) {
    console.error(`${label} failed:`, error.message);

    if (error.code === "AI_KEY_NOT_CONFIGURED") {
        return res.status(503).json({
            error: error.message,
            code: "AI_KEY_NOT_CONFIGURED"
        });
    }

    if (error.message === "QuickBooks is not connected") {
        return res.status(400).json({
            error: error.message,
            code: "QB_NOT_CONNECTED"
        });
    }

    if (error.code === "QB_REAUTH_REQUIRED") {
        return res.status(400).json({
            error: "Your QuickBooks connection has expired. Reconnect to keep seeing your numbers.",
            code: "QB_REAUTH_REQUIRED"
        });
    }

    // An exhausted Anthropic balance used to fall through to the generic
    // 500 below, so every AI panel just said "unable to load" — which
    // reads as a bug in the app and sends the owner looking for a fault
    // that isn't theirs. It's an account problem with a specific fix, so
    // it gets its own code and its own wording.
    if (
        error.status === 400 &&
        /credit balance is too low/i.test(error.message || "")
    ) {
        return res.status(503).json({
            error:
                "The AI features are paused because this account is out of Anthropic credits. " +
                "Everything else in the portal still works.",
            code: "AI_NO_CREDITS"
        });
    }

    return res.status(500).json({
        error: `Failed to ${label}`
    });
}

// ============================================================
// RESULT CACHE
//
// Anomalies/recommendations/health-score each cost a real Claude call.
// QuickBooks data doesn't change second-to-second, so there's no reason
// to regenerate on every page visit — cache the finished response for a
// few minutes, shared across everyone hitting the same organization
// (including concurrent in-flight requests).
// ============================================================

const RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const resultCache = new Map();

function withResultCache(key, factory) {
    const cached = resultCache.get(key);

    if (cached && Date.now() - cached.time < RESULT_CACHE_TTL_MS) {
        return cached.promise;
    }

    const promise = factory().catch(error => {
        resultCache.delete(key);
        throw error;
    });

    resultCache.set(key, { promise, time: Date.now() });

    return promise;
}

// Snapshot and trend are independent QuickBooks reads, so they load
// together rather than one after the other.
function loadContext(organizationId) {
    return Promise.all([
        financialContext.buildFinancialSnapshot(organizationId),
        financialContext.buildMonthlyTrend(organizationId, 6)
    ]);
}

// ============================================================
// ANOMALIES
// ============================================================

router.get("/anomalies", async (req, res) => {
    const organizationId = req.organizationId;

    try {
        const result = await withResultCache(`anomalies:${organizationId}`, async () => {
            const [snapshot, trend] = await loadContext(organizationId);

            return aiService.detectAnomalies(snapshot, trend);
        });

        return res.json(result);
    } catch (error) {
        return handleAIError(error, res, "detect anomalies");
    }
});

// ============================================================
// RECOMMENDATIONS
// ============================================================

router.get("/recommendations", async (req, res) => {
    const organizationId = req.organizationId;

    try {
        const result = await withResultCache(`recommendations:${organizationId}`, async () => {
            const [snapshot, trend] = await loadContext(organizationId);

            return aiService.generateRecommendations(snapshot, trend);
        });

        return res.json(result);
    } catch (error) {
        return handleAIError(error, res, "generate recommendations");
    }
});

// ============================================================
// HEALTH SCORE
// ============================================================

router.get("/health-score", async (req, res) => {
    const organizationId = req.organizationId;

    try {
        const result = await withResultCache(`health-score:${organizationId}`, async () => {
            const [snapshot, trend] = await loadContext(organizationId);
            const health = await aiService.generateHealthScore(snapshot, trend);

            return { health };
        });

        return res.json(result);
    } catch (error) {
        return handleAIError(error, res, "calculate financial health score");
    }
});

// ============================================================
// CHAT
//
// The conversation history comes from the browser, so it is untrusted:
// only plain user/assistant text turns are passed on, and both their
// number and their length are capped. Anything else — system-role
// turns, tool or document blocks, an unbounded transcript — would let a
// request steer the model or run up the Claude bill.
// ============================================================

const MAX_QUESTION_CHARS = 2000;
const MAX_HISTORY_TURNS = 20;
const MAX_TURN_CHARS = 8000;

function cleanHistory(history) {
    if (!Array.isArray(history)) return [];

    const turns = history
        .filter(turn =>
            turn &&
            (turn.role === "user" || turn.role === "assistant") &&
            typeof turn.content === "string" &&
            turn.content.trim()
        )
        .slice(-MAX_HISTORY_TURNS)
        .map(turn => ({
            role: turn.role,
            content: turn.content.slice(0, MAX_TURN_CHARS)
        }));

    // A conversation has to open with the user.
    while (turns.length && turns[0].role !== "user") {
        turns.shift();
    }

    return turns;
}

router.post("/ask", async (req, res) => {
    // The organization comes from the access check, never from the body:
    // the body is where a caller would put someone else's.
    const organizationId = req.organizationId;
    const { question, history } = req.body;

    if (typeof question !== "string" || !question.trim()) {
        return res.status(400).json({ error: "question is required" });
    }

    if (question.length > MAX_QUESTION_CHARS) {
        return res.status(400).json({
            error: `Please keep questions under ${MAX_QUESTION_CHARS} characters.`
        });
    }

    try {
        const snapshot = await financialContext.buildFinancialSnapshot(organizationId);

        const answer = await aiService.chat(
            question.trim(),
            snapshot,
            cleanHistory(history)
        );

        return res.json({ answer });
    } catch (error) {
        return handleAIError(error, res, "process AI request");
    }
});

function forgetOrganization(organizationId) {
    for (const key of resultCache.keys()) {
        if (key.endsWith(`:${organizationId}`)) {
            resultCache.delete(key);
        }
    }
}

module.exports = router;
module.exports.forgetOrganization = forgetOrganization;
module.exports._internals = { cleanHistory };
