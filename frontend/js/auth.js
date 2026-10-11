// ============================================================
// NONAKA FINANCIAL PARTNERS — AUTH
// Supabase Auth + Backend Session
// ============================================================

// Network calls go through NFK_Api.request (api.js).

// ------------------------------------------------------------
// SIGN UP
// ------------------------------------------------------------

async function signup(email, password, fullName, organizationName) {
    try {
        const { ok, data } = await NFK_Api.request("/auth/signup", {
            method: "POST",
            auth: false,
            body: {
                email,
                password,
                fullName,
                organizationName
            }
        });

        if (!ok) {
            throw new Error(
                data.error || "Signup failed"
            );
        }

        // Nothing is stored: signing up creates no session, so a saved user
        // here would look logged in on the next page load with no way to
        // make an authenticated call. login() stores what the portal needs.
        return data;

    } catch (error) {
        console.error("Signup error:", error);
        throw error;
    }
}

// --------------------------------------------------------
// Inline field/banner errors, replacing the alert() dialogs signup
// used to use — an alert interrupts the whole page and pushes what the
// user typed out of view, which is the wrong tone for someone already
// nervous about the money side of their business.
// --------------------------------------------------------

const SIGNUP_FIELDS = [
    "signup-name",
    "signup-organization",
    "signup-email",
    "signup-password",
    "signup-confirm-password"
];

function setFieldError(fieldId, message) {
    const el = document.getElementById(`err-${fieldId}`);
    if (el) el.textContent = message || "";
}

function clearSignupErrors() {
    SIGNUP_FIELDS.forEach(id => setFieldError(id, ""));
    hideAuthError();
}

function showAuthError(message) {
    const box = document.getElementById("auth-error");
    const msg = document.getElementById("auth-error-msg");
    if (msg) msg.textContent = message;
    if (box) box.style.display = "flex";
}

function hideAuthError() {
    const box = document.getElementById("auth-error");
    if (box) box.style.display = "none";
}

async function handleSignup() {

    const value = id => document.getElementById(id).value;

    const fullName = value("signup-name").trim();
    const organizationName = value("signup-organization").trim();
    const email = value("signup-email").trim();
    const password = value("signup-password");
    const confirmPassword = value("signup-confirm-password");

    clearSignupErrors();

    // --------------------------------------------------------
    // VALIDATION — each problem is reported against the field it
    // belongs to, and all of them at once rather than one per submit.
    // --------------------------------------------------------

    let firstBad = null;

    const require = (id, val, message) => {
        if (!val) {
            setFieldError(id, message);
            firstBad = firstBad || id;
        }
    };

    require("signup-name", fullName, "Please enter your name.");
    require("signup-organization", organizationName, "Please enter your business name.");
    require("signup-email", email, "Please enter your email address.");
    require("signup-password", password, "Please choose a password.");
    require("signup-confirm-password", confirmPassword, "Please confirm your password.");

    if (password && password.length < 6) {
        setFieldError("signup-password", "Use at least 6 characters.");
        firstBad = firstBad || "signup-password";
    }

    if (password && confirmPassword && password !== confirmPassword) {
        setFieldError("signup-confirm-password", "These passwords don't match.");
        firstBad = firstBad || "signup-confirm-password";
    }

    if (firstBad) {
        document.getElementById(firstBad)?.focus();
        return;
    }

    const btn = document.getElementById("signup-btn");
    const btnText = document.getElementById("signup-btn-text");
    const btnSpin = document.getElementById("signup-btn-spin");

    if (btn) btn.disabled = true;
    if (btnText) btnText.style.display = "none";
    if (btnSpin) btnSpin.style.display = "inline-block";

    try {

        const data =
            await signup(
                email,
                password,
                fullName,
                organizationName
            );

        // Supabase blocks sign-in until the emailed link is clicked, so
        // dropping the user back on the form would only earn them a
        // failed login. The confirmation pane says what to do instead.
        const sentMsg = document.getElementById("signup-sent-msg");

        if (sentMsg) {
            sentMsg.textContent = data.needsEmailConfirmation
                ? `We've sent a confirmation link to ${email}. Click it to activate your account, then sign in.`
                : "Your account is ready. You can sign in now.";
        }

        showSentPane();

    } catch (error) {

        console.error("Signup failed:", error);

        showAuthError(
            error.message ||
            "Couldn't create your account. Please try again."
        );

    } finally {
        if (btn) btn.disabled = false;
        if (btnText) btnText.style.display = "";
        if (btnSpin) btnSpin.style.display = "none";
    }
}

