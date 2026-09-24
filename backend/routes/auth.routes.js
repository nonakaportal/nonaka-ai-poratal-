const express = require("express");

const router = express.Router();

const supabaseService = require("../services/supabase/supabase.service");

// ============================================================
// SIGN UP
// ============================================================

router.post("/signup", async (req, res) => {
    try {
        const {
            email,
            password,
            fullName,
            organizationName
        } = req.body;

        if (!email || !password || !fullName || !organizationName) {
            return res.status(400).json({
                success: false,
                error: "email, password, fullName and organizationName are required"
            });
        }

        if (
            [email, password, fullName, organizationName].some(v => typeof v !== "string") ||
            fullName.length > 120 ||
            organizationName.length > 120
        ) {
            return res.status(400).json({
                success: false,
                error: "Please keep your name and business name under 120 characters."
            });
        }

        // 1. Create Supabase Auth user (sends a real confirmation email —
        // see signUpUser's comment for why admin.createUser isn't used)
        const confirmRedirect =
            `${process.env.FRONTEND_URL || "http://127.0.0.1:5500"}/index.html?confirmed=true`;

        const { user, needsEmailConfirmation } = await supabaseService.signUpUser(
            email,
            password,
            confirmRedirect
        );

        // 2. Create profile
        const profile = await supabaseService.createProfile(
            user.id,
            fullName
        );

        // 3. Create organization
        const organization =
            await supabaseService.createOrganization(
                organizationName
            );

        // 4. Connect user to organization
        const userOrganization =
            await supabaseService.createUserOrganization(
                user.id,
                organization.id
            );

        res.status(201).json({
            success: true,
            user: {
                id: user.id,
                email: user.email
            },
            profile,
            organization,
            userOrganization,
            needsEmailConfirmation
        });

    } catch (error) {
        console.error("Signup failed:", error);

        // Backstop for duplicate-email signups Supabase's own response
        // didn't clearly flag ahead of time (see signUpUser's comments):
        // a decoy id with no real row hits a foreign-key violation
        // (23503) on the profiles insert, a real existing id hits a
        // unique-constraint violation (23505). Either way, it always
        // means "this email already has an account" — never leak the
        // raw Postgres error for that.
        const isDuplicateEmail =
            error.code === "EMAIL_ALREADY_REGISTERED" ||
            error.code === "23503" ||
            error.code === "23505";

        if (isDuplicateEmail) {
            return res.status(409).json({
                success: false,
                error: "An account with this email already exists. Please log in instead."
            });
        }

        // Supabase rejects an address it cannot deliver to, and a password
        // below the project's minimum. Both are the person's input, not a
        // server fault, so they get a 400 and a sentence they can act on
        // rather than a 500 with the raw error quoted back at them.
        if (error.code === "email_address_invalid") {
            return res.status(400).json({
                success: false,
                field: "email",
                error: "That email address doesn't look like one we can deliver to. Check it and try again."
            });
        }

        if (error.code === "weak_password") {
            return res.status(400).json({
                success: false,
                field: "password",
                error: "That password is too weak. Try a longer one."
            });
        }

        if (error.status === 400) {
            return res.status(400).json({
                success: false,
                error: "We couldn't create your account with those details. Check them and try again."
            });
        }

        res.status(500).json({
            success: false,
            error: "Something went wrong creating your account. Please try again."
        });
    }
});


// ============================================================
// LOGIN
// ============================================================

router.post("/login", async (req, res) => {
    try {
        const {
            email,
            password
        } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: "email and password are required"
            });
        }

        // 1. Authenticate user with Supabase
        const authData =
            await supabaseService.signInUser(
                email,
                password
            );

        const user = authData.user;

        // 2. Get user's profile
        const profile =
            await supabaseService.getProfile(
                user.id
            );

        // 3. Get every organization this user belongs to. Most people
        // have one; an owner with two companies, or an advisor looking
        // after several, has more, and the portal has to let them pick.
        const memberships =
            await supabaseService.getUserOrganizations(
                user.id
            );

        if (!memberships.length) {
            return res.status(404).json({
                success: false,
                error: "No organization is associated with this user"
            });
        }

        const userOrganization = memberships[0];

        res.json({
            success: true,

            user: {
                id: user.id,
                email: user.email
            },

            profile,

            // The one the portal opens on.
            organization:
                userOrganization.organizations,

            // All of them, so the top bar can offer a switch without
            // another round trip. A single-company owner sees no
            // difference.
            organizations:
                memberships.map(m => m.organizations),

            userOrganization,

            session: {
                access_token:
                    authData.session?.access_token || null,

                refresh_token:
                    authData.session?.refresh_token || null,

                expires_at:
                    authData.session?.expires_at || null
            }
        });

    } catch (error) {
        console.error("Login failed:", error.message);

        // Supabase's own wording ("Invalid login credentials") and any
        // database error text were passed straight to the person signing
        // in. The two cases they can act on get a sentence that says how;
        // anything else is ours to fix, not theirs.
        if (error.code === "email_not_confirmed" || /email not confirmed/i.test(error.message || "")) {
            return res.status(401).json({
                success: false,
                error: "Please confirm your email address first — use the link we sent when you signed up."
            });
        }

        if (error.code === "invalid_credentials" || /invalid login credentials/i.test(error.message || "")) {
            return res.status(401).json({
                success: false,
                error: "That email and password don't match. Try again, or reset your password."
            });
        }

        res.status(500).json({
            success: false,
            error: "We couldn't sign you in right now. Please try again in a moment."
        });
    }
});


// ============================================================
// REFRESH SESSION
// ============================================================

router.post("/refresh", async (req, res) => {
    try {
        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({
                success: false,
                error: "refresh_token is required"
            });
        }

        const authData =
            await supabaseService.refreshSession(refresh_token);

        res.json({
            success: true,

            session: {
                access_token:
                    authData.session?.access_token || null,

                refresh_token:
                    authData.session?.refresh_token || null,

                expires_at:
                    authData.session?.expires_at || null
            }
        });

    } catch (error) {
        console.error("Session refresh failed:", error);

        res.status(401).json({
            success: false,
            error: error.message,
            code: "AUTH_INVALID"
        });
    }
});


// ============================================================
// FORGOT PASSWORD — sends Supabase's real reset email
// ============================================================

router.post("/forgot-password", async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                error: "email is required"
            });
        }

        const redirectTo =
            `${process.env.FRONTEND_URL || "http://127.0.0.1:5500"}/reset-password.html`;

        try {
            await supabaseService.sendPasswordResetEmail(email, redirectTo);
        } catch (error) {
            // Swallowed on purpose: responding differently for a
            // nonexistent email vs. a real one would let an attacker
            // enumerate which addresses have accounts. Still logged
            // server-side for debugging.
            console.error("Password reset email failed:", error.message);
        }

        res.json({
            success: true,
            message: "If an account exists for that email, a reset link has been sent."
        });

    } catch (error) {
        console.error("Forgot password failed:", error);

        res.status(500).json({
            success: false,
            error: "Failed to process request"
        });
    }
});


// ============================================================
// RESET PASSWORD — called from reset-password.html with the
// access_token Supabase put in the emailed link
// ============================================================

router.post("/reset-password", async (req, res) => {
    try {
        const { access_token, password } = req.body;

        if (!access_token || !password) {
            return res.status(400).json({
                success: false,
                error: "access_token and password are required"
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                error: "Password must be at least 6 characters"
            });
        }

        const user = await supabaseService.getUserFromToken(access_token);

        if (!user) {
            return res.status(401).json({
                success: false,
                error: "This reset link is invalid or has expired"
            });
        }

        // This endpoint sets a new password without asking for the old
        // one, which is only acceptable for someone who proved control of
        // the mailbox by clicking a recovery link. An ordinary sign-in
        // token must not be enough: otherwise anyone who got hold of a
        // session — a borrowed device, a token read out of localStorage —
        // could lock the real owner out of their own account.
        //
        // Supabase records how the session was established in the token's
        // `amr` claim: "password" for a sign-in, "otp" for a session
        // minted from an emailed link. Safe to read here because
        // getUserFromToken() has already verified the token is genuine.
        const authMethods = supabaseService.getTokenAuthMethods(access_token);

        if (!authMethods.includes("otp") && !authMethods.includes("recovery")) {
            console.error(
                "Password reset rejected — token was not from a recovery link. Methods:",
                authMethods
            );

            return res.status(403).json({
                success: false,
                error:
                    "Password can only be changed through a reset link sent to your email address."
            });
        }

        await supabaseService.updateUserPassword(user.id, password);

        res.json({ success: true });

    } catch (error) {
        console.error("Reset password failed:", error);

        res.status(500).json({
            success: false,
            error: "Failed to reset password"
        });
    }
});


module.exports = router;