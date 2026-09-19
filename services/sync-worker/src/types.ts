/**
 * أنواع D1 وبيئة الـWorker، مكتوبة يدويًا.
 *
 * البديل `@cloudflare/workers-types` يضيف تبعية وقفلًا جديدًا مقابل ما نستعمله
 * فعلًا: أربع دوال من D1 وثلاثة globals. ما هنا هو سطح الاستخدام كاملًا، ولو
 * نما الاستخدام تُضاف الحزمة.
 */

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /** ذرّية: الدفعة كلها تنجح أو لا شيء منها — وهذا ما يجعل السحب لقطة متسقة. */
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface Env {
  DB: D1Database;
  /** مؤقت فقط لمهايئ الـWorker القديم داخل secure-index؛ لا يخرج للعميل. */
  VANTARA_SESSION_SECRET: string;
  /** يوقّع access token v2 نفسه الذي يفهمه Worker وContent API. */
  VANTARA_IDENTITY_SECRET: string;
  /** HMAC لبيانات pairing/device؛ D1 لا يخزن credential خامًا. */
  VANTARA_DEVICE_PEPPER: string;
  /** أصول مسموح لها بالطلب. فاصلة بينها. */
  ALLOWED_ORIGINS?: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
