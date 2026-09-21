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
// Forecast/anomalies/recommendations/health-score each cost a real
// Claude call. QuickBooks data doesn't change second-to-second, so
// there's no reason to regenerate on every page visit — cache the
// finished response for a few minutes, shared across everyone hitting
// the same organization (including concurrent in-flight requests).
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

// ============================================================
// FORECAST
// ============================================================

router.get("/forecast", async (req, res) => {
    const { organizationId } = req.query;

    if (!organizationId) {
        return res.status(400).json({ error: "organizationId is required" });
    }

    try {
        const result = await withResultCache(`forecast:${organizationId}`, async () => {
            const snapshot = await financialContext.buildFinancialSnapshot(organizationId);
            const trend = await financialContext.buildMonthlyTrend(organizationId, 6);
            const forecast = await aiService.generateForecast(snapshot, trend);

            return { forecast, trend };
        });

        return res.json(result);
    } catch (error) {
        return handleAIError(error, res, "generate forecast");
    }
});

// ============================================================
// ANOMALIES
// ============================================================

router.get("/anomalies", async (req, res) => {
    const { organizationId } = req.query;

    if (!organizationId) {
        return res.status(400).json({ error: "organizationId is required" });
    }

    try {
        const result = await withResultCache(`anomalies:${organizationId}`, async () => {
            const snapshot = await financialContext.buildFinancialSnapshot(organizationId);
            const trend = await financialContext.buildMonthlyTrend(organizationId, 6);

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
    const { organizationId } = req.query;

    if (!organizationId) {
        return res.status(400).json({ error: "organizationId is required" });
    }

    try {
        const result = await withResultCache(`recommendations:${organizationId}`, async () => {
            const snapshot = await financialContext.buildFinancialSnapshot(organizationId);
            const trend = await financialContext.buildMonthlyTrend(organizationId, 6);

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
    const { organizationId } = req.query;

    if (!organizationId) {
        return res.status(400).json({ error: "organizationId is required" });
    }

    try {
        const result = await withResultCache(`health-score:${organizationId}`, async () => {
            const snapshot = await financialContext.buildFinancialSnapshot(organizationId);
            const trend = await financialContext.buildMonthlyTrend(organizationId, 6);
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
// ============================================================

router.post("/ask", async (req, res) => {
    try {
        const { organizationId, question, history } = req.body;

        if (!organizationId) {
            return res.status(400).json({
                error: "organizationId is required"
            });
        }

        if (!question) {
            return res.status(400).json({
                error: "question is required"
            });
        }

        console.log("Nonaka AI question:", question);

        const snapshot =
            await financialContext.buildFinancialSnapshot(organizationId);

        const answer = await aiService.chat(
            question,
            snapshot,
            Array.isArray(history) ? history : []
        );

        return res.json({ answer });
    } catch (error) {
        return handleAIError(error, res, "process AI request");
    }
});

module.exports = router;
