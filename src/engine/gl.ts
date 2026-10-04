import type { BlendMode, MaskShape, TransitionType } from '../types';
import type { FxParams } from '../lib/filters';

export interface TexRef {
  key: string;
  source: TexImageSource;
  version: number | string;
  mip?: boolean;
}

export interface DrawLayer {
  tex: TexRef | null;
  color: [number, number, number];
  /** quad center and size in frame pixels */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** radians, clockwise */
  rot: number;
  uv: [number, number, number, number];
  opacity: number;
  blend: BlendMode;
  fx: FxParams | null;
  mask: { shape: MaskShape; radius: number; feather: number } | null;
  chroma: { color: [number, number, number]; similarity: number; smoothness: number } | null;
}

export interface Page {
  background: { blur: number; layer: DrawLayer } | null;
  layers: DrawLayer[];
}

export interface FrameSpec {
  width: number;
  height: number;
  clear: [number, number, number];
  pages: Page[];
  transition: { type: TransitionType; progress: number } | null;
  layers: DrawLayer[];
  seed: number;
}

export const TRANSITION_CODES: Record<TransitionType, number> = {
  none: 0,
  fade: 1,
  black: 2,
  white: 3,
  slideLeft: 4,
  slideRight: 5,
  slideUp: 6,
  slideDown: 7,
  wipeLeft: 8,
  wipeRight: 9,
  wipeUp: 10,
  wipeDown: 11,
  zoomIn: 12,
  zoomOut: 13,
  spin: 14,
  circle: 15,
  blur: 16,
};

const VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
uniform mat3 u_mat;
uniform vec2 u_res;
uniform float u_flip;
uniform vec4 u_uv;
out vec2 v_uv;
out vec2 v_local;
void main() {
  vec3 p = u_mat * vec3(a_pos, 1.0);
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, (1.0 - p.y / u_res.y * 2.0) * u_flip, 0.0, 1.0);
  v_uv = mix(u_uv.xy, u_uv.zw, a_pos);
  v_local = a_pos;
}`;

const LAYER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_local;
uniform sampler2D u_tex;
uniform int u_solid;
uniform vec3 u_color;
uniform float u_opacity;
uniform vec2 u_texel;
uniform vec2 u_size;
uniform int u_fx;
uniform vec4 u_fx0;
uniform vec4 u_fx1;
uniform vec4 u_fx2;
uniform vec4 u_fx3;
uniform vec3 u_splitS;
uniform vec3 u_splitH;
uniform int u_chroma;
uniform vec3 u_key;
uniform vec2 u_keyParams;
uniform int u_mask;
uniform vec2 u_maskParams;
uniform int u_aa;
out vec4 o;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 toUV(vec3 c) {
  return vec2(
    c.r * -0.100644 + c.g * -0.338572 + c.b * 0.439216 + 0.501961,
    c.r * 0.439216 + c.g * -0.398942 + c.b * -0.040274 + 0.501961);
}

void main() {
  vec4 c;
  if (u_solid == 1) {
    c = vec4(u_color, 1.0);
  } else {
    c = texture(u_tex, v_uv);
    if (u_fx == 1 && u_fx2.w > 0.0) {
      vec4 n = texture(u_tex, v_uv + vec2(u_texel.x, 0.0)) + texture(u_tex, v_uv - vec2(u_texel.x, 0.0))
             + texture(u_tex, v_uv + vec2(0.0, u_texel.y)) + texture(u_tex, v_uv - vec2(0.0, u_texel.y));
      c = clamp(c + (c * 4.0 - n) * u_fx2.w * 0.6, 0.0, 1.0);
    }
  }
  float a = c.a;
  vec3 rgb = a > 0.0001 ? c.rgb / a : vec3(0.0);

  if (u_chroma == 1) {
    float base = distance(toUV(rgb), toUV(u_key)) - u_keyParams.x;
    a *= pow(clamp(base / max(u_keyParams.y, 0.0001), 0.0, 1.0), 1.5);
    float spill = pow(clamp(base / 0.1, 0.0, 1.0), 1.5);
    rgb = mix(vec3(dot(rgb, LUMA)), rgb, spill);
  }

  if (u_fx == 1) {
    rgb *= exp2(u_fx0.w * 1.5);
    rgb += u_fx0.x * 0.25;
    rgb = (rgb - 0.5) * (1.0 + u_fx0.y * (u_fx0.y > 0.0 ? 1.0 : 0.85)) + 0.5;
    float l = dot(clamp(rgb, 0.0, 1.0), LUMA);
    rgb += u_fx1.w * 0.3 * (1.0 - smoothstep(0.0, 0.55, l));
    rgb += u_fx1.z * 0.3 * smoothstep(0.45, 1.0, l);
    rgb += vec3(u_fx1.x * 0.12 + u_fx1.y * 0.04, -u_fx1.y * 0.08, -u_fx1.x * 0.12 + u_fx1.y * 0.04);
    l = dot(rgb, LUMA);
    rgb = mix(vec3(l), rgb, 1.0 + u_fx0.z);
    if (u_fx3.x > 0.0) {
      vec3 sep = vec3(dot(rgb, vec3(0.393, 0.769, 0.189)), dot(rgb, vec3(0.349, 0.686, 0.168)), dot(rgb, vec3(0.272, 0.534, 0.131)));
      rgb = mix(rgb, sep, u_fx3.x);
    }
    if (u_fx3.y > 0.0) {
      l = clamp(dot(rgb, LUMA), 0.0, 1.0);
      rgb += ((u_splitS - 0.5) * (1.0 - l) + (u_splitH - 0.5) * l) * u_fx3.y * 0.5;
    }
    rgb = mix(rgb, rgb * 0.78 + 0.16, u_fx2.x);
    if (u_fx2.y > 0.0) {
      float vd = length(v_local - 0.5) * 1.41421;
      rgb *= 1.0 - u_fx2.y * smoothstep(0.3, 1.0, vd) * 0.85;
    }
    if (u_fx2.z > 0.0) {
      rgb += (hash(floor(v_local * u_size) + u_fx3.z) - 0.5) * u_fx2.z * 0.16;
    }
  }

  if (u_mask > 0) {
    vec2 p = (v_local - 0.5) * u_size;
    float m = min(u_size.x, u_size.y);
    float d;
    if (u_mask == 1) {
      d = length(p) - m * 0.5;
    } else {
      float r = clamp(u_maskParams.x, 0.0, 0.5) * m;
      vec2 q = abs(p) - u_size * 0.5 + r;
      d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }
    a *= clamp(-d / max(u_maskParams.y * m, 1.0), 0.0, 1.0);
  }
  if (u_aa == 1) {
    vec2 e = min(v_local, 1.0 - v_local) * u_size;
    a *= clamp(min(e.x, e.y), 0.0, 1.0);
  }
  a *= u_opacity;
  o = vec4(clamp(rgb, 0.0, 1.0) * a, a);
}`;

