# CC Domain Manager: Integration Architecture

## What This Document Covers

The specific integration points for adding automated domain provisioning to Command Center's app creation pipeline. This focuses on the domain-specific flow: searching for available domains, showing costs, purchasing, wiring DNS to GitHub Pages, and configuring the custom domain — all from within CC.

---

## The Three-System Handshake

Custom domain setup requires coordinating three separate systems. Today you do this manually across three browser tabs. CC will orchestrate all three via API.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  DOMAIN          │     │  GITHUB          │     │  COMMAND         │
│  REGISTRAR       │     │  (Pages)         │     │  CENTER          │
│                  │     │                  │     │                  │
│  • Search/buy    │     │  • CNAME file    │     │  • Orchestrator  │
│  • DNS records   │◄───►│  • Pages config  │◄───►│  • Status UI     │
│  • Account funds │     │  • HTTPS cert    │     │  • Health checks │
│                  │     │                  │     │                  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**What CC already does with GitHub:** Creates repos, enables Pages, commits files, manages CNAME files — all via GitHub REST API. This is proven, working infrastructure in SetupNewAppView.

**What CC needs to add:** A registrar API layer that handles domain search, purchase, and DNS configuration. Plus the glue logic that wires the two sides together.

---

## Recommended Registrar: NameSilo

After reviewing the API options, NameSilo is the strongest fit for CC's use case:

| Criteria | NameSilo | Cloudflare | Others |
|----------|----------|------------|--------|
| API simplicity | Simple GET/POST with API key | OAuth + zone management | Varies |
| Browser-friendly | Yes — simple HTTP calls, JSON responses | Yes but more complex | Some have CORS issues |
| Pricing | At-cost, no markup. .com ~$10.95/yr | At-cost. .com ~$9.77/yr | Higher with markup |
| Account funding | Pre-fund account balance, or payment profile on file | Credit card on account | Varies |
| DNS management | Full API for A, CNAME, TXT, MX records | Full API | Most support this |
| WHOIS privacy | Free, lifetime, automatic | Free | Usually free |
| Sandbox testing | Available on request | No sandbox | Rarely |
| CORS from browser | Works via simple HTTP GET | Requires proxy for some endpoints | Varies |

The architecture below uses NameSilo as the primary integration, but is designed with an abstraction layer so Cloudflare or others could be swapped in.

---

## Integration Architecture

### New Service: DomainService

Follows the same pattern as CC's existing service modules (WorkItemService, SessionService, TokenRegistryService, EngineRegistryService).

```javascript
const DomainService = {
    // ─── Configuration ───
    // Stored in localStorage as 'cc_domain_config' (sensitive — API key)
    // NOT synced to Firebase (contains payment credentials)
    
    getConfig() {
        return JSON.parse(localStorage.getItem('cc_domain_config') || '{}');
        // { provider: 'namesilo', apiKey: '...', paymentId: '...' }
    },
    
    isConfigured() {
        const cfg = this.getConfig();
        return !!(cfg.provider && cfg.apiKey);
    },

    // ─── Domain Search & Pricing ───
    
    async checkAvailability(domainName) {
        // Input: 'myapp' or 'myapp.com'
        // Checks multiple TLDs if no extension provided
        // Returns: [{ domain, available, price, renewPrice, premium }]
    },
    
    async searchSuggestions(keyword) {
        // Input: 'coolapp'
        // Returns creative alternatives across TLDs
        // e.g., coolapp.com, coolapp.io, coolapp.dev, coolapp.app
    },

    async getTLDPrices() {
        // Returns all supported TLDs with register + renew pricing
        // Cached in localStorage for 24hrs
    },
    
    // ─── Account & Billing ───
    
    async getAccountBalance() {
        // Returns current prepaid balance in USD
    },

    async addFunds(amount, paymentId) {
        // Add funds to account (uses saved payment profile)
        // paymentId references a credit card on file at NameSilo
    },

    // ─── Domain Registration ───
    
    async registerDomain(domain, years = 1) {
        // Purchase the domain
        // Auto-enables WHOIS privacy
        // Returns: { success, domain, orderAmount, message }
    },
    
    // ─── DNS Management ───
    
    async listDNSRecords(domain) {
        // Returns all current DNS records for a domain
    },

    async configureForGitHubPages(domain, githubUsername) {
        // THE KEY METHOD — sets up all DNS records needed for GitHub Pages
        // Creates: 4 A records + 1 CNAME record
        // Returns: { success, records: [...] }
    },
    
    async addDNSRecord(domain, type, host, value, ttl = 7200) {
        // Generic DNS record creation
    },
    
    async deleteDNSRecord(domain, recordId) {
        // Remove a specific DNS record
    },

    // ─── Health & Status ───
    
    async getDomainInfo(domain) {
        // Full domain details: status, expiry, nameservers, etc.
    },
    
    async verifyDNSPropagation(domain) {
        // Check if DNS records have propagated
        // Returns: { propagated: true/false, records: [...] }
    }
};
```

