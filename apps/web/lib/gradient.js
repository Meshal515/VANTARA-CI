/**
 * خلفية متحركة.
 *
 * طريقة الرسم مأخوذة من مرجع 21st.dev: shader واحد على مستطيل كامل، ضجيج
 * Perlin يُشوّه الإحداثيات، دوامة تكرارية فوقه، ثم مزج ثلاثة ألوان بحدود
 * ناعمة. ما عُدِّل: كل رقم.
 *
 * تهيئة VANTARA: حركة أبطأ بكثير، تشبّع أقل، ألوان من لوحة الحساب لا من
 * تهيئة جاهزة. المرجع يصنع خلفيات دعائية صاخبة؛ هذه خلفية يجلس فوقها نص
 * ووجه ولا يجوز أن تُزاحمهما.
 *
 * وثلاثة قيود لم تكن في المرجع، وكلها لهاتف لا لسطح مكتب:
 *
 *   - انتقال ناعم بين اللوحات (~320ms) بدل إعادة بناء الـcontext.
 *   - إيقاف الرسم عند إخفاء التطبيق: shader يعمل في الخلفية يستهلك بطارية.
 *   - سقف على devicePixelRatio: 3x على شاشة هاتف ثلاثة أضعاف العمل بلا فرق.
 */

import { DEFAULT_PALETTE } from './colors.js';

const VERTEX_SHADER = `#version 300 es
in vec4 a_position;
void main() { gl_Position = a_position; }`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform float u_pixelRatio;
uniform vec4  u_color1;
uniform vec4  u_color2;
uniform vec4  u_color3;
uniform float u_scale;
uniform float u_distortion;
uniform float u_swirl;
uniform float u_softness;
uniform float u_proportion;

out vec4 fragColor;

