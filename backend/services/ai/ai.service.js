// backend/services/ai/ai.service.js
//
// Nonaka AI's features: anomaly detection, recommendations, the health
// score, and chat, answered by NVIDIA or Anthropic depending on
// AI_PROVIDER. Every call is grounded
// in the real QuickBooks data assembled by financial-context.service.js
// — the system prompt explicitly forbids inventing figures.

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

// Chat is free-form conversation where reasoning quality matters most, so
// it stays on Opus with default (high) thinking effort. The other three
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

// Which backend answers the AI features. Claude ("anthropic") is the real
// provider and the default; "nvidia" calls NVIDIA's OpenAI-compatible API
// and is only a stand-in for testing while the Anthropic account is out
// of credits.
const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
// deepseek-v4.1-flash took minutes per reply on the free tier; Nemotron
// answers in seconds and follows the JSON schemas reliably.
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

let client = null;

function getClient() {
    const apiKey = process.env.CLAUDE_API_KEY;

    if (!apiKey || apiKey === 'your_claude_api_key') {
        const error = new Error(
            'AI features require a Claude API key. Add a real CLAUDE_API_KEY to your .env file.'
        );

        error.code = 'AI_KEY_NOT_CONFIGURED';

        throw error;
    }

    if (!client) {
        client = new Anthropic({ apiKey });
    }

    return client;
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
// NVIDIA
//
// The hosted models don't all support a strict schema mode, so the JSON
// Schema goes in the prompt and the reply is validated against the same
// zod schema the Anthropic path uses. A reply that doesn't fit throws,
// which the routes turn into their normal "unable to load" state.
// ============================================================

async function nvidiaComplete(messages, maxTokens) {
    const apiKey = process.env.NVIDIA_API_KEY;

    if (!apiKey) {
        const error = new Error(
            'AI features require an NVIDIA API key. Add NVIDIA_API_KEY to your .env file.'
        );

        error.code = 'AI_KEY_NOT_CONFIGURED';

        throw error;
    }

    // The free tier regularly answers "Service temporarily overloaded"
    // (503) or rate-limits (429); a couple of spaced retries clears most.
    let response;

    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, attempt * 3000));
        }

        response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: NVIDIA_MODEL,
                max_tokens: maxTokens,
                messages
            })
        });

        if (response.status !== 503 && response.status !== 429) break;
    }

    if (!response.ok) {
        const error = new Error(
            `NVIDIA API error ${response.status}: ${(await response.text()).slice(0, 300)}`
        );

        error.status = response.status;

        throw error;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Reasoning models sometimes inline their thinking; never show it.
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function nvidiaStructured(prompt, schema) {
    const text = await nvidiaComplete(
        [
            { role: 'system', content: SYSTEM_PROMPT },
            {
                role: 'user',
                content:
                    prompt +
                    '\n\nRespond with only a JSON object matching this JSON Schema ' +
                    '— no prose, no code fences:\n' +
                    JSON.stringify(z.toJSONSchema(schema))
            }
        ],
        8192
    );

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start === -1 || end === -1) {
        throw new Error('NVIDIA response contained no JSON object');
    }

    return schema.parse(JSON.parse(text.slice(start, end + 1)));
}

// ============================================================
// SCHEMAS
// ============================================================

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
                .describe('The specific figures from the data that support this finding'),
            explanation: z
                .string()
                .describe(
                    'Shown when the owner opens the card: 3-5 plain-language sentences ' +
                    'walking through what happened, citing each figure and the simple ' +
                    'math that connects them (differences, percentages, ratios)'
                ),
            futureImpact: z
                .string()
                .describe(
                    'What is likely to happen to the business in the next few months ' +
                    'if this continues, with estimated figures where the data supports ' +
                    'them. Say plainly when the data is too thin to estimate.'
                ),
            keyFigures: z
                .array(
                    z.object({
                        label: z.string().describe('Plain-language name, e.g. "What you owe"'),
                        value: z.string().describe('The figure as it should be shown, e.g. "$31,131.33"')
                    })
                )
                .describe('2-3 figures taken straight from the data that sum up this finding')
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
            expectedImpact: z.string(),
            steps: z
                .string()
                .describe(
                    'Shown when the owner opens the card: how to actually do this, as ' +
                    '2-4 short concrete steps, citing the figures involved'
                ),
            benefit: z
                .string()
                .describe(
                    'The estimated benefit in numbers and how it was worked out from ' +
                    'the data (e.g. "$4,114 overdue x ~80% collected = ~$3,300 more ' +
                    'cash"), plus what it changes for the business'
                )
        })
    )
});

// ============================================================
// FEATURES
// ============================================================

// The three fixed-schema features share one shape: a prompt plus a schema,
// answered by whichever provider is active.
async function structured(prompt, schema) {
    if (PROVIDER !== 'anthropic') {
        return nvidiaStructured(prompt, schema);
    }

    const client = getClient();

    // 8192 leaves room for the longer explanation fields on top of the
    // thinking budget.
    const response = await client.messages.parse({
        model: FAST_MODEL,
        max_tokens: 8192,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        output_config: {
            effort: 'low',
            format: zodOutputFormat(schema)
        }
    });

    return response.parsed_output;
}

async function detectAnomalies(snapshot, trend) {
    return structured(
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
        `Current snapshot:\n${JSON.stringify(snapshot)}`,
        AnomalySchema
    );
}

async function generateRecommendations(snapshot, trend) {
    return structured(
        'Based on this company\'s real financial snapshot and ' +
        '6-month trend (JSON below), give 3-6 concrete, ' +
        'actionable recommendations a small-business owner ' +
        'could actually act on this month. Ground every ' +
        'recommendation in a specific figure from the data.\n\n' +
        `Monthly trend:\n${JSON.stringify(trend)}\n\n` +
        `Current snapshot:\n${JSON.stringify(snapshot)}`,
        RecommendationSchema
    );
}

async function generateHealthScore(snapshot, trend) {
    return structured(
        'Score this company\'s overall financial health from 0-100 based ' +
        'on the real snapshot and 6-month trend (JSON below). Weigh ' +
        'profitability, cash/liquidity position, receivables and payables ' +
        'health, debt load relative to assets, and revenue stability. ' +
        'Cite the specific figures that drove the score in each factor.\n\n' +
        `Monthly trend:\n${JSON.stringify(trend)}\n\n` +
        `Current snapshot:\n${JSON.stringify(snapshot)}`,
        HealthScoreSchema
    );
}

async function chat(question, snapshot, history = []) {
    const contextualSystem =
        SYSTEM_PROMPT +
        '\n\nCurrent financial snapshot for this company (JSON):\n' +
        JSON.stringify(snapshot);

    if (PROVIDER !== 'anthropic') {
        const answer = await nvidiaComplete(
            [
                { role: 'system', content: contextualSystem },
                ...history,
                { role: 'user', content: question }
            ],
            8192
        );

        return answer || "I wasn't able to generate a response.";
    }

    const client = getClient();

    // Adaptive thinking spends from the same max_tokens budget as the
    // answer. At 2048 a question that needed some thought could use it all
    // up and come back truncated or empty, so leave room for both. Only the
    // tokens actually generated are billed.
    const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
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
    detectAnomalies,
    generateRecommendations,
    generateHealthScore,
    chat
};
