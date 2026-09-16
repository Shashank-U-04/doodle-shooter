// GLSL for the "blue biro on paper" look, ported from the reference game.
//
// The scene is rendered to a float render target whose four channels are used as
// data, not colour:  r = shade (-1 means "solid fill"), g = ink index (0..5),
// b/a = the view-space normal's x/y. The post pass then lays hand-drawn hatching
// over the paper, anchored to each surface, plus a silhouette test done in
// inverse depth so edges stay crisp near and far.

export const INK_VERT = /* glsl */ `
varying vec3 vNormalV;
void main() {
  vec3 transformed = position;
  vec3 objectNormal = normal;
  #ifdef USE_INSTANCING
    transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;
    objectNormal = mat3(instanceMatrix) * objectNormal;
  #endif
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  vNormalV = normalize(normalMatrix * objectNormal);
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const INK_FRAG = /* glsl */ `
precision highp float;
uniform float uInk;
uniform float uFill;
uniform float uFlat;
uniform float uShadeScale;
uniform float uShadeBias;
uniform vec3 uLightDir;
varying vec3 vNormalV;
void main() {
  vec3 n = normalize(vNormalV);
  if (!gl_FrontFacing) n = -n;
  float ndl = dot(n, uLightDir) * 0.5 + 0.5;
  float shade = clamp(ndl * uShadeScale + uShadeBias, 0.0, 1.0);
  // -1 means "this surface is solid ink": filled panels and flat tracer/shards.
  if (uFill > 0.5) shade = -1.0;
  if (uFlat > 0.5) shade = -1.0;
  gl_FragColor = vec4(shade, uInk, n.x, n.y);
}
`;

export const PAPER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uAspect;
uniform float uTime;
uniform float uNear;
uniform float uFar;
uniform float uHurt;
uniform float uFlash;
uniform float uSlow;
uniform float uLineSpacing;
uniform float uLineMode;
uniform float uLowHp;
uniform vec3 uPaper;
uniform vec3 uInks[6];
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform float uOutline;

float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float linDepth(float z) { float zn = z * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - zn * (uFar - uNear)); }
vec3 inkColor(float id) {
  int i = int(id + 0.5);
  if (i <= 0) return uInks[0]; if (i == 1) return uInks[1]; if (i == 2) return uInks[2];
  if (i == 3) return uInks[3]; if (i == 4) return uInks[4]; return uInks[5];
}
float stripes(vec2 p, vec2 dir, float spacing, float width) {
  float t = dot(p, vec2(-dir.y, dir.x));
  float f = abs(fract(t / spacing) - 0.5) * spacing;
  float soft = width * 0.6;
  return 1.0 - smoothstep(width * 0.5 - soft, width * 0.5 + soft, f);
}
void main() {
  vec2 px = 1.0 / uRes;
  float sc = uRes.y / 900.0;
  vec2 nuv = vUv * vec2(uAspect, 1.0);
  vec2 wob = vec2(vnoise(nuv * 6.0 + 11.3), vnoise(nuv * 6.0 + 37.0)) - 0.5;
  vec2 suv = vUv + wob * 2.0 * sc * px;
  vec4 s = texture2D(tScene, suv);
  float z = texture2D(tDepth, suv).x;
  float d = linDepth(z);
  float o = 1.15 * sc;
  vec2 ox = vec2(o, 0.0) * px, oy = vec2(0.0, o) * px;
  float zl = texture2D(tDepth, suv - ox).x, zr = texture2D(tDepth, suv + ox).x;
  float zu = texture2D(tDepth, suv + oy).x, zd = texture2D(tDepth, suv - oy).x;
  vec4 sl = texture2D(tScene, suv - ox), sr = texture2D(tScene, suv + ox);
  vec4 su = texture2D(tScene, suv + oy), sd = texture2D(tScene, suv - oy);
  // Edge test in inverse depth. For any plane - including ones seen at a grazing
  // angle, like the floor - 1/d is affine across the screen, so its second
  // difference is zero there and only real silhouettes register. Comparing it
  // against 1/d itself keeps the test scale invariant, so distant outlines stay
  // as crisp as near ones.
  float iw = 1.0 / d;
  float lap = abs(1.0 / linDepth(zl) + 1.0 / linDepth(zr) - 2.0 * iw)
            + abs(1.0 / linDepth(zu) + 1.0 / linDepth(zd) - 2.0 * iw);
  float edge = smoothstep(0.07, 0.30, lap / (iw + 1e-7));
  float nEdge = length(sl.ba - sr.ba) + length(su.ba - sd.ba);
  edge = max(edge, smoothstep(0.42, 0.85, nEdge));
  edge *= uOutline;
  // ink colour of the front-most sample around the edge
  float zmin = z; float inkId = s.g;
  if (zl < zmin) { zmin = zl; inkId = sl.g; }
  if (zr < zmin) { zmin = zr; inkId = sr.g; }
  if (zu < zmin) { zmin = zu; inkId = su.g; }
  if (zd < zmin) { zmin = zd; inkId = sd.g; }
  float dFront = linDepth(zmin);
  bool sky = z >= 0.99999;

  // Hatching is anchored to the surface itself, not to the screen. The fragment's
  // world position is rebuilt from depth and the strokes are laid out in world
  // units on whichever pair of axes faces away from the surface normal, so the
  // pattern stays put on a wall as you move past it. Line spacing steps in powers
  // of two with distance, which keeps the on-screen density roughly constant
  // instead of collapsing into moire on far geometry.
  float shade = s.r;
  float hatch = 0.0;
  if (!sky) {
    if (shade < 0.0) hatch = 1.0;
    else {
      vec2 hp; float sp, w;
      if (d < 2.0) {
        // the held weapon rides with the camera, so for it the screen is the stable frame
        hp = gl_FragCoord.xy + wob * 5.0 * sc;
        sp = 8.5 * sc; w = 1.5 * sc;
      } else {
        vec4 clip = vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
        vec4 vpos = uInvProj * clip; vpos /= vpos.w;
        vec3 wpos = (uInvView * vec4(vpos.xyz, 1.0)).xyz;
        vec2 nxy = s.ba;
        vec3 nView = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
        vec3 wn = normalize(mat3(uInvView) * nView);
        vec3 an = abs(wn);
        // project onto the plane the surface most faces, so strokes lie flat along it
        hp = an.y > max(an.x, an.z) ? wpos.xz : (an.x > an.z ? wpos.zy : wpos.xy);
        // pick the world spacing whose projected width is about nine pixels, quantised to powers
        // of two so the pattern only changes density in steps and never crawls as you walk
        float lod = exp2(floor(log2(max(1e-4, (0.0165 * d) / 0.16))));
        sp = 0.16 * lod; w = sp * 0.17;
        hp += (vnoise(hp * (2.5 / sp)) - 0.5) * sp * 0.4; // hand-drawn waver, fixed to the surface
      }
      const vec2 d1 = vec2(0.7071, 0.7071);
      const vec2 d2 = vec2(-0.7071, 0.7071);
      const vec2 d3 = vec2(0.2588, 0.9659);
      float h1 = stripes(hp, d1, sp, w);
      float h2 = stripes(hp, d2, sp * 1.15, w);
      float h3 = stripes(hp, d3, sp * 0.7, w);
      hatch = h1 * smoothstep(0.64, 0.5, shade);
      hatch = max(hatch, h2 * smoothstep(0.42, 0.32, shade));
      hatch = max(hatch, h3 * smoothstep(0.24, 0.14, shade));
      hatch = max(hatch, smoothstep(0.12, 0.0, shade) * 0.9);
    }
  }
  float fade = mix(1.0, 0.28, smoothstep(14.0, 110.0, d));
  float fadeE = mix(1.0, 0.45, smoothstep(30.0, 220.0, dFront));

  // paper with grain, ruled lines and a red margin
  vec2 pp = gl_FragCoord.xy;
  float grain = vnoise(pp * 0.8) * 0.6 + vnoise(pp * 0.17) * 0.4;
  vec3 paper = uPaper * (0.95 + 0.06 * grain);
  float ls = uLineSpacing;
  if (uLineMode < 0.5) {
    float ly = mod(pp.y + ls * 0.5, ls);
    float rule = 1.0 - smoothstep(0.5 * sc, 1.7 * sc, abs(ly - ls * 0.5));
    paper = mix(paper, vec3(0.58, 0.70, 0.92), rule * 0.5);
    float margin = 1.0 - smoothstep(0.9 * sc, 2.3 * sc, abs(pp.x - uRes.x * 0.07));
    paper = mix(paper, vec3(0.92, 0.48, 0.55), margin * 0.55);
  } else {
    // graph paper: a faint green grid, the field-notebook look; kept light so the ink stays the subject
    float gs = ls * 0.62;
    float gx = mod(pp.x + gs * 0.5, gs), gy = mod(pp.y + gs * 0.5, gs);
    float g1 = 1.0 - smoothstep(0.35 * sc, 1.15 * sc, abs(gx - gs * 0.5));
    float g2 = 1.0 - smoothstep(0.35 * sc, 1.15 * sc, abs(gy - gs * 0.5));
    paper = mix(paper, vec3(0.58, 0.76, 0.63), max(g1, g2) * 0.19);
  }

  vec3 col = paper;
  col = mix(col, inkColor(s.g), hatch * 0.72 * fade);
  float ew = 0.75 + 0.35 * vnoise(pp * 0.35);
  col = mix(col, inkColor(inkId) * 0.92, clamp(edge * ew, 0.0, 1.0) * fadeE);

  // hurt: red scribble vignette; low hp: pulsing
  vec2 vc = (vUv - 0.5) * vec2(uAspect, 1.0);
  float vig = smoothstep(0.32, 0.9, length(vc));
  float scr = 0.55 + 0.45 * stripes(pp + wob * 8.0, normalize(vec2(1.0, 0.8)), 7.0 * sc, 2.2 * sc);
  float hurt = clamp(uHurt + uLowHp * (0.35 + 0.25 * sin(uTime * 6.0)), 0.0, 1.0);
  col = mix(col, uInks[1] * 0.9, hurt * vig * scr);
  col = mix(col, uPaper, uFlash);
  float lum = dot(col, vec3(0.3, 0.5, 0.2));
  col = mix(col, vec3(lum) * vec3(0.8, 0.86, 1.0), uSlow * 0.55);
  gl_FragColor = vec4(col, 1.0);
}
`;
