// server.js
const express = require('express');
const fetch = require('node-fetch'); // npm i node-fetch@2
const { Pool } = require('pg');       // npm i pg
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Config from Render env vars (set these in Render)
const CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID || 'REPLACE_ME';
const CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET || 'REPLACE_ME';
const CALLBACK_BASE = process.env.CALLBACK_URL || `https://yourapp.onrender.com/callback/quickbooks`;
const BASE_URL = process.env.BASE_URL || 'https://yourapp.onrender.com'; // optional

// Warn if placeholders
if (CLIENT_ID === 'REPLACE_ME' || CLIENT_SECRET === 'REPLACE_ME') {
  console.warn('WARNING: QUICKBOOKS_CLIENT_ID or QUICKBOOKS_CLIENT_SECRET is not set (using placeholder).');
}

// DB: use Postgres if DATABASE_URL is present, else in-memory
let usePg = !!process.env.DATABASE_URL;
let pool;
let store = {}; // in-memory { stateId: { access_token, refresh_token, realmId, expires_at } }

if (usePg) {
  try {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }});
    (async () => {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS connections (
            state_id TEXT PRIMARY KEY,
            access_token TEXT,
            refresh_token TEXT,
            realm_id TEXT,
            expires_at TIMESTAMP
          );
        `);
        console.log('Postgres connected and table ensured.');
      } catch (err) {
        console.error('Error creating connections table:', err);
      }
    })();
  } catch (err) {
    console.error('Failed to initialize Postgres pool:', err);
    usePg = false;
  }
} else {
  console.log('No DATABASE_URL found — using in-memory store (non-persistent).');
}

console.log(`Using storage: ${usePg ? 'Postgres' : 'In-memory'}`);
console.log(`Callback URL: ${CALLBACK_BASE}`);

// Quick test
app.get('/', (req, res) => res.send('✅ QuickBooks Middleware is running on Render!'));

// 1) Start OAuth: redirect user to QuickBooks authorize page
app.get('/auth/quickbooks', (req, res) => {
  const { state, redirect } = req.query;
  // Save redirect URL temporarily for use in callback
  oauthClient.authorizeUri = `${process.env.BASE_URL}/callback/quickbooks?state=${state}&redirect=${encodeURIComponent(redirect)}`;

  const authUri = oauthClient.authorizeUri({
    state,
    redirectUri: `${process.env.BASE_URL}/callback/quickbooks?state=${state}&redirect=${encodeURIComponent(redirect)}`
  });

  res.redirect(authUri);
});


// 2) Callback: QuickBooks will call this after user authorizes
app.get('/callback/quickbooks', async (req, res) => {
  const { code, state, realmId, error, error_description, redirect } = req.query;

  // Handle any OAuth errors first
  if (error) {
    console.error('OAuth error from QuickBooks:', error_description || error);
    return res.status(400).send(`Auth error: ${error_description || error}`);
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  // Decode redirectTarget safely
  const redirectTarget = redirect ? decodeURIComponent(redirect) : null;
  console.log('📍 Callback received for state:', state);
  console.log('🔗 Redirect target:', redirectTarget);

  // Exchange code for tokens
  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', CALLBACK_BASE);

  try {
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('❌ Token exchange failed:', tokenJson);
      return res.status(500).send('Token exchange failed.');
    }

    const access_token = tokenJson.access_token;
    const refresh_token = tokenJson.refresh_token;
    const expires_in = tokenJson.expires_in || 3600;
    const expires_at = new Date(Date.now() + expires_in * 1000);

    // Store tokens in DB or in-memory store
    if (usePg) {
      try {
        await pool.query(
          `INSERT INTO connections(state_id, access_token, refresh_token, realm_id, expires_at)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT(state_id) DO UPDATE
             SET access_token = EXCLUDED.access_token,
                 refresh_token = EXCLUDED.refresh_token,
                 realm_id = EXCLUDED.realm_id,
                 expires_at = EXCLUDED.expires_at;`,
          [state, access_token, refresh_token, realmId, expires_at]
        );
        console.log(`✅ Tokens saved for state=${state}`);
      } catch (dbErr) {
        console.error('DB insert/update failed:', dbErr);
        return res.status(500).send('Server error storing tokens.');
      }
    } else {
      store[state] = { access_token, refresh_token, realmId, expires_at };
    }

    // ✅ Redirect Logic
    if (redirectTarget) {
      // Redirect back to Salesforce Lightning page where your LWC lives
      console.log('➡️ Redirecting user back to Salesforce:', redirectTarget);
      return res.send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
            <h2>✅ QuickBooks connected successfully!</h2>
            <p>Redirecting back to Salesforce...</p>
            <script>
              const redirectUrl = "${redirectTarget}${redirectTarget.includes('?') ? '&' : '?'}connected=true";
              window.top.location.replace(redirectUrl);
            </script>
          </body>
        </html>
      `);
    } else {
      // Fallback if redirect not provided
      return res.send(`
        <html><body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
          <h2>QuickBooks connected successfully ✅</h2>
          <p>You can now return to Salesforce.</p>
          <p><a href="salesforce1://">Return to Salesforce</a></p>
        </body></html>
      `);
    }

  } catch (err) {
    console.error('❌ Error during QuickBooks callback:', err);
    return res.status(500).send('Server error during token exchange');
  }
});