### The Critical Method: `configureForGitHubPages()`

This is where the magic happens. It creates all the DNS records GitHub Pages needs in a single orchestrated call.

```javascript
async configureForGitHubPages(domain, githubUsername) {
    const cfg = this.getConfig();
    const results = [];
    
    // GitHub Pages IP addresses (current as of 2025)
    const GITHUB_PAGES_IPS = [
        '185.199.108.153',
        '185.199.109.153',
        '185.199.110.153',
        '185.199.111.153'
    ];
    
    // Step 1: Clear any existing default DNS records
    //         (new domains come with parking records)
    const existing = await this.listDNSRecords(domain);
    for (const record of existing) {
        if (record.type === 'A' || record.type === 'CNAME' || record.type === 'AAAA') {
            await this.deleteDNSRecord(domain, record.recordId);
            await this._rateLimit();  // NameSilo: 1 req/sec
        }
    }
    
    // Step 2: Create A records for apex domain (e.g., myapp.com)
    for (const ip of GITHUB_PAGES_IPS) {
        const result = await this.addDNSRecord(domain, 'A', '', ip, 3600);
        results.push({ type: 'A', host: '@', value: ip, ...result });
        await this._rateLimit();
    }
    
    // Step 3: Create CNAME for www subdomain
    //         Points www.myapp.com → username.github.io
    const cnameResult = await this.addDNSRecord(
        domain, 'CNAME', 'www', 
        `${githubUsername}.github.io`, 3600
    );
    results.push({ type: 'CNAME', host: 'www', 
                   value: `${githubUsername}.github.io`, ...cnameResult });
    
    return { success: true, recordsCreated: results.length, records: results };
},

_rateLimit() {
    return new Promise(resolve => setTimeout(resolve, 1100));
    // NameSilo requires ≤1 request per second
}
```

---

## API Call Mapping

Every integration point mapped to the actual NameSilo API endpoint CC will call.

### Domain Search & Availability

```
User types "myapp" in search box
        │
        ▼
GET https://www.namesilo.com/api/checkRegisterAvailability
    ?version=1&type=json&key={API_KEY}
    &domains=myapp.com,myapp.io,myapp.dev,myapp.app,myapp.co
        │
        ▼
Response: {
    available: [
        { domain: "myapp.dev", price: 12.99 },
        { domain: "myapp.app", price: 17.99 }
    ],
    unavailable: ["myapp.com", "myapp.io", "myapp.co"]
}
```

### Get Pricing for All TLDs

```
User opens domain search (first time, or cached > 24hrs)
        │
        ▼
GET https://www.namesilo.com/api/getPrices
    ?version=1&type=json&key={API_KEY}
        │
        ▼
Response: {
    com:  { registration: 10.95, renewal: 10.95 },
    io:   { registration: 44.99, renewal: 44.99 },
    dev:  { registration: 12.99, renewal: 12.99 },
    app:  { registration: 17.99, renewal: 17.99 },
    co:   { registration: 11.99, renewal: 11.99 },
    ...
}
        │
        ▼
Cached in localStorage: cc_tld_prices (with timestamp)
```