const BLUR_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv) * 0.2270270270;
  c += texture(u_tex, v_uv + u_dir * 1.3846153846) * 0.3162162162;
  c += texture(u_tex, v_uv - u_dir * 1.3846153846) * 0.3162162162;
  c += texture(u_tex, v_uv + u_dir * 3.2307692308) * 0.0702702703;
  c += texture(u_tex, v_uv - u_dir * 3.2307692308) * 0.0702702703;
  o = c;
}`;

const TRANS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_p;
uniform int u_type;
uniform float u_aspect;
out vec4 o;

const vec4 BLACK = vec4(0.0, 0.0, 0.0, 1.0);

bool outside(vec2 uv) { return uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0; }
vec4 sa(vec2 uv) { return outside(uv) ? BLACK : texture(u_a, uv); }
vec4 sb(vec2 uv) { return outside(uv) ? BLACK : texture(u_b, uv); }

vec2 xform(vec2 uv, float ang, float scale) {
  vec2 q = (uv - 0.5) * vec2(u_aspect, 1.0);
  float c = cos(ang);
  float s = sin(ang);
  q = vec2(c * q.x - s * q.y, s * q.x + c * q.y) / scale;
  return q / vec2(u_aspect, 1.0) + 0.5;
}

vec4 blurred(sampler2D t, vec2 uv, float r) {
  vec4 acc = texture(t, uv);
  float w = 1.0;
  for (int i = 0; i < 12; i++) {
    float ang = float(i) * 0.5235988;
    float rr = r * ((i / 2) * 2 == i ? 1.0 : 0.5);
    vec2 off = vec2(cos(ang), sin(ang) * u_aspect) * rr;
    acc += texture(t, clamp(uv + off, 0.0, 1.0));
    w += 1.0;
  }
  return acc / w;
}

float wipe(float edge, float p) {
  float e = 0.03;
  float t = p * (1.0 + 2.0 * e) - e;
  return 1.0 - smoothstep(t - e, t + e, edge);
}

void main() {
  vec2 uv = v_uv;
  float p = u_p;
  if (u_type == 1) {
    o = mix(texture(u_a, uv), texture(u_b, uv), p);
  } else if (u_type == 2 || u_type == 3) {
    vec4 k = u_type == 2 ? BLACK : vec4(1.0);
    o = p < 0.5 ? mix(texture(u_a, uv), k, p * 2.0) : mix(k, texture(u_b, uv), p * 2.0 - 1.0);
  } else if (u_type == 4) {
    o = uv.x < 1.0 - p ? texture(u_a, uv + vec2(p, 0.0)) : texture(u_b, uv - vec2(1.0 - p, 0.0));
  } else if (u_type == 5) {
    o = uv.x >= p ? texture(u_a, uv - vec2(p, 0.0)) : texture(u_b, uv + vec2(1.0 - p, 0.0));
  } else if (u_type == 6) {
    o = uv.y < 1.0 - p ? texture(u_a, uv + vec2(0.0, p)) : texture(u_b, uv - vec2(0.0, 1.0 - p));
  } else if (u_type == 7) {
    o = uv.y >= p ? texture(u_a, uv - vec2(0.0, p)) : texture(u_b, uv + vec2(0.0, 1.0 - p));
  } else if (u_type >= 8 && u_type <= 11) {
    float edge = u_type == 8 ? 1.0 - uv.x : (u_type == 9 ? uv.x : (u_type == 10 ? 1.0 - uv.y : uv.y));
    o = mix(texture(u_a, uv), texture(u_b, uv), wipe(edge, p));
  } else if (u_type == 12) {
    o = mix(sa(xform(uv, 0.0, 1.0 + p * 1.5)), sb(xform(uv, 0.0, 1.0 + (1.0 - p) * 0.6)), smoothstep(0.3, 0.7, p));
  } else if (u_type == 13) {
    o = mix(sa(xform(uv, 0.0, 1.0 - p * 0.5)), sb(xform(uv, 0.0, 1.5 - p * 0.5)), smoothstep(0.3, 0.7, p));
  } else if (u_type == 14) {
    o = mix(sa(xform(uv, p * 3.14159, 1.0 - p * 0.6)), sb(xform(uv, -(1.0 - p) * 3.14159, 1.0 - (1.0 - p) * 0.6)), smoothstep(0.35, 0.65, p));
  } else if (u_type == 15) {
    vec2 q = (uv - 0.5) * vec2(u_aspect, 1.0);
    float r = p * (length(vec2(u_aspect, 1.0) * 0.5) + 0.02);
    o = mix(texture(u_a, uv), texture(u_b, uv), 1.0 - smoothstep(r - 0.02, r, length(q)));
  } else if (u_type == 16) {
    float r = sin(p * 3.14159) * 0.04;
    o = mix(blurred(u_a, uv, r), blurred(u_b, uv, r), smoothstep(0.2, 0.8, p));
  } else {
    o = p < 0.5 ? texture(u_a, uv) : texture(u_b, uv);
  }
}`;