// 3) Status endpoint for Salesforce to check whether connection is ready
app.get('/status', async (req, res) => {
  const state = req.query.state;
  if (!state) return res.status(400).send({ ok: false, message: 'Missing state' });

  if (usePg) {
    try {
      const dbRes = await pool.query('SELECT * FROM connections WHERE state_id=$1', [state]);
      if (dbRes.rows.length === 0) return res.json({ ok: true, connected: false });
      const r = dbRes.rows[0];
      return res.json({ ok: true, connected: true, realmId: r.realm_id });
    } catch (err) {
      console.error('DB error on /status:', err);
      return res.status(500).json({ ok: false, message: 'DB error' });
    }
  } else {
    const entry = store[state];
    if (!entry) return res.json({ ok: true, connected: false });
    return res.json({ ok: true, connected: true, realmId: entry.realmId });
  }
});

// Utility to refresh QuickBooks tokens when expired
async function refreshQuickBooksToken(stateId) {
  let conn;
  if (usePg) {
    const result = await pool.query('SELECT * FROM connections WHERE state_id=$1 LIMIT 1', [stateId]);
    if (result.rows.length === 0) return null;
    conn = result.rows[0];
  } else {
    conn = store[stateId];
  }

  const now = new Date();
  const expiresAt = new Date(conn.expires_at);
  if (expiresAt > now) {
    // Token still valid
    return conn;
  }

  console.log(`🔄 Access token expired for state=${stateId}, refreshing...`);

  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', conn.refresh_token);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('❌ Failed to refresh token', data);
    return null;
  }

  const newAccess = data.access_token;
  const newRefresh = data.refresh_token || conn.refresh_token;
  const newExpires = new Date(Date.now() + (data.expires_in || 3600) * 1000);

  if (usePg) {
    await pool.query(
      `UPDATE connections
       SET access_token=$1, refresh_token=$2, expires_at=$3
       WHERE state_id=$4`,
      [newAccess, newRefresh, newExpires, stateId]
    );
  } else {
    conn.access_token = newAccess;
    conn.refresh_token = newRefresh;
    conn.expires_at = newExpires;
  }

  console.log(`✅ Token refreshed for state=${stateId}`);
  return { ...conn, access_token: newAccess, refresh_token: newRefresh, expires_at: newExpires };
}


// Utility: find connection by realmId (example)
async function findConnectionByRealmId(realmId) {
  if (usePg) {
    const dbRes = await pool.query('SELECT * FROM connections WHERE realm_id=$1 LIMIT 1', [realmId]);
    if (dbRes.rows.length === 0) return null;
    return dbRes.rows[0];
  } else {
    // search in-memory store
    for (const [state, entry] of Object.entries(store)) {
      if (entry.realmId === realmId) {
        return { state_id: state, access_token: entry.access_token, refresh_token: entry.refresh_token, realm_id: entry.realmId, expires_at: entry.expires_at };
      }
    }
    return null;
  }
}

