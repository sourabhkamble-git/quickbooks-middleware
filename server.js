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

// Slack OAuth credentials
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || 'REPLACE_ME';
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || 'REPLACE_ME';

// Warn if placeholders
if (CLIENT_ID === 'REPLACE_ME' || CLIENT_SECRET === 'REPLACE_ME') {
  console.warn('WARNING: QUICKBOOKS_CLIENT_ID or QUICKBOOKS_CLIENT_SECRET is not set (using placeholder).');
}
if (SLACK_CLIENT_ID === 'REPLACE_ME' || SLACK_CLIENT_SECRET === 'REPLACE_ME') {
  console.warn('WARNING: SLACK_CLIENT_ID or SLACK_CLIENT_SECRET is not set (using placeholder).');
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
            expires_at TIMESTAMP,
            service_type TEXT DEFAULT 'quickbooks',
            team_id TEXT,
            team_name TEXT
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

// Simple memory map (for demo — in prod, use Redis or DB)
const redirectMap = new Map();

// ---------------- AUTH START -----------------
app.get('/auth/quickbooks', (req, res) => {
  const { state, redirect } = req.query;
  if (!state) return res.status(400).send('Missing state (connection request id).');

  // ✅ Store the redirect target temporarily
  if (redirect) {
    redirectMap.set(state, decodeURIComponent(redirect));
    console.log(`✅ Stored redirect for state=${state}:`, decodeURIComponent(redirect));
  }

  const redirectUri = encodeURIComponent(CALLBACK_BASE);
  const scope = encodeURIComponent('com.intuit.quickbooks.accounting openid profile email');
  const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${CLIENT_ID}&response_type=code&scope=${scope}&redirect_uri=${redirectUri}&state=${state}`;
  return res.redirect(authUrl);
});
// ---------------- AUTH END -------------------


// ---------------- CALLBACK -------------------
app.get('/callback/quickbooks', async (req, res) => {
  const { code, state, realmId, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`Auth error: ${error_description || error}`);
  }
  if (!code || !state) return res.status(400).send('Missing code/state');

  // Exchange code for tokens
  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CALLBACK_BASE,
  });

  try {
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('❌ Token exchange failed', tokenJson);
      return res.status(500).send('Token exchange failed.');
    }

    const { access_token, refresh_token, expires_in } = tokenJson;
    const expires_at = new Date(Date.now() + (expires_in || 3600) * 1000);

    // Store tokens
    if (usePg) {
      await pool.query(
        `INSERT INTO connections(state_id, access_token, refresh_token, realm_id, expires_at)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(state_id) DO UPDATE
           SET access_token=EXCLUDED.access_token,
               refresh_token=EXCLUDED.refresh_token,
               realm_id=EXCLUDED.realm_id,
               expires_at=EXCLUDED.expires_at`,
        [state, access_token, refresh_token, realmId, expires_at]
      );
    } else {
      store[state] = { access_token, refresh_token, realmId, expires_at };
    }

    // ✅ Retrieve redirect target from map
    const redirectTarget = redirectMap.get(state);
    redirectMap.delete(state);
    console.log(`🔁 Found redirectTarget for state=${state}:`, redirectTarget);

    if (redirectTarget) {
      //const vfRedirectUrl = `${redirectTarget}${redirectTarget.includes('?') ? '&' : '?'}qb_connected=true`;
      const vfRedirectUrl = `${redirectTarget}#qb_connected=true&state=${encodeURIComponent(state)}`;
      console.log(`🔁 Redirecting to VF page: ${vfRedirectUrl}`);
      return res.redirect(vfRedirectUrl);
    } else {
      return res.send(`
        <html>
          <body>
            <h2>QuickBooks connected successfully ✅</h2>
            <p>You can now return to Salesforce manually.</p>
            <p><a href="https://login.salesforce.com">Return to Salesforce</a></p>
          </body>
        </html>
      `);
    }
  } catch (err) {
    console.error('❌ Callback error:', err);
    return res.status(500).send('Server error during token exchange');
  }
});

// ============ SLACK OAUTH FLOW ============