class Program {
  readonly prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private gl: WebGL2RenderingContext,
    vs: string,
    fs: string,
  ) {
    const p = gl.createProgram();
    if (!p) throw new Error('createProgram failed');
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
      }
      gl.attachShader(p, s);
      return s;
    };
    const a = compile(gl.VERTEX_SHADER, vs);
    const b = compile(gl.FRAGMENT_SHADER, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    }
    gl.deleteShader(a);
    gl.deleteShader(b);
    this.prog = p;
  }

  u(name: string): WebGLUniformLocation | null {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.locs.set(name, l);
    }
    return l;
  }
}

interface Fbo {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

interface TexEntry {
  tex: WebGLTexture;
  version: number | string | null;
  w: number;
  h: number;
  used: number;
}

function sourceSize(s: TexImageSource): [number, number] {
  if (typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement) return [s.videoWidth, s.videoHeight];
  if (typeof VideoFrame !== 'undefined' && s instanceof VideoFrame) return [s.displayWidth, s.displayHeight];
  if (typeof HTMLImageElement !== 'undefined' && s instanceof HTMLImageElement) return [s.naturalWidth, s.naturalHeight];
  const o = s as { width: number; height: number };
  return [o.width, o.height];
}

const DIM_FX: FxParams = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: -0.2,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  fade: 0,
  vignette: 0,
  grain: 0,
  sharpen: 0,
  sepia: 0,
  splitShadow: [0.5, 0.5, 0.5],
  splitHighlight: [0.5, 0.5, 0.5],
  splitAmount: 0,
};

export type CompositorCanvas = HTMLCanvasElement | OffscreenCanvas;

/** WebGL2 compositor shared by the live preview and the exporter. */
export class Compositor {
  gl!: WebGL2RenderingContext;
  private layerProg!: Program;
  private blurProg!: Program;
  private transProg!: Program;
  private vao!: WebGLVertexArrayObject;
  private textures = new Map<string, TexEntry>();
  private fboA: Fbo | null = null;
  private fboB: Fbo | null = null;
  private blurA: Fbo | null = null;
  private blurB: Fbo | null = null;
  private frame = 0;
  private flip = 1;
  private resW = 1;
  private resH = 1;
  private seed = 0;
  onRestored?: () => void;

  constructor(
    readonly canvas: CompositorCanvas,
    opts: { preserve?: boolean } = {},
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: !!opts.preserve,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available on this device');
    this.gl = gl;
    this.init();
    const c = canvas as HTMLCanvasElement;
    c.addEventListener?.('webglcontextlost', (e) => e.preventDefault());
    c.addEventListener?.('webglcontextrestored', () => {
      this.textures.clear();
      this.fboA = this.fboB = this.blurA = this.blurB = null;
      this.init();
      this.onRestored?.();
    });
  }

  private init() {
    const gl = this.gl;
    this.layerProg = new Program(gl, VS, LAYER_FS);
    this.blurProg = new Program(gl, VS, BLUR_FS);
    this.transProg = new Program(gl, VS, TRANS_FS);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  get lost(): boolean {
    return this.gl.isContextLost();
  }

  private newTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  private upload(ref: TexRef): TexEntry | null {
    const gl = this.gl;
    let e = this.textures.get(ref.key);
    if (!e) {
      e = { tex: this.newTexture(), version: null, w: 1, h: 1, used: 0 };
      this.textures.set(ref.key, e);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    if (e.version !== ref.version) {
      const [w, h] = sourceSize(ref.source);
      if (!w || !h) return e.version === null ? null : e;
      try {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ref.source);
        if (ref.mip) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        } else {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
        e.version = ref.version;
        e.w = w;
        e.h = h;
      } catch (err) {
        console.warn('texture upload failed', err);
        if (e.version === null) return null;
      }
    }
    e.used = this.frame;
    return e;
  }

  releaseTexture(key: string) {
    const e = this.textures.get(key);
    if (e) {
      this.gl.deleteTexture(e.tex);
      this.textures.delete(key);
    }
  }

  private gc() {
    if (this.frame % 120 !== 0) return;
    for (const [k, e] of this.textures) {
      if (this.frame - e.used > 600) {
        this.gl.deleteTexture(e.tex);
        this.textures.delete(k);
      }
    }
  }

  private ensureFbo(f: Fbo | null, w: number, h: number): Fbo {
    const gl = this.gl;
    if (f && f.w === w && f.h === h) return f;
    if (f) {
      gl.deleteFramebuffer(f.fb);
      gl.deleteTexture(f.tex);
    }
    const tex = this.newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }

  /** Binds a render target. Coordinates are always expressed in frame pixels (resW × resH). */
  private bind(target: Fbo | null, vw: number, vh: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, vw, vh);
    this.flip = target ? -1 : 1;
  }