### Check Account Balance

```
User clicks "Register Domain" — CC checks funds first
        │
        ▼
GET https://www.namesilo.com/api/getAccountBalance
    ?version=1&type=json&key={API_KEY}
        │
        ▼
Response: { balance: "47.82" }
        │
        ▼
CC compares: balance ($47.82) >= domain cost ($12.99)?
  ├── Yes → proceed to registration
  └── No  → show "Insufficient funds" with link to add funds
```

### Register Domain

```
User confirms purchase
        │
        ▼
GET https://www.namesilo.com/api/registerDomain
    ?version=1&type=json&key={API_KEY}
    &domain=myapp.dev
    &years=1
    &private=1        ← auto-enable WHOIS privacy
    &auto_renew=1     ← don't let it expire accidentally
        │
        ▼
Response: {
    code: 300,
    detail: "success",
    message: "Your domain registration was successfully processed.",
    domain: "myapp.dev",
    order_amount: "12.99"
}
```

### Configure DNS for GitHub Pages

```
After registration succeeds, CC runs configureForGitHubPages()
        │
        ▼
(5 sequential API calls with 1-second spacing)

1. DELETE existing parking/default records
   GET .../api/dnsDeleteRecord?...&rrid={each_existing_record_id}

2. A record #1
   GET .../api/dnsAddRecord?...&domain=myapp.dev&rrtype=A
       &rrhost=&rrvalue=185.199.108.153&rrttl=3600

3. A record #2
   GET .../api/dnsAddRecord?...&rrvalue=185.199.109.153

4. A record #3
   GET .../api/dnsAddRecord?...&rrvalue=185.199.110.153

5. A record #4
   GET .../api/dnsAddRecord?...&rrvalue=185.199.111.153

6. CNAME for www
   GET .../api/dnsAddRecord?...&rrtype=CNAME
       &rrhost=www&rrvalue=stewartdavidp-ship-it.github.io
```

### Wire Up GitHub Side

```
After DNS records are created at NameSilo, CC configures GitHub
        │
        ▼
(CC already has GitHubAPI — these are new calls using existing wrapper)

1. Create CNAME file in repo
   PUT /repos/{owner}/{repo}/contents/CNAME
   Body: base64("myapp.dev")
   Message: "Add custom domain CNAME for myapp.dev"

2. Update Pages configuration with custom domain
   PUT /repos/{owner}/{repo}/pages
   Body: { "cname": "myapp.dev", "source": { "branch": "main", "path": "/" } }
   Headers: Authorization: Bearer {github_token}

3. After DNS propagates (~5-30 min), enforce HTTPS
   PUT /repos/{owner}/{repo}/pages
   Body: { "https_enforced": true }
```

### Verify Everything is Working

```
CC polls for DNS propagation + HTTPS cert
        │
        ▼
GET /repos/{owner}/{repo}/pages/health
Headers: Authorization: Bearer {github_token}
        │
        ▼
Response: {
    domain: {
        host: "myapp.dev",
        caa_error: null,
        dns_resolves: true,                 ← DNS propagated
        is_apex_domain: true,
        https_error: null,
        enforced_https: true,               ← HTTPS working
        is_a_record: true,
        has_cname_record: true
    }
}
```

---

## Payment Model: Pre-Funded Account

NameSilo uses a prepaid account balance model, which is actually ideal for this use case.

```
How funding works:

1. INITIAL SETUP (one-time, done in CC Settings)
   ├── Create NameSilo account at namesilo.com
   ├── Add a credit card as a "payment profile" 
   ├── Generate an API key in NameSilo's API Manager
   └── Enter API key + payment profile ID in CC Settings

2. ADD FUNDS (as needed, from CC or NameSilo site)
   ├── Option A: CC calls addAccountFunds API with amount + paymentId
   │   └── Charges the card on file, credits the NameSilo balance
   ├── Option B: User adds funds directly at namesilo.com
   └── Balance visible in CC's domain management UI

3. PURCHASE DOMAINS (automated, deducts from balance)
   ├── CC checks balance >= domain cost before attempting
   ├── registerDomain API deducts from balance
   └── No card prompt needed — it's prepaid
```

