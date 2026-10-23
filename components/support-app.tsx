'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { Chat } from '@/components/chat';
import { SidePanel } from '@/components/side-panel';
import type { FaultConfig } from '@/lib/types';

export function SupportApp({ customer }: { customer: { name: string; email: string } }) {
  const router = useRouter();
  const [faultConfig, setFaultConfig] = useState<FaultConfig>({});
  const faultRef = useRef(faultConfig);
  faultRef.current = faultConfig;
  // Bumped after each agent run so the side panel refetches.
  const [dataVersion, setDataVersion] = useState(0);
  const [chatKey, setChatKey] = useState(0);

  const refresh = useCallback(() => setDataVersion((v) => v + 1), []);

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  async function resetDemo() {
    const res = await fetch('/api/demo/reset', { method: 'POST' });
    if (!res.ok) {
      alert((await res.json().catch(() => ({}))).message ?? 'Reset failed.');
      return;
    }
    setChatKey((k) => k + 1);
    refresh();
  }

  return (
    <div className="h-screen flex flex-col">
      <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-gray-200 bg-white">
        <div>
          <h1 className="font-semibold">ShopCo Support</h1>
          <p className="text-xs text-gray-500">AI assistant for order issues</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden sm:inline text-gray-600">
            {customer.name} <span className="text-gray-400">({customer.email})</span>
          </span>
          <button onClick={resetDemo} className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50">
            Reset demo data
          </button>
          <button onClick={signOut} className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50">
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_440px]">
        <Chat
          key={chatKey}
          customerName={customer.name}
          getFaultConfig={() => faultRef.current}
          activeFaults={faultConfig}
          onRunFinished={refresh}
        />
        <SidePanel
          dataVersion={dataVersion}
          onRefresh={refresh}
          faultConfig={faultConfig}
          onFaultConfigChange={setFaultConfig}
        />
      </main>
    </div>
  );
}
