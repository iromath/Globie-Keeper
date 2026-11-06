import { WEB_ORIGIN } from './config';
import type { Group } from './types';

type InviteGroup = Pick<Group, 'name' | 'inviteToken'>;

/** The one link a member can open to land on the join screen with the code filled in. */
export function joinUrl(inviteToken: string) {
  return `${WEB_ORIGIN}/join?code=${encodeURIComponent(inviteToken.toUpperCase())}`;
}

/** Every invite code the server will accept: 4-16 characters, A-Z and 0-9. */
const INVITE_CODE = /^[A-Z0-9]{4,16}$/;

/**
 * Read an invite code out of whatever the camera produced. The QR carries
 * `joinUrl`, but a member may also paste a `globiekeeper://` link or print the
 * code itself, so all three shapes resolve to the same 6-character token.
 * Returns null for anything that is not an invite.
 */
export function parseInviteCode(payload: string): string | null {
  const raw = payload.trim();
  if (!raw) return null;

  const bare = raw.toUpperCase();
  if (INVITE_CODE.test(bare)) return bare;

  const match = raw.match(/[?&](?:code|invite)=([^&#\s]+)/i);
  if (!match) return null;

  let decoded = match[1];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A malformed escape sequence is still worth checking as-is.
  }
  const code = decoded.trim().toUpperCase();
  return INVITE_CODE.test(code) ? code : null;
}

export function inviteSubject(group: InviteGroup) {
  return `Join ${group.name} on Globie Keeper`;
}

/** Plain text that survives any share sheet, mail client or chat app. */
export function inviteMessage(group: InviteGroup) {
  return [
    `Join "${group.name}" on Globie Keeper.`,
    '',
    joinUrl(group.inviteToken),
    '',
    `Invite code: ${group.inviteToken.toUpperCase()}`,
  ].join('\n');
}