// 4) Example proxied API call (Salesforce will call this to create QuickBooks invoice/customer)
app.post('/api/quickbooks/:realmId/customers', async (req, res) => {
  const realmId = req.params.realmId;
  try {
    let conn = await findConnectionByRealmId(realmId);
    if (!conn) return res.status(404).json({ ok: false, message: 'No tokens found for realmId' });

    // Automatically refresh if expired
    const refreshed = await refreshQuickBooksToken(conn.state_id);
    conn = refreshed || conn;
    if (!conn) return res.status(404).json({ ok: false, message: 'No tokens found for realmId' });

    // Example: call QuickBooks API with conn.access_token
    // For POC, we return a mock success plus show token hint (DO NOT return tokens in production)
    return res.json({ ok: true, message: 'Mock create customer accepted', body: req.body, usedRealmId: realmId });
  } catch (err) {
    console.error('Error in proxied API:', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// 5) Test QuickBooks API call (with auto token refresh)
app.get('/api/quickbooks/:stateId/test', async (req, res) => {
  const stateId = req.params.stateId;

  try {
    let conn;
    if (usePg) {
      const result = await pool.query('SELECT * FROM connections WHERE state_id=$1 LIMIT 1', [stateId]);
      if (result.rows.length === 0) return res.status(404).json({ ok: false, message: 'No tokens found for this state' });
      conn = result.rows[0];
    } else {
      conn = store[stateId];
    }

    // Ensure token is valid or refreshed
    const refreshed = await refreshQuickBooksToken(stateId);
    conn = refreshed || conn;

    // Example QuickBooks API call (Get Company Info)
    const qbRes = await fetch(`https://sandbox-quickbooks.api.intuit.com/v3/company/${conn.realm_id}/companyinfo/${conn.realm_id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${conn.access_token}`,
        'Accept': 'application/json'
      }
    });

    const data = await qbRes.json();

    if (!qbRes.ok) {
      console.error('QuickBooks API failed:', data);
      return res.status(500).json({ ok: false, message: 'QuickBooks API error', details: data });
    }

    return res.json({ ok: true, message: 'QuickBooks API call success', data });

  } catch (err) {
    console.error('Error in test API call:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// 🔄 Test QuickBooks API call (auto refresh if needed)
app.get('/api/test/:stateId', async (req, res) => {
  const stateId = req.params.stateId;

  try {
    // Step 1: Find connection by state
    let conn;
    if (usePg) {
      const dbRes = await pool.query('SELECT * FROM connections WHERE state_id=$1', [stateId]);
      if (dbRes.rows.length === 0) return res.status(404).json({ ok: false, message: 'No connection found' });
      conn = dbRes.rows[0];
    } else {
      conn = store[stateId];
      if (!conn) return res.status(404).json({ ok: false, message: 'No connection found' });
    }

    // Step 2: Check expiration
    const expiresAt = new Date(conn.expires_at);
    if (Date.now() > expiresAt.getTime()) {
      console.log('Access token expired, refreshing...');
      const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
      const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', conn.refresh_token);

      const refreshRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });

      const newTokens = await refreshRes.json();
      if (!refreshRes.ok) {
        console.error('Failed to refresh token', newTokens);
        return res.status(500).json({ ok: false, message: 'Token refresh failed', details: newTokens });
      }

      // Update DB
      const newExpiresAt = new Date(Date.now() + (newTokens.expires_in || 3600) * 1000);
      if (usePg) {
        await pool.query(
          `UPDATE connections SET access_token=$1, refresh_token=$2, expires_at=$3 WHERE state_id=$4`,
          [newTokens.access_token, newTokens.refresh_token, newExpiresAt, stateId]
        );
      } else {
        conn.access_token = newTokens.access_token;
        conn.refresh_token = newTokens.refresh_token;
        conn.expires_at = newExpiresAt;
      }

      conn.access_token = newTokens.access_token;
    }

    // Step 3: Call QuickBooks API (CompanyInfo)
    const apiUrl = `https://sandbox-quickbooks.api.intuit.com/v3/company/${conn.realm_id}/companyinfo/${conn.realm_id}`;
    const qbRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${conn.access_token}`,
        'Accept': 'application/json'
      }
    });

    const qbJson = await qbRes.json();
    if (!qbRes.ok) {
      console.error('QuickBooks API error', qbJson);
      return res.status(500).json({ ok: false, message: 'QuickBooks API error', details: qbJson });
    }

    res.json({ ok: true, companyInfo: qbJson });
  } catch (err) {
    console.error('Test API call failed:', err);
    res.status(500).json({ ok: false, message: 'Internal Server Error', details: err.message });
  }
});



app.get('/debug/connections', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM connections LIMIT 10');
    res.json(result.rows);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