  private setBlend(mode: BlendMode) {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
    else if (mode === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else if (mode === 'multiply') gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private drawLayer(L: DrawLayer, raw?: { tex: WebGLTexture; w: number; h: number }) {
    if (L.opacity <= 0.001 || Math.abs(L.w) < 0.5 || Math.abs(L.h) < 0.5) return;
    const gl = this.gl;
    const P = this.layerProg;
    gl.useProgram(P.prog);
    let tw = 1;
    let th = 1;
    if (raw) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, raw.tex);
      tw = raw.w;
      th = raw.h;
    } else if (L.tex) {
      const e = this.upload(L.tex);
      if (!e) return;
      tw = e.w;
      th = e.h;
    }
    gl.uniform1i(P.u('u_tex'), 0);
    gl.uniform1i(P.u('u_solid'), raw || L.tex ? 0 : 1);
    gl.uniform3f(P.u('u_color'), L.color[0], L.color[1], L.color[2]);
    const c = Math.cos(L.rot);
    const s = Math.sin(L.rot);
    const a = c * L.w;
    const b = s * L.w;
    const cc = -s * L.h;
    const d = c * L.h;
    gl.uniformMatrix3fv(P.u('u_mat'), false, [a, b, 0, cc, d, 0, L.cx - 0.5 * (a + cc), L.cy - 0.5 * (b + d), 1]);
    gl.uniform2f(P.u('u_res'), this.resW, this.resH);
    gl.uniform1f(P.u('u_flip'), this.flip);
    gl.uniform4f(P.u('u_uv'), L.uv[0], L.uv[1], L.uv[2], L.uv[3]);
    gl.uniform2f(P.u('u_size'), Math.abs(L.w), Math.abs(L.h));
    gl.uniform2f(P.u('u_texel'), 1 / tw, 1 / th);
    gl.uniform1f(P.u('u_opacity'), Math.min(1, L.opacity));
    const fx = L.fx;
    gl.uniform1i(P.u('u_fx'), fx ? 1 : 0);
    if (fx) {
      gl.uniform4f(P.u('u_fx0'), fx.brightness, fx.contrast, fx.saturation, fx.exposure);
      gl.uniform4f(P.u('u_fx1'), fx.temperature, fx.tint, fx.highlights, fx.shadows);
      gl.uniform4f(P.u('u_fx2'), fx.fade, fx.vignette, fx.grain, fx.sharpen);
      gl.uniform4f(P.u('u_fx3'), fx.sepia, fx.splitAmount, this.seed, 0);
      gl.uniform3fv(P.u('u_splitS'), fx.splitShadow);
      gl.uniform3fv(P.u('u_splitH'), fx.splitHighlight);
    }
    const ch = L.chroma;
    gl.uniform1i(P.u('u_chroma'), ch ? 1 : 0);
    if (ch) {
      gl.uniform3fv(P.u('u_key'), ch.color);
      gl.uniform2f(P.u('u_keyParams'), ch.similarity, ch.smoothness);
    }
    const m = L.mask;
    gl.uniform1i(P.u('u_mask'), !m || m.shape === 'none' ? 0 : m.shape === 'circle' ? 1 : 2);
    if (m) gl.uniform2f(P.u('u_maskParams'), m.radius, m.feather);
    const deg = Math.abs(((L.rot * 180) / Math.PI) % 90);
    gl.uniform1i(P.u('u_aa'), deg > 0.05 && deg < 89.95 ? 1 : 0);
    this.setBlend(L.blend);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private fullscreen(P: Program) {
    const gl = this.gl;
    gl.uniformMatrix3fv(P.u('u_mat'), false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    gl.uniform2f(P.u('u_res'), 1, 1);
    gl.uniform1f(P.u('u_flip'), this.flip);
    gl.uniform4f(P.u('u_uv'), 0, 0, 1, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private drawBlurBackground(bg: { blur: number; layer: DrawLayer }, target: Fbo | null, W: number, H: number) {
    const gl = this.gl;
    const div = 4 + bg.blur * 14;
    const bw = Math.max(8, Math.round(W / div));
    const bh = Math.max(8, Math.round(H / div));
    this.blurA = this.ensureFbo(this.blurA, bw, bh);
    this.blurB = this.ensureFbo(this.blurB, bw, bh);
    this.bind(this.blurA, bw, bh);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawLayer(bg.layer);
    const passes = 1 + Math.round(bg.blur * 3);
    const P = this.blurProg;
    gl.useProgram(P.prog);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(P.u('u_tex'), 0);
    for (let i = 0; i < passes; i++) {
      this.bind(this.blurB, bw, bh);
      gl.bindTexture(gl.TEXTURE_2D, this.blurA.tex);
      gl.uniform2f(P.u('u_dir'), 1 / bw, 0);
      this.fullscreen(P);
      this.bind(this.blurA, bw, bh);
      gl.bindTexture(gl.TEXTURE_2D, this.blurB.tex);
      gl.uniform2f(P.u('u_dir'), 0, 1 / bh);
      this.fullscreen(P);
    }
    this.bind(target, W, H);
    this.drawLayer(
      {
        tex: null,
        color: [0, 0, 0],
        cx: W / 2,
        cy: H / 2,
        w: W,
        h: H,
        rot: 0,
        uv: [0, 0, 1, 1],
        opacity: 1,
        blend: 'normal',
        fx: DIM_FX,
        mask: null,
        chroma: null,
      },
      { tex: this.blurA.tex, w: bw, h: bh },
    );
  }

  private renderPage(page: Page | undefined, target: Fbo | null, W: number, H: number, clear: [number, number, number]) {
    const gl = this.gl;
    this.bind(target, W, H);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!page) return;
    if (page.background) this.drawBlurBackground(page.background, target, W, H);
    for (const L of page.layers) this.drawLayer(L);
  }

  render(spec: FrameSpec) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    this.frame++;
    this.seed = spec.seed % 997;
    const W = Math.max(2, Math.round(spec.width));
    const H = Math.max(2, Math.round(spec.height));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    this.resW = W;
    this.resH = H;
    gl.bindVertexArray(this.vao);
    if (spec.transition && spec.pages.length > 1 && spec.transition.type !== 'none') {
      this.fboA = this.ensureFbo(this.fboA, W, H);
      this.fboB = this.ensureFbo(this.fboB, W, H);
      this.renderPage(spec.pages[0], this.fboA, W, H, spec.clear);
      this.renderPage(spec.pages[1], this.fboB, W, H, spec.clear);
      this.bind(null, W, H);
      gl.disable(gl.BLEND);
      const P = this.transProg;
      gl.useProgram(P.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fboA.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.fboB.tex);
      gl.uniform1i(P.u('u_a'), 0);
      gl.uniform1i(P.u('u_b'), 1);
      gl.uniform1f(P.u('u_p'), Math.min(1, Math.max(0, spec.transition.progress)));
      gl.uniform1i(P.u('u_type'), TRANSITION_CODES[spec.transition.type] ?? 1);
      gl.uniform1f(P.u('u_aspect'), W / H);
      this.fullscreen(P);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    } else {
      this.renderPage(spec.pages[0], null, W, H, spec.clear);
    }
    this.bind(null, W, H);
    for (const L of spec.layers) this.drawLayer(L);
    this.gc();
  }

  dispose() {
    const gl = this.gl;
    for (const e of this.textures.values()) gl.deleteTexture(e.tex);
    this.textures.clear();
    for (const f of [this.fboA, this.fboB, this.blurA, this.blurB]) {
      if (f) {
        gl.deleteFramebuffer(f.fb);
        gl.deleteTexture(f.tex);
      }
    }
    this.fboA = this.fboB = this.blurA = this.blurB = null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
