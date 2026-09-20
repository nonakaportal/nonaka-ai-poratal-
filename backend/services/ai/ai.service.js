// backend/services/ai/ai.service.js
//
// Wraps the Anthropic SDK for Nonaka AI's four features: forecasts,
// anomaly detection, recommendations, and chat. Every call is grounded
// in the real QuickBooks data assembled by financial-context.service.js
// — the system prompt explicitly forbids inventing figures.

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

// Chat is free-form conversation where reasoning quality matters most, so
// it stays on Opus with default (high) thinking effort. The other four
// calls all fill in a fixed schema from data that's already been
// summarized for them — a much more bounded task — so they run on Sonnet
// with thinking effort capped to "low". Thinking is on by default on both
// models and can't be fully disabled without giving up structured-output
// reliability (disabled-thinking mode is prone to leaking raw text instead
// of valid JSON), so effort is the actual lever: it caps how many
// thinking tokens the model spends before answering, which is what was
// driving most of the latency (measured ~500-750 thinking tokens per call
// even with no explicit thinking budget requested).
const MODEL = 'claude-opus-5';
const FAST_MODEL = 'claude-sonnet-5';

function getClient() {
    const apiKey = process.env.CLAUDE_API_KEY;

    if (!apiKey || apiKey === 'your_claude_api_key') {
        const error = new Error(
            'AI features require a Claude API key. Add a real CLAUDE_API_KEY to your .env file.'
        );

        error.code = 'AI_KEY_NOT_CONFIGURED';

        throw error;
    }

    return new Anthropic({ apiKey });
}

const SYSTEM_PROMPT =
    'You are Nonaka AI, a financial analyst embedded in a small-business ' +
    'accounting platform. You are given real QuickBooks-derived data for ' +
    'one company in each request. Base every claim strictly on that data ' +
    '— never invent figures, account names, or trends that are not ' +
    'present in it. If the data provided is insufficient to support a ' +
    'confident conclusion, say so explicitly rather than guessing. Keep ' +
    'language plain and direct, suitable for a small-business owner, not ' +
    'an accountant. When you write free-text answers, format them for a ' +
    'chat window: short paragraphs, occasional bullet points, and no ' +
    'large markdown tables.';

// ============================================================
// SCHEMAS
// ============================================================

const ForecastSchema = z.object({
    narrative: z
        .string()
        .describe('2-4 sentence plain-language summary of the projection and why'),
    monthlyProjection: z
        .array(
            z.object({
                label: z.string().describe('Month label, e.g. "Nov 26"'),
                projectedRevenue: z.number(),
                projectedNetIncome: z.number()
            })
        )
        .describe('Projected figures for the next periods, in chronological order'),
    confidence: z.enum(['low', 'medium', 'high']),
    keyAssumptions: z
        .array(z.string())
        .describe('Short bullet points on what the projection assumes')
});

const AnomalySchema = z.object({
    anomalies: z.array(
        z.object({
            title: z.string(),
            severity: z.enum(['low', 'medium', 'high']),
            category: z.enum([
                'revenue',
                'expenses',
                'cashflow',
                'receivables',
                'payables',
                'debt',
                'margin'
            ]),
            description: z.string(),
            evidence: z
                .string()
                .describe('The specific figures from the data that support this finding')
        })
    )
});

const HealthScoreSchema = z.object({
    score: z
        .number()
        .min(0)
        .max(100)
        .describe('Overall financial health score, 0 (critical) to 100 (excellent)'),
    rating: z.enum(['critical', 'weak', 'fair', 'good', 'strong']),
    summary: z
        .string()
        .describe('2-3 sentence plain-language explanation of the score'),
    factors: z
        .array(
            z.object({
                label: z.string().describe('Short factor name, e.g. "Cash reserves"'),
                impact: z.enum(['positive', 'negative', 'neutral']),
                detail: z
                    .string()
                    .describe('One sentence citing the specific figure behind this factor')
            })
        )
        .describe('3-5 factors that most influenced the score, each grounded in a specific figure')
});

const ReceiptSchema = z.object({
    vendor: z.string().nullable().describe('Merchant/vendor name as printed on the receipt, or null if illegible'),
    date: z.string().nullable().describe('Purchase date in YYYY-MM-DD format, or null if not visible'),
    amount: z.number().nullable().describe('Total amount paid, or null if not visible'),
    category: z.enum([
        'supplies',
        'materials',
        'equipment',
        'travel',
        'meals',
        'utilities',
        'rent',
        'professional-services',
        'marketing',
        'other'
    ]).describe('Best-guess expense category based on what was purchased'),
    confidence: z.enum(['low', 'medium', 'high']).describe('How confident the extraction is overall'),
    notes: z.string().nullable().describe('Anything unclear, missing, or worth the owner double-checking before entering this into QuickBooks')
});

const RecommendationSchema = z.object({
    recommendations: z.array(
        z.object({
            title: z.string(),
            priority: z.enum(['low', 'medium', 'high']),
            category: z.enum([
                'revenue',
                'expenses',
                'cashflow',
                'receivables',
                'payables',
                'debt',
                'margin'
            ]),
            description: z.string(),
            expectedImpact: z.string()
        })
    )
});

// ============================================================
// FEATURES
// ============================================================

