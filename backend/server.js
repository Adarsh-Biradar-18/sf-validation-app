require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const jsforce = require('jsforce');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// Render (and most hosting platforms) sit behind a reverse proxy that terminates
// HTTPS. Without this, Express doesn't consider the connection secure, so
// secure session cookies never actually get set - breaking login.
app.set('trust proxy', 1);

app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  })
);
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // secure cookies require https - Heroku terminates TLS at the router,
      // so this is safe to enable in production
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60, // 1 hour
    },
  })
);

const oauth2 = new jsforce.OAuth2({
  loginUrl: process.env.SF_LOGIN_URL,
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  redirectUri: process.env.SF_CALLBACK_URL,
});

// Rebuild a jsforce connection from the tokens stored in the session
function connectionFromSession(req) {
  if (!req.session.sfTokens) return null;
  const { accessToken, refreshToken, instanceUrl } = req.session.sfTokens;
  return new jsforce.Connection({
    oauth2,
    instanceUrl,
    accessToken,
    refreshToken,
  });
}

function requireAuth(req, res, next) {
  if (!req.session.sfTokens) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }
  next();
}

// PKCE helpers - this Connected App requires a code challenge/verifier pair
function base64url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePkcePair() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

// Step 1: Login button hits this - redirects browser to Salesforce login/consent screen
app.get('/auth/login', (req, res) => {
  const { codeVerifier, codeChallenge } = generatePkcePair();
  // stash the verifier in the session so the callback can send it back at token-exchange time
  req.session.codeVerifier = codeVerifier;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SF_CLIENT_ID,
    redirect_uri: process.env.SF_CALLBACK_URL,
    scope: 'api refresh_token offline_access id',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `${process.env.SF_LOGIN_URL}/services/oauth2/authorize?${params.toString()}`;
  res.redirect(authUrl);
});

// Step 2: Salesforce redirects back here with a `code` after user approves
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  const codeVerifier = req.session.codeVerifier;

  if (!code) {
    return res.status(400).send('Missing authorization code from Salesforce.');
  }
  if (!codeVerifier) {
    return res.status(400).send('Missing PKCE code verifier - session may have expired. Please try logging in again.');
  }

  try {
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
      redirect_uri: process.env.SF_CALLBACK_URL,
      code_verifier: codeVerifier,
    });

    const tokenRes = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error('Token exchange failed:', tokenData);
      return res.redirect(`${process.env.FRONTEND_URL}?login=error`);
    }

    req.session.sfTokens = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      instanceUrl: tokenData.instance_url,
    };
    delete req.session.codeVerifier;

    res.redirect(`${process.env.FRONTEND_URL}?login=success`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}?login=error`);
  }
});

// Frontend calls this on load to check if the user already has a session
app.get('/auth/status', (req, res) => {
  res.json({ loggedIn: !!req.session.sfTokens });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Step 3: fetch all validation rules defined on the Account object via Tooling API
app.get('/api/validation-rules', requireAuth, async (req, res) => {
  const conn = connectionFromSession(req);
  try {
    const soql = `
      SELECT Id, ValidationName, Active, ErrorMessage, Description
      FROM ValidationRule
      WHERE EntityDefinition.QualifiedApiName = 'Account'
      ORDER BY ValidationName
    `;
    const result = await conn.tooling.query(soql);
    res.json(result.records);
  } catch (err) {
    console.error('Fetch validation rules error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 4 & 5: Deploy button - push toggled Active states back to Salesforce
// Body: { changes: [{ id: '03d...', active: true }, ...] }
app.post('/api/deploy', requireAuth, async (req, res) => {
  const conn = connectionFromSession(req);
  const { changes } = req.body;

  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ error: 'No changes to deploy.' });
  }

  const results = [];
  for (const change of changes) {
    try {
      // The Tooling API doesn't allow updating ValidationRule.Active directly -
      // you must fetch the full Metadata blob, flip `active` inside it, and send
      // the whole Metadata object back.
      const existing = await conn.tooling.sobject('ValidationRule').retrieve(change.id);
      const metadata = existing.Metadata;
      metadata.active = change.active;

      await conn.tooling.sobject('ValidationRule').update({
        Id: change.id,
        Metadata: metadata,
      });
      results.push({ id: change.id, success: true });
    } catch (err) {
      console.error(`Deploy failed for rule ${change.id}:`, err.message);
      results.push({ id: change.id, success: false, error: err.message });
    }
  }

  const allSucceeded = results.every((r) => r.success);
  res.status(allSucceeded ? 200 : 207).json({ results });
});

// In production, serve the built React app from the same server/URL
if (process.env.NODE_ENV === 'production') {
  const path = require('path');
  const buildPath = path.join(__dirname, '..', 'frontend', 'build');
  app.use(express.static(buildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('Salesforce Validation Rule Manager API is running.');
  });
}

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});