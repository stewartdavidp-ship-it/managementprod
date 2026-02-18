/*
 * CC Shared Utilities — cc-shared.js v1.1.0
 * Part of the Command Center Satellite Architecture (v8.49.0+)
 *
 * Loaded by all CC satellite apps. Provides shared infrastructure so
 * satellites don't need to duplicate credential management or Firebase init.
 *
 * Provides:
 *   1. CC object — Secrets reader (reads gs_* localStorage keys set by CC Core)
 *      - getGitHubToken(), getFirebaseSA(), getConfig(), getFirebaseUid()
 *      - getCoreUrl() — resolves path back to CC Core index.html
 *      - getApiKey() — Anthropic API key for AI features
 *   2. initFirebase(CC) — Firebase initialization helper using SA credentials
 *   3. React components:
 *      - SatelliteHeader — Common header with CC logo link, satellite name, back button
 *      - MissingCredentials — Fallback screen when gs_* keys are empty
 *
 * Usage: <script src="../shared/cc-shared.js"></script>
 *        (load AFTER React, ReactDOM, and Babel CDN scripts)
 *
 * Key Design Decisions:
 *   - Dual-read: tries gs_* keys first, falls back to cc_* for backward compat
 *   - No writes: only CC Core writes credentials, satellites just read
 *   - Firebase init is lazy: satellites call initFirebase() when needed
 */

// =========================================================================
// 1. CC — Secrets & Config Reader
// =========================================================================

const CC = {
    /** GitHub Personal Access Token */
    getGitHubToken() {
        return localStorage.getItem('gs_github_token')
            || localStorage.getItem('cc_token')
            || '';
    },

    /** Firebase Service Account JSON (parsed) */
    getFirebaseSA() {
        try {
            const sa = localStorage.getItem('gs_firebase_sa')
                    || localStorage.getItem('cc_firebase_sa');
            return sa ? JSON.parse(sa) : null;
        } catch { return null; }
    },

    /** App/project configuration object */
    getConfig() {
        try {
            const cfg = localStorage.getItem('gs_config')
                     || localStorage.getItem('commandCenterConfig');
            return cfg ? JSON.parse(cfg) : {};
        } catch { return {}; }
    },

    /** Firebase user UID */
    getFirebaseUid() {
        return localStorage.getItem('gs_firebase_uid')
            || localStorage.getItem('cc_firebase_uid')
            || '';
    },

    /** Anthropic API key */
    getApiKey() {
        return localStorage.getItem('gs_api_key')
            || localStorage.getItem('cc_api_key')
            || '';
    },

    /** Resolve URL to CC Core index.html */
    getCoreUrl() {
        // Satellites live at /command-center/{satellite}/index.html
        // CC Core lives at /command-center/index.html
        try {
            const loc = window.location;
            if (loc.protocol === 'file:') {
                // Local file: go up one directory
                return '../index.html';
            }
            // Web: construct path
            const pathParts = loc.pathname.split('/').filter(Boolean);
            // Expected: ['command-center', '{satellite}', 'index.html'] or similar
            const ccIdx = pathParts.indexOf('command-center');
            if (ccIdx >= 0) {
                return '/' + pathParts.slice(0, ccIdx + 1).join('/') + '/';
            }
            return '../';
        } catch {
            return '../index.html';
        }
    },

    /** Check if all required credentials are present */
    hasCredentials() {
        return !!(this.getGitHubToken() && this.getFirebaseUid());
    },

    /** Settings URL in CC Core */
    getSettingsUrl() {
        return this.getCoreUrl() + '#settings';
    }
};


// =========================================================================
// 2. Firebase Initialization Helper
// =========================================================================

const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBQVwn8vOrFTzLlm2MYIPBwgZV2xR9AuhM",
    authDomain: "word-boxing.firebaseapp.com",
    databaseURL: "https://word-boxing-default-rtdb.firebaseio.com",
    projectId: "word-boxing"
};

/**
 * Initialize Firebase app, auth, and database.
 * Returns { app, auth, db } or null on failure.
 */
function initFirebase() {
    try {
        if (typeof firebase === 'undefined') {
            console.warn('[cc-shared] Firebase SDK not loaded');
            return null;
        }
        let app;
        if (!firebase.apps.length) {
            app = firebase.initializeApp(FIREBASE_CONFIG);
        } else {
            app = firebase.apps[0];
        }
        const auth = firebase.auth();
        const db = firebase.database();
        console.log('[cc-shared] Firebase initialized');
        return { app, auth, db };
    } catch (e) {
        console.error('[cc-shared] Firebase init error:', e);
        return null;
    }
}


// =========================================================================
// 3. React Components (available globally, used by satellites via Babel)
// =========================================================================

/**
 * SatelliteHeader — Common header for satellite apps.
 *
 * Props:
 *   - name: string       — Satellite display name (e.g. "Infrastructure")
 *   - icon: string       — Emoji icon for this satellite
 *   - version: string    — Optional version string
 *   - showBack: boolean  — Show "← CC Core" back link (default: true)
 */