// ------------------------------------------------------------
// LOGIN
// ------------------------------------------------------------

async function login(email, password) {

    // Get values from login form when called from HTML
    if (!email) {
        email = document
            .getElementById("login-email")
            .value
            .trim();
    }

    if (!password) {
        password = document
            .getElementById("login-password")
            .value;
    }

    try {
        const { ok, data } = await NFK_Api.request("/auth/login", {
            method: "POST",
            auth: false,
            body: {
                email,
                password
            }
        });

        if (!ok) {
            throw new Error(data.error || "Login failed");
        }

        // ----------------------------------------------------
        // SAVE USER
        // ----------------------------------------------------

        if (data.user) {
            localStorage.setItem(
                "nfk_user",
                JSON.stringify(data.user)
            );
        }

        // ----------------------------------------------------
        // SAVE PROFILE
        // ----------------------------------------------------

        if (data.profile) {
            localStorage.setItem(
                "nfk_profile",
                JSON.stringify(data.profile)
            );
        }

        // ----------------------------------------------------
        // SAVE ORGANIZATION
        // ----------------------------------------------------

        if (data.organization) {
            localStorage.setItem(
                "nfk_organization",
                JSON.stringify(data.organization)
            );

            localStorage.setItem(
                "nfk-organization-id",
                data.organization.id
            );
        }

        // Everything this person can see. Usually one company; an owner
        // with two, or an advisor looking after several, gets a switcher
        // in the top bar built from this list.
        if (Array.isArray(data.organizations)) {
            localStorage.setItem(
                "nfk_organizations",
                JSON.stringify(data.organizations)
            );
        }

        // ----------------------------------------------------
        // SAVE SESSION
        // ----------------------------------------------------

        if (data.session) {
            localStorage.setItem(
                "nfk_session",
                JSON.stringify(data.session)
            );
        }

        // ----------------------------------------------------
        // NAVIGATE PAST THE LOGIN SCREEN
        // ----------------------------------------------------

        await routeAfterLogin();

        return data;

    } catch (error) {
        console.error("Login failed:", error.message);
        throw error;
    }
}


// ------------------------------------------------------------
// HANDLE LOGIN BUTTON (loading state + error display)
// ------------------------------------------------------------

async function handleLoginClick() {
    const btn = document.getElementById("login-btn");
    const btnText = document.getElementById("login-btn-text");
    const btnSpin = document.getElementById("login-btn-spin");

    hideAuthError();

    if (btn) btn.disabled = true;
    if (btnText) btnText.style.display = "none";
    if (btnSpin) btnSpin.style.display = "inline-block";

    try {
        await login();
    } catch (error) {
        showAuthError(error.message || "Invalid email or password.");
    } finally {
        if (btn) btn.disabled = false;
        if (btnText) btnText.style.display = "inline";
        if (btnSpin) btnSpin.style.display = "none";
    }
}

// ------------------------------------------------------------
// GET SAVED USER
// ------------------------------------------------------------

function getCurrentUser() {
    const user = localStorage.getItem("nfk_user");

    if (!user) {
        return null;
    }

    try {
        return JSON.parse(user);
    } catch {
        return null;
    }
}


// ------------------------------------------------------------
// GET CURRENT ORGANIZATION
// ------------------------------------------------------------

