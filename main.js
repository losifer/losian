import * as THREE from 'three';
import { TTFLoader } from 'three/addons/loaders/TTFLoader.js';
import { Font } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const TITLE = 'LOSIAN';
const FONT_URL = './assets/fonts/Monoton-Regular.ttf';
const TEXT_SIZE = 1;
const TEXT_DEPTH = 0.42;
const TRACKING = 0.08; // extra space between letters, in text-size units
const EMBER_COUNT = 5000;
const STAR_COUNT = 2200;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const timeScale = reducedMotion ? 0.35 : 1;

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const NOISE_GLSL = /* glsl */ `
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
          mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
          mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5;
    float s = 0.0;
    for (int i = 0; i < 5; i++) {
      s += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return s;
  }
  // black -> ember red -> orange -> amber -> white-hot
  vec3 fireRamp(float h) {
    vec3 c = mix(vec3(0.0), vec3(0.55, 0.04, 0.0), smoothstep(0.0, 0.35, h));
    c = mix(c, vec3(1.0, 0.32, 0.02), smoothstep(0.3, 0.62, h));
    c = mix(c, vec3(1.0, 0.68, 0.22), smoothstep(0.58, 0.84, h));
    c = mix(c, vec3(1.0, 0.96, 0.88), smoothstep(0.84, 1.0, h));
    return c;
  }
`;

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 0, 12);

const uTime = { value: 0 };
const uPixelRatio = { value: renderer.getPixelRatio() };

// ---------------------------------------------------------------------------
// Dimensional background: nebula + receding grid tunnel (fullscreen quad)
// ---------------------------------------------------------------------------

const bgUniforms = {
  uTime,
  uRes: { value: new THREE.Vector2() },
  uMouse: { value: new THREE.Vector2() },
};

