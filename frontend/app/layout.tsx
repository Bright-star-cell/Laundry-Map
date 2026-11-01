import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Laundry Map | Care for every load',
  description: 'Laundry pickup, expert care, and delivery across Karu and Mararaba.',
  manifest: '/manifest.json',
  applicationName: 'Laundry Map',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Laundry Map' },
};

export const viewport: Viewport = {
  themeColor: '#f4f4ed',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-NG"><body>{children}<script src="/register-sw.js" defer /></body></html>;
}