function getCurrentOrganization() {
    const organization =
        localStorage.getItem("nfk_organization");

    if (!organization) {
        return null;
    }

    try {
        return JSON.parse(organization);
    } catch {
        return null;
    }
}


// ------------------------------------------------------------
// GET ORGANIZATION ID
// ------------------------------------------------------------

function getOrganizationId() {

    const organization =
        getCurrentOrganization();

    if (!organization) {
        return null;
    }

    return organization.id;
}


// ------------------------------------------------------------
// EVERY COMPANY THIS PERSON CAN SEE
// ------------------------------------------------------------

function getOrganizations() {
    try {
        const list =
            JSON.parse(
                localStorage.getItem("nfk_organizations") || "null"
            );

        if (Array.isArray(list) && list.length) {
            return list;
        }
    } catch {
        // Fall through to the single active organization below.
    }

    // Sessions that predate the switcher only stored the active one.
    const current = getCurrentOrganization();

    return current ? [current] : [];
}


// Switches which company the portal is looking at.
//
// This reloads the page rather than re-rendering in place. Every page
// holds its own fetched figures — the twelve-month history, the ratio
// trends, the scenario baseline — and showing one company's numbers
// under another company's name would be a serious thing to get wrong.
// A reload guarantees nothing survives the switch.
function setActiveOrganization(organizationId) {
    const match =
        getOrganizations().find(o => o.id === organizationId);

    if (!match) {
        console.error("Unknown organization:", organizationId);
        return;
    }

    if (getOrganizationId() === match.id) {
        return;
    }

    localStorage.setItem(
        "nfk_organization",
        JSON.stringify(match)
    );

    localStorage.setItem(
        "nfk-organization-id",
        match.id
    );

    window.location.reload();
}


// ------------------------------------------------------------
// GET ACCESS TOKEN — attached to every authenticated API call so
// the backend can verify who's asking, not just trust organizationId.
// ------------------------------------------------------------

function getAccessToken() {
    try {
        const session = JSON.parse(
            localStorage.getItem("nfk_session") || "null"
        );

        return session?.access_token || null;
    } catch {
        return null;
    }
}


// ------------------------------------------------------------
// REFRESH SESSION
//
// Called reactively — the first API call that comes back with an
// expired/invalid token triggers this. Concurrent callers (a page
// load easily fires a dozen requests at once) share the same
// in-flight promise instead of each racing their own refresh call:
// Supabase rotates the refresh token on every use, so two
// simultaneous refresh attempts with the same stale token would
// have only the first succeed and the second fail outright.
// ------------------------------------------------------------

let refreshSessionPromise = null;

async function refreshSession() {
    if (refreshSessionPromise) {
        return refreshSessionPromise;
    }

    refreshSessionPromise = (async () => {
        const session = JSON.parse(
            localStorage.getItem("nfk_session") || "null"
        );

        const refreshToken = session?.refresh_token;

        if (!refreshToken) {
            throw new Error("No refresh token available");
        }

        const { ok, data } = await NFK_Api.request("/auth/refresh", {
            method: "POST",
            auth: false,
            body: { refresh_token: refreshToken }
        });

        if (!ok || !data.session?.access_token) {
            throw new Error(data.error || "Failed to refresh session");
        }

        localStorage.setItem("nfk_session", JSON.stringify(data.session));

        return data.session;
    })();

    try {
        return await refreshSessionPromise;
    } finally {
        refreshSessionPromise = null;
    }
}


// ------------------------------------------------------------
// LOGOUT
// ------------------------------------------------------------

function logout() {

    // Every key this app writes — including the company list, so the next
    // person on a shared computer doesn't inherit the previous one's.
    [
        "nfk_user",
        "nfk_profile",
        "nfk_organization",
        "nfk_organizations",
        "nfk_user_organization",
        "nfk_session",
        "nfk-organization-id"
    ].forEach(key => localStorage.removeItem(key));

    // replace() (not href =) drops the dashboard from browser history,
    // so the back button can't return to a stale authenticated page.
    window.location.replace("index.html");
}


