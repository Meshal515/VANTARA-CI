/**
 * B10 — معرّف الربط.
 *
 * السؤال: هل يستطيع عميلٌ أن يحقن سطرًا في سجلّنا أو يضخّم عمودًا في
 * القاعدة عبر ترويسة؟ وهل يبقى الطلب قابلًا للتتبّع إن أرسل قمامة؟
 */
import { describe, expect, it } from 'vitest';
import { correlationIdFrom, isCorrelationId, newCorrelationId } from './correlation.ts';

describe('شكل المعرّف', () => {
  it('يقبل الشكل الضيّق وحده', () => {
    expect(isCorrelationId('abc12345')).toBe(true);
    expect(isCorrelationId('a-b_c-1234')).toBe(true);
  });

  it('يرفض القصير والطويل', () => {
    expect(isCorrelationId('short')).toBe(false);
    expect(isCorrelationId('a'.repeat(65))).toBe(false);
  });

  it('يرفض ما يحقن سطرًا في السجلّ', () => {
    // هذا هو سبب الحدّ: المعرّف ينتهي في سطر يُقرأ
    expect(isCorrelationId('abc12345\nERROR fake line')).toBe(false);
    expect(isCorrelationId('abc 12345')).toBe(false);
    expect(isCorrelationId('abc/12345')).toBe(false);
  });

  it('يرفض ما ليس نصًّا', () => {
    expect(isCorrelationId(undefined)).toBe(false);
    expect(isCorrelationId(12345678)).toBe(false);
    expect(isCorrelationId({ toString: () => 'abc12345' })).toBe(false);
  });
});

describe('اعتماد معرّف الطلب', () => {
  it('يمرّر معرّف العميل حين يصحّ شكله', () => {
    expect(correlationIdFrom('client-request-01')).toBe('client-request-01');
  });

  it('يولّد بديلًا بلا اعتراض حين لا يصحّ', () => {
    // الغرض تتبّعٌ لا تحقّق هوية: طلبٌ بمعرّف تالف يبقى قابلًا للتتبّع
    const made = correlationIdFrom('../../etc/passwd');
    expect(isCorrelationId(made)).toBe(true);
    expect(made).not.toBe('../../etc/passwd');
  });

  it('يولّد بديلًا حين تغيب الترويسة', () => {
    expect(isCorrelationId(correlationIdFrom(undefined))).toBe(true);
  });

  it('يأخذ الأولى حين تتكرّر الترويسة', () => {
    expect(correlationIdFrom(['first-one-here', 'second'])).toBe('first-one-here');
  });

  it('لا يكرّر معرّفين', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newCorrelationId()));
    expect(seen.size).toBe(200);
  });
});
