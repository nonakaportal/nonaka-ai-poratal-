// ============================================================
// NONAKA FINANCIAL PARTNERS — RUNTIME CONFIG
//
// When the frontend and backend are deployed separately (frontend on
// Vercel, backend on Render), relative paths like "/api" resolve
// against the Vercel domain instead of the backend. Setting API_BASE
// here points every API call at the actual backend origin.
//
// Left unset (or this file removed), auth.js/app.js fall back to the
// relative "/api" path, which is correct when the backend serves the
// frontend itself (e.g. running everything on Render alone).
// ============================================================

window.NFK_CONFIG = {
  API_BASE: "https://YOUR-RENDER-BACKEND.onrender.com/api"
};
