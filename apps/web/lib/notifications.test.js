import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_LABELS,
  popupPatch,
  popupSettings,
  shouldToast,
  stateOf,
  toastable,
  unreadCount,
} from './notifications.js';

const ME = 'me';
const row = (over = {}) => ({
  id: 'n1',
  user_id: ME,
  actor_id: 'dahmi',
  kind: 'RECOMMENDATION',
  body: 'اقرأه',
  seen: 0,
  read: 0,
  created_at: 10,
  ...over,
});

const ON = popupSettings(null);

describe('state', () => {
  it('reads the three states', () => {
    expect(stateOf(row())).toBe('created');
    expect(stateOf(row({ seen: 1 }))).toBe('seen');
    expect(stateOf(row({ seen: 1, read: 1 }))).toBe('read');
    expect(stateOf(row({ seen: 0, read: 1 }))).toBe('read');
  });

  it('counts unread by read alone', () => {
    // التنبيه ظهر ومرّ: الإشعار ما زال غير مقروء، والجرس يجب أن يقوله
    expect(unreadCount([row({ seen: 1 }), row({ seen: 1, read: 1 }), row()])).toBe(2);
  });
});

describe('popup settings', () => {
  it('defaults everything on with no settings row', () => {
    expect(ON.enabled).toBe(true);
    for (const kind of NOTIFICATION_KINDS) expect(ON.kinds[kind]).toBe(true);
  });

  it('parses the stored JSON blob', () => {
    const settings = popupSettings({ data: JSON.stringify({ notifications: { popups: false } }) });
    expect(settings.enabled).toBe(false);
  });

  it('treats corrupt JSON as everything on', () => {
    const settings = popupSettings({ data: '{not json' });
    expect(settings.enabled).toBe(true);
  });

  it('round-trips through the patch shape', () => {
    const muted = { enabled: true, kinds: { ...ON.kinds, REACTION: false } };
    const parsed = popupSettings({ data: JSON.stringify(popupPatch(muted)) });
    expect(parsed.kinds.REACTION).toBe(false);
    expect(parsed.kinds.RECOMMENDATION).toBe(true);
    expect(parsed.enabled).toBe(true);
  });

  it('labels every kind it can toggle', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(typeof NOTIFICATION_LABELS[kind]).toBe('string');
      expect(NOTIFICATION_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('shouldToast', () => {
  it('toasts a fresh notification for the viewer', () => {
    expect(shouldToast(row(), { viewerId: ME, settings: ON })).toBe(true);
  });

  it('does not toast twice', () => {
    expect(shouldToast(row({ seen: 1 }), { viewerId: ME, settings: ON })).toBe(false);
  });

  it('does not toast a notification for someone else', () => {
    expect(shouldToast(row({ user_id: 'ngm' }), { viewerId: ME, settings: ON })).toBe(false);
  });

  it('does not toast the viewer own action', () => {
    expect(shouldToast(row({ actor_id: ME }), { viewerId: ME, settings: ON })).toBe(false);
  });

  it('stays silent with popups off', () => {
    const off = popupSettings({ data: JSON.stringify({ notifications: { popups: false } }) });
    expect(shouldToast(row(), { viewerId: ME, settings: off })).toBe(false);
    // ومع ذلك يبقى غير مقروء في الصندوق — هذا هو مثال القبول في الخطة
    expect(unreadCount([row()])).toBe(1);
  });

  it('mutes one kind and keeps the others', () => {
    const muted = popupSettings({
      data: JSON.stringify(popupPatch({ enabled: true, kinds: { ...ON.kinds, REACTION: false } })),
    });
    expect(shouldToast(row({ kind: 'REACTION' }), { viewerId: ME, settings: muted })).toBe(false);
    expect(shouldToast(row({ kind: 'RECOMMENDATION' }), { viewerId: ME, settings: muted })).toBe(true);
  });

  it('shows an unknown kind rather than swallowing it', () => {
    expect(shouldToast(row({ kind: 'BRAND_NEW' }), { viewerId: ME, settings: ON })).toBe(true);
  });

  it('needs a signed-in viewer', () => {
    expect(shouldToast(row(), { viewerId: null, settings: ON })).toBe(false);
  });
});

describe('toastable', () => {
  it('picks only what deserves a toast, oldest first', () => {
    const rows = [
      row({ id: 'c', created_at: 30 }),
      row({ id: 'a', created_at: 10 }),
      row({ id: 'seen', seen: 1, created_at: 20 }),
      row({ id: 'mine', actor_id: ME, created_at: 15 }),
      row({ id: 'b', created_at: 20 }),
    ];
    expect(toastable(rows, { viewerId: ME, settings: ON }).map((entry) => entry.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('returns nothing from an empty inbox', () => {
    expect(toastable([], { viewerId: ME, settings: ON })).toEqual([]);
  });
});