**Why prepaid works well here:**
- No payment popup or card entry during the wizard flow — keeps it seamless
- CC can check balance before purchase and warn if insufficient
- User controls their spending — can only spend what they've pre-loaded
- No risk of unexpected charges from API bugs — balance is the ceiling

**CC Settings UI addition:**

```
Settings → Domain Registrar
┌─────────────────────────────────────────────────┐
│  🌐 Domain Registrar Configuration               │
│                                                   │
│  Provider:    [NameSilo ▾]                        │
│  API Key:     [••••••••••••••••] [Show] [Test]    │
│  Payment ID:  [••••••] (from NameSilo account)    │
│                                                   │
│  Account Balance: $47.82  [Refresh]               │
│  [+ Add $25]  [+ Add $50]  [+ Add $100]          │
│                                                   │
│  Domains Managed: 3                               │
│  ├── gameshelf.co    expires 2027-03-15  ✅       │
│  ├── quotle.info     expires 2026-11-20  ✅       │
│  └── myapp.dev       expires 2027-02-09  ✅       │
│                                                   │
│  [Test Connection]  status: ✅ Connected           │
└─────────────────────────────────────────────────┘
```

---

## The Full Orchestrated Flow

Here's how it all comes together in the Setup New App wizard when "Map to Custom Domain" is selected:

```
STEP 3: Infrastructure (existing wizard step, enhanced)

  ☑ Map to custom domain

  ┌─ Domain Search ──────────────────────────────────────────┐
  │                                                          │
  │  Search: [myapp          ] [Search]                      │
  │                                                          │
  │  ✅ myapp.dev         $12.99/yr  (renew: $12.99)  [Select]│
  │  ✅ myapp.app         $17.99/yr  (renew: $17.99)  [Select]│
  │  ❌ myapp.com         taken                              │
  │  ❌ myapp.io          taken                              │
  │  ✅ myapp.co          $11.99/yr  (renew: $11.99)  [Select]│
  │  ✅ myapp.site         $2.99/yr  (renew: $10.99)  [Select]│
  │                                                          │
  │  💰 Account balance: $47.82                              │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
  
  Selected: myapp.dev ($12.99)
  Balance after purchase: $34.83
```

```
STEP 4: Create & Generate (wizard execution)

  ✅ Creating repository: myapp-dev ........................ done
  ✅ Enabling GitHub Pages ................................. done
  ✅ Seeding initial HTML .................................. done
  ✅ Registering domain: myapp.dev ......................... done ($12.99)
  ✅ Configuring DNS records (6 records) ................... done
  ✅ Setting custom domain on GitHub Pages ................. done
  ✅ Adding to Command Center config ....................... done
  ✅ Generating Claude project prompt ...................... done
  ⏳ Waiting for DNS propagation ........................... checking...
  
  ┌─ Domain Status ──────────────────────────────────────────┐
  │                                                          │
  │  🌐 myapp.dev                                           │
  │                                                          │
  │  DNS Records:         ✅ 4 A records + 1 CNAME created  │
  │  DNS Propagation:     🔄 Propagating (can take 5-30 min)│
  │  GitHub CNAME:        ✅ CNAME file committed            │
  │  GitHub Pages Config: ✅ Custom domain set               │
  │  HTTPS Certificate:   ⏳ Pending (auto after DNS)        │
  │                                                          │
  │  Your app will be live at https://myapp.dev              │
  │  once DNS propagates. CC will notify you.                │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
```

---

## How It Connects to Existing CC Infrastructure

### Changes to App Definition Schema