// 1) Start Slack OAuth: redirect user to Slack authorize page
app.get('/auth/slack', (req, res) => {
  const { state, redirect } = req.query;
  if (!state) return res.status(400).send('Missing state (connection request id).');

  // Store the redirect target temporarily
  if (redirect) {
    redirectMap.set(state, decodeURIComponent(redirect));
    console.log(`✅ Stored Slack redirect for state=${state}:`, decodeURIComponent(redirect));
  }

  const redirectUri = encodeURIComponent(`${CALLBACK_BASE}/slack`);
  const scope = 'chat:write,channels:read,channels:join';
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&scope=${encodeURIComponent(scope)}&redirect_uri=${redirectUri}&state=${state}`;
  return res.redirect(authUrl);
});

// 2) Slack OAuth callback
app.get('/callback/slack', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`Slack auth error: ${error_description || error}`);
  }
  if (!code || !state) return res.status(400).send('Missing code/state');

  // Exchange code for tokens
  const tokenUrl = 'https://slack.com/api/oauth.v2.access';
  const params = new URLSearchParams({
    code,
    client_id: SLACK_CLIENT_ID,
    client_secret: SLACK_CLIENT_SECRET,
    redirect_uri: `${CALLBACK_BASE}/slack`
  });

  try {
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.ok) {
      console.error('❌ Slack token exchange failed', tokenJson);
      return res.status(500).send('Slack token exchange failed.');
    }

    const { access_token, team, bot_user_id } = tokenJson.authed_user || tokenJson;
    const teamId = team?.id;
    const teamName = team?.name;
    
    // For Slack, access_token doesn't expire (unless revoked)
    const expires_at = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000); // 100 years in the future

    // Store tokens
    if (usePg) {
      await pool.query(
        `INSERT INTO connections(state_id, access_token, refresh_token, realm_id, expires_at, service_type, team_id, team_name)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(state_id) DO UPDATE
           SET access_token=EXCLUDED.access_token,
               refresh_token=EXCLUDED.refresh_token,
               realm_id=EXCLUDED.realm_id,
               expires_at=EXCLUDED.expires_at,
               service_type=EXCLUDED.service_type,
               team_id=EXCLUDED.team_id,
               team_name=EXCLUDED.team_name`,
        [state, access_token, '', teamId, expires_at, 'slack', teamId, teamName]
      );
    } else {
      store[state] = { access_token, refresh_token: '', realmId: teamId, expires_at, serviceType: 'slack', teamId, teamName };
    }

    // Retrieve redirect target from map
    const redirectTarget = redirectMap.get(state);
    redirectMap.delete(state);
    console.log(`🔁 Found Slack redirectTarget for state=${state}:`, redirectTarget);

    if (redirectTarget) {
      const vfRedirectUrl = `${redirectTarget}#slack_connected=true&state=${encodeURIComponent(state)}`;
      console.log(`🔁 Redirecting to VF page: ${vfRedirectUrl}`);
      return res.redirect(vfRedirectUrl);
    } else {
      return res.send(`
        <html>
          <body>
            <h2>Slack connected successfully ✅</h2>
            <p>Team: ${teamName}</p>
            <p>You can now return to Salesforce manually.</p>
            <p><a href="https://login.salesforce.com">Return to Salesforce</a></p>
          </body>
        </html>
      `);
    }
  } catch (err) {
    console.error('❌ Slack callback error:', err);
    return res.status(500).send('Server error during Slack token exchange');
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

// 4) Create QuickBooks Customer API call (Salesforce will call this to create QuickBooks customer)
app.post('/api/quickbooks/:realmId/customers', async (req, res) => {
  const realmId = req.params.realmId;
  try {
    // Find connection by realmId
    let conn = await findConnectionByRealmId(realmId);
    if (!conn) {
      return res.status(404).json({ 
        ok: false, 
        error: 'CONNECTION_NOT_FOUND',
        message: 'No QuickBooks connection found for this realm ID',
        details: 'Please ensure your QuickBooks account is properly connected'
      });
    }

    // Automatically refresh if expired
    const refreshed = await refreshQuickBooksToken(conn.state_id);
    conn = refreshed || conn;
    if (!conn) {
      return res.status(401).json({ 
        ok: false, 
        error: 'TOKEN_EXPIRED',
        message: 'QuickBooks connection has expired',
        details: 'Please reconnect your QuickBooks account'
      });
    }

    // Build QuickBooks Customer payload from request body
    const customerData = req.body;
    
    // Validate required fields
    if (!customerData.DisplayName) {
      return res.status(400).json({ 
        ok: false, 
        error: 'INVALID_DATA',
        message: 'Customer DisplayName is required',
        details: 'Please provide a valid customer name'
      });
    }
    
    // Call QuickBooks API to create customer
    const qbRes = await fetch(`https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/customer`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${conn.access_token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(customerData)
    });

    const result = await qbRes.json();

    if (!qbRes.ok) {
      console.error('QuickBooks API error creating customer:', result);
      return res.status(qbRes.status).json({ 
        ok: false, 
        error: 'QUICKBOOKS_API_ERROR',
        message: 'QuickBooks API returned an error',
        details: result.Fault ? result.Fault.Error[0].Detail : 'Unknown QuickBooks error',
        quickbooksError: result
      });
    }

    console.log('✅ Customer created in QuickBooks:', result.QueryResponse?.Customer?.[0]?.Id);
    return res.json({ 
      ok: true, 
      message: 'Customer created successfully', 
      customerId: result.QueryResponse?.Customer?.[0]?.Id,
      data: result 
    });
    
  } catch (err) {
    console.error('Error creating QuickBooks customer:', err);
    return res.status(500).json({ 
      ok: false, 
      error: 'SERVER_ERROR',
      message: 'Internal server error occurred',
      details: err.message 
    });
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

// ============ SLACK ENDPOINTS ============

// Send message to Slack channel
app.post('/api/slack/channels/:teamId/messages', async (req, res) => {
  const teamId = req.params.teamId;
  
  try {
    const messageData = req.body;
    const channelId = messageData.channel; // Channel ID passed in body
    
    // Validate required fields
    if (!messageData.text && !messageData.blocks) {
      return res.status(400).json({ 
        ok: false, 
        error: 'INVALID_DATA',
        message: 'Message text or blocks are required',
        details: 'Please provide either a text message or message blocks'
      });
    }
    
    if (!channelId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'INVALID_DATA',
        message: 'Channel ID is required',
        details: 'Please provide a channel ID in the message data'
      });
    }
    
    // Find Slack connection by team ID
    let conn;
    let accessToken;
    
    if (usePg) {
      const result = await pool.query('SELECT * FROM connections WHERE team_id=$1 AND service_type=$2 LIMIT 1', [teamId, 'slack']);
      if (result.rows.length > 0) {
        conn = result.rows[0];
        accessToken = conn.access_token;
      }
    } else {
      // Search in-memory store
      for (const [state, entry] of Object.entries(store)) {
        if (entry.teamId === teamId && entry.serviceType === 'slack') {
          conn = { state_id: state, access_token: entry.access_token, refresh_token: entry.refresh_token, realm_id: entry.realmId, expires_at: entry.expires_at, service_type: entry.serviceType, team_id: entry.teamId, team_name: entry.teamName };
          accessToken = conn.access_token;
          break;
        }
      }
    }
    
    // Fallback to global SLACK_BOT_TOKEN if no connection found (for POC testing)
    if (!accessToken) {
      const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
      if (SLACK_BOT_TOKEN) {
        accessToken = SLACK_BOT_TOKEN;
        console.log('⚠️ Using global SLACK_BOT_TOKEN (no connection found for team ' + teamId + ')');
      } else {
        return res.status(404).json({ 
          ok: false, 
          error: 'CONNECTION_NOT_FOUND',
          message: 'No Slack connection found for this team',
          details: 'Please connect your Slack workspace or set SLACK_BOT_TOKEN environment variable'
        });
      }
    }
    
    // Build Slack message payload
    const slackPayload = {
      channel: channelId,
      text: messageData.text || 'New message from Salesforce',
      blocks: messageData.blocks || undefined
    };
    
    // Remove undefined blocks if not provided
    if (!slackPayload.blocks) {
      delete slackPayload.blocks;
    }
    
    // Call Slack Web API to post message
    const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(slackPayload)
    });
    
    const result = await slackRes.json();
    
    if (!result.ok) {
      console.error('Slack API error:', result);
      return res.status(slackRes.status).json({ 
        ok: false, 
        error: 'SLACK_API_ERROR',
        message: 'Slack API returned an error',
        details: result.error || 'Unknown Slack error',
        slackError: result
      });
    }
    
    console.log('✅ Message sent to Slack:', result.ts);
    return res.json({ 
      ok: true, 
      message: 'Message sent successfully', 
      ts: result.ts,
      data: result 
    });
    
  } catch (err) {
    console.error('Error sending Slack message:', err);
    return res.status(500).json({ 
      ok: false, 
      error: 'SERVER_ERROR',
      message: 'Internal server error occurred',
      details: err.message 
    });
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



// ⚠️ TESTING ONLY: Manually insert Slack token (for POC testing without full OAuth)
app.post('/api/test/slack-connection', async (req, res) => {
  const { stateId, teamId, accessToken, channelId } = req.body;
  
  if (!stateId || !teamId || !accessToken) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Missing required fields',
      message: 'Requires: stateId, teamId, accessToken'
    });
  }
  
  try {
    const expires_at = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000); // 100 years
    
    if (usePg) {
      await pool.query(
        `INSERT INTO connections(state_id, access_token, refresh_token, realm_id, expires_at, service_type, team_id, team_name)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(state_id) DO UPDATE
           SET access_token=EXCLUDED.access_token,
               realm_id=EXCLUDED.realm_id,
               service_type=EXCLUDED.service_type,
               team_id=EXCLUDED.team_id`,
        [stateId, accessToken, '', channelId || '', expires_at, 'slack', teamId, 'Manual Test']
      );
    } else {
      store[stateId] = { access_token: accessToken, refresh_token: '', realmId: channelId || '', expires_at, serviceType: 'slack', teamId, teamName: 'Manual Test' };
    }
    
    return res.json({ 
      ok: true, 
      message: 'Slack connection stored successfully',
      stateId: stateId,
      teamId: teamId
    });
    
  } catch (err) {
    console.error('Error storing Slack connection:', err);
    return res.status(500).json({ 
      ok: false, 
      error: 'SERVER_ERROR',
      message: 'Failed to store connection',
      details: err.message 
    });
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
