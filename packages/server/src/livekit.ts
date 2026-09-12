import { AccessToken, TrackSource } from 'livekit-server-sdk';
import type { Session } from './session.js';
import { config } from './config.js';

export interface LiveKitCredentials {
  url: string;
  token: string;
  room: string;
}

/** Emite um token curto e limitado ao canal atual do Vox. */
export async function issueLiveKitToken(session: Session): Promise<LiveKitCredentials | null> {
  if (!config.livekitUrl || !config.livekitApiKey || !config.livekitApiSecret) return null;

  const room = `vox-${session.serverId}-${session.channelId}`;
  const identity = `vox-${session.serverId}-${session.id}`;
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    name: session.nickname,
    ttl: '10m',
  });
  token.addGrant({
    room,
    roomJoin: true,
    canSubscribe: true,
    canPublishSources: [TrackSource.SCREEN_SHARE],
    canPublishData: false,
  });

  return { url: config.livekitUrl, token: await token.toJwt(), room };
}
