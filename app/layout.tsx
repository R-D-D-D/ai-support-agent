import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ShopCo Support',
  description: 'AI customer support agent demo for order issues, refunds, and escalation.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased font-sans">{children}</body>
    </html>
  );
}
