/**
 * CC Shared — Satellite Bootstrap Module (v1.0.0)
 * Provides Firebase init, credential access, and shared UI components
 * for CC satellite apps (Infrastructure, Analytics, Quality).
 *
 * Dependencies: Firebase compat SDK must be loaded before this script.
 * Usage: <script src="../shared/cc-shared.js"></script>
 */

// =========================================================================
// FIREBASE INIT
// =========================================================================

function initFirebase() {
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyBQVwn8vOrFTzLlm2MYIPBwgZV2xR9AuhM",
        authDomain: "word-boxing.firebaseapp.com",
        databaseURL: "https://word-boxing-default-rtdb.firebaseio.com",
        projectId: "word-boxing"
    };

    try {
        let app;
        if (!firebase.apps.length) {
            app = firebase.initializeApp(FIREBASE_CONFIG);
        } else {
            app = firebase.apps[0];
        }

        const auth = firebase.auth();
        const db = firebase.database();

        // Auto sign-in with service account UID if available
        const uid = localStorage.getItem('gs_firebase_uid') || localStorage.getItem('cc_firebase_uid');
        const sa = localStorage.getItem('gs_firebase_sa') || localStorage.getItem('cc_firebase_sa');
        if (sa) {
            try {
                auth.signInWithCustomToken(sa).catch(() => {});
            } catch {}
        }

        console.log('[CC Shared] Firebase initialized');
        return { app, auth, db };
    } catch (e) {
        console.error('[CC Shared] Firebase init error:', e);
        return null;
    }
}

// =========================================================================
// CC NAMESPACE — Credential & Config Access
// =========================================================================

const CC = {
    getGitHubToken() {
        return localStorage.getItem('gs_github_token') || localStorage.getItem('cc_token') || null;
    },

    getFirebaseUid() {
        return localStorage.getItem('gs_firebase_uid') || localStorage.getItem('cc_firebase_uid') || null;
    },

    getConfig() {
        try {
            const raw = localStorage.getItem('gs_config') || localStorage.getItem('commandCenterConfig');
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    },

    hasCredentials() {
        return !!(this.getGitHubToken() && this.getFirebaseUid());
    },

    getCoreUrl() {
        // Return the CC core app URL (same origin, root)
        return window.location.origin + '/';
    },

    getApiKey() {
        return localStorage.getItem('gs_api_key') || localStorage.getItem('cc_api_key') || null;
    }
};

// =========================================================================
// UTILITY FUNCTIONS
// =========================================================================

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const val = bytes / Math.pow(k, i);
    return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

// =========================================================================
// SHARED REACT COMPONENTS
// =========================================================================

/**
 * SatelliteHeader — Top navigation bar for satellite apps
 * Props: name/title (string), icon (string emoji), version (string)
 */
const SatelliteHeader = (function() {
    const e = React.createElement;

    return function SatelliteHeader(props) {
        const name = props.name || props.title || 'Satellite';
        const icon = props.icon || '📡';
        const version = props.version || '';

        return e('div', {
            style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 20px',
                background: '#1e293b',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                position: 'sticky',
                top: 0,
                zIndex: 50
            }
        },
            e('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                e('span', { style: { fontSize: '20px' } }, icon),
                e('span', {
                    style: {
                        fontSize: '16px',
                        fontWeight: 600,
                        color: '#e2e8f0'
                    }
                }, name),
                version ? e('span', {
                    style: {
                        fontSize: '11px',
                        color: '#64748b',
                        background: '#334155',
                        padding: '2px 8px',
                        borderRadius: '10px'
                    }
                }, 'v' + version) : null
            ),
            e('a', {
                href: CC.getCoreUrl(),
                style: {
                    fontSize: '13px',
                    color: '#818cf8',
                    textDecoration: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                },
                onMouseOver: function(ev) { ev.target.style.color = '#a5b4fc'; },
                onMouseOut: function(ev) { ev.target.style.color = '#818cf8'; }
            }, '← Command Center')
        );
    };
})();

/**
 * MissingCredentials — Shown when satellite can't find required auth tokens
 * Props: satelliteName/title (string)
 */
const MissingCredentials = (function() {
    const e = React.createElement;

    return function MissingCredentials(props) {
        const name = props.satelliteName || props.title || 'This satellite';

        return e('div', {
            style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: '80vh',
                padding: '20px'
            }
        },
            e('div', {
                style: {
                    textAlign: 'center',
                    maxWidth: '420px',
                    padding: '40px',
                    background: '#1e293b',
                    borderRadius: '16px',
                    border: '1px solid rgba(255,255,255,0.06)'
                }
            },
                e('div', { style: { fontSize: '48px', marginBottom: '16px' } }, '🔑'),
                e('h2', {
                    style: {
                        fontSize: '20px',
                        fontWeight: 600,
                        color: '#e2e8f0',
                        marginBottom: '12px'
                    }
                }, 'Credentials Required'),
                e('p', {
                    style: {
                        fontSize: '14px',
                        color: '#94a3b8',
                        lineHeight: 1.6,
                        marginBottom: '24px'
                    }
                }, name + ' needs access to your Command Center credentials. Please open CC Core first and make sure you\'re signed in.'),
                e('a', {
                    href: CC.getCoreUrl(),
                    style: {
                        display: 'inline-block',
                        padding: '10px 24px',
                        background: '#4f46e5',
                        color: 'white',
                        borderRadius: '8px',
                        textDecoration: 'none',
                        fontSize: '14px',
                        fontWeight: 500
                    }
                }, 'Open Command Center →')
            )
        );
    };
})();

console.log('[CC Shared] Module loaded — initFirebase, CC, SatelliteHeader, MissingCredentials, formatBytes available');
