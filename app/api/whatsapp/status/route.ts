import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    provider: 'Baileys',
    status: 'pending-integration',
    demoNumber: process.env.DEMO_WHATSAPP_NUMBER || process.env.NEXT_PUBLIC_DEMO_WHATSAPP_NUMBER || '3054879364',
    nextStep: 'Connect a Baileys-based worker to the same Supabase tables to handle inbound WhatsApp messages.',
  });
}
