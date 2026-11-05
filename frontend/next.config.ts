import type { NextConfig } from 'next';

const apiUrl = process.env.NEXT_PUBLIC_API_URL;
if (!apiUrl) throw new Error('NEXT_PUBLIC_API_URL must be provided at build time');
const parsedApiUrl = new URL(apiUrl);
const apiUrlIsOrigin = parsedApiUrl.origin === apiUrl.replace(/\/$/, '')
  && !parsedApiUrl.username && !parsedApiUrl.password
  && parsedApiUrl.pathname === '/' && !parsedApiUrl.search && !parsedApiUrl.hash;
const secureApiUrl = parsedApiUrl.protocol === 'https:'
  || (process.env.NODE_ENV !== 'production' && parsedApiUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedApiUrl.hostname));
if (!apiUrlIsOrigin || !secureApiUrl) {
  throw new Error('NEXT_PUBLIC_API_URL must use HTTPS in production');
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
      ],
    }];
  },
};

export default nextConfig;