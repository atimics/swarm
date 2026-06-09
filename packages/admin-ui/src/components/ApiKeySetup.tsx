/**
 * API Key Setup — shown in local/desktop mode when no API key is configured.
 */
import { useState, useEffect } from 'react';

export function ApiKeySetup() {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Poll for key after OAuth flow
  useEffect(() => {
    if (saved) return;
    const check = async () => {
      try {
        const res = await fetch('/api/secrets/llm-api-key');
        if (res.ok) setSaved(true);
      } catch {
        // OAuth completion is polled; transient fetch failures are retried.
      }
    };
    const interval = setInterval(check, 2000);
    check();
    return () => clearInterval(interval);
  }, [saved]);

  if (saved) return null;

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/secrets/llm-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: apiKey.trim() }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 max-w-md mx-auto bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl p-4 text-left">
      <p className="text-sm font-medium text-[var(--color-text)] mb-2">OpenRouter API Key</p>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">
        Connect your OpenRouter account to enable AI chat — no key needed.
      </p>
      <button onClick={() => window.parent.postMessage({ action: "openrouter-connect" }, "*")}
        className="w-full w-full px-4 py-2.5 text-sm bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium transition-colors mb-3"
      >
        Connect with OpenRouter
      </button>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">
        After authorizing, come back here — the key will be detected automatically. Or paste your API key manually:
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-or-v1-..."
          className="flex-1 px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-tertiary)] focus:outline-none focus:border-brand-500"
          disabled={saving}
        />
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          className="px-4 py-2 text-sm bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
