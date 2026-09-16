// GLSL sources for the "blue biro on paper" look.

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
  if (uFill > 0.5) shade = 1.0;
  if (uFlat > 0.5) shade = 0.0;
  // r = shade (0 = pure ink stroke, 1 = paper), g = ink index
  gl_FragColor = vec4(shade, uInk / 5.0, n.x * 0.5 + 0.5, 1.0);
}
`;

export const PAPER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uTime;
uniform float uNear;
uniform float uFar;
uniform float uHurt;
uniform float uFlash;
uniform float uSlow;
uniform float uLowHp;
uniform vec3 uPaper;
uniform vec3 uInks[6];
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform float uOutline;

float linDepth(vec2 uv) {
  float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}

void main() {
  vec2 uv = vUv;

  // paper base + grain
  float grain = fract(sin(dot(uv * uRes, vec2(12.9898, 78.233)) + uTime) * 43758.5453);
  vec3 col = uPaper * (0.982 + 0.026 * grain);

  // faint ruled lines
  float py = uv.y * uRes.y;
  float ln = abs(fract(py / 52.0) - 0.5) * 52.0;
  col = mix(col, col * 0.972, smoothstep(1.4, 0.0, ln) * 0.45);

  // scene decode
  vec4 s = texture2D(tScene, uv);
  float shade = s.r;
  float inkId = floor(s.g * 5.0 + 0.5);

  // depth-based ink: blue biro up close, graphite in the distance
  float d = linDepth(uv);
  float depthFac = clamp((d - 6.0) / 58.0, 0.0, 1.0);
  vec3 inkCol = mix(uInks[0], uInks[2], depthFac);
  inkCol = inkId > 0.5 ? uInks[1] : inkCol;
  inkCol = inkId > 1.5 ? uInks[2] : inkCol;
  inkCol = inkId > 2.5 ? uInks[3] : inkCol;
  inkCol = inkId > 3.5 ? uInks[4] : inkCol;
  inkCol = inkId > 4.5 ? uInks[5] : inkCol;

  // sketchy edge from depth discontinuity
  vec2 px = 1.0 / uRes;
  float dR = linDepth(uv + vec2(1.3, 0.0) * px);
  float dU = linDepth(uv + vec2(0.0, 1.3) * px);
  float edge = clamp((abs(d - dR) + abs(d - dU)) * 0.028 * uOutline, 0.0, 1.0);

  // compose object color: r=0 -> pure ink stroke, higher -> shaded paper
  vec3 paperTint = uPaper * (0.9 + 0.1 * shade);
  vec3 obj = mix(inkCol, paperTint, shade);
  obj = mix(obj, inkCol * 1.05, edge * 0.8);

  col = obj;

  // focus (katana) slow-mo: desaturate toward graphite
  float g = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, mix(vec3(g), col, 0.4) * vec3(0.99, 0.985, 1.0), uSlow * 0.8);

  // damage tint
  col = mix(col, vec3(0.74, 0.2, 0.18), uHurt * 0.4);

  // low hp pulsing edge
  float pulse = 0.5 + 0.5 * sin(uTime * 5.0);
  float vigE = smoothstep(0.38, 0.78, length(uv - 0.5));
  col = mix(col, vec3(0.7, 0.16, 0.15), uLowHp * vigE * (0.18 + 0.3 * pulse));

  // gentle vignette
  col *= mix(1.0, 0.94, smoothstep(0.5, 1.1, length(uv - 0.5)));

  // muzzle flash wash
  col = mix(col, vec3(1.0), uFlash * 0.55);

  gl_FragColor = vec4(col, 1.0);
}
`;
