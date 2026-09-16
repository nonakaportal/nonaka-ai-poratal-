// ============================================================
// NONAKA FINANCIAL PARTNERS — AUTH
// Supabase Auth + Backend Session
// ============================================================

console.log("🔐 Auth module loaded");

const API_BASE = window.NFK_CONFIG?.API_BASE || "/api";
const AUTH_API = `${API_BASE}/auth`;
const QB_API = API_BASE;

// ------------------------------------------------------------
// SIGN UP
// ------------------------------------------------------------

async function signup(email, password, fullName, organizationName) {
    try {
        const response = await fetch(`${AUTH_API}/signup`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email,
                password,
                fullName,
                organizationName
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.error || "Signup failed"
            );
        }

        // Save user information locally
        localStorage.setItem(
            "nfk_user",
            JSON.stringify(data.user)
        );

        localStorage.setItem(
            "nfk_profile",
            JSON.stringify(data.profile)
        );

        localStorage.setItem(
            "nfk_organization",
            JSON.stringify(data.organization)
        );

        localStorage.setItem(
            "nfk_user_organization",
            JSON.stringify(data.userOrganization)
        );

        console.log("✅ Signup successful");
        console.log("👤 User:", data.user);
        console.log("🏢 Organization:", data.organization);

        return data;

    } catch (error) {
        console.error("❌ Signup error:", error);
        throw error;
    }
}

