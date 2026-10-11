// ============================================================
// NONAKA FINANCIAL PARTNERS — API CLIENT
// Every call to the backend goes through request(): one base URL, the
// session token on signed-in calls, and one silent refresh-and-retry when
// that session has expired. Loaded before auth.js and app.js.
// ============================================================

(function () {
  const BASE = window.NFK_CONFIG?.API_BASE || "/api";
  const SESSION_ERRORS = new Set(["AUTH_INVALID", "AUTH_REQUIRED"]);

  // Resolves to { ok, status, data, sessionLost } and never throws for an
  // HTTP error, so each caller keeps its own way of telling the user.
  // sessionLost means the session expired and could not be refreshed.
  async function request(path, { method = "GET", body, auth = true, retry = true } = {}) {
    const headers = {};
    const token = auth ? window.NFK_Auth?.getAccessToken?.() : null;

    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok && auth && retry && SESSION_ERRORS.has(data.code)) {
      try {
        await window.NFK_Auth.refreshSession();
      } catch {
        return { ok: false, status: response.status, data, sessionLost: true };
      }

      return request(path, { method, body, auth, retry: false });
    }

    return { ok: response.ok, status: response.status, data };
  }

  window.NFK_Api = { BASE, request };
})();
