import React, { useEffect, useState, useCallback } from 'react';

// In production, the backend serves this frontend from the same origin,
// so API calls should be relative (empty base). Locally, the frontend (port 3000)
// and backend (port 5000) run separately, so we need the full localhost URL.
const API_BASE =
  process.env.REACT_APP_API_URL ||
  (window.location.port === '3000' ? 'http://localhost:5000' : '');

function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [rules, setRules] = useState([]);
  const [pendingChanges, setPendingChanges] = useState({}); // { id: newActiveBool }
  const [loadingRules, setLoadingRules] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);

  const checkAuthStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/status`, { credentials: 'include' });
      const data = await res.json();
      setLoggedIn(data.loggedIn);
    } catch (err) {
      setLoggedIn(false);
    } finally {
      setCheckingAuth(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === 'success') {
      setStatusMessage({ type: 'success', text: 'Logged in to Salesforce.' });
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('login') === 'error') {
      setStatusMessage({ type: 'error', text: 'Login failed. Please try again.' });
      window.history.replaceState({}, '', window.location.pathname);
    }
    checkAuthStatus();
  }, [checkAuthStatus]);

  const handleLogin = () => {
    window.location.href = `${API_BASE}/auth/login`;
  };

  const handleLogout = async () => {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
    setLoggedIn(false);
    setRules([]);
    setPendingChanges({});
  };

  const fetchRules = async (options = {}) => {
    const { silent = false } = options;
    setLoadingRules(true);
    if (!silent) setStatusMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/validation-rules`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to fetch rules');
      const data = await res.json();
      setRules(data);
      setPendingChanges({});
    } catch (err) {
      setStatusMessage({ type: 'error', text: err.message });
    } finally {
      setLoadingRules(false);
    }
  };

  const currentActiveState = (rule) =>
    Object.prototype.hasOwnProperty.call(pendingChanges, rule.Id)
      ? pendingChanges[rule.Id]
      : rule.Active;

  const toggleRule = (rule) => {
    const newValue = !currentActiveState(rule);
    setPendingChanges((prev) => ({ ...prev, [rule.Id]: newValue }));
  };

  const toggleAll = (makeActive) => {
    const changes = {};
    rules.forEach((r) => {
      changes[r.Id] = makeActive;
    });
    setPendingChanges(changes);
  };

  const hasPendingChanges = Object.keys(pendingChanges).length > 0;

  const deployChanges = async () => {
    const changes = Object.entries(pendingChanges).map(([id, active]) => ({ id, active }));
    if (changes.length === 0) return;

    setDeploying(true);
    setStatusMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/deploy`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      });
      const data = await res.json();
      const failed = (data.results || []).filter((r) => !r.success);

      if (failed.length === 0) {
        setStatusMessage({ type: 'success', text: `Deployed ${changes.length} change(s) to Salesforce.` });
        await fetchRules({ silent: true });
      } else {
        setStatusMessage({
          type: 'error',
          text: `${failed.length} of ${changes.length} change(s) failed to deploy.`,
        });
      }
    } catch (err) {
      setStatusMessage({ type: 'error', text: err.message });
    } finally {
      setDeploying(false);
    }
  };

  if (checkingAuth) {
    return <div className="app-shell centered">Checking Salesforce session...</div>;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Validation Rule Manager</h1>
          <p className="subtitle">Account object &middot; Salesforce Tooling API</p>
        </div>
        {loggedIn ? (
          <button className="btn btn-ghost" onClick={handleLogout}>
            Log out
          </button>
        ) : null}
      </header>

      {statusMessage && (
        <div className={`banner banner-${statusMessage.type}`}>{statusMessage.text}</div>
      )}

      {!loggedIn ? (
        <div className="card centered">
          <p>Connect to your Salesforce org to manage validation rules.</p>
          <button className="btn btn-primary" onClick={handleLogin}>
            Log in to Salesforce
          </button>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <button className="btn btn-primary" onClick={fetchRules} disabled={loadingRules}>
              {loadingRules ? 'Loading...' : 'Get Validation Rules'}
            </button>
            {rules.length > 0 && (
              <>
                <button className="btn btn-secondary" onClick={() => toggleAll(true)}>
                  Enable All
                </button>
                <button className="btn btn-secondary" onClick={() => toggleAll(false)}>
                  Disable All
                </button>
                <button
                  className="btn btn-deploy"
                  onClick={deployChanges}
                  disabled={!hasPendingChanges || deploying}
                >
                  {deploying ? 'Deploying...' : 'Deploy Changes'}
                </button>
              </>
            )}
          </div>

          {rules.length === 0 ? (
            <p className="empty-state">
              No rules loaded yet. Click "Get Validation Rules" to fetch them from your org.
            </p>
          ) : (
            <table className="rules-table">
              <thead>
                <tr>
                  <th>Rule Name</th>
                  <th>Error Message</th>
                  <th>State</th>
                  <th>Toggle</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => {
                  const active = currentActiveState(rule);
                  const isDirty = Object.prototype.hasOwnProperty.call(pendingChanges, rule.Id);
                  return (
                    <tr key={rule.Id} className={isDirty ? 'row-dirty' : ''}>
                      <td>{rule.ValidationName}</td>
                      <td className="error-msg">{rule.ErrorMessage}</td>
                      <td>
                        <span className={`pill ${active ? 'pill-active' : 'pill-inactive'}`}>
                          {active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={active}
                            onChange={() => toggleRule(rule)}
                          />
                          <span className="slider" />
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

export default App;
