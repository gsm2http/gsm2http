import { KeyRound, Radio } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, errorMessage, getConfig } from '../api/client';
import { clearToken, onUnauthorized, setToken } from '../api/token';

type State = 'checking' | 'ok' | 'needToken' | 'rejected' | 'unreachable';

interface Props {
  /** Rendered once the server accepts the stored token (or needs none). */
  children: (signOut: () => void) => ReactNode;
}

/** Asks for the API token before the dashboard loads, and again if the server rejects it. */
export function TokenGate({ children }: Props) {
  const [state, setState] = useState<State>('checking');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  // Bumped on every successful sign-in so the dashboard remounts with a fresh socket.
  const [session, setSession] = useState(0);

  /** Resolves to the state the server's answer to an authenticated request puts us in. */
  const check = useCallback(
    (afterSubmit: boolean): Promise<State> =>
      getConfig().then(
        () => 'ok',
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            return afterSubmit ? 'rejected' : 'needToken';
          }
          setError(errorMessage(err));
          return 'unreachable';
        },
      ),
    [],
  );

  const apply = useCallback((next: State) => {
    setState(next);
    if (next === 'ok') setSession((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void check(false).then((next) => {
      if (!cancelled) apply(next);
    });
    const unsubscribe = onUnauthorized(() => setState('needToken'));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [check, apply]);

  const signOut = useCallback(() => {
    clearToken();
    setState('needToken');
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const token = draft.trim();
    if (!token) return;
    setToken(token);
    setDraft('');
    setState('checking');
    void check(true).then(apply);
  };

  if (state === 'ok') return <div key={session}>{children(signOut)}</div>;

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-4"
      >
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2.5 rounded-xl shadow-sm text-white">
            <Radio className="w-5 h-5" />
          </div>
          <h1 className="text-xl font-bold text-slate-800">gsm2http</h1>
        </div>

        {state === 'checking' && <p className="text-sm text-slate-500">Connecting…</p>}

        {state === 'unreachable' && (
          <p className="text-sm text-red-700">Cannot reach the server: {error}</p>
        )}

        {(state === 'needToken' || state === 'rejected' || state === 'unreachable') && (
          <>
            <label className="block space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                <KeyRound className="w-3.5 h-3.5" /> API token
              </span>
              <input
                type="password"
                autoComplete="current-password"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            {state === 'rejected' && (
              <p className="text-xs text-red-700">The server rejected that token.</p>
            )}
            <p className="text-xs text-slate-500">
              The <code>API_TOKEN</code> from the server&apos;s <code>.env</code>. It is kept in
              this browser only.
            </p>
            <button
              type="submit"
              disabled={!draft.trim()}
              className="w-full p-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-lg text-sm font-semibold cursor-pointer"
            >
              Sign in
            </button>
          </>
        )}
      </form>
    </div>
  );
}
