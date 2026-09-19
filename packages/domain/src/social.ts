/**
 * عقود B8 الاجتماعية النقية.
 *
 * لا I/O هنا: هذه القواعد مشتركة بين الـWorker والاختبارات وتبقى مستقلة عن D1.
 */

export const RECOMMENDATION_STATES = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;
export type RecommendationState = (typeof RECOMMENDATION_STATES)[number];

export const RECOMMENDATION_INTENTS = ['WATCH_NOW', 'WATCH_LATER', 'ADD_TO_LIBRARY'] as const;
export type RecommendationIntent = (typeof RECOMMENDATION_INTENTS)[number];

export function isRecommendationState(value: unknown): value is RecommendationState {
  return (
    typeof value === 'string' &&
    (RECOMMENDATION_STATES as readonly string[]).includes(value)
  );
}

export function isRecommendationIntent(value: unknown): value is RecommendationIntent {
  return (
    typeof value === 'string' &&
    (RECOMMENDATION_INTENTS as readonly string[]).includes(value)
  );
}

export interface ActivityReceiptRow {
  deliveredAt?: number | null;
  seenAt?: number | null;
}

export type ActivityReceiptState = 'none' | 'delivered' | 'seen';

export function receiptState(row: ActivityReceiptRow): ActivityReceiptState {
  if (typeof row.seenAt === 'number') return 'seen';
  if (typeof row.deliveredAt === 'number') return 'delivered';
  return 'none';
}

/**
 * إيصال أحادي الاتجاه.
 *
 * - seen يضمن delivered.
 * - إعادة تسليم متأخرة لا تُرجع seen إلى delivered.
 * - أول timestamp ناجح يبقى ثابتًا بدل أن يتحرك مع retries.
 */
export function advanceReceipt(
  current: ActivityReceiptRow,
  next: 'delivered' | 'seen',
  at: number,
): { deliveredAt: number | null; seenAt: number | null } {
  const deliveredAt = typeof current.deliveredAt === 'number' ? current.deliveredAt : null;
  const seenAt = typeof current.seenAt === 'number' ? current.seenAt : null;

  if (next === 'delivered') {
    if (seenAt !== null) return { deliveredAt: deliveredAt ?? seenAt, seenAt };
    return { deliveredAt: deliveredAt ?? at, seenAt: null };
  }

  return {
    deliveredAt: deliveredAt ?? at,
    seenAt: seenAt ?? at,
  };
}

export type SocialLinkInput =
  | { kind: 'work'; seriesRef: string }
  | { kind: 'recommendation'; seriesRef: string }
  | { kind: 'comment'; seriesRef: string; commentId: string }
  | { kind: 'reaction'; seriesRef: string; commentId: string };

export function socialLinkFor(input: SocialLinkInput): string {
  const series = encodeURIComponent(input.seriesRef);
  if (input.kind === 'work' || input.kind === 'recommendation') {
    return `vantara://series/${series}`;
  }

  return `vantara://series/${series}/comment/${encodeURIComponent(input.commentId)}`;
}
