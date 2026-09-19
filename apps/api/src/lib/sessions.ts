import { query, queryOne } from '@vantara/db';
import { identityIdForUsername } from '@vantara/domain';
import type { UchiyomiClient } from '@vantara/uchiyomi';
import { decrypt, encrypt, newSessionId } from './crypto.ts';

export const SESSION_COOKIE = 'vantara_session';

export interface Session {
  id: string;
  /** هوية VANTARA الموحدة، عند الدخول عبر access token v2. */
  identityId?: string;
  /** معرّف Uchiyomi الداخلي؛ Uchiyomi يبقى مالك المحتوى والمكتبة والتقدم. */
  userId: string;
  username: string;
  /** توكن Uchiyomi بعد فكّ التشفير. لا يُسجَّل ولا يُعاد إلى العميل. */
  token: string;
  /** معرّف التوكن الأعلى، مطلوب لإبطاله عند logout. */
  tokenId?: string;
}

interface SessionRow {
  id: string;
  uchiyomi_user_id: string;
  token_encrypted: string;
  token_id: string | null;
  username: string;
}

interface IdentityLinkRow {
  vantara_identity_id: string;
  uchiyomi_user_id: string;
  token_encrypted: string;
  token_id: string | null;
  username: string;
}

export interface SessionStoreOptions {
  key: Buffer;
  ttlDays: number;
  uchiyomi: UchiyomiClient;
}

export class SessionStore {
  readonly #options: SessionStoreOptions;

  constructor(options: SessionStoreOptions) {
    this.#options = options;
  }