async function generateForecast(snapshot, trend) {
    const client = getClient();

    const response = await client.messages.parse({
        model: FAST_MODEL,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        messages: [
            {
                role: 'user',
                content:
                    'Here is this company\'s real monthly financial trend ' +
                    '(oldest to newest) and current snapshot, as JSON. ' +
                    'Project the next 3 months of revenue and net income ' +
                    'based on the actual trend shown — do not assume growth ' +
                    'that is not supported by the data.\n\n' +
                    `Monthly trend:\n${JSON.stringify(trend)}\n\n` +
                    `Current snapshot:\n${JSON.stringify(snapshot)}`
            }
        ],
        output_config: {
            effort: 'low',
            format: zodOutputFormat(ForecastSchema)
        }
    });

    return response.parsed_output;
}

async function detectAnomalies(snapshot, trend) {
    const client = getClient();

    const response = await client.messages.parse({
        model: FAST_MODEL,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        messages: [
            {
                role: 'user',
                content:
                    'Analyze this company\'s real financial snapshot and ' +
                    '6-month trend (JSON below) for genuine anomalies — ' +
                    'unusual spikes or drops, deteriorating margins, aging ' +
                    'receivables/payables, concentration risk in top ' +
                    'customers/vendors, or anything that looks out of line ' +
                    'with the rest of the trend. Only report findings you ' +
                    'can point to specific numbers for. If nothing stands ' +
                    'out, return an empty list rather than inventing an ' +
                    'anomaly.\n\n' +
                    `Monthly trend:\n${JSON.stringify(trend)}\n\n` +
                    `Current snapshot:\n${JSON.stringify(snapshot)}`
            }
        ],
        output_config: {
            effort: 'low',
            format: zodOutputFormat(AnomalySchema)
        }
    });

    return response.parsed_output;
}

async function generateRecommendations(snapshot, trend) {
    const client = getClient();

    const response = await client.messages.parse({
        model: FAST_MODEL,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        messages: [
            {
                role: 'user',
                content:
                    'Based on this company\'s real financial snapshot and ' +
                    '6-month trend (JSON below), give 3-6 concrete, ' +
                    'actionable recommendations a small-business owner ' +
                    'could actually act on this month. Ground every ' +
                    'recommendation in a specific figure from the data.\n\n' +
                    `Monthly trend:\n${JSON.stringify(trend)}\n\n` +
                    `Current snapshot:\n${JSON.stringify(snapshot)}`
            }
        ],
        output_config: {
            effort: 'low',
            format: zodOutputFormat(RecommendationSchema)
        }
    });

    return response.parsed_output;
}

async function generateHealthScore(snapshot, trend) {
    const client = getClient();

    const response = await client.messages.parse({
        model: FAST_MODEL,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        messages: [
            {
                role: 'user',
                content:
                    'Score this company\'s overall financial health from 0-100 based ' +
                    'on the real snapshot and 6-month trend (JSON below). Weigh ' +
                    'profitability, cash/liquidity position, receivables and payables ' +
                    'health, debt load relative to assets, and revenue stability. ' +
                    'Cite the specific figures that drove the score in each factor.\n\n' +
                    `Monthly trend:\n${JSON.stringify(trend)}\n\n` +
                    `Current snapshot:\n${JSON.stringify(snapshot)}`
            }
        ],
        output_config: {
            effort: 'low',
            format: zodOutputFormat(HealthScoreSchema)
        }
    });

    return response.parsed_output;
}

const RECEIPT_SYSTEM_PROMPT =
    'You are a receipt-reading assistant for a small-business accounting ' +
    'app. You are given a photo of a single receipt. Extract only what is ' +
    'actually visible in the image — never guess or invent a vendor name, ' +
    'amount, or date that you cannot actually read. If something is ' +
    'blurry, cut off, or missing, say so in notes and leave that field ' +
    'null rather than fabricating a plausible-looking value. This is for ' +
    'a real business expense record, so accuracy matters more than ' +
    'completeness.';

// Image never leaves the server unprocessed — the frontend only ever
// receives the structured result below, never the raw Claude response.
// Always expects JPEG: the frontend resizes/compresses to JPEG before
// upload, so there's one fixed media type to trust here rather than
// accepting an arbitrary client-supplied one.
async function scanReceipt(imageBase64) {
    const client = getClient();

    const response = await client.messages.parse({
        model: FAST_MODEL,
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
        system: RECEIPT_SYSTEM_PROMPT,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/jpeg',
                            data: imageBase64
                        }
                    },
                    {
                        type: 'text',
                        text: 'Extract the vendor, date, total amount, and likely expense category from this receipt.'
                    }
                ]
            }
        ],
        output_config: {
            effort: 'low',
            format: zodOutputFormat(ReceiptSchema)
        }
    });

    return response.parsed_output;
}

async function chat(question, snapshot, history = []) {
    const client = getClient();

    const contextualSystem =
        SYSTEM_PROMPT +
        '\n\nCurrent financial snapshot for this company (JSON):\n' +
        JSON.stringify(snapshot);

    const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        thinking: { type: 'adaptive' },
        system: contextualSystem,
        messages: [
            ...history,
            { role: 'user', content: question }
        ]
    });

    const textBlock = response.content.find(block => block.type === 'text');

    return textBlock?.text || "I wasn't able to generate a response.";
}

module.exports = {
    generateForecast,
    detectAnomalies,
    generateRecommendations,
    generateHealthScore,
    scanReceipt,
    chat
};