```javascript
// New fields in config.apps[appId]
{
    ...existingFields,
    
    // Domain configuration (new)
    domain: {
        name: 'myapp.dev',           // The custom domain
        provider: 'namesilo',        // Which registrar
        registeredAt: '2026-02-09',  // When purchased
        expiresAt: '2027-02-09',     // When renewal is due
        autoRenew: true,
        dnsStatus: 'active',         // active | propagating | error
        httpsStatus: 'enforced',     // pending | approved | enforced | error
        lastHealthCheck: '2026-02-09T15:30:00Z',
        healthResult: { dns_resolves: true, https_error: null }
    }
}
```

### Changes to GitHubAPI Wrapper

Add two new methods to the existing `GitHubAPI` object:

```javascript
// New methods on existing GitHubAPI
async updatePagesConfig(repoFullName, cname, enforceHttps = false) {
    return await this.request(`/repos/${repoFullName}/pages`, {
        method: 'PUT',
        body: JSON.stringify({
            cname: cname,
            https_enforced: enforceHttps,
            source: { branch: 'main', path: '/' }
        })
    });
},

async checkPagesHealth(repoFullName) {
    return await this.request(`/repos/${repoFullName}/pages/health`);
    // Note: first call returns 202 (async), poll until 200
}
```

### Changes to SetupNewAppView

The domain flow slots into the existing wizard as an optional enhancement to Step 3 (Infrastructure) and Step 4 (Create). No structural changes — it's additive.

```
Step 3 additions:
  ├── "Map to custom domain" checkbox (like existing "isPWA" checkbox)
  ├── If checked → show domain search inline
  ├── DomainSearchPanel component (new)
  └── Selected domain stored in appData.domain

Step 4 additions:
  ├── After repo creation + seed deploy (existing)
  ├── If appData.domain → run domain provisioning sequence
  │   ├── DomainService.registerDomain()
  │   ├── DomainService.configureForGitHubPages()
  │   ├── GitHubAPI.createOrUpdateFile() for CNAME
  │   ├── GitHubAPI.updatePagesConfig()
  │   └── Start background health polling
  └── Update app config with domain metadata
```

### Dashboard Integration

Apps with custom domains get a domain badge on the dashboard card:

```
🎮 Game Shelf          v2.3.1  test ✓  prod ✓
   🌐 gameshelf.co  ✅ HTTPS    

🆕 My New App          v0.1.0  prod ✓
   🌐 myapp.dev     🔄 DNS propagating...
```

### Monitor Tab Integration

A new "Domains" subtab under Monitor showing health status for all custom domains, renewal dates, and DNS record status. Periodic health checks via GitHub Pages health API.

---

## Domain Management Beyond Setup

After initial provisioning, CC should also support:

### Mapping Existing Domains to Existing Apps

Not just new apps — ability to add a domain to any app already in CC:

```
App Card → ⚙️ Edit → Domain tab
  └── [+ Add Custom Domain]
      ├── Enter domain name (already owned)
      ├── CC verifies you own it (via NameSilo API)
      ├── CC configures DNS records
      ├── CC updates GitHub Pages config
      └── Domain linked to app
```

### Renewal Management

```
Monitor → Domains
  ┌──────────────────────────────────────────────────────┐
  │  Domain Health                                        │
  │                                                       │
  │  gameshelf.co    ✅ Active   Expires: 2027-03-15      │
  │  quotle.info     ⚠️ Renews in 45 days                │
  │  myapp.dev       ✅ Active   Expires: 2027-02-09      │
  │                                                       │
  │  All domains set to auto-renew                        │
  │  Account balance: $47.82 (covers all renewals)        │
  └──────────────────────────────────────────────────────┘
```

### Domain Transfer Support (Future)

For domains already owned at other registrars, CC could initiate transfers to NameSilo to centralize management. This is Phase 2 — the transfer API exists but the flow is more complex (auth codes, 60-day locks, etc.).

---

## CORS and Browser Security Considerations

CC runs as a static HTML file in the browser. API calls need to work from `file://` and `https://` origins.

**NameSilo's API:** Uses simple GET requests with API key as a query parameter. Based on community usage, these work from browser JavaScript without CORS issues. If CORS becomes a problem, the fallback is:

1. **Firebase Cloud Function proxy** — CC already has Firebase Functions deployed. A thin proxy function could relay NameSilo API calls:

```javascript
// Firebase Function (already have this infrastructure)
exports.domainProxy = functions.https.onCall(async (data, context) => {
    // Verify authenticated user
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated');
    
    const { operation, params } = data;
    const apiKey = /* user's encrypted key from Firebase */;
    const url = `https://www.namesilo.com/api/${operation}?version=1&type=json&key=${apiKey}&${params}`;
    const response = await fetch(url);
    return await response.json();
});
```

2. **Direct calls first, proxy fallback** — Try the direct API call. If it fails with CORS error, automatically route through the Firebase proxy. Transparent to the user.

**GitHub API:** Already working from browser in CC today — no changes needed.

---

## Data Storage

```
localStorage (sensitive — NOT synced to Firebase):
  cc_domain_config     →  { provider, apiKey, paymentId }

localStorage (cached, refreshable):
  cc_tld_prices        →  { timestamp, prices: { com: {...}, io: {...} } }
  cc_domain_health     →  { [domain]: { lastCheck, result } }

Firebase (synced, part of app config):
  config.apps[id].domain  →  { name, registeredAt, expiresAt, ... }
```

The API key never touches Firebase. Same pattern as `cc_github_token` and `cc_firebase_sa`.

---

## Implementation Roadmap

### Session 1: Domain Service + Settings UI
- DomainService module (availability check, pricing, balance)
- Settings → Domain Registrar configuration panel
- Connection test + account balance display
- TLD price caching

### Session 2: Domain Search in Setup Wizard
- DomainSearchPanel component
- Integrate into SetupNewAppView Step 3
- Availability results with pricing
- Domain selection into appData

### Session 3: Purchase + DNS + GitHub Wiring
- registerDomain() integration in Step 4
- configureForGitHubPages() — the 6-record DNS setup
- CNAME file commit + GitHub Pages API configuration
- Progress log entries for each step
- App config domain metadata

### Session 4: Health Monitoring + Polish
- Background DNS propagation polling
- Domain health check on Monitor tab
- Dashboard domain badges
- Renewal warnings
- Existing app → domain mapping flow

### Future: Multi-registrar abstraction
- Abstract DomainService behind provider interface
- Add Cloudflare provider option
- Domain transfer support

---

## Error Handling

| Scenario | CC Response |
|----------|-------------|
| API key invalid | Show error in Settings, block domain operations |
| Domain taken (race condition) | Show "no longer available" and re-search |
| Insufficient balance | Show balance vs. cost, offer "Add Funds" button |
| DNS record creation fails | Retry up to 3 times, then show manual instructions |
| GitHub Pages API rejects domain | Check if domain is already used by another GH Pages site |
| DNS propagation timeout (>1hr) | Stop polling, show "still propagating" with manual verify link |
| HTTPS cert fails | Check CAA records, suggest waiting 24hrs, link to GH troubleshooting |
| NameSilo API rate limit | Queue requests with 1.1s spacing, show progress indicator |
| CORS blocking API calls | Transparent fallback to Firebase Function proxy |

---

## What This Enables

**Before (today's manual process):**
1. Go to domain registrar website, search for domain
2. Add to cart, go through checkout
3. Wait for purchase to complete
4. Navigate to DNS management panel
5. Delete default parking records
6. Manually add 4 A records with GitHub IPs
7. Manually add CNAME record for www
8. Go to GitHub repo → Settings → Pages
9. Enter custom domain, click Save
10. Wait for DNS propagation
11. Come back and enable HTTPS
12. Update CC config with domain info

**After (CC automated):**
1. During app setup, check "Map to custom domain"
2. Type a keyword, pick from available options
3. Click "Create"
4. CC does steps 2-12 automatically
5. Get a notification when it's live

**Time saved:** ~15-30 minutes of manual work per domain, plus elimination of DNS configuration errors (wrong IPs, missing records, etc.) that can take hours to debug.
