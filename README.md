# Salesforce Validation Rule Manager

A web app that connects to a Salesforce org via OAuth 2.0, lists all validation rules on the
Account object (via the Tooling API), and lets you toggle rules Active/Inactive and deploy the
changes back to Salesforce.

## Stack
- **Frontend:** React
- **Backend:** Node.js + Express (acts as the OAuth "bridge" / Connected App consumer, keeps the
  Consumer Secret off the browser)
- **Salesforce access:** jsforce library, OAuth 2.0 Web Server Flow, Tooling API

## How it works
1. **Login** — click "Log in to Salesforce"; the backend redirects you to Salesforce's OAuth
   consent screen.
2. **Callback** — Salesforce redirects back to the backend with an authorization code; the
   backend exchanges it for an access token and stores it in a server-side session.
3. **Get Validation Rules** — frontend calls `GET /api/validation-rules`; backend queries the
   Tooling API (`ValidationRule` object, filtered to the Account entity).
4. **Toggle** — flipping a switch only updates local React state (a "pending changes" list) —
   nothing is sent to Salesforce yet.
5. **Deploy Changes** — sends the pending changes to `POST /api/deploy`; backend updates each
   `ValidationRule.Active` field via the Tooling API, then the list is refreshed from Salesforce.

## 1. Local setup

### Backend
```bash
cd backend
npm install
cp .env.example .env
# edit .env and fill in SF_CLIENT_ID, SF_CLIENT_SECRET from your Connected App
npm start
```
Runs on `http://localhost:5000`.

### Frontend
```bash
cd frontend
npm install
npm start
```
Runs on `http://localhost:3000`.

### Connected App callback URL (local)
In Salesforce Setup → App Manager → your Connected App, set:
```
Callback URL: http://localhost:5000/oauth/callback
```

## 2. Deploying to Heroku (single app, one URL)

This repo is set up so **one Heroku app serves both the API and the built React frontend**,
so you only need one deployed URL.

```bash
# from the project root (the folder containing this README)
heroku login
heroku create your-app-name

heroku config:set SF_CLIENT_ID=your_consumer_key
heroku config:set SF_CLIENT_SECRET=your_consumer_secret
heroku config:set SF_LOGIN_URL=https://login.salesforce.com
heroku config:set SESSION_SECRET=some_long_random_string
heroku config:set NODE_ENV=production

# these two must match the Heroku URL you were assigned
heroku config:set SF_CALLBACK_URL=https://your-app-name.herokuapp.com/oauth/callback
heroku config:set FRONTEND_URL=https://your-app-name.herokuapp.com

git init
git add .
git commit -m "Initial commit"
heroku git:remote -a your-app-name
git push heroku main
```

### Update the Connected App callback URL (production)
Go back to Setup → App Manager → your Connected App → Edit, and **add** (don't just replace):
```
https://your-app-name.herokuapp.com/oauth/callback
```
as an additional Callback URL (keep the localhost one too if you still want to test locally).

Then open `https://your-app-name.herokuapp.com` and test the full flow.

## Project structure
```
sf-validation-app/
├── Procfile                  # tells Heroku how to start the app
├── package.json              # root: builds frontend, installs backend, on Heroku
├── backend/
│   ├── server.js             # Express API: OAuth + Tooling API calls
│   ├── package.json
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── App.js            # login, fetch rules, toggle, deploy UI
    │   └── App.css
    └── public/index.html
```

## Notes on the Tooling API query used
```sql
SELECT Id, ValidationName, Active, ErrorMessage, Description
FROM ValidationRule
WHERE EntityDefinition.QualifiedApiName = 'Account'
ORDER BY ValidationName
```
`ValidationRule` in the Tooling API supports both querying and updating the `Active` field
directly, which is what the Deploy step uses — no XML metadata package retrieve/deploy needed.
