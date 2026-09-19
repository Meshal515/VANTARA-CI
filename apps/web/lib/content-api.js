/**
 * عميل Content API.
 *
 * الويب يحتفظ بالكوكي للتوافق، لكن الـAPK يعتمد على Bearer لأن أصل Capacitor
 * مختلف. إذا انتهى access token (15 دقيقة) نجدد trusted-device session مرة
 * واحدة ثم نعيد نفس الطلب. لا loop على 401.
 */
export async function requestContent({
  // بلا قيمة، `${baseUrl}${path}` يصير `undefined/v1/…`: نداء يفشل بعنوان
  // مضلِّل. المنادي في التطبيق يمرّر نصًّا دائمًا، لكن العقد لا يجب أن يعتمد
  // على ذلك — الأصل نفسه هو الحالة الصحيحة للويب.
  baseUrl = '',
  sync,
  path,
  options = {},
  allowRefresh = true,
}) {
  const headers = { ...(options.headers ?? {}) };
  const authorization = sync?.authorizationHeader;
  if (authorization) headers.authorization = authorization;
  if (options.body) headers['content-type'] ??= 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    credentials: baseUrl ? 'include' : 'same-origin',
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (
    response.status === 401 &&
    allowRefresh &&
    sync?.signedIn &&
    typeof sync.refreshSession === 'function'
  ) {
    try {
      await sync.refreshSession();
      return requestContent({ baseUrl, sync, path, options, allowRefresh: false });
    } catch {
      // نرجع خطأ الطلب الأصلي؛ refreshSession حدّث حالة الجلسة داخليًا.
    }
  }

  if (response.status === 204) return null;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload?.error;
    // B10: الخادم يعيد معرّف هذا النداء في الترويسة وفي الجسم. حملُه على
    // الخطأ يجعل «أبلغ عن مشكلة» يصل ومعه الخيط إلى سطر السجلّ بالضبط،
    // بدل أن يصل ومعه الوقت وحده.
    error.correlationId =
      response.headers.get('x-correlation-id') ?? payload?.correlationId ?? null;
    throw error;
  }
  return payload;
}