async function handleSignup() {

    const fullName =
        document.getElementById("signup-name")
            .value
            .trim();

    const email =
        document.getElementById("signup-email")
            .value
            .trim();

    const password =
        document.getElementById("signup-password")
            .value;

    const confirmPassword =
        document.getElementById("signup-confirm-password")
            .value;

    const organizationName =
        document.getElementById("signup-organization")
            .value
            .trim();


    // --------------------------------------------------------
    // VALIDATION
    // --------------------------------------------------------

    if (
        !fullName ||
        !email ||
        !password ||
        !confirmPassword ||
        !organizationName
    ) {
        alert("Please fill in all fields.");
        return;
    }

    if (password !== confirmPassword) {
        alert("Passwords do not match.");
        return;
    }

    if (password.length < 6) {
        alert("Password must be at least 6 characters.");
        return;
    }


    try {

        console.log("📝 Creating account...");

        const data =
            await signup(
                email,
                password,
                fullName,
                organizationName
            );

        console.log(
            "✅ Account created:",
            data
        );

        if (data.needsEmailConfirmation) {
            alert(
                "Account created! Check your email for a confirmation " +
                "link before logging in."
            );
        } else {
            alert(
                "Account created successfully!"
            );
        }

        showLogin();

    } catch (error) {

        console.error(
            "❌ Signup failed:",
            error
        );

        alert(
            error.message ||
            "Failed to create account."
        );
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
        const response = await fetch(`${AUTH_API}/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email,
                password
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Login failed");
        }

        console.log("✅ Login successful");
        console.log("👤 User:", data.user);
        console.log("🏢 Organization:", data.organization);
        console.log("🔗 User Organization:", data.userOrganization);

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

            console.log(
                "🏢 Organization ID saved:",
                data.organization.id
            );
        }

        // ----------------------------------------------------
        // SAVE USER ORGANIZATION
        // ----------------------------------------------------

        if (data.userOrganization) {
            localStorage.setItem(
                "nfk_user_organization",
                JSON.stringify(data.userOrganization)
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
        console.error("❌ Login failed:", error);
        throw error;
    }
}


// ------------------------------------------------------------
// HANDLE LOGIN BUTTON (loading state + error display)
// ------------------------------------------------------------

async function handleLoginClick() {
    const btnText = document.getElementById("login-btn-text");
    const btnSpin = document.getElementById("login-btn-spin");
    const errorBox = document.getElementById("auth-error");

    if (errorBox) {
        errorBox.style.display = "none";
    }

    if (btnText) btnText.style.display = "none";
    if (btnSpin) btnSpin.style.display = "inline-block";

    try {
        await login();
    } catch (error) {
        const msgEl = document.getElementById("auth-error-msg");

        if (msgEl) {
            msgEl.textContent =
                error.message || "Invalid email or password.";
        }

        if (errorBox) {
            errorBox.style.display = "flex";
        }
    } finally {
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

        const response = await fetch(`${QB_API}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: refreshToken })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.session?.access_token) {
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
// GET USER ORGANIZATION
// ------------------------------------------------------------

function getUserOrganization() {

    const data =
        localStorage.getItem("nfk_user_organization");

    if (!data) {
        return null;
    }

    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}


// ------------------------------------------------------------
// LOGOUT
// ------------------------------------------------------------

function logout() {

    localStorage.removeItem("nfk_user");
    localStorage.removeItem("nfk_profile");
    localStorage.removeItem("nfk_organization");
    localStorage.removeItem("nfk_user_organization");
    localStorage.removeItem("nfk_session");
    localStorage.removeItem("nfk-organization-id");

    console.log("Logged out");

    // replace() (not href =) drops the dashboard from browser history,
    // so the back button can't return to a stale authenticated page.
    window.location.replace("index.html");
}


// ------------------------------------------------------------
// AUTH STATE
// ------------------------------------------------------------

function isLoggedIn() {
    return getCurrentUser() !== null;
}
function showSignup() {
    console.log("📝 Opening signup form");

    // Hide login elements
    const loginEmail =
        document.getElementById("login-email");

    const loginPassword =
        document.getElementById("login-password");

    const loginButton =
        document.getElementById("login-btn");

    const loginRow =
        document.querySelector(".auth-row");

    const loginSignup =
        document.querySelector(".auth-card > .auth-signup");

    if (loginEmail) {
        loginEmail.closest(".form-group").style.display = "none";
    }

    if (loginPassword) {
        loginPassword.closest(".form-group").style.display = "none";
    }

    if (loginButton) {
        loginButton.style.display = "none";
    }

    if (loginRow) {
        loginRow.style.display = "none";
    }

    if (loginSignup) {
        loginSignup.style.display = "none";
    }

    // Hide the login card's own title/subtitle — the signup form below
    // already has its own "Create your account" heading, so leaving
    // these visible (even retitled) duplicates it on screen.
    const title =
        document.querySelector(".auth-card > .auth-card-title");

    const subtitle =
        document.querySelector(".auth-card > .auth-card-sub");

    if (title) {
        title.style.display = "none";
    }

    if (subtitle) {
        subtitle.style.display = "none";
    }

    // Show signup form
    const signupForm =
        document.getElementById("signup-form");

    if (signupForm) {
        signupForm.style.display = "block";
    }
}
function showLogin() {
    console.log("🔐 Returning to login");

    const signupForm =
        document.getElementById("signup-form");

    if (signupForm) {
        signupForm.style.display = "none";
    }

    // Show login fields
    const loginEmail =
        document.getElementById("login-email");

    const loginPassword =
        document.getElementById("login-password");

    const loginButton =
        document.getElementById("login-btn");

    const loginRow =
        document.querySelector(".auth-row");

    const loginSignup =
        document.querySelector(".auth-card > .auth-signup");

    if (loginEmail) {
        loginEmail.closest(".form-group").style.display = "block";
    }

    if (loginPassword) {
        loginPassword.closest(".form-group").style.display = "block";
    }

    if (loginButton) {
        loginButton.style.display = "block";
    }

    if (loginRow) {
        loginRow.style.display = "flex";
    }

    if (loginSignup) {
        loginSignup.style.display = "flex";
    }

    // Restore heading
    const title =
        document.querySelector(".auth-card > .auth-card-title");

    const subtitle =
        document.querySelector(".auth-card > .auth-card-sub");

    if (title) {
        title.style.display = "";
    }

    if (subtitle) {
        subtitle.style.display = "";
    }
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
        await fetch(`${AUTH_API}/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email })
        });
    } catch (error) {
        console.error("❌ Forgot password request failed:", error);
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
        const response = await fetch(
            `${QB_API}/quickbooks/status?organizationId=${encodeURIComponent(organizationId)}`
        );

        return await response.json().catch(() => ({ connected: false }));
    } catch (error) {
        console.error("❌ QuickBooks status check failed:", error);

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
        enterPortal();
    } else {
        showView("view-connect-qb");
    }
}


// ------------------------------------------------------------
// CONNECT TO QUICKBOOKS (real OAuth redirect)
// ------------------------------------------------------------

async function connectQB(_isRetry = false) {
    const organizationId = getOrganizationId();
    const token = getAccessToken();

    if (!organizationId || !token) {
        alert("You need to be logged in before connecting QuickBooks.");
        return;
    }

    try {
        const response = await fetch(
            `${QB_API}/quickbooks/connect-url?organizationId=${encodeURIComponent(organizationId)}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.authUrl) {
            if (
                !_isRetry &&
                (data.code === "AUTH_INVALID" || data.code === "AUTH_REQUIRED")
            ) {
                try {
                    await refreshSession();
                    return connectQB(true);
                } catch {
                    alert("Your session has expired. Please log in again.");
                    logout();
                    return;
                }
            }

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
        const response = await fetch(
            `${QB_API}/quickbooks/disconnect?organizationId=${encodeURIComponent(organizationId)}`,
            {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` }
            }
        );

        if (!response.ok) {
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

const QB_CONNECT_STEPS = [
    "Opening QuickBooks OAuth window...",
    "Authenticating credentials...",
    "Fetching company list...",
    "Pulling Chart of Accounts...",
    "Importing financial statements...",
    "Calculating metrics & KPIs...",
    "Connection complete!"
];

function renderQBSteps(activeIndex) {
    const wrap = document.getElementById("qb-steps-v2");

    if (!wrap) return;

    wrap.innerHTML = QB_CONNECT_STEPS
        .map((label, i) => {
            let stateClass = "";
            let icon = "○";

            if (i < activeIndex) {
                stateClass = "done";
                icon = "✓";
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

function runQBConnectAnimation() {
    showView("view-connect-qb");

    const idleEl = document.getElementById("qb-state-idle");
    const connectingEl = document.getElementById("qb-state-connecting");
    const successEl = document.getElementById("qb-state-success");

    if (idleEl) idleEl.style.display = "none";
    if (successEl) successEl.style.display = "none";
    if (connectingEl) connectingEl.style.display = "block";

    let step = 0;

    renderQBSteps(step);

    const interval = setInterval(() => {
        step++;

        renderQBSteps(step);

        if (step >= QB_CONNECT_STEPS.length) {
            clearInterval(interval);

            setTimeout(async () => {
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
            }, 500);
        }
    }, 650);
}


// ------------------------------------------------------------
// ENTER PORTAL (after QuickBooks connect, or already connected)
// ------------------------------------------------------------

function enterPortal() {
    showView("view-app");

    if (window.NFK_App) {
        // Refreshes the topbar badge, which app.js rendered once
        // at initial page load — before login — using whatever
        // (usually empty) organization/connection state existed
        // then. Without this it stays stuck on "Not Connected".
        if (typeof window.NFK_App.buildTopBar === "function") {
            window.NFK_App.buildTopBar();
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
    if (!isLoggedIn()) {
        showView("view-login");
        return;
    }

    const params = new URLSearchParams(window.location.search);

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
    getCurrentUser,
    getCurrentOrganization,
    getOrganizationId,
    getAccessToken,
    refreshSession,
    getUserOrganization,
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

console.log(" Auth system ready");