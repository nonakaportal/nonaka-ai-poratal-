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

        res.status(500).json({
            success: false,
            error: error.message
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

        // 3. Get user's organization
        const userOrganization =
            await supabaseService.getUserOrganization(
                user.id
            );

        if (!userOrganization) {
            return res.status(404).json({
                success: false,
                error: "No organization is associated with this user"
            });
        }

        res.json({
            success: true,

            user: {
                id: user.id,
                email: user.email
            },

            profile,

            organization:
                userOrganization.organizations,

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
        console.error("Login failed:", error);

        res.status(401).json({
            success: false,
            error: error.message
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