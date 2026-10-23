// Demo logins. These are public on purpose: the login page lists them so a
// reviewer can sign in. Kept apart from the seed so the browser can import
// this file without pulling in server-only code.

export const DEMO_ACCOUNTS = [
  { id: 'cus_alice', name: 'Alice Tan', email: 'alice@example.com', password: 'alice-demo-123' },
  { id: 'cus_ben', name: 'Ben Okafor', email: 'ben@example.com', password: 'ben-demo-123' },
  { id: 'cus_chloe', name: 'Chloe Ng', email: 'chloe@example.com', password: 'chloe-demo-123' },
] as const;