// ------------------------------------------------------------
// AUTH STATE
// ------------------------------------------------------------

// A saved user without a session can't make a single authenticated call,
// so it counts as logged out rather than sending them into the portal.
function isLoggedIn() {
    return getCurrentUser() !== null && getAccessToken() !== null;
}
// The card shows one of three panes - sign in, sign up, or the
// post-signup "check your email" confirmation. Which one is visible is
// decided by a single class on the card, so the panes cannot end up
// half-shown the way toggling each element individually could.
function setAuthMode(mode) {
    const card = document.getElementById("auth-card");
    if (!card) return;

    card.classList.remove("mode-signup", "mode-sent");

    if (mode === "signup") card.classList.add("mode-signup");
    if (mode === "sent") card.classList.add("mode-sent");

    // A failed sign-in should not stay on screen over a different form.
    hideAuthError();
    clearSignupErrors();
}

function showSignup() {
    setAuthMode("signup");
    document.getElementById("signup-name")?.focus();
}

function showLogin() {
    setAuthMode("login");
}

function showSentPane() {
    setAuthMode("sent");
}

// ------------------------------------------------------------
// VIEW SWITCHING
// ------------------------------------------------------------

function showView(viewId) {
    document.querySelectorAll(".full-view").forEach(view => {
        view.classList.remove("active");
    });

    const target = document.getElementById(viewId);

    if (target) {
        target.classList.add("active");
    }
}


// ------------------------------------------------------------
// PASSWORD VISIBILITY
// ------------------------------------------------------------

function togglePw() {
    const input = document.getElementById("login-password");
    const toggle = document.getElementById("pw-toggle");

    if (!input) return;

    const showing = input.type === "text";

    input.type = showing ? "password" : "text";

    if (toggle) {
        toggle.title = showing ? "Show password" : "Hide password";
    }
}


// ------------------------------------------------------------
// FORGOT PASSWORD
// ------------------------------------------------------------

function forgotPassword() {
    const overlay = document.getElementById("forgot-overlay");

    if (overlay) {
        overlay.classList.add("open");
    }
}

async function sendReset() {
    const emailInput = document.getElementById("forgot-email");
    const email = emailInput ? emailInput.value.trim() : "";
    const successEl = document.getElementById("forgot-success");

    if (!email) {
        alert("Please enter your email address.");
        return;
    }

    try {
        await NFK_Api.request("/auth/forgot-password", {
            method: "POST",
            auth: false,
            body: { email }
        });
    } catch (error) {
        console.error("Forgot password request failed:", error);
    }

    // Shown regardless of outcome, on purpose — matches the backend
    // never revealing whether that email actually has an account.
    if (successEl) {
        successEl.style.display = "block";
    }
}


// ------------------------------------------------------------
// CHECK QUICKBOOKS CONNECTION STATUS
// ------------------------------------------------------------

async function checkQBStatus() {
    const organizationId = getOrganizationId();

    if (!organizationId) {
        return { connected: false };
    }

    try {
        // /status is behind requireOrgAccess like every other data route,
        // so it needs the session token, and an expired session is
        // refreshed and asked again (both in api.js) rather than being
        // misreported as a missing QuickBooks connection.
        const { ok, data } = await NFK_Api.request(
            `/quickbooks/status?organizationId=${encodeURIComponent(organizationId)}`
        );

        if (!ok) {
            return { connected: false };
        }

        return data;
    } catch (error) {
        console.error("QuickBooks status check failed:", error);

        return { connected: false };
    }
}


// ------------------------------------------------------------
// ROUTE TO THE RIGHT VIEW AFTER LOGIN / ON RELOAD
// ------------------------------------------------------------

async function routeAfterLogin() {
    const organizationId = getOrganizationId();

    if (!organizationId) {
        showView("view-connect-qb");
        return;
    }

    const status = await checkQBStatus();

    if (status.connected) {
        enterPortal(status);
        return;
    }

    showView("view-connect-qb");

    // A connection that has gone stale looks identical to never having
    // connected at all, which leaves the owner wondering why they're
    // being asked to do something they already did. Say what happened.
    if (status.needsReconnect) {
        showReconnectNotice(status.message);
    }
}

// Shown on the connect screen when a previously working QuickBooks
// connection can no longer be refreshed.
function showReconnectNotice(message) {
    const box = document.getElementById("qb-connect-error");
    const msg = document.getElementById("qb-connect-error-msg");

    if (msg) {
        msg.textContent =
            message ||
            "Your QuickBooks connection has expired. Reconnect to keep seeing your numbers.";
    }

    if (box) box.style.display = "flex";
}


// ------------------------------------------------------------
// CONNECT TO QUICKBOOKS (real OAuth redirect)
// ------------------------------------------------------------

async function connectQB() {
    const organizationId = getOrganizationId();
    const token = getAccessToken();

    if (!organizationId || !token) {
        alert("You need to be logged in before connecting QuickBooks.");
        return;
    }

    try {
        const { ok, data, sessionLost } = await NFK_Api.request(
            `/quickbooks/connect-url?organizationId=${encodeURIComponent(organizationId)}`
        );

        if (sessionLost) {
            alert("Your session has expired. Please log in again.");
            logout();
            return;
        }

        if (!ok || !data.authUrl) {
            throw new Error(data.error || "Failed to start QuickBooks connection");
        }

        window.location.href = data.authUrl;
    } catch (error) {
        console.error("❌ Failed to start QuickBooks connection:", error);
        alert("Couldn't start the QuickBooks connection. Please try again.");
    }
}


// ------------------------------------------------------------
// DISCONNECT QUICKBOOKS (wrong company was connected)
// ------------------------------------------------------------

async function disconnectQB() {
    const organizationId = getOrganizationId();
    const token = getAccessToken();

    if (!organizationId || !token) {
        return;
    }

    if (!confirm("Disconnect this QuickBooks company? You can reconnect with the right account afterward.")) {
        return;
    }

    try {
        const { ok } = await NFK_Api.request(
            `/quickbooks/disconnect?organizationId=${encodeURIComponent(organizationId)}`,
            { method: "DELETE" }
        );

        if (!ok) {
            throw new Error("Failed to disconnect");
        }

        alert("Disconnected. Before reconnecting, sign out of QuickBooks/Intuit in this browser (or use a private window) so it prompts you to choose the right account.");

        showView("view-connect-qb");

        const connectingEl = document.getElementById("qb-state-connecting");
        const successEl = document.getElementById("qb-state-success");
        const idleEl = document.getElementById("qb-state-idle");

        if (connectingEl) connectingEl.style.display = "none";
        if (successEl) successEl.style.display = "none";
        if (idleEl) idleEl.style.display = "block";
    } catch (error) {
        console.error("❌ Failed to disconnect QuickBooks:", error);
        alert("Couldn't disconnect. Please try again.");
    }
}


// ------------------------------------------------------------
// QUICKBOOKS CONNECTING ANIMATION
// ------------------------------------------------------------

// These steps are real work, not a timer.
//
// Each one is a question the Overview is about to ask anyway. Asking
// them here, while the person is watching a progress list rather than
// an empty dashboard, means the answers are already in hand by the
// time they arrive — the page fills straight away instead of firing
// everything at QuickBooks at once and having the slowest cards
// refused. A tick appears when that step's own answer comes back, so
// the list says what is actually happening.
//
// One at a time on purpose: QuickBooks turns away a burst of calls for
// the same company. See backend/services/quickbooks/request-gate.js.
function qbWarmupSteps(organizationId) {
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const iso = d =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    // This has to match getPeriodRange("month") in app.js exactly. A
    // different date range is a different question, and the Overview
    // would just ask again — losing the whole point of warming up.
    const endDate = iso(now);
    const startDate = iso(new Date(now.getFullYear(), now.getMonth(), 1));

    const org = encodeURIComponent(organizationId);
    const range =
        `&startDate=${encodeURIComponent(startDate)}` +
        `&endDate=${encodeURIComponent(endDate)}`;

    return [
        {
            label: "Checking your QuickBooks connection",
            path: `/quickbooks/status?organizationId=${org}`
        },
        {
            label: "Reading what you earned and spent",
            path: `/quickbooks/pl-story?organizationId=${org}${range}`
        },
        {
            label: "Looking at what's in the bank",
            path: `/quickbooks/cash-projection?organizationId=${org}&days=30`
        },
        {
            label: "Working out where the money went",
            path: `/quickbooks/money-flow?organizationId=${org}${range}`
        },
        {
            label: "Finding who still owes you",
            path: `/quickbooks/invoice-urgency?organizationId=${org}`
        },
        {
            label: "Listing the bills coming due",
            path: `/quickbooks/bills-schedule?organizationId=${org}`
        },
        {
            label: "Adding up what you own and what you owe",
            path: `/quickbooks/balance-questions?organizationId=${org}`
        }
    ];
}

// statuses[i] is "done", "warn", or undefined for not reached yet.
function renderQBSteps(steps, activeIndex, statuses = []) {
    const wrap = document.getElementById("qb-steps-v2");

    if (!wrap) return;

    wrap.innerHTML = steps
        .map(({ label }, i) => {
            let stateClass = "";
            let icon = "○";

            if (statuses[i] === "done") {
                stateClass = "done";
                icon = "✓";
            } else if (statuses[i] === "warn") {
                // Not a failure worth alarming anyone about — the page
                // asks again by itself. Say it was skipped, don't tick
                // it as if it worked.
                stateClass = "warn";
                icon = "–";
            } else if (i === activeIndex) {
                stateClass = "active";
                icon = `<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>`;
            }

            return `
                <div class="qb-step ${stateClass}">
                    <span class="qb-step-icon">${icon}</span>
                    <span>${label}</span>
                </div>
            `;
        })
        .join("");
}

// A step that is already answered comes back in milliseconds, which
// would flash past too fast to read. Hold each one briefly so the list
// reads as progress rather than a flicker.
const QB_STEP_MIN_MS = 280;

async function runOneWarmupStep(step) {
    const startedAt = Date.now();

    let outcome = "warn";

    try {
        const { ok, status } = await NFK_Api.request(step.path);

        // The answer itself is thrown away on purpose. It is already
        // held on the server for the next minute, which is what the
        // Overview will read. This is only about having asked.
        if (ok) {
            outcome = "done";
        } else {
            console.warn(
                `Warm-up step failed (${status}): ${step.label}`
            );
        }
    } catch (error) {
        console.warn(`Warm-up step failed: ${step.label}`, error);
    }

    const elapsed = Date.now() - startedAt;

    if (elapsed < QB_STEP_MIN_MS) {
        await new Promise(resolve =>
            setTimeout(resolve, QB_STEP_MIN_MS - elapsed)
        );
    }

    return outcome;
}

