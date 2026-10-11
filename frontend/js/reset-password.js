// ============================================================
// NONAKA FINANCIAL PARTNERS — RESET PASSWORD PAGE
// ============================================================

// Supabase appends the recovery session to the URL as a hash fragment
// (#access_token=...&type=recovery&...) rather than a query string, so
// it's never sent to the server — only readable here in the browser.
const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
const accessToken = params.get("access_token");
const type = params.get("type");

// The token is held in memory from here on; leaving it in the address bar
// would keep it in browser history and show it to anyone looking at the screen.
if (window.location.hash) {
  window.history.replaceState(null, "", window.location.pathname);
}

if (!accessToken || type !== "recovery") {
  document.getElementById("reset-form").style.display = "none";
  document.getElementById("reset-sub").style.display = "none";
  document.getElementById("reset-invalid").style.display = "block";
}

async function submitReset() {
  const password = document.getElementById("reset-password").value;
  const confirm = document.getElementById("reset-password-confirm").value;
  const errorEl = document.getElementById("reset-error");
  const btn = document.getElementById("reset-btn");
  const btnText = document.getElementById("reset-btn-text");
  const btnSpin = document.getElementById("reset-btn-spin");

  if (btn.disabled) return;

  errorEl.style.display = "none";

  if (!password || password.length < 6) {
    errorEl.textContent = "Password must be at least 6 characters.";
    errorEl.style.display = "block";
    return;
  }

  if (password !== confirm) {
    errorEl.textContent = "Passwords do not match.";
    errorEl.style.display = "block";
    return;
  }

  btn.disabled = true;
  btnText.style.display = "none";
  btnSpin.style.display = "inline-block";

  try {
    const { ok, data } = await NFK_Api.request("/auth/reset-password", {
      method: "POST",
      auth: false,
      body: { access_token: accessToken, password }
    });

    if (!ok) {
      throw new Error(data.error || "Failed to reset password");
    }

    document.getElementById("reset-form").style.display = "none";
    document.getElementById("reset-sub").style.display = "none";
    document.getElementById("reset-success").style.display = "block";

  } catch (error) {
    errorEl.textContent = error.message || "Something went wrong. Please try again.";
    errorEl.style.display = "block";
    btn.disabled = false;
    btnText.style.display = "inline";
    btnSpin.style.display = "none";
  }
}
