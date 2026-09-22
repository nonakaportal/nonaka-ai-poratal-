// backend/services/quickbooks/balance-questions.service.js
//
// A balance sheet is the report small business owners skip. It is laid
// out for the person preparing it, not the person running the company,
// and its three totals only mean something once you know what question
// each one answers.
//
// So this asks the questions instead, and lets the balance sheet answer
// them: what would be left if you stopped today, can you cover what is
// due in the next year, and how much of what you own is actually yours.
//
// Every figure comes from the report. Nothing is modelled.

const quickbooksService = require('./quickbooks.service');

function round2(n) {
    return Math.round(Number(n || 0) * 100) / 100;
}

// The sentences below name real amounts, so they have to read like
// money rather than like a raw number. Keeping the wording and its
// figures together is what stops the two drifting apart.
function formatter(currency = 'USD') {
    let format;

    try {
        format = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format;
    } catch {
        // An unrecognised currency code should not take the page down.
        format = n => `${Number(n).toFixed(2)}`;
    }

    return n => format(Number(n || 0));
}

// The report nests sections several levels deep and names them
// consistently ("Current Assets", "Current Liabilities"). Finding one by
// name is more robust than assuming a position in the array.
function findSection(nodes, name) {
    const wanted = String(name).toLowerCase();

    for (const node of nodes || []) {
        if (String(node?.name || '').toLowerCase() === wanted) {
            return node;
        }

        const inside = findSection(node?.children, name);

        if (inside) return inside;
    }

    return null;
}

function sectionTotal(nodes, name) {
    const section = findSection(nodes, name);

    return section ? round2(section.amount) : null;
}

// Question 1: if you stopped trading today and settled up, what would
// be left over?
function whatWouldBeLeft(bs, money) {
    const assets = round2(bs?.totalAssets);
    const liabilities = round2(bs?.totalLiabilities);
    const left = round2(assets - liabilities);

    if (left < 0) {
        return {
            key: 'net-worth',
            question: 'If you stopped today, what would be left?',
            answer: left,
            tone: 'bad',
            headline: `You would still owe ${money(Math.abs(left))}`,
            detail:
                `Everything the business owns comes to ${money(assets)}, ` +
                `and it owes ${money(liabilities)}. Selling it all would ` +
                'not clear the debts.',
            parts: [
                { label: 'What the business owns', amount: assets },
                { label: 'What it owes', amount: -liabilities }
            ]
        };
    }

    return {
        key: 'net-worth',
        question: 'If you stopped today, what would be left?',
        answer: left,
        tone: left > 0 ? 'good' : 'warn',
        headline:
            left > 0
                ? 'There would be something left over'
                : 'You would come out exactly even',
        detail:
            `Everything the business owns comes to ${money(assets)}, ` +
            `and it owes ${money(liabilities)}.`,
        parts: [
            { label: 'What the business owns', amount: assets },
            { label: 'What it owes', amount: -liabilities }
        ]
    };
}

// Question 2: the one that actually keeps owners awake — can the next
// twelve months of bills be met out of what is to hand.
function canYouCoverWhatsDue(bs, money) {
    const currentAssets = sectionTotal(bs?.details?.assets, 'Current Assets');
    const currentLiabilities = sectionTotal(bs?.details?.liabilities, 'Current Liabilities');

    if (currentAssets === null || currentLiabilities === null) {
        return {
            key: 'cover',
            question: 'Could you cover what is due in the next year?',
            answer: null,
            tone: 'quiet',
            headline: 'Not enough detail in the report to say',
            detail:
                'QuickBooks did not break this balance sheet into current ' +
                'and longer-term, so the short-term picture cannot be ' +
                'separated out.',
            parts: []
        };
    }

    const surplus = round2(currentAssets - currentLiabilities);
    const cover = currentLiabilities > 0
        ? Math.round((currentAssets / currentLiabilities) * 100) / 100
        : null;

    const parts = [
        { label: 'Cash and money owed to you', amount: currentAssets },
        { label: 'Bills and debts due within a year', amount: -currentLiabilities }
    ];

    if (currentLiabilities === 0) {
        return {
            key: 'cover',
            question: 'Could you cover what is due in the next year?',
            answer: surplus,
            tone: 'good',
            headline: 'Nothing is due in the next year',
            detail: 'The business has no short-term debts on its books.',
            cover,
            parts
        };
    }

    if (surplus < 0) {
        return {
            key: 'cover',
            question: 'Could you cover what is due in the next year?',
            answer: surplus,
            tone: 'bad',
            headline: `You are ${money(Math.abs(surplus))} short`,
            detail:
                'What is due in the next year is more than the cash and ' +
                'customer payments you have to meet it with. Something has ' +
                'to come in, or a payment has to be pushed back.',
            cover,
            parts
        };
    }

    // Bare cover is not comfort: it assumes every customer pays on time
    // and nothing unexpected arrives.
    if (cover !== null && cover < 1.2) {
        return {
            key: 'cover',
            question: 'Could you cover what is due in the next year?',
            answer: surplus,
            tone: 'warn',
            headline: 'Only just',
            detail:
                `You have ${money(cover)} for every ${money(1)} you owe in the ` +
                'next year. That only works if your customers pay on time.',
            cover,
            parts
        };
    }

    return {
        key: 'cover',
        question: 'Could you cover what is due in the next year?',
        answer: surplus,
        tone: 'good',
        headline: 'Yes, with room to spare',
        detail:
            `You have ${money(cover)} for every ${money(1)} due in the next ` +
            `year, leaving ${money(surplus)} over.`,
        cover,
        parts
    };
}

