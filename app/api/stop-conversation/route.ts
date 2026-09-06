import { NextRequest, NextResponse } from 'next/server';
import { AgoraClient, Area } from 'agora-agents';
import { StopConversationRequest } from '@/types/conversation';

type StopConversationRequestWithChannel = StopConversationRequest & {
  channel_name?: string;
};

function isAgentAlreadyStoppingOrStopped(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const maybeErr = error as {
    statusCode?: number;
    body?: { detail?: string; reason?: string };
    message?: string;
  };

  const statusCode = maybeErr.statusCode;
  const reason = maybeErr.body?.reason?.toLowerCase();
  const detail = maybeErr.body?.detail?.toLowerCase() ?? maybeErr.message?.toLowerCase() ?? '';

  if (statusCode === 404) return true;
  if (reason === 'invalidrequest' && detail.includes('already in the process of shutting down')) {
    return true;
  }
  return false;
}

export async function POST(request: NextRequest) {
  try {
    const body: StopConversationRequestWithChannel = await request.json();
    const { agent_id, channel_name } = body;

    if (!agent_id) {
      return NextResponse.json(
        { error: 'agent_id is required' },
        { status: 400 },
      );
    }

    const appId = (process.env.NEXT_PUBLIC_AGORA_APP_ID || '').trim();
    const appCertificate = (process.env.NEXT_AGORA_APP_CERTIFICATE || '').trim();
    if (!appId || !appCertificate) {
      throw new Error(
        'Missing Agora configuration. Set NEXT_PUBLIC_AGORA_APP_ID and NEXT_AGORA_APP_CERTIFICATE.',
      );
    }

    // area: change to Area.EU or Area.AP for European or Asia-Pacific deployments.
    const client = new AgoraClient({
      area: Area.US,
      appId,
      appCertificate,
    });
    try {
      await client.stopAgent(agent_id);
    } catch (error) {
      if (isAgentAlreadyStoppingOrStopped(error)) {
        // Treat stop as idempotent: agent is already exiting (or gone).
        return NextResponse.json({ success: true, state: 'already-stopping' });
      }
      throw error;
    }

    // Clear Redis cache so the next session start creates a fresh agent
    if (channel_name) {
      try {
        const { redis } = await import('@/lib/redis');
        await Promise.all([
          redis.del(`channel:${channel_name}:agent_id`),
          redis.del(`channel:${channel_name}:remote_uids`),
        ]);
        console.log(`[stop-conversation] Cleared Redis cache for channel ${channel_name}`);
      } catch {
        // Redis is optional
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error stopping conversation:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to stop conversation',
      },
      { status: 500 },
    );
  }
}
