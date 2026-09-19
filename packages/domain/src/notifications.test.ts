import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POPUP_SETTINGS,
  NOTIFICATION_KINDS,
  advanceState,
  isNotificationKind,
  notificationId,
  notificationTargets,
  popupAllowed,
  popupSettingsFrom,
  shouldToast,
  stateOf,
  unreadCount,
} from './notifications.ts';

describe('notification state', () => {
  it('reads the three states off a D1 row', () => {
    expect(stateOf({ seen: 0, read: 0 })).toBe('created');
    expect(stateOf({ seen: 1, read: 0 })).toBe('seen');
    expect(stateOf({ seen: 1, read: 1 })).toBe('read');
    // مقروء بلا seen: القراءة تعني العرض ضمنًا
    expect(stateOf({ seen: 0, read: 1 })).toBe('read');
  });

  it('treats a missing column as not yet seen', () => {
    expect(stateOf({})).toBe('created');
  });

  it('never walks a state backwards', () => {
    // جهاز متأخر يزامن «عُرض» بعد أن قرأ الآخر الإشعار
    expect(advanceState('read', 'seen')).toBe('read');
    expect(advanceState('read', 'created')).toBe('read');
    expect(advanceState('seen', 'created')).toBe('seen');
    expect(advanceState('seen', 'read')).toBe('read');
    expect(advanceState('created', 'seen')).toBe('seen');
  });

  it('counts unread by read alone, not by seen', () => {
    // التنبيه الجانبي ظهر ومرّ: الإشعار ما زال غير مقروء
    const rows = [{ seen: 1, read: 0 }, { seen: 1, read: 1 }, { seen: 0, read: 0 }];
    expect(unreadCount(rows)).toBe(2);
  });
});

describe('popup settings', () => {
  it('defaults to every popup on', () => {
    expect(popupSettingsFrom(undefined)).toEqual(DEFAULT_POPUP_SETTINGS);
    expect(popupSettingsFrom({})).toEqual(DEFAULT_POPUP_SETTINGS);
    for (const kind of NOTIFICATION_KINDS) {
      expect(popupAllowed(kind, DEFAULT_POPUP_SETTINGS)).toBe(true);
    }
  });

  it('reads a global off switch', () => {
    const settings = popupSettingsFrom({ notifications: { popups: false } });
    expect(settings.enabled).toBe(false);
    expect(popupAllowed('RECOMMENDATION', settings)).toBe(false);
  });

  it('reads a per-kind off switch and leaves the rest on', () => {
    const settings = popupSettingsFrom({ notifications: { kinds: { REACTION: false } } });
    expect(popupAllowed('REACTION', settings)).toBe(false);
    expect(popupAllowed('RECOMMENDATION', settings)).toBe(true);
  });

  it('treats a corrupt setting as on rather than silencing everything', () => {
    // إعداد مكتوب خطأ يجب ألا يُسكت التنبيهات: عطل لا يشتكي منه المستخدم
    // بل يظنّ أن أصدقاءه لا يرسلون شيئًا
    const settings = popupSettingsFrom({ notifications: 'yes please' });
    expect(settings.enabled).toBe(true);
    expect(popupAllowed('RECOMMENDATION', settings)).toBe(true);
  });

  it('allows an unknown kind instead of hiding it', () => {
    expect(popupAllowed('BRAND_NEW', DEFAULT_POPUP_SETTINGS)).toBe(true);
    expect(isNotificationKind('BRAND_NEW')).toBe(false);
  });
});

describe('shouldToast', () => {
  const base = {
    kind: 'RECOMMENDATION',
    state: 'created' as const,
    userId: 'me',
    viewerId: 'me',
    settings: DEFAULT_POPUP_SETTINGS,
  };

  it('toasts a fresh notification addressed to the viewer', () => {
    expect(shouldToast({ ...base, actorId: 'dahmi' })).toBe(true);
  });

  it('does not toast the same notification twice', () => {
    expect(shouldToast({ ...base, state: 'seen', actorId: 'dahmi' })).toBe(false);
    expect(shouldToast({ ...base, state: 'read', actorId: 'dahmi' })).toBe(false);
  });

  it('does not toast someone else notification', () => {
    expect(shouldToast({ ...base, userId: 'ngm', actorId: 'dahmi' })).toBe(false);
  });

  it('does not toast the viewer own action', () => {
    expect(shouldToast({ ...base, actorId: 'me' })).toBe(false);
  });

  it('stays silent when popups are off but the inbox still receives', () => {
    // مثال القبول: تعطيل المنبثقة لا يظهر Toast، والعنصر يبقى في الصندوق
    const settings = popupSettingsFrom({ notifications: { popups: false } });
    expect(shouldToast({ ...base, actorId: 'dahmi', settings })).toBe(false);
    expect(unreadCount([{ seen: 0, read: 0 }])).toBe(1);
  });

  it('stays silent for a muted kind and speaks for the others', () => {
    const settings = popupSettingsFrom({ notifications: { kinds: { REACTION: false } } });
    expect(shouldToast({ ...base, kind: 'REACTION', actorId: 'dahmi', settings })).toBe(false);
    expect(shouldToast({ ...base, kind: 'COMMENT_REPLY', actorId: 'dahmi', settings })).toBe(true);
  });
});

describe('notificationTargets', () => {
  const accounts = ['dahmi', 'mansour', 'ngm'];

  it('sends one notification to a named recipient', () => {
    expect(notificationTargets({ accounts, actorId: 'dahmi', to: 'ngm' })).toEqual(['ngm']);
  });

  it('fans a recommendation for everyone out to everyone but the sender', () => {
    // كان الـWorker يُنشئ إشعارًا للمستلم المحدد فقط، فتوصية «للجميع» لا تُشعر
    // أحدًا: تظهر في سجل التوصيات ولا يعرف بها أحد
    expect(notificationTargets({ accounts, actorId: 'dahmi', to: null })).toEqual(['mansour', 'ngm']);
    expect(notificationTargets({ accounts, actorId: 'dahmi' })).toEqual(['mansour', 'ngm']);
  });

  it('never notifies the actor', () => {
    expect(notificationTargets({ accounts, actorId: 'dahmi', to: 'dahmi' })).toEqual([]);
  });

  it('is stable and deduplicated so a retry does not notify twice', () => {
    const first = notificationTargets({ accounts: [...accounts, 'ngm'], actorId: 'dahmi' });
    const second = notificationTargets({ accounts: ['ngm', 'mansour', 'ngm'], actorId: 'dahmi' });
    expect(first).toEqual(second);
  });

  it('derives an id per recipient from the op id', () => {
    expect(notificationId('op-1', 'ngm')).toBe('op-1:ngm');
    expect(notificationId('op-1', 'ngm')).toBe(notificationId('op-1', 'ngm'));
    expect(notificationId('op-1', 'mansour')).not.toBe(notificationId('op-1', 'ngm'));
  });
});