  /**
   * Legacy/owner linking path. كلمة المرور لا تدخل شاشة الحساب اليومية. عند
   * نجاح الربط نحفظ توكن Uchiyomi مشفّرًا تحت VANTARA identity الثابتة حتى
   * يستطيع access token v2 فتح المحتوى من دون Login ثانٍ.
   */
  async login(username: string, password: string, device?: string): Promise<Session> {
    const uchiyomi = this.#options.uchiyomi;
    const result = await uchiyomi.login(username, password);

    const expiresInDays = this.#options.ttlDays;
    const minted = await uchiyomi.mintToken(result.accessToken, {
      name: `vantara${device ? ` (${device})` : ''}`,
      scopes: ['read', 'write'],
      expiresInDays,
    });

    await query(
      `INSERT INTO vantara_users (uchiyomi_user_id, username)
            VALUES ($1, $2)
       ON CONFLICT (uchiyomi_user_id)
       DO UPDATE SET username = EXCLUDED.username, last_seen_at = now()`,
      [result.user.id, result.user.username],
    );
    const encrypted = encrypt(minted.token, this.#options.key);
    const identityId = identityIdForUsername(result.user.username);
    if (identityId) {
      await query(
        `INSERT INTO vantara_identity_links
           (vantara_identity_id, uchiyomi_user_id, token_encrypted, token_id, revoked_at)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (vantara_identity_id) DO UPDATE SET
           uchiyomi_user_id = EXCLUDED.uchiyomi_user_id,
           token_encrypted = EXCLUDED.token_encrypted,
           token_id = EXCLUDED.token_id,
           linked_at = now(),
           last_used_at = now(),
           revoked_at = NULL`,
        [identityId, result.user.id, encrypted, minted.id],
      );
    }

    const id = newSessionId();
    await query(
      `INSERT INTO vantara_sessions
         (id, uchiyomi_user_id, token_encrypted, token_id, device, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)`,
      [id, result.user.id, encrypted, minted.id, device ?? null, String(expiresInDays)],
    );

    return {
      id,
      ...(identityId ? { identityId } : {}),
      userId: result.user.id,
      username: result.user.username,
      token: minted.token,
      tokenId: minted.id,
    };
  }

  /** يُرجع undefined للجلسة المنتهية أو المُبطلة أو غير الموجودة — بلا تمييز. */
  async resolve(sessionId: string): Promise<Session | undefined> {
    const row = await queryOne<SessionRow>(
      `SELECT s.id, s.uchiyomi_user_id, s.token_encrypted, s.token_id, u.username
         FROM vantara_sessions s
         JOIN vantara_users u USING (uchiyomi_user_id)
        WHERE s.id = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()`,
      [sessionId],
    );
    if (!row) return undefined;

    let token: string;
    try {
      token = decrypt(row.token_encrypted, this.#options.key);
    } catch {
      await this.revoke(sessionId);
      return undefined;
    }

    return {
      id: row.id,
      userId: row.uchiyomi_user_id,
      username: row.username,
      token,
      ...(row.token_id ? { tokenId: row.token_id } : {}),
    };
  }

  /**
   * يحول VANTARA identity الموقعة إلى جلسة محتوى؛ التوكن الحقيقي يبقى على
   * الخادم. deviceId يدخل id التشخيصي فقط، والـWorker هو من يثبت الجهاز.
   */
  async resolveIdentity(identityId: string, deviceId: string): Promise<Session | undefined> {
    const row = await queryOne<IdentityLinkRow>(
      `SELECT l.vantara_identity_id, l.uchiyomi_user_id, l.token_encrypted, l.token_id, u.username
         FROM vantara_identity_links l
         JOIN vantara_users u USING (uchiyomi_user_id)
        WHERE l.vantara_identity_id = $1 AND l.revoked_at IS NULL`,
      [identityId],
    );
    if (!row) return undefined;

    let token: string;
    try {
      token = decrypt(row.token_encrypted, this.#options.key);
    } catch {
      await query(
        `UPDATE vantara_identity_links SET revoked_at = now()
          WHERE vantara_identity_id = $1 AND revoked_at IS NULL`,
        [identityId],
      );
      return undefined;
    }

    void query(
      `UPDATE vantara_identity_links SET last_used_at = now()
        WHERE vantara_identity_id = $1 AND revoked_at IS NULL`,
      [identityId],
    ).catch(() => {});

    return {
      id: `identity:${identityId}:${deviceId}`,
      identityId: row.vantara_identity_id,
      userId: row.uchiyomi_user_id,
      username: row.username,
      token,
      ...(row.token_id ? { tokenId: row.token_id } : {}),
    };
  }

  /** لمسة خفيفة لآخر استخدام. لا تُنتظر في مسار الطلب. */
  async touch(sessionId: string): Promise<void> {
    await query(
      `UPDATE vantara_sessions SET last_used_at = now()
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
  }

  async revoke(sessionId: string): Promise<void> {
    await query(
      `UPDATE vantara_sessions SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
  }

  /**
   * إغلاق جلسة الـcookie القديمة بلا كسر ربط الهوية الحديثة.
   *
   * مسار الربط يخزّن credential Uchiyomi طويل العمر في `vantara_identity_links`
   * كي يستطيع Bearer v2 فتح المحتوى بلا كلمة مرور. وقد تحمل جلسة cookie التي
   * أنشأت الربط **نفس** token_id؛ إبطاله عند خروج الكوكي يترك صف الهوية نشطًا
   * لكنه يشير إلى credential ميت، فتتحول كل طلبات Bearer إلى 500/401.
   *
   * لذلك:
   * - Bearer identity ليست جلسة قابلة للإبطال هنا؛ الجهاز يُلغى عند الـWorker
   *   والتوكن القصير ينتهي خلال 15 دقيقة.
   * - cookie session تُغلق محليًا دائمًا.
   * - credential الأعلى يُلغى فقط إذا لم يعد يحمي ربط Identity نشطًا.
   */
  async logout(session: Session): Promise<void> {
    if (session.identityId) return;

    let revokeError: unknown;
    try {
      let backsActiveIdentity = false;
      if (session.tokenId) {
        const linked = await queryOne<{ active: number }>(
          `SELECT 1 AS active
             FROM vantara_identity_links
            WHERE token_id = $1 AND revoked_at IS NULL
            LIMIT 1`,
          [session.tokenId],
        );
        backsActiveIdentity = linked !== undefined;
      }

      if (session.tokenId && !backsActiveIdentity) {
        await this.#options.uchiyomi.revokeToken(session.token, session.tokenId);
      }
    } catch (error) {
      // عند الشك لا نقتل credential قد يكون هو ربط الهوية الوحيد.
      revokeError = error;
    } finally {
      await this.revoke(session.id);
    }

    if (revokeError) throw revokeError;
  }

  async revokeAllFor(userId: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `UPDATE vantara_sessions SET revoked_at = now()
        WHERE uchiyomi_user_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [userId],
    );
    return rows.length;
  }

  /** تنظيف دوري. الجلسة المنتهية تبقى صفًا ميتًا حتى تُحذف. */
  async purgeExpired(): Promise<number> {
    const rows = await query<{ id: string }>(
      `DELETE FROM vantara_sessions
        WHERE expires_at < now() - interval '7 days'
           OR revoked_at < now() - interval '7 days'
        RETURNING id`,
    );
    return rows.length;
  }
}