const background = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    uniforms: bgUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = vec4(position.xy, 0.9999, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec2 uRes;
      uniform vec2 uMouse;
      ${NOISE_GLSL}

      float gridLines(vec2 g, float width) {
        vec2 w = fwidth(g) * width;
        vec2 d = abs(fract(g) - 0.5);
        vec2 l = 1.0 - smoothstep(vec2(0.0), w, d);
        return max(l.x, l.y);
      }

      void main() {
        vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
        p += uMouse * 0.035;
        vec3 col = vec3(0.012, 0.005, 0.002);

        // nebula
        float n = fbm(vec3(p * 1.5, uTime * 0.025));
        float n2 = fbm(vec3(p * 3.2 + n * 1.6, uTime * 0.04 + 7.0));
        col += vec3(0.50, 0.12, 0.015) * smoothstep(0.42, 0.95, n2) * 0.2;
        col += vec3(0.22, 0.04, 0.0) * pow(n, 3.0) * 0.4;

        // vanishing-point core glow
        col += vec3(1.0, 0.33, 0.04) * 0.07 * exp(-dot(p, p) * 5.0);

        // grid tunnel: floor and ceiling receding to the horizon
        float hy = abs(p.y);
        float depth = 0.22 / max(hy, 1e-3);
        vec2 g = vec2(p.x * depth * 2.0, depth * 2.0 + uTime * 2.4);
        float line = gridLines(g, 1.2);
        float fade = exp(-depth * 0.09) * smoothstep(0.015, 0.22, hy);
        float side = p.y < 0.0 ? 1.0 : 0.45;
        col += vec3(1.0, 0.38, 0.06) * line * fade * side * 0.22;

        // horizon flare
        col += vec3(1.0, 0.42, 0.1) * exp(-hy * 55.0) * 0.22 * smoothstep(1.2, 0.0, abs(p.x));

        // vignette
        col *= smoothstep(1.35, 0.25, length(p * vec2(0.85, 1.0)));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
);
background.frustumCulled = false;
background.renderOrder = -1;
scene.add(background);

// ---------------------------------------------------------------------------
// Warp stars streaming toward the camera
// ---------------------------------------------------------------------------

{
  const positions = new Float32Array(STAR_COUNT * 3);
  const rand = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    const r = 3 + Math.pow(Math.random(), 0.6) * 28;
    const a = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = Math.sin(a) * r;
    positions[i * 3 + 2] = -90 + Math.random() * 100;
    rand[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));

  const stars = new THREE.Points(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { uTime, uPixelRatio },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uPixelRatio;
        attribute float aRand;
        varying float vFade;
        varying float vTint;
        void main() {
          vec3 p = position;
          p.z = mod(p.z + 90.0 + uTime * (4.0 + aRand * 6.0), 100.0) - 90.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vFade = smoothstep(-90.0, -55.0, p.z) * smoothstep(10.0, 2.0, p.z);
          vTint = aRand;
          gl_PointSize = (1.0 + aRand * 2.2) * uPixelRatio * (18.0 / -mv.z);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vFade;
        varying float vTint;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          vec3 c = mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.9, 0.8), vTint);
          gl_FragColor = vec4(c * a * vFade * 0.9, 1.0);
        }
      `,
    })
  );
  stars.frustumCulled = false;
  scene.add(stars);
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.4, 0.45);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

const titleGroup = new THREE.Group();
scene.add(titleGroup);

const titleBox = new THREE.Box3(); // padded local-space bounds used as the grab target
const letters = []; // { mesh, ignite, delay }
const embersUniforms = { uTime, uPixelRatio, uIgnite: { value: 0 } };
let titleWidth = 7;
let titleHeight = 1;

function buildTitle(font) {
  const glyphs = font.data.glyphs;
  const resolution = font.data.resolution;

  // Lay letters out by glyph advance plus tracking
  const geometries = [];
  let cursor = 0;
  for (const ch of TITLE) {
    const geo = new TextGeometry(ch, {
      font,
      size: TEXT_SIZE,
      height: TEXT_DEPTH,
      curveSegments: 10,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.006,
      bevelSegments: 3,
    });
    geo.translate(cursor, 0, 0);
    geometries.push(geo);
    const advance = (glyphs[ch]?.ha ?? resolution * 0.8) / resolution * TEXT_SIZE;
    cursor += advance + TRACKING * TEXT_SIZE;
  }

  // Center the whole word on the origin
  const box = new THREE.Box3();
  for (const geo of geometries) {
    geo.computeBoundingBox();
    box.union(geo.boundingBox);
  }
  const center = box.getCenter(new THREE.Vector3());
  for (const geo of geometries) geo.translate(-center.x, -center.y, -center.z);
  box.translate(center.negate());

  titleBox.copy(box).expandByScalar(0.2);
  titleWidth = box.max.x - box.min.x;
  titleHeight = box.max.y - box.min.y;

  const bounds = new THREE.Vector4(box.min.x, box.max.x, box.min.y, box.max.y);
  const zRange = new THREE.Vector2(box.min.z, box.max.z);

  geometries.forEach((geo, i) => {
    const ignite = { value: 0 };

    // Caps: molten afterburn surface
    const faceMat = new THREE.ShaderMaterial({
      uniforms: { uTime, uIgnite: ignite, uBounds: { value: bounds } },
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIgnite;
        uniform vec4 uBounds;
        varying vec3 vPos;
        ${NOISE_GLSL}
        void main() {
          vec2 nUv = vec2(
            (vPos.x - uBounds.x) / (uBounds.y - uBounds.x),
            (vPos.y - uBounds.z) / (uBounds.w - uBounds.z)
          );
          float flow = fbm(vec3(vPos.x * 1.8, vPos.y * 2.6 - uTime * 1.3, uTime * 0.4));
          float core = 1.0 - smoothstep(0.0, 0.6, abs(nUv.y - 0.5) * 2.0);
          float heat = 0.28 + 0.34 * flow + 0.2 * core;

          // scanning thrust band sweeping across the word
          float sweep = fract(uTime * 0.11) * 1.8 - 0.4;
          float band = exp(-pow((nUv.x - sweep + (nUv.y - 0.5) * 0.25) * 7.0, 2.0));
          heat += band * 0.3;

          float flicker = 0.93 + 0.07 * noise(vec3(uTime * 9.0, vPos.x, 0.0));
          float flash = 1.0 + 2.5 * smoothstep(0.6, 1.0, uIgnite) * (1.0 - smoothstep(1.0, 1.4, uIgnite));
          vec3 col = fireRamp(clamp(heat, 0.0, 1.0)) * (0.95 + band * 0.9) * flicker;
          col *= min(uIgnite, 1.0) * flash;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    // Sides + bevel: dark hull that heats toward the front edge
    const sideMat = new THREE.ShaderMaterial({
      uniforms: { uTime, uIgnite: ignite, uZRange: { value: zRange } },
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        void main() {
          vPos = position;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewW = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIgnite;
        uniform vec2 uZRange;
        varying vec3 vPos;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        ${NOISE_GLSL}
        void main() {
          float t = clamp((vPos.z - uZRange.x) / (uZRange.y - uZRange.x), 0.0, 1.0);
          float turb = fbm(vec3(vPos.xy * 3.0, vPos.z * 5.0 - uTime * 2.2));
          float heat = pow(t, 2.2) * 0.8 + turb * 0.22 - 0.1;
          float rim = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewW))), 3.0);
          vec3 hull = vec3(0.035, 0.014, 0.006);
          vec3 col = hull + fireRamp(clamp(heat, 0.0, 1.0)) * 0.9 + vec3(1.0, 0.36, 0.05) * rim * 0.3;
          col *= min(uIgnite, 1.0);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    const mesh = new THREE.Mesh(geo, [faceMat, sideMat]);
    mesh.position.z = -2;
    titleGroup.add(mesh);
    letters.push({ mesh, ignite, delay: 0.25 + i * 0.16 });
  });

  buildEmbers(geometries, zRange.x);
  fitCamera();
}

// Afterburn embers: sampled from the letter surfaces, streaming back and outward
function buildEmbers(geometries, zBack) {
  const merged = mergeGeometries(
    geometries.map((g) => {
      const c = g.clone();
      c.clearGroups();
      return c;
    }),
    false
  );
  const sampler = new MeshSurfaceSampler(new THREE.Mesh(merged)).build();

  const starts = new Float32Array(EMBER_COUNT * 3);
  const rands = new Float32Array(EMBER_COUNT * 4);
  const p = new THREE.Vector3();
  for (let i = 0; i < EMBER_COUNT; i++) {
    sampler.sample(p);
    starts[i * 3] = p.x;
    starts[i * 3 + 1] = p.y;
    starts[i * 3 + 2] = Math.min(p.z, zBack + 0.05);
    for (let k = 0; k < 4; k++) rands[i * 4 + k] = Math.random();
  }
  merged.dispose();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(starts, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rands, 4));

  const embers = new THREE.Points(
    geo,
    new THREE.ShaderMaterial({
      uniforms: embersUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uIgnite;
        attribute vec4 aRand;
        varying float vLife;
        varying float vRand;
        void main() {
          float speed = 0.22 + aRand.x * 0.4;
          float life = fract(uTime * speed + aRand.y);
          vec3 p = position;
          float len = 2.2 + aRand.z * 4.0;
          p.z -= life * len;
          p.xy += position.xy * life * (0.12 + aRand.w * 0.16);  // flare outward
          p.y += life * life * (0.3 + aRand.w * 0.5);             // heat rise
          p.x += sin(uTime * 2.1 + aRand.y * 40.0 + life * 6.0) * 0.09 * life;
          p.y += cos(uTime * 1.7 + aRand.x * 40.0 + life * 5.0) * 0.09 * life;
          vLife = life;
          vRand = aRand.z;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = mix(4.5, 1.0, life) * (0.5 + aRand.x * 0.8);
          gl_PointSize = size * uPixelRatio * uIgnite * (7.0 / -mv.z);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vLife;
        varying float vRand;
        ${NOISE_GLSL}
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          float heat = (1.0 - vLife) * (0.75 + vRand * 0.3);
          vec3 col = fireRamp(heat) * 0.55;
          float fade = smoothstep(0.0, 0.06, vLife) * (1.0 - vLife);
          gl_FragColor = vec4(col * a * fade, 1.0);
        }
      `,
    })
  );
  embers.frustumCulled = false;
  titleGroup.add(embers);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

