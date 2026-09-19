export const VANTARA_IDENTITIES = [
  { id: '07588797-a471-44d1-99ce-7fb4f188c196', username: 'dahmi' },
  { id: 'bedcf897-a6f0-4730-b757-402b14891ca5', username: 'ngm' },
  { id: '9e4b51d9-4ca0-4da2-9b1f-2205e67134ed', username: 'mansour' },
] as const;

export type VantaraIdentityId = (typeof VANTARA_IDENTITIES)[number]['id'];

export function identityIdForUsername(username: string): VantaraIdentityId | null {
  const normalized = username.trim().toLowerCase();
  return VANTARA_IDENTITIES.find((identity) => identity.username === normalized)?.id ?? null;
}
