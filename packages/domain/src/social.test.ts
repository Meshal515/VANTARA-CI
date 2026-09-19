import { describe, expect, it } from 'vitest';
import * as domain from './index.ts';

type SocialContract = {
  isRecommendationState?: (value: unknown) => boolean;
  isRecommendationIntent?: (value: unknown) => boolean;
  receiptState?: (row: { deliveredAt?: number | null; seenAt?: number | null }) => string;
  advanceReceipt?: (
    current: { deliveredAt?: number | null; seenAt?: number | null },
    next: 'delivered' | 'seen',
    at: number,
  ) => { deliveredAt: number | null; seenAt: number | null };
  socialLinkFor?: (input:
    | { kind: 'work'; seriesRef: string }
    | { kind: 'recommendation'; seriesRef: string }
    | { kind: 'comment'; seriesRef: string; commentId: string }
    | { kind: 'reaction'; seriesRef: string; commentId: string }
  ) => string;
};

const social = domain as unknown as SocialContract;

describe('B8 recommendation contracts', () => {
  it('accepts only the three recommendation states', () => {
    expect(typeof social.isRecommendationState).toBe('function');
    if (!social.isRecommendationState) return;

    expect(social.isRecommendationState('PENDING')).toBe(true);
    expect(social.isRecommendationState('ACCEPTED')).toBe(true);
    expect(social.isRecommendationState('REJECTED')).toBe(true);
    expect(social.isRecommendationState('SENT')).toBe(false);
    expect(social.isRecommendationState('')).toBe(false);
    expect(social.isRecommendationState(null)).toBe(false);
  });

  it('accepts only the three recommendation intents', () => {
    expect(typeof social.isRecommendationIntent).toBe('function');
    if (!social.isRecommendationIntent) return;

    expect(social.isRecommendationIntent('WATCH_NOW')).toBe(true);
    expect(social.isRecommendationIntent('WATCH_LATER')).toBe(true);
    expect(social.isRecommendationIntent('ADD_TO_LIBRARY')).toBe(true);
    expect(social.isRecommendationIntent('REJECT')).toBe(false);
    expect(social.isRecommendationIntent('')).toBe(false);
  });
});

describe('B8 activity receipts', () => {
  it('advances none -> delivered -> seen and never goes backwards', () => {
    expect(typeof social.advanceReceipt).toBe('function');
    expect(typeof social.receiptState).toBe('function');
    if (!social.advanceReceipt || !social.receiptState) return;

    const delivered = social.advanceReceipt({}, 'delivered', 100);
    expect(delivered).toEqual({ deliveredAt: 100, seenAt: null });
    expect(social.receiptState(delivered)).toBe('delivered');

    const seen = social.advanceReceipt(delivered, 'seen', 200);
    expect(seen).toEqual({ deliveredAt: 100, seenAt: 200 });
    expect(social.receiptState(seen)).toBe('seen');

    const staleDelivery = social.advanceReceipt(seen, 'delivered', 300);
    expect(staleDelivery).toEqual(seen);
  });

  it('seen implies delivered even when no delivery receipt exists yet', () => {
    expect(typeof social.advanceReceipt).toBe('function');
    if (!social.advanceReceipt) return;

    expect(social.advanceReceipt({}, 'seen', 250)).toEqual({
      deliveredAt: 250,
      seenAt: 250,
    });
  });
});

describe('B8 social links', () => {
  it('builds deterministic links for works and recommendations', () => {
    expect(typeof social.socialLinkFor).toBe('function');
    if (!social.socialLinkFor) return;

    expect(social.socialLinkFor({ kind: 'work', seriesRef: 'a/b c' })).toBe(
      'vantara://series/a%2Fb%20c',
    );
    expect(social.socialLinkFor({ kind: 'recommendation', seriesRef: 'a/b c' })).toBe(
      'vantara://series/a%2Fb%20c',
    );
  });

  it('builds deterministic links for comments and reactions', () => {
    expect(typeof social.socialLinkFor).toBe('function');
    if (!social.socialLinkFor) return;

    expect(
      social.socialLinkFor({ kind: 'comment', seriesRef: 'a/b c', commentId: 'c/1' }),
    ).toBe('vantara://series/a%2Fb%20c/comment/c%2F1');
    expect(
      social.socialLinkFor({ kind: 'reaction', seriesRef: 's1', commentId: 'comment 1' }),
    ).toBe('vantara://series/s1/comment/comment%201');
  });
});
