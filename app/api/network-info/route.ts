import { NextResponse } from 'next/server';
import os from 'os';

export async function GET() {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const netList = interfaces[name];
    if (!netList) continue;
    for (const net of netList) {
      // Pick IPv4 and non-internal addresses
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }

  // Fallback to first non-internal or localhost
  const primaryIp = addresses[0] || 'localhost';

  return NextResponse.json({
    addresses,
    primaryIp,
    publicUrl: process.env.NEXT_PUBLIC_APP_URL || null,
  });
}