#define TWO_PI 6.28318530718

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  float a = random(i);
  float b = random(i + vec2(1.0, 0.0));
  float c = random(i + vec2(0.0, 1.0));
  float d = random(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// مزج بحدود ناعمة. الحدّ الحاد يُظهر خطوطًا (banding) على تدرّج غامق،
// وهي أظهر ما تكون على شاشة AMOLED وهي شاشة الهاتف.
vec4 blendColors(vec4 c1, vec4 c2, vec4 c3, float mixer, float edge) {
  float r1 = smoothstep(0.0, 0.62 + edge, mixer);
  float r2 = smoothstep(0.34, 1.0 + edge, mixer);
  vec3 blended = mix(c1.rgb, c2.rgb, r1);
  return vec4(mix(blended, c3.rgb, r2), 1.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * 0.5;

  float noiseScale = 0.0006 + 0.004 * u_scale;
  uv -= 0.5;
  uv *= (noiseScale * u_resolution);
  uv /= u_pixelRatio;
  uv += 0.5;

  float n1 = noise(uv * 1.0 + t);
  float n2 = noise(uv * 2.0 - t);
  float angle = n1 * TWO_PI;
  uv.x += u_distortion * n2 * cos(angle);
  uv.y += u_distortion * n2 * sin(angle);

  for (float i = 1.0; i <= 5.0; i += 1.0) {
    uv.x += u_swirl / i * cos(t + i * 1.5 * uv.y);
    uv.y += u_swirl / i * cos(t + i * 1.0 * uv.x);
  }

  float shape = 0.5 + 0.5 * sin(uv.x * 1.6) * cos(uv.y * 1.6);
  float mixer = shape + 0.48 * sign(u_proportion - 0.5) * pow(abs(u_proportion - 0.5), 0.5);

  fragColor = blendColors(u_color1, u_color2, u_color3, mixer, 0.02 + 0.06 * u_softness);
}`;

/** تهيئة VANTARA. الحركة عند 0.09: محسوسة وغير ملفتة. */
const TUNING = {
  speed: 0.09,
  scale: 0.5,
  distortion: 1.1,
  swirl: 0.32,
  softness: 0.9,
  proportion: 0.42,
};

/** مدة الانتقال بين حسابين. */
const TRANSITION_MS = 320;

/** فوق 2x لا يُرى فرق على الهاتف، ويُرى في البطارية. */
const MAX_PIXEL_RATIO = 2;

function hexToRgb(hex) {
  const value = String(hex ?? '').replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const int = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(int)) return [0, 0, 0];
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

function stopsOf(palette) {
  // الأساس أولًا: التدرّج يبدأ أسود ويرتفع، فيبقى أسفل الشاشة عميقًا
  return [hexToRgb(palette.base), hexToRgb(palette.secondary), hexToRgb(palette.primary)];
}

/**
 * خلفية CSS بديلة.
 *
 * بلا WebGL2 — محرك قديم أو تسريع معطّل — تبقى شاشة الدخول مفهومة وملوّنة
 * بالحساب نفسه. الرجوع إلى أسود مسطّح يجعل الشاشة تبدو معطوبة لا مبسّطة.
 */
function paintFallback(host, palette) {
  host.style.background = [
    `radial-gradient(120% 80% at 50% 0%, ${palette.primary}, transparent 62%)`,
    `radial-gradient(90% 70% at 20% 100%, ${palette.secondary}, transparent 58%)`,
    palette.base,
  ].join(',');
}

/**
 * يُنشئ الخلفية داخل `host`.
 *
 * تُعيد `{ setPalette, destroy }`. تغيير اللوحة ينتقل تدريجيًا ولا يُعيد
 * بناء أي شيء، فالتمرير بين الحسابات لا يُسقط إطارًا.
 */
export function createGradient(host, initialPalette = DEFAULT_PALETTE) {
  const canvas = document.createElement('canvas');
  canvas.className = 'gradient__canvas';
  host.append(canvas);

  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'low-power' });
  if (!gl) {
    canvas.remove();
    paintFallback(host, initialPalette);
    return {
      setPalette: (palette) => paintFallback(host, palette),
      destroy: () => {
        host.style.background = '';
      },
    };
  }

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    // ترجمة فاشلة على محرك غريب: البديل أفضل من مستطيل أسود
    canvas.remove();
    paintFallback(host, initialPalette);
    return { setPalette: (palette) => paintFallback(host, palette), destroy: () => {} };
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const uniform = (name) => gl.getUniformLocation(program, name);
  const u = {
    time: uniform('u_time'),
    resolution: uniform('u_resolution'),
    pixelRatio: uniform('u_pixelRatio'),
    color1: uniform('u_color1'),
    color2: uniform('u_color2'),
    color3: uniform('u_color3'),
    scale: uniform('u_scale'),
    distortion: uniform('u_distortion'),
    swirl: uniform('u_swirl'),
    softness: uniform('u_softness'),
    proportion: uniform('u_proportion'),
  };

  gl.uniform1f(u.scale, TUNING.scale);
  gl.uniform1f(u.distortion, TUNING.distortion);
  gl.uniform1f(u.swirl, TUNING.swirl);
  gl.uniform1f(u.softness, TUNING.softness);
  gl.uniform1f(u.proportion, TUNING.proportion);

  let from = stopsOf(initialPalette);
  let to = from;
  let transitionStart = 0;
  let ratio = 1;

  const resize = () => {
    const width = host.clientWidth || window.innerWidth;
    const height = host.clientHeight || window.innerHeight;
    ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  // حركة مُعطّلة بطلب النظام: نرسم إطارًا ثابتًا واحدًا ونتوقف
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let frame = null;
  const start = performance.now();

  const draw = (now) => {
    const elapsed = (now - start) / 1000;
    const progress = transitionStart ? Math.min(1, (now - transitionStart) / TRANSITION_MS) : 1;
    // ease-out: النهاية تهدأ، فلا يبدو الانتقال كقطع
    const eased = 1 - (1 - progress) ** 3;

    for (let i = 0; i < 3; i += 1) {
      const a = from[i];
      const b = to[i];
      const mixed = [
        a[0] + (b[0] - a[0]) * eased,
        a[1] + (b[1] - a[1]) * eased,
        a[2] + (b[2] - a[2]) * eased,
      ];
      gl.uniform4f(u[`color${i + 1}`], mixed[0], mixed[1], mixed[2], 1);
    }
    if (progress >= 1 && transitionStart) {
      from = to;
      transitionStart = 0;
    }

    gl.uniform1f(u.time, elapsed * TUNING.speed);
    gl.uniform2f(u.resolution, canvas.width, canvas.height);
    gl.uniform1f(u.pixelRatio, ratio);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (reduceMotion?.matches && !transitionStart) {
      frame = null;
      return;
    }
    frame = requestAnimationFrame(draw);
  };

  const play = () => {
    if (frame === null) frame = requestAnimationFrame(draw);
  };
  const pause = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };

  // التطبيق في الخلفية لا يرسم: هذا أكبر توفير بطارية في الشاشة
  const onVisibility = () => (document.visibilityState === 'hidden' ? pause() : play());
  document.addEventListener('visibilitychange', onVisibility);
  play();

  return {
    setPalette(palette) {
      const next = stopsOf(palette);
      if (JSON.stringify(next) === JSON.stringify(to)) return;
      // الانتقال يبدأ من المعروض الآن لا من الهدف السابق: تمرير سريع بين
      // ثلاثة حسابات لا يقفز
      const progress = transitionStart
        ? Math.min(1, (performance.now() - transitionStart) / TRANSITION_MS)
        : 1;
      const eased = 1 - (1 - progress) ** 3;
      from = from.map((a, i) => a.map((channel, c) => channel + (to[i][c] - channel) * eased));
      to = next;
      transitionStart = performance.now();
      play();
    },
    destroy() {
      pause();
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteBuffer(buffer);
      canvas.remove();
    },
  };
}