let baseDistance = 12;

function fitCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const widthFill = aspect < 1 ? 0.86 : 0.62;
  const distW = (titleWidth / 2 / widthFill) / (tanHalf * aspect);
  const distH = (titleHeight / 2 / 0.3) / tanHalf;
  baseDistance = Math.max(distW, distH);
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  uPixelRatio.value = renderer.getPixelRatio();
  bgUniforms.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  fitCamera();
}
window.addEventListener('resize', onResize);
onResize();

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

const pointer = new THREE.Vector2();
const pointerSmooth = new THREE.Vector2();
window.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
});
window.addEventListener('pointerleave', () => pointer.set(0, 0));

// Grab-and-rotate: drag the title to spin it. A throw coasts on its momentum and a
// damped spring carries it home to the front-facing angle it was already heading for;
// a gentle release snaps back to front with a little bounce.
const DRAG_SPEED = 0.009; // radians per pixel
const THROW_SPEED = 2; // rad/s; releases slower than this bounce back instead of gliding
const THROWN = { spring: 6, friction: 5, ramp: 0.8 }; // lands without bouncing; ramp lets it coast first
const BOUNCE = { spring: 24, friction: 4.4, ramp: 0.12 }; // ~20% overshoot, one small rebound
const SETTLE_BACK = 0.6; // rad; a throw that only coasts this far past front eases back to it
const TAU = Math.PI * 2;

const canvas = renderer.domElement;
canvas.style.touchAction = 'none';

const raycaster = new THREE.Raycaster();
const localRay = new THREE.Ray();
const ndc = new THREE.Vector2();
const invMatrix = new THREE.Matrix4();

const spin = { x: 0, y: 0 };
const spinVel = { x: 0, y: 0 };
const spinRest = { x: 0, y: 0 };
const drag = { id: null, x: 0, y: 0, time: 0 };
let sinceRelease = Infinity;
let spinFeel = BOUNCE;

