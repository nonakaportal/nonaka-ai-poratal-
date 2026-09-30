const { createClient } = require("@supabase/supabase-js");

class SupabaseService {
    constructor() {
        this.url = process.env.SUPABASE_URL;
        this.serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!this.url) {
            throw new Error("SUPABASE_URL is missing");
        }

        if (!this.serviceRoleKey) {
            throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
        }

        // Backend client
        // Uses the service-role key because this service runs on the server.
        this.client = this._buildClient();

        console.log("Supabase service initialized");
    }

    // ==========================================================
    // CLIENT FACTORY
    //
    // quickbooks_connections reads/writes each get their own fresh
    // client (see below) instead of reusing one shared instance.
    // A shared client, hit by several concurrent requests at once
    // (e.g. the dashboard firing 6 parallel report fetches, each
    // doing a connection lookup, while an OAuth callback is also
    // writing), was intermittently and sometimes consistently
    // rejected by RLS on writes — while the exact same write, run
    // in isolation with the same key moments later, always
    // succeeded instantly. That points at shared state inside the
    // client being disturbed by concurrent use, not the key, the
    // policy, or Supabase itself. A fresh client per call has no
    // state to share, which removes that possibility entirely.
    // ==========================================================

    _buildClient() {
        return createClient(
            this.url,
            this.serviceRoleKey,
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                },
                global: {
                    headers: {
                        Connection: "close"
                    }
                }
            }
        );
    }

    // ==========================================================
    // RETRY HELPER
    //
    // Supabase writes to quickbooks_connections have intermittently
    // failed (RLS rejection, or "0 rows" on an update that a raw
    // REST call with the same credentials succeeds at moments
    // later) in a way that isn't reproducible on demand and isn't
    // explained by the key, policies, or our code — it clears up on
    // its own on retry every time it's been observed. Rather than
    // surface that flakiness to the user, retry transparently.
    // ==========================================================

    async _withRetry(fn, { retries = 3, delayMs = 400, label = "operation" } = {}) {
        let lastError;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;

                console.warn(
                    `${label} failed (attempt ${attempt}/${retries}):`,
                    error.message || error
                );

                if (attempt < retries) {
                    await new Promise(resolve =>
                        setTimeout(resolve, delayMs * attempt)
                    );
                }
            }
        }

        throw lastError;
    }

     // ==========================================================
    // AUTH
    // ==========================================================
    
    // Uses the public signUp() call (not admin.createUser) specifically so
    // Supabase actually sends a confirmation email — admin.createUser is a
    // bypass endpoint that never emails anyone. With "Confirm email"
    // enabled in the Supabase project (the default), data.session comes
    // back null until the user clicks that email's link; callers use
    // needsEmailConfirmation to tell the user to check their inbox instead
    // of silently treating signup as fully complete.
    async signUpUser(email, password, redirectTo) {
        const { data, error } = await this._buildClient().auth.signUp({
            email,
            password,
            options: redirectTo
                ? { emailRedirectTo: redirectTo }
                : undefined
        });

        if (error) {
            throw error;
        }

        const alreadyRegistered = () => {
            const err = new Error(
                "An account with this email already exists. Please log in instead."
            );

            err.code = "EMAIL_ALREADY_REGISTERED";

            return err;
        };

        // Case 1 — already registered AND confirmed: Supabase's
        // anti-enumeration behavior returns a decoy user object
        // (identities: []) instead of erroring, so an attacker can't
        // tell "already registered" apart from "signup succeeded" by
        // response shape alone. That decoy id has no real row behind
        // it — creating a profile/org for it fails downstream with a
        // confusing foreign-key error instead of a clear message.
        if (data.user && data.user.identities?.length === 0) {
            throw alreadyRegistered();
        }

        // Case 2 — already registered but never confirmed, signing up
        // again: Supabase treats this as "resend the confirmation
        // email" and returns the same *real* existing user (not a
        // decoy), which already has a profile row from the first
        // attempt. Blindly creating one again hits a unique-constraint
        // violation, so check first instead of letting that happen.
        if (data.user) {
            const { data: existingProfile } = await this._buildClient()
                .from("profiles")
                .select("id")
                .eq("id", data.user.id)
                .maybeSingle();

            if (existingProfile) {
                throw alreadyRegistered();
            }
        }

        return {
            user: data.user,
            needsEmailConfirmation: !data.session
        };
    }

    // Sends Supabase's real "reset your password" email. Errors are
    // swallowed by the caller (auth.routes.js) so the response never
    // reveals whether an email address has an account — only whether the
    // request itself was malformed.
    async sendPasswordResetEmail(email, redirectTo) {
        const { error } = await this._buildClient()
            .auth.resetPasswordForEmail(email, { redirectTo });

        if (error) {
            throw error;
        }

        return true;
    }

    // Called after verifying the access_token from the reset-password
    // email link (see getUserFromToken) — sets the new password via the
    // admin API rather than requiring the client to hold a live session.
    async updateUserPassword(userId, newPassword) {
        const { data, error } = await this._buildClient()
            .auth.admin.updateUserById(userId, { password: newPassword });

        if (error) {
            throw error;
        }

        return data.user;
    }
    
    
    async signInUser(email, password) {
        const { data, error } =
            await this._buildClient().auth.signInWithPassword({
                email,
                password
            });

        if (error) {
            throw error;
        }

        return data;
    }


    // Supabase rotates the refresh token on every use — the old one
    // becomes invalid the moment this succeeds, so the caller must
    // store the new refresh_token returned here, not reuse the old one.
    async refreshSession(refreshToken) {
        const { data, error } =
            await this._buildClient().auth.refreshSession({
                refresh_token: refreshToken
            });

        if (error) {
            throw error;
        }

        return data;
    }
    
    
    async getProfile(userId) {
        const { data, error } = await this._buildClient()
            .from("profiles")
            .select("*")
            .eq("id", userId)
            .single();
    
        if (error) {
            throw error;
        }
    
        return data;
    }

    // ==========================================================
    // ORGANIZATIONS
    // ==========================================================

    async createOrganization(name) {
        const { data, error } = await this._buildClient()
            .from("organizations")
            .insert({
                name
            })
            .select()
            .single();

        if (error) {
            throw error;
        }

        return data;
    }

    async createUserOrganization(userId, organizationId) {
        const { data, error } = await this._buildClient()
            .from("user_organization")
            .insert({
                user_id: userId,
                organization_id: organizationId
            })
            .select()
            .single();

        if (error) {
            throw error;
        }

        return data;
    }

    // ==========================================================
    // SIGNUP CLEANUP
    //
    // Signup writes four things in separate calls (auth user, profile,
    // organization, membership). If a later one fails, what was already
    // written is removed so the person can simply try again: a user with
    // no organization can neither log in nor sign up a second time.
    // ==========================================================

    async deleteMembershipsForOrganization(organizationId) {
        const { error } = await this._buildClient()
            .from("user_organization")
            .delete()
            .eq("organization_id", organizationId);

        if (error) throw error;
    }

    async deleteOrganization(organizationId) {
        const { error } = await this._buildClient()
            .from("organizations")
            .delete()
            .eq("id", organizationId);

        if (error) throw error;
    }

    async deleteProfile(userId) {
        const { error } = await this._buildClient()
            .from("profiles")
            .delete()
            .eq("id", userId);

        if (error) throw error;
    }

    async deleteAuthUser(userId) {
        const { error } = await this._buildClient()
            .auth.admin.deleteUser(userId);

        if (error) throw error;
    }

    // Every organization this user belongs to. Nothing stops a person
    // being linked to more than one — an owner with two companies, or an
    // advisor looking after several — so this must never assume one.
    // The single-row version of this query answered a second membership
    // with "JSON object requested, multiple (or no) rows returned",
    // which locked those users out of the portal entirely.
    async getUserOrganizations(userId) {
        const { data, error } = await this._buildClient()
            .from("user_organization")
            .select(`
                id,
                user_id,
                organization_id,
                organizations (
                    id,
                    name
                )
            `)
            .eq("user_id", userId)
            .order("id", { ascending: true });

        if (error) {
            throw error;
        }

        // A membership row whose organization has since been deleted
        // would otherwise become a null entry the caller has to guard.
        return (data || []).filter(row => row.organizations);
    }

    // Used by the auth middleware to confirm a request's authenticated
    // user actually belongs to the organizationId it's asking about,
    // before any QuickBooks or AI data for that org is touched.
    async isUserInOrganization(userId, organizationId) {
        const { data, error } = await this._buildClient()
            .from("user_organization")
            .select("id")
            .eq("user_id", userId)
            .eq("organization_id", organizationId)
            .maybeSingle();

        if (error) {
            throw error;
        }

        return !!data;
    }

    // Verifies a Supabase-issued access token and returns the user it
    // belongs to, or null if the token is missing/invalid/expired.
    async getUserFromToken(accessToken) {
        if (!accessToken) {
            return null;
        }

        const { data, error } = await this._buildClient().auth.getUser(accessToken);

        if (error || !data?.user) {
            return null;
        }

        return data.user;
    }

    // How the session behind this token was established, read from the
    // JWT's `amr` claim. A password sign-in reports "password"; a session
    // minted by clicking an emailed recovery link reports "otp".
    //
    // Only ever call this on a token whose authenticity has already been
    // confirmed by getUserFromToken() — the payload is decoded here
    // without checking the signature, so on an unverified token these
    // claims would be attacker-chosen.
    getTokenAuthMethods(accessToken) {
        try {
            const payload = JSON.parse(
                Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')
            );

            return Array.isArray(payload.amr)
                ? payload.amr.map(entry => entry?.method).filter(Boolean)
                : [];
        } catch {
            return [];
        }
    }

    // ==========================================================
    // QUICKBOOKS CONNECTION
    // ==========================================================

    async saveQuickBooksTokens(organizationId, tokens) {
        const expiresAt = new Date(
            Date.now() +
            Number(tokens.expires_in || 3600) * 1000
        ).toISOString();

        return this._withRetry(
            async () => {
                const { data, error } = await this._buildClient()
                    .from("quickbooks_connections")
                    .upsert(
                        {
                            organization_id: organizationId,
                            realm_id: tokens.realm_id,
                            access_token: tokens.access_token,
                            refresh_token: tokens.refresh_token,
                            token_expires_at: expiresAt,
                            connection_status: "connected",
                            updated_at: new Date().toISOString()
                        },
                        {
                            onConflict: "organization_id"
                        }
                    )
                    .select()
                    .single();

                if (error) {
                    console.error(
                        "saveQuickBooksTokens Supabase error:",
                        {
                            code: error.code,
                            message: error.message,
                            details: error.details,
                            hint: error.hint
                        }
                    );

                    throw error;
                }

                return data;
            },
            { label: "saveQuickBooksTokens" }
        );
    }

    async getQuickBooksTokens(organizationId) {
        return this._withRetry(
            async () => {
                const { data, error } = await this._buildClient()
                    .from("quickbooks_connections")
                    .select("*")
                    .eq("organization_id", organizationId)
                    .maybeSingle();

                if (error) {
                    console.error(
                        "Supabase QuickBooks lookup failed:",
                        error.message
                    );

                    throw error;
                }

                return data;
            },
            { label: "getQuickBooksTokens" }
        );
    }
    // Lets a user unlink a wrongly-connected QuickBooks company — e.g. a
    // stale Intuit browser session auto-authorized the wrong company
    // during OAuth instead of prompting for login. Deleting the row
    // (rather than just clearing tokens) lets a fresh /connect-url flow
    // upsert cleanly afterward.
    async deleteQuickBooksTokens(organizationId) {
        return this._withRetry(
            async () => {
                const { error } = await this._buildClient()
                    .from("quickbooks_connections")
                    .delete()
                    .eq("organization_id", organizationId);

                if (error) {
                    throw error;
                }

                return true;
            },
            { label: "deleteQuickBooksTokens" }
        );
    }

    async createProfile(userId, fullName) {
        const { data, error } = await this._buildClient()
            .from("profiles")
            .insert({
                id: userId,
                full_name: fullName
            })
            .select()
            .single();
    
        if (error) {
            throw error;
        }
    
        return data;
    }

    async updateQuickBooksTokens(organizationId, tokens) {
        const expiresAt = new Date(
            Date.now() +
            Number(tokens.expires_in || 3600) * 1000
        ).toISOString();

        return this._withRetry(
            async () => {
                const { data, error } = await this._buildClient()
                    .from("quickbooks_connections")
                    .update({
                        access_token: tokens.access_token,
                        refresh_token: tokens.refresh_token,
                        token_expires_at: expiresAt,
                        connection_status: "connected",
                        updated_at: new Date().toISOString()
                    })
                    .eq("organization_id", organizationId)
                    .select()
                    .single();

                if (error) {
                    console.error(
                        "updateQuickBooksTokens Supabase error:",
                        {
                            code: error.code,
                            message: error.message,
                            details: error.details,
                            hint: error.hint
                        }
                    );

                    throw error;
                }

                return data;
            },
            { label: "updateQuickBooksTokens" }
        );
    }
}

module.exports = new SupabaseService();