# Technical Audit & Optimization Plan
**Nonaka Financial Partners — Full App**

---

## CODEBASE OVERVIEW

### Backend Stack
- **Framework**: Express 5.2.1
- **Database**: Supabase (PostgreSQL)
- **External APIs**: 
  - QuickBooks Online (OAuth, REST API)
  - Anthropic Claude (AI features)
- **Services**: 14 specialized service modules
- **Routes**: 3 route files (~2,400 LOC)
- **Middleware**: Auth/CORS/Rate-limiting/Helmet

### Frontend Stack
- **Architecture**: Vanilla JS (IIFE), no framework
- **External Libraries**: Chart.js (CDN)
- **Styling**: Custom CSS (no framework)
- **State Management**: In-memory object (`state`, `nonakaChatHistory`, `kpiDetailStore`)
- **HTTP**: Fetch API
- **Entry Point**: index.html loads 4 JS files sequentially

### Size Metrics
| Component | LOC | Status |
|-----------|-----|--------|
| frontend/js/app.js | 8,326 | Large monolithic file |
| frontend/js/auth.js | 1,216 | Moderate |
| frontend/js/charts.js | 1,129 | Moderate |
| backend/routes/quickbooks.routes.js | 1,796 | Large; many endpoints |
| frontend/js (total) | 10,846 | Single-page app |

---

## FINDINGS BY CATEGORY

### 1. DEAD CODE / UNUSED FILES

**Critical Issues Found:**
- `backend/services/quickbooks/company.service.js` — **Empty file (0 bytes)**
  - Not imported anywhere in the codebase
  - Not required by any route
  - **Action**: Delete

- `frontend/js/sidebar.js` — **Loaded but never invoked**
  - Defines `SidebarManager` class
  - Not loaded in index.html (no <script> tag)
  - Targets DOM elements that don't exist in the actual DOM
  - **Action**: Remove from disk; archive or verify it's not needed

- `.agents/skills/*` — **12 design/UI agent skill files**
  - Not part of the running application
  - Development artifacts for design guidance
  - **Action**: Can be archived/removed from main repo; not breaking anything

---

### 2. SECURITY ISSUES

**High Priority:**
- `backend/server.js` (line 26): Imports `quickbooksService` but **never uses it**
  - No routes directly call it (routes require it separately)
  - Wastes memory and startup time
  - **Action**: Remove unused import

- `.env` file committed to git (present in repo root)
  - Should never be version-controlled even if empty
  - **Action**: Ensure `.gitignore` includes `.env`

- Frontend stores auth tokens in localStorage without explicit security measures
  - Tokens are accessible to XSS attacks if any injected
  - Current CSP is permissive (`scriptSrcAttr: ["'unsafe-inline'"]`)
  - **Action**: Review CSP strictness; consider secure cookies for tokens

---

### 3. PERFORMANCE ISSUES

**Frontend:**
- **Large monolithic app.js (8,326 lines)**
  - Single 262KB file parsed on every page load
  - No code splitting, lazy loading, or module bundling
  - Renders entire dashboard UI on init, regardless of current page
  - **Impact**: Slower first-paint, wasted JS parsing on auth page
  - **Recommended Action**: Consider bundling later (not blocking)

- **No caching headers on static assets**
  - `express.static()` serves CSS/JS without cache-busting beyond query strings
  - Browsers re-download assets on every page load
  - **Action**: Add `Cache-Control` headers in server config

- **Multiple API calls with no request deduplication**
  - If two components load the same endpoint simultaneously, both fire separate requests
  - No built-in caching layer
  - **Action**: Add simple response cache (in-memory with TTL)

- **Sidebar.js runs on DOMContentLoaded even though it's never included**
  - Dead code that won't run (no script tag)
  - **Action**: Delete file

**Backend:**
- **N+1 Query Risk in QuickBooks integration**
  - Need to audit `quickbooks.service.js` for repeated queries in loops
  - Requires detailed code review (73KB file)

- **Rate-limited endpoints may have cascading failures**
  - 3 separate rate limiters applied; unclear if stacking causes issues
  - **Action**: Test rate limit behavior under load

---

### 4. ARCHITECTURE ISSUES

**Frontend State Management:**
- Global state in IIFE closure (`state`, `nonakaChatHistory`, `kpiDetailStore`)
- No single source of truth; state spread across multiple objects
- Difficult to debug and test
- **Not breaking, but suboptimal**

**Backend Modularity:**
- QuickBooks routes file is 1,796 lines — should be split
- 14 separate service files for QB functionality — some could be consolidated
- Services are tightly coupled to route handlers

**Unused Dependencies:**
- `zod` included in both root and backend `package.json`
  - Root package.json has no legitimate use (no app runs there)
  - Backend uses `zod` but no validation schemas are present
  - **Action**: Remove `zod` from root; verify it's actually used in backend

- `axios` in backend — only used for QB API calls
  - Could use native `fetch()` (Node 18+) to reduce dependencies
  - Not critical but reduces complexity

---

### 5. CODE QUALITY ISSUES

**API Error Handling:**
- Some endpoints return raw error objects; others swallow errors silently
- Inconsistent error shape across routes
- **Action**: Standardize error response format

**Frontend Naming:**
- Many single-letter or abbreviated variable names (`el`, `m`, `v`, `px`)
- Makes large files harder to maintain
- **Not blocking; cosmetic**

**Missing Endpoint Documentation:**
- No JSDoc or inline comments explaining what each QB endpoint does
- **Action**: Add brief endpoint docs for maintainability

---

### 6. BROKEN FUNCTIONALITY

**Investigation Needed:**
- Cannot fully test without:
  - Active Supabase credentials
  - Active QuickBooks OAuth credentials
  - Active Anthropic API key
- Server starts successfully ✓
- Health check endpoint works ✓
- Auth flow structure appears sound
- No obvious runtime errors in code review

---

### 7. DEPENDENCY AUDIT

| Package | Version | Used? | Keep? | Notes |
|---------|---------|-------|-------|-------|
| @anthropic-ai/sdk | 0.120.0 | ✓ | Yes | AI features (claude requests) |
| @supabase/supabase-js | 2.112.3 | ✓ | Yes | Database & Auth |
| axios | 1.19.0 | ✓ | Maybe | QB API calls; could use fetch |
| cors | 2.8.6 | ✓ | Yes | Cross-origin requests |
| dotenv | 17.4.2 | ✓ | Yes | Environment config |
| express | 5.2.1 | ✓ | Yes | Web framework |
| express-rate-limit | 8.6.2 | ✓ | Yes | Rate limiting |
| helmet | 8.3.0 | ✓ | Yes | Security headers |
| zod | 4.4.3 | ✗ | No | Not used anywhere (dead dep) |
| nodemon | 3.1.14 | ✓ | Yes | Dev only |

---

## OPTIMIZATION ROADMAP

### Phase 1: Dead Code Removal (Quick Wins)
1. Delete `backend/services/quickbooks/company.service.js`
2. Delete unused import of `quickbooksService` from `backend/server.js`
3. Remove `sidebar.js` from disk (or archive)
4. Remove `zod` from dependencies (root + backend)
5. Remove `.agents/` directory (or move to separate branch)

**Effort**: 15 mins | **Risk**: Very Low | **Impact**: Cleaner codebase

### Phase 2: Security Hardening (Medium Priority)
1. Verify `.env` is in `.gitignore`
2. Add explicit CSP for inline styles/scripts
3. Review token storage security (consider secure cookies)
4. Add input validation schemas (even basic)

**Effort**: 30 mins | **Risk**: Low | **Impact**: Security improvements

### Phase 3: Performance Optimization (Medium Priority)
1. Add cache headers to static assets
2. Implement simple request deduplication cache
3. Profile QB service for N+1 queries
4. Split `quickbooks.routes.js` into 2-3 files

**Effort**: 1-2 hours | **Risk**: Low-Medium | **Impact**: Faster loads, fewer API calls

### Phase 4: Architecture Cleanup (Lower Priority)
1. Standardize API response/error format
2. Consider consolidating QB services (if they're redundant)
3. Add JSDoc comments to all routes
4. Consider migrating from axios to native fetch

**Effort**: 2-3 hours | **Risk**: Medium | **Impact**: Better maintainability

### Phase 5: Frontend Modernization (Future)
1. Add simple module bundler (or use native ES modules)
2. Split large JS files by page/feature
3. Implement request caching layer
4. Add proper state management (even minimal)

**Effort**: 4+ hours | **Risk**: Medium-High | **Impact**: Better UX, faster loads

---

## WHAT NOT TO CHANGE
- UI/UX design or styling (preserve current look)
- Database schema (unless critical)
- API contracts (endpoints, response shapes)
- Authentication flow (working correctly)
- Existing working features

---

## EXECUTION ORDER
1. **Phase 1 (Now)**: Delete dead code → Verify build works
2. **Phase 2 (Now)**: Security audit → Fix critical issues
3. **Phase 3 (If time)**: Performance → Measure impact
4. **Phase 4 (Deferred)**: Architecture → Document as you go
5. **Phase 5 (Future)**: Frontend modernization → Plan separately

---

## SUCCESS CRITERIA
- ✓ No unused files or imports
- ✓ No dead code
- ✓ All tests pass (if tests exist)
- ✓ Server starts without warnings
- ✓ Build completes successfully
- ✓ No security holes introduced
- ✓ Functionality preserved
- ✓ Codebase is smaller and faster