const SatelliteHeader = ({ name, icon = '🛰️', version, showBack = true }) => {
    const coreUrl = CC.getCoreUrl();
    const e = React.createElement;

    return e('header', {
        style: {
            background: '#1e293b',
            borderBottom: '1px solid #334155',
            position: 'sticky',
            top: 0,
            zIndex: 50
        }
    },
        e('div', {
            style: {
                maxWidth: '72rem',
                margin: '0 auto',
                padding: '0.75rem 1rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
            }
        },
            // Left: Logo + title
            e('div', { style: { display: 'flex', alignItems: 'center', gap: '0.75rem' } },
                // CC Logo (links home)
                e('a', {
                    href: coreUrl,
                    title: 'Back to Command Center',
                    style: { display: 'flex', textDecoration: 'none' }
                },
                    e('svg', {
                        viewBox: '0 0 100 100', width: 28, height: 28,
                        xmlns: 'http://www.w3.org/2000/svg'
                    },
                        e('defs', null,
                            e('linearGradient', { id: 'gsBadgeGrad', x1: '0%', y1: '0%', x2: '100%', y2: '100%' },
                                e('stop', { offset: '0%', style: { stopColor: '#667eea' } }),
                                e('stop', { offset: '100%', style: { stopColor: '#764ba2' } })
                            )
                        ),
                        e('rect', { x: 5, y: 5, width: 90, height: 90, rx: 20, fill: 'url(#gsBadgeGrad)' }),
                        e('g', { transform: 'rotate(-12, 35, 50)' },
                            e('rect', { x: 15, y: 28, width: 28, height: 36, rx: 4, fill: 'white' }),
                            e('circle', { cx: 43, cy: 46, r: 6, fill: 'white' }),
                            e('text', { x: 29, y: 54, fontFamily: 'Arial', fontSize: 20, fontWeight: 'bold', fill: '#667eea', textAnchor: 'middle' }, 'G')
                        ),
                        e('g', { transform: 'rotate(12, 65, 50)' },
                            e('rect', { x: 57, y: 28, width: 28, height: 36, rx: 4, fill: 'rgba(255,255,255,0.9)' }),
                            e('circle', { cx: 57, cy: 46, r: 6, fill: 'url(#gsBadgeGrad)' }),
                            e('text', { x: 71, y: 54, fontFamily: 'Arial', fontSize: 20, fontWeight: 'bold', fill: '#764ba2', textAnchor: 'middle' }, 'S')
                        )
                    )
                ),
                // Satellite name
                e('div', null,
                    e('h1', { style: { fontSize: '1.125rem', fontWeight: 700, margin: 0, color: '#f1f5f9' } },
                        e('span', { style: { marginRight: '0.375rem' } }, icon), name
                    ),
                    e('div', { style: { fontSize: '0.7rem', color: '#64748b' } },
                        'Command Center',
                        version ? ` • v${version}` : ''
                    )
                )
            ),
            // Right: Back link
            showBack && e('a', {
                href: coreUrl,
                style: {
                    fontSize: '0.8rem',
                    color: '#94a3b8',
                    textDecoration: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    padding: '0.375rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #334155',
                    transition: 'background 0.15s'
                },
                onMouseEnter: (ev) => { ev.currentTarget.style.background = '#334155'; },
                onMouseLeave: (ev) => { ev.currentTarget.style.background = 'transparent'; }
            }, '← CC Core')
        )
    );
};


/**
 * MissingCredentials — Fallback screen when gs_* keys are empty.
 *
 * Props:
 *   - satelliteName: string — Name of the satellite app
 *   - needs: string[]      — List of required credentials (default: all)
 */
const MissingCredentials = ({ satelliteName = 'This satellite', needs }) => {
    const settingsUrl = CC.getSettingsUrl();
    const e = React.createElement;

    const missing = [];
    if (!CC.getGitHubToken())  missing.push('GitHub Token');
    if (!CC.getFirebaseUid())  missing.push('Firebase Sign-in');
    if (!CC.getFirebaseSA())   missing.push('Firebase Service Account');

    // Filter to only requested needs
    const filtered = needs ? missing.filter(m => needs.some(n => m.toLowerCase().includes(n.toLowerCase()))) : missing;
    const display = filtered.length > 0 ? filtered : missing;

    if (display.length === 0) return null;

    return e('div', {
        style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '60vh',
            padding: '2rem'
        }
    },
        e('div', {
            style: {
                background: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.75rem',
                padding: '2rem',
                maxWidth: '480px',
                width: '100%',
                textAlign: 'center'
            }
        },
            e('div', { style: { fontSize: '3rem', marginBottom: '1rem' } }, '🔑'),
            e('h2', { style: { fontSize: '1.25rem', fontWeight: 700, color: '#f1f5f9', marginBottom: '0.5rem' } },
                'Credentials Required'
            ),
            e('p', { style: { color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1.25rem' } },
                `${satelliteName} needs the following from Command Center:`
            ),
            e('div', { style: { marginBottom: '1.5rem' } },
                display.map((item, i) =>
                    e('div', {
                        key: i,
                        style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            padding: '0.5rem 0.75rem',
                            background: '#7f1d1d',
                            border: '1px solid #b91c1c',
                            borderRadius: '0.5rem',
                            marginBottom: '0.5rem',
                            fontSize: '0.875rem',
                            color: '#f87171'
                        }
                    }, '⚠️ ', item, ' — not found')
                )
            ),
            e('a', {
                href: settingsUrl,
                style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.375rem',
                    padding: '0.625rem 1.25rem',
                    background: '#4f46e5',
                    color: '#fff',
                    borderRadius: '0.5rem',
                    textDecoration: 'none',
                    fontWeight: 500,
                    fontSize: '0.875rem'
                }
            }, '⚙️ Open CC Core Settings'),
            e('p', { style: { color: '#64748b', fontSize: '0.75rem', marginTop: '1rem' } },
                'Save your credentials in Command Center, then reload this page.'
            )
        )
    );
};


// =========================================================================
// 4. Exports — Available globally for satellite apps
// =========================================================================

// These are all globals: CC, FIREBASE_CONFIG, initFirebase, SatelliteHeader, MissingCredentials
console.log('[cc-shared] Loaded — CC secrets reader, Firebase helper, shared components ready');