function hitsTitle(e) {
  if (letters.length === 0) return false;
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  titleGroup.updateMatrixWorld();
  invMatrix.copy(titleGroup.matrixWorld).invert();
  localRay.copy(raycaster.ray).applyMatrix4(invMatrix);
  return localRay.intersectsBox(titleBox);
}

canvas.addEventListener('pointerdown', (e) => {
  if (drag.id !== null || !hitsTitle(e)) return;
  drag.id = e.pointerId;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.time = performance.now();
  spinVel.x = spinVel.y = 0;
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== drag.id) {
    if (drag.id === null) canvas.style.cursor = hitsTitle(e) ? 'grab' : '';
    return;
  }
  const now = performance.now();
  const dt = Math.max((now - drag.time) / 1000, 1 / 240);
  const yaw = (e.clientX - drag.x) * DRAG_SPEED;
  const pitch = (e.clientY - drag.y) * DRAG_SPEED;
  spin.y += yaw;
  spin.x += pitch;
  // blend toward instantaneous velocity so a flick carries momentum
  spinVel.y = THREE.MathUtils.lerp(spinVel.y, yaw / dt, 0.6);
  spinVel.x = THREE.MathUtils.lerp(spinVel.x, pitch / dt, 0.6);
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.time = now;
});

function endDrag(e) {
  if (e.pointerId !== drag.id) return;
  // a pause before release kills the flick
  if (performance.now() - drag.time > 80) spinVel.x = spinVel.y = 0;
  spinFeel = Math.hypot(spinVel.x, spinVel.y) >= THROW_SPEED ? THROWN : BOUNCE;
  spinRest.x = restAngle(spin.x, spinVel.x);
  spinRest.y = restAngle(spin.y, spinVel.y);
  drag.id = null;
  sinceRelease = 0;
  canvas.style.cursor = hitsTitle(e) ? 'grab' : '';
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// Pick the front-facing whole turn a release should come to rest on. A real throw lands
// on the next front in its direction of travel so the spring carries the momentum
// through rather than reversing it; a gentle release settles to the nearest front.
function restAngle(angle, velocity) {
  const coast = angle + velocity / spinFeel.friction; // where friction alone would stop it
  if (Math.abs(velocity) < THROW_SPEED) return Math.round(coast / TAU) * TAU;
  const dir = Math.sign(velocity);
  const passed = (dir > 0 ? Math.floor(coast / TAU) : Math.ceil(coast / TAU)) * TAU;
  return Math.abs(coast - passed) < SETTLE_BACK ? passed : passed + dir * TAU;
}

function updateSpin(dt) {
  if (drag.id !== null) return;
  sinceRelease += dt;
  const { spring, friction, ramp } = spinFeel;
  const k = spring * THREE.MathUtils.smoothstep(sinceRelease, 0, ramp);
  for (const axis of ['x', 'y']) {
    spinVel[axis] += (k * (spinRest[axis] - spin[axis]) - friction * spinVel[axis]) * dt;
    spin[axis] += spinVel[axis] * dt;
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
let titleStart = -1;

function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  uTime.value += dt * timeScale;
  const t = uTime.value;

  pointerSmooth.lerp(pointer, 1 - Math.pow(0.001, dt));
  bgUniforms.uMouse.value.copy(pointerSmooth);

  camera.position.set(pointerSmooth.x * 0.9, pointerSmooth.y * 0.5, baseDistance);
  camera.lookAt(0, 0, 0);

  updateSpin(dt);
  titleGroup.rotation.y = spin.y + Math.sin(t * 0.35) * 0.1;
  titleGroup.rotation.x = spin.x + Math.sin(t * 0.27) * 0.04;
  titleGroup.position.y = Math.sin(t * 0.6) * 0.04;

  if (titleStart >= 0) {
    const since = clock.elapsedTime - titleStart;
    for (const l of letters) {
      const k = THREE.MathUtils.clamp((since - l.delay) / 0.9, 0, 1);
      // ignite runs 0 -> 1.4: full brightness at 0.6+, a flash peaking at 1.0, settled at 1.4
      l.ignite.value = k * 1.4;
      l.mesh.position.z = -2 * (1 - easeOutCubic(k));
    }
    const last = letters[letters.length - 1];
    embersUniforms.uIgnite.value = THREE.MathUtils.clamp((since - last.delay) / 1.2, 0, 1);
  }

  composer.render();
});

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const status = document.getElementById('status');

new TTFLoader().load(
  FONT_URL,
  (json) => {
    buildTitle(new Font(json));
    titleStart = clock.elapsedTime;
    status.classList.add('hidden');
  },
  undefined,
  (err) => {
    console.error(err);
    status.textContent =
      location.protocol === 'file:'
        ? 'Serve over http — e.g. npx serve .'
        : 'Font failed to load';
  }
);
