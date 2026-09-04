const { createClient } = require("@supabase/supabase-js");

class SupabaseService {
    constructor() {
        this.url = process.env.SUPABASE_URL;
        this.anonKey = process.env.SUPABASE_ANON_KEY;
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
    
    async signUpUser(email, password) {
        const { data, error } = await this._buildClient().auth.admin.createUser({
            email,
            password,
            email_confirm: true
        });
    
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
    
    
    async getUser(userId) {
        const {
            data,
            error
        } = await this._buildClient().auth.admin.getUserById(userId);
    
        if (error) {
            throw error;
        }
    
        return data.user;
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

    async getUserOrganization(userId) {
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
            .maybeSingle();

        if (error) {
            throw error;
        }

        return data;
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
        console.log(
            "Looking up QuickBooks connection:",
            organizationId
        );

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
                        error
                    );

                    throw error;
                }

                console.log(
                    "QuickBooks connection found:",
                    data
                        ? {
                            id: data.id,
                            organization_id: data.organization_id,
                            realm_id: data.realm_id,
                            connection_status: data.connection_status
                        }
                        : null
                );

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