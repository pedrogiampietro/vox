import { AccessToken, TrackSource } from 'livekit-server-sdk';
import type { Session } from './session.js';
import { config } from './config.js';

export interface LiveKitCredentials {
  url: string;
  token: string;
  room: string;
}

function issueToken(
  session: Session,
  roomPrefix: string,
  identityPrefix: string,
  source: TrackSource,
): Promise<LiveKitCredentials | null> {
  if (!config.livekitUrl || !config.livekitApiKey || !config.livekitApiSecret) {
    return Promise.resolve(null);
  }

  const room = `${roomPrefix}-${session.serverId}-${session.channelId}`;
  const identity = `${identityPrefix}-${session.serverId}-${session.id}`;
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    name: session.nickname,
    ttl: '10m',
  });
  token.addGrant({
    room,
    roomJoin: true,
    canSubscribe: true,
    canPublishSources: [source],
    canPublishData: false,
  });

  return token.toJwt().then((jwt) => ({ url: config.livekitUrl, token: jwt, room }));
}

/** Emite um token curto e limitado ao canal atual do Vox. */
export function issueLiveKitToken(session: Session): Promise<LiveKitCredentials | null> {
  return issueToken(session, 'vox', 'vox', TrackSource.SCREEN_SHARE);
}

/** Token de voz separado do compartilhamento de tela, usado no failover. */
export function issueLiveKitVoiceToken(session: Session): Promise<LiveKitCredentials | null> {
  return issueToken(session, 'vox-voice', 'vox-voice', TrackSource.MICROPHONE);
}