// Question 3: of everything on the books, how much is the owner's and
// how much is really the lenders'.
function howMuchIsYours(bs, money) {
    const assets = round2(bs?.totalAssets);
    const liabilities = round2(bs?.totalLiabilities);
    const equity = round2(bs?.totalEquity);

    const parts = [
        { label: 'Funded by what you owe', amount: liabilities },
        { label: 'Funded by you and past profits', amount: equity }
    ];

    if (assets <= 0) {
        return {
            key: 'ownership',
            question: 'How much of what you own is actually yours?',
            answer: null,
            tone: 'quiet',
            headline: 'Nothing on the books to divide up',
            detail: 'The business has no assets recorded in QuickBooks.',
            parts: []
        };
    }

    const yourShare = Math.round((equity / assets) * 1000) / 10;

    if (equity < 0) {
        return {
            key: 'ownership',
            question: 'How much of what you own is actually yours?',
            answer: yourShare,
            tone: 'bad',
            headline: 'None of it, on paper',
            detail:
                'What the business owes is more than everything it owns, so ' +
                'there is no share left over for you. That happens after a ' +
                'run of losses or when the owner has taken more out than the ' +
                'business made.',
            parts
        };
    }

    if (yourShare < 25) {
        return {
            key: 'ownership',
            question: 'How much of what you own is actually yours?',
            answer: yourShare,
            tone: 'warn',
            headline: `About ${Math.round(yourShare)}% of it`,
            detail:
                'Most of what the business owns is funded by money it owes. ' +
                'That works while trading is steady and gets uncomfortable ' +
                'when it is not.',
            parts
        };
    }

    return {
        key: 'ownership',
        question: 'How much of what you own is actually yours?',
        answer: yourShare,
        tone: 'good',
        headline: `About ${Math.round(yourShare)}% of it`,
        detail:
            `Of everything on the books, ${Math.round(yourShare)}% is yours ` +
            'and the rest is funded by what the business owes.',
        parts
    };
}

function buildBalanceQuestions(bs) {
    const money = formatter(bs?.currency || 'USD');

    const assets = round2(bs?.totalAssets);
    const liabilities = round2(bs?.totalLiabilities);
    const equity = round2(bs?.totalEquity);

    // A balance sheet that does not balance means the report was read
    // wrongly, and every answer below it would inherit the error.
    const drift = round2(assets - (liabilities + equity));

    return {
        asOf: bs?.period?.endDate || bs?.period?.startDate || null,
        currency: bs?.currency || 'USD',
        hasData: Boolean(bs?.hasData) && assets !== 0,
        totals: { assets, liabilities, equity },
        questions: [
            whatWouldBeLeft(bs, money),
            canYouCoverWhatsDue(bs, money),
            howMuchIsYours(bs, money)
        ],
        balances: Math.abs(drift) < 0.02,
        drift
    };
}

async function getBalanceQuestions(connection, { asOf } = {}) {
    const accessToken =
        await quickbooksService.getValidAccessToken(connection);

    const report = await quickbooksService.getBalanceSheet(
        accessToken,
        connection.realmId,
        asOf
    );

    return buildBalanceQuestions(quickbooksService.parseBalanceSheet(report));
}

module.exports = {
    getBalanceQuestions,
    buildBalanceQuestions,
    _internals: {
        findSection,
        sectionTotal,
        whatWouldBeLeft,
        canYouCoverWhatsDue,
        howMuchIsYours
    }
};
