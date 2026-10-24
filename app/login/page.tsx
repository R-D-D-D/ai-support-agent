'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DEMO_ACCOUNTS } from '@/lib/data/demo-accounts';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      router.replace(body.customer?.role === 'staff' ? '/staff' : '/');
      router.refresh();
      return;
    }
    const body = await res.json().catch(() => ({}));
    setError(body.message ?? 'Sign-in failed.');
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold mb-1">ShopCo Support</h1>
        <p className="text-sm text-gray-500 mb-6">Sign in to chat with our support assistant.</p>

        <form onSubmit={submit} className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <label className="block text-sm">
            <span className="text-gray-700">Email</span>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-700">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-indigo-600 text-white py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="mt-6 text-sm">
          <p className="text-gray-500 mb-2">Demo accounts (click to fill):</p>
          <ul className="space-y-1">
            {DEMO_ACCOUNTS.map((a) => (
              <li key={a.email}>
                <button
                  type="button"
                  onClick={() => {
                    setEmail(a.email);
                    setPassword(a.password);
                  }}
                  className="text-indigo-600 hover:underline"
                >
                  {a.name}
                </button>
                <span className="text-gray-400"> · {a.email} / {a.password}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}