async function runQBConnectAnimation() {
    showView("view-connect-qb");

    const idleEl = document.getElementById("qb-state-idle");
    const connectingEl = document.getElementById("qb-state-connecting");
    const successEl = document.getElementById("qb-state-success");

    if (idleEl) idleEl.style.display = "none";
    if (successEl) successEl.style.display = "none";
    if (connectingEl) connectingEl.style.display = "block";

    const organizationId = getOrganizationId();
    const steps = qbWarmupSteps(organizationId);
    const statuses = [];

    if (organizationId) {
        for (let i = 0; i < steps.length; i++) {
            renderQBSteps(steps, i, statuses);
            statuses[i] = await runOneWarmupStep(steps[i]);
        }
    }

    renderQBSteps(steps, steps.length, statuses);

    await new Promise(resolve => setTimeout(resolve, 400));

    if (connectingEl) connectingEl.style.display = "none";
    if (successEl) successEl.style.display = "block";

    // Show which company actually got connected — Intuit can
    // silently authorize whatever account is already logged
    // into this browser, so surfacing the name here is what
    // lets the user catch a wrong connection instead of
    // assuming it's correct.
    const companyEl = document.getElementById("qb-connected-company");

    if (companyEl) {
        try {
            const status = await checkQBStatus();
            companyEl.textContent = status?.companyName
                ? `Connected to: ${status.companyName}`
                : "";
        } catch {
            companyEl.textContent = "";
        }
    }

    const step2 = document.getElementById("qb-onboard-step-2");
    const line2 = document.getElementById("qb-onboard-line-2");
    const step3 = document.getElementById("qb-onboard-step-3");

    if (step2) {
        step2.classList.remove("active");
        step2.classList.add("done");
        step2.querySelector(".step-num").textContent = "✓";
    }

    if (line2) line2.classList.add("done");

    if (step3) {
        step3.classList.add("done");
        step3.querySelector(".step-num").textContent = "✓";
    }
}


// ------------------------------------------------------------
// ENTER PORTAL (after QuickBooks connect, or already connected)
// ------------------------------------------------------------

// knownStatus is the /status answer the caller already has, if any, so
// the top bar doesn't ask QuickBooks the same question again.
function enterPortal(knownStatus = null) {
    showView("view-app");

    if (window.NFK_App) {
        if (typeof window.NFK_App.buildTopBar === "function") {
            window.NFK_App.buildTopBar(knownStatus);
        }

        if (typeof window.NFK_App.nav === "function") {
            window.NFK_App.nav("overview");
        }
    }
}


// ------------------------------------------------------------
// BOOTSTRAP THE CORRECT VIEW ON PAGE LOAD
// ------------------------------------------------------------

async function bootstrapAuthView() {
    const params = new URLSearchParams(window.location.search);

    if (!isLoggedIn()) {
        showView("view-login");

        // The intro page's "Sign up" link points here with #signup so it
        // opens straight into the sign-up pane instead of sign-in.
        if (window.location.hash === "#signup") {
            showSignup();
        }

        // Arriving from the confirmation email. Say it worked, and drop
        // the query string and the session tokens Supabase appends to
        // the link's hash, so neither lingers in the address bar or history.
        if (params.get("confirmed") === "true") {
            const sub = document.querySelector("#login-pane .auth-card-sub");
            if (sub) sub.textContent = "Your email is confirmed. Sign in to get started.";

            window.history.replaceState({}, document.title, window.location.pathname);
        }

        return;
    }

    if (params.get("connected") === "true") {
        window.history.replaceState(
            {},
            document.title,
            window.location.pathname
        );

        runQBConnectAnimation();
        return;
    }

    if (params.get("qb_error") === "1") {
        window.history.replaceState(
            {},
            document.title,
            window.location.pathname
        );

        showView("view-connect-qb");

        const errorBox = document.getElementById("qb-connect-error");

        if (errorBox) {
            errorBox.style.display = "flex";
        }

        return;
    }

    await routeAfterLogin();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrapAuthView);
} else {
    bootstrapAuthView();
}


// ------------------------------------------------------------
// EXPOSE AUTH FUNCTIONS
// ------------------------------------------------------------

window.NFK_Auth = {
    signup,
    handleSignup,
    login,
    handleLoginClick,
    showSignup,
    showLogin,
    showSentPane,
    getCurrentUser,
    getCurrentOrganization,
    getOrganizations,
    setActiveOrganization,
    getOrganizationId,
    getAccessToken,
    refreshSession,
    logout,
    isLoggedIn,
    showView,
    togglePw,
    forgotPassword,
    sendReset,
    connectQB,
    disconnectQB,
    enterPortal
};