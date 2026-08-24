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

        // 1. Create Supabase Auth user
        const user = await supabaseService.signUpUser(
            email,
            password
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
            userOrganization
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


module.exports = router;