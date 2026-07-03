import "./style.css";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { initGameSentry, sentryCanvasSnapshot } from "@genex-ai/embed-sdk/sentry";
import { initEmbed, waitForAuth } from "@genex-ai/embed-sdk";
import { GENEX } from "./genex.config";

// --- Identity + crash reporting FIRST, before any other game code ---
initGameSentry({ slug: GENEX.slug });
initEmbed({
  slug: GENEX.slug,
  apiUrl: GENEX.apiUrl,
  dashboardOrigins: GENEX.dashboardOrigins,
});

// Tiny DOM helper that never returns null (keeps strict TS happy).
const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error("missing " + sel);
  return el;
};

// --- Asset URLs (served from public/, so the "public/" prefix is dropped) ---
const SKYBOX_URL = "./assets/skybox/bright-clear-blue-sky-with-soft-white-clouds-sunny.jpg";
const FLOOR_TEX_URL = "./assets/textures/clean-checkered-stone-floor-tiles-light-and-dark-s/basecolor.png";
const BALL_TEX_URL = "./assets/textures/glossy-swirled-colorful-marble-vivid-blue-and-oran/basecolor.png";
const CHIME_URL = "./assets/sfx/cheerful-bright-coin-collect-chime-short-and-satis.mp3";
const STAR_MODEL_URL = "./assets/models/glowing-golden-five-point-star-smooth-rounded-shin.glb";

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const app = $<HTMLDivElement>("#app");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(0, 10, 16);

const listener = new THREE.AudioListener();
camera.add(listener);

// --- Sky as background + image-based lighting ---
new THREE.TextureLoader().load(SKYBOX_URL, (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
  scene.environment = tex;
});

// --- Lights ---
const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x35402a, 0.7);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(24, 42, 16);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 140;
sun.shadow.camera.left = -50;
sun.shadow.camera.right = 50;
sun.shadow.camera.top = 50;
sun.shadow.camera.bottom = -50;
sun.shadow.bias = -0.0004;
scene.add(sun);

// ---------------------------------------------------------------------------
// Course layout
// ---------------------------------------------------------------------------
type Platform = { x: number; z: number; w: number; d: number; top: number };

const PLATFORMS: Platform[] = [
  { x: 0, z: 0, w: 12, d: 12, top: 0 }, // start
  { x: 0, z: -9, w: 6, d: 6, top: 0 },
  { x: 0, z: -15, w: 6, d: 6, top: 0 },
  { x: 0, z: -21, w: 6, d: 6, top: 0 },
  // --- gap here (jump!) ---
  { x: 0, z: -33, w: 6, d: 6, top: 0 },
  { x: 6, z: -33, w: 6, d: 6, top: 0 },
  { x: 12, z: -33, w: 6, d: 6, top: 0 },
  { x: 18, z: -33, w: 6, d: 6, top: 0 },
  { x: 18, z: -39, w: 6, d: 6, top: 0 },
  { x: 18, z: -45, w: 6, d: 6, top: 0 },
  { x: 18, z: -53, w: 12, d: 12, top: 0 }, // goal
];

const GOAL = new THREE.Vector3(18, 0, -53);
const SPAWN = new THREE.Vector3(0, 0, 3);

const BALL_R = 0.7;

// --- Floor texture (cloned per platform so tile scale stays consistent) ---
const floorTexBase = new THREE.TextureLoader().load(FLOOR_TEX_URL, (t) => {
  t.colorSpace = THREE.SRGBColorSpace;
});

function makePlatform(p: Platform): void {
  const tex = floorTexBase.clone();
  tex.needsUpdate = true;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(Math.max(1, Math.round(p.w / 3)), Math.max(1, Math.round(p.d / 3)));

  const thickness = 1;
  const geo = new THREE.BoxGeometry(p.w, thickness, p.d);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.85,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(p.x, p.top - thickness / 2, p.z);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  scene.add(mesh);
}
PLATFORMS.forEach(makePlatform);

// ---------------------------------------------------------------------------
// The ball (player)
// ---------------------------------------------------------------------------
const ballTex = new THREE.TextureLoader().load(BALL_TEX_URL, (t) => {
  t.colorSpace = THREE.SRGBColorSpace;
});
const ballMesh = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 48, 32),
  new THREE.MeshStandardMaterial({
    map: ballTex,
    roughness: 0.28,
    metalness: 0.15,
  })
);
ballMesh.castShadow = true;
scene.add(ballMesh);

const ballPos = new THREE.Vector3(SPAWN.x, BALL_R, SPAWN.z);
const velocity = new THREE.Vector3(0, 0, 0);
ballMesh.position.copy(ballPos);

// ---------------------------------------------------------------------------
// Goal gate (a glowing golden ring you roll into)
// ---------------------------------------------------------------------------
const goalRing = new THREE.Mesh(
  new THREE.TorusGeometry(2.2, 0.28, 20, 48),
  new THREE.MeshStandardMaterial({
    color: 0xffd24a,
    emissive: 0xffab10,
    emissiveIntensity: 1.4,
    roughness: 0.3,
    metalness: 0.6,
  })
);
goalRing.position.set(GOAL.x, 2.6, GOAL.z);
scene.add(goalRing);
const goalGlow = new THREE.PointLight(0xffc23a, 6, 18, 2);
goalGlow.position.set(GOAL.x, 3, GOAL.z);
scene.add(goalGlow);

// ---------------------------------------------------------------------------
// Collectible stars
// ---------------------------------------------------------------------------
type Star = {
  group: THREE.Group;
  base: THREE.Vector3;
  phase: number;
  collected: boolean;
};

const STAR_BASES = [
  new THREE.Vector3(0, 1.5, -15),
  new THREE.Vector3(0, 1.5, -21),
  new THREE.Vector3(0, 2.2, -27), // floating over the gap — grab it mid-jump
  new THREE.Vector3(12, 1.5, -33),
  new THREE.Vector3(18, 1.5, -39),
  new THREE.Vector3(18, 1.5, -45),
];

const stars: Star[] = [];

// Placeholder star geometry (a real 5-point star) shown until the model loads.
function makePlaceholderStar(): THREE.Mesh {
  const shape = new THREE.Shape();
  const spikes = 5;
  const outer = 0.6;
  const inner = 0.26;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.2,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.06,
    bevelSegments: 2,
  });
  geo.center();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffcf33,
    emissive: 0xffa300,
    emissiveIntensity: 0.6,
    metalness: 0.4,
    roughness: 0.35,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

for (const base of STAR_BASES) {
  const group = new THREE.Group();
  group.position.copy(base);
  group.add(makePlaceholderStar());
  scene.add(group);
  stars.push({ group, base: base.clone(), phase: base.z, collected: false });
}

// Swap the placeholders for the real generated star model once it loads.
new GLTFLoader().load(
  STAR_MODEL_URL,
  (gltf: GLTF) => {
    // Normalize the model to roughly a 1.2-unit tall star.
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scaleTo = 1.4 / maxDim;

    for (const star of stars) {
      const model = gltf.scene.clone(true);
      model.scale.setScalar(scaleTo);
      model.traverse((child: THREE.Object3D) => {
        if ((child as THREE.Mesh).isMesh) child.castShadow = true;
      });
      star.group.clear();
      star.group.add(model);
    }
  },
  undefined,
  () => {
    // If the model fails to load, the placeholder stars stay — no crash.
  }
);

// ---------------------------------------------------------------------------
// Audio (collect chime)
// ---------------------------------------------------------------------------
let chimeBuffer: AudioBuffer | null = null;
new THREE.AudioLoader().load(CHIME_URL, (buffer) => {
  chimeBuffer = buffer;
});
function playChime(): void {
  if (!chimeBuffer) return;
  const sound = new THREE.Audio(listener);
  sound.setBuffer(chimeBuffer);
  sound.setVolume(0.55);
  sound.play();
}
function resumeAudio(): void {
  const ctx = listener.context;
  if (ctx.state === "suspended") void ctx.resume();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const hud = document.createElement("div");
hud.className = "hud";
hud.innerHTML = `
  <div class="hud__panel">
    <div class="hud__greet" id="greet">Marble Roll</div>
    <div class="hud__hint">Roll: W A S D / arrows &nbsp;·&nbsp; Space: jump</div>
    <div class="hud__hint">Collect the stars &nbsp;·&nbsp; reach the golden gate</div>
  </div>
  <div class="hud__stars" id="stars">⭐ 0 / ${stars.length}</div>
  <div class="hud__banner" id="banner"></div>
`;
document.body.appendChild(hud);
const starsLabel = $<HTMLDivElement>("#stars");
const banner = $<HTMLDivElement>("#banner");
const greet = $<HTMLDivElement>("#greet");

let collected = 0;
let won = false;

function updateStarsLabel(): void {
  starsLabel.textContent = `⭐ ${collected} / ${stars.length}`;
}

function showBanner(title: string, sub: string): void {
  banner.innerHTML = `${title}<small>${sub}</small>`;
  banner.classList.add("hud__banner--show");
}

// Greet the signed-in player by name (auth never blocks rendering).
waitForAuth()
  .then(({ user }) => {
    greet.textContent = `Rolling as ${user.name}`;
  })
  .catch(() => {
    /* SDK overlay handles blocked sign-in; nothing to do here */
  });

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set<string>();
const MOVE_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
];
window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (MOVE_KEYS.includes(e.code)) e.preventDefault();
  resumeAudio();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("pointerdown", resumeAudio);

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------
const GRAVITY = 28;
const MOVE_ACCEL = 46;
const MAX_SPEED = 15;
const JUMP_SPEED = 11;
const GROUND_DAMP = 4.2;
const AIR_DAMP = 0.35;
const FALL_Y = -24;

function platformUnder(px: number, pz: number): Platform | null {
  for (const p of PLATFORMS) {
    if (
      px >= p.x - p.w / 2 &&
      px <= p.x + p.w / 2 &&
      pz >= p.z - p.d / 2 &&
      pz <= p.z + p.d / 2
    ) {
      return p;
    }
  }
  return null;
}

function respawn(): void {
  ballPos.set(SPAWN.x, BALL_R, SPAWN.z);
  velocity.set(0, 0, 0);
}

const rollAxis = new THREE.Vector3();

function update(dt: number): void {
  // --- input direction (camera-relative: camera trails behind +Z) ---
  let ix = 0;
  let iz = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) iz -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) iz += 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
  const ilen = Math.hypot(ix, iz);
  if (ilen > 0) {
    ix /= ilen;
    iz /= ilen;
    velocity.x += ix * MOVE_ACCEL * dt;
    velocity.z += iz * MOVE_ACCEL * dt;
  }

  // clamp horizontal speed
  const hs = Math.hypot(velocity.x, velocity.z);
  if (hs > MAX_SPEED) {
    velocity.x *= MAX_SPEED / hs;
    velocity.z *= MAX_SPEED / hs;
  }

  // gravity + integrate
  velocity.y -= GRAVITY * dt;
  const prevY = ballPos.y;
  ballPos.x += velocity.x * dt;
  ballPos.y += velocity.y * dt;
  ballPos.z += velocity.z * dt;

  // ground contact
  let grounded = false;
  const p = platformUnder(ballPos.x, ballPos.z);
  if (p) {
    const surface = p.top + BALL_R;
    if (ballPos.y <= surface && prevY >= surface - 0.8 && velocity.y <= 0) {
      ballPos.y = surface;
      velocity.y = 0;
      grounded = true;
    }
  }

  // damping (more grip on the ground than in the air)
  const damp = Math.exp(-(grounded ? GROUND_DAMP : AIR_DAMP) * dt);
  velocity.x *= damp;
  velocity.z *= damp;

  // jump
  if (grounded && keys.has("Space")) {
    velocity.y = JUMP_SPEED;
    grounded = false;
  }

  // fell off the course
  if (ballPos.y < FALL_Y) respawn();

  ballMesh.position.copy(ballPos);

  // rolling look: spin the ball around the axis perpendicular to travel
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed > 0.02) {
    rollAxis.set(velocity.z, 0, -velocity.x).normalize();
    ballMesh.rotateOnWorldAxis(rollAxis, (speed * dt) / BALL_R);
  }

  // --- stars ---
  for (const star of stars) {
    if (star.collected) continue;
    star.group.rotation.y += dt * 2.2;
    star.group.position.y = star.base.y + Math.sin(elapsed * 3 + star.phase) * 0.22;
    if (ballPos.distanceTo(star.group.position) < BALL_R + 1.1) {
      star.collected = true;
      star.group.visible = false;
      collected += 1;
      updateStarsLabel();
      playChime();
    }
  }

  // --- goal ring ---
  goalRing.rotation.y += dt * 1.2;
  goalRing.rotation.z += dt * 0.6;
  if (!won) {
    const dx = ballPos.x - GOAL.x;
    const dz = ballPos.z - GOAL.z;
    if (Math.hypot(dx, dz) < 3.2) {
      won = true;
      const perfect = collected === stars.length;
      showBanner(
        "🏁 You made it!",
        perfect
          ? `Every star collected — a perfect run!`
          : `Stars collected: ${collected} / ${stars.length}`
      );
    }
  }

  // --- camera trails the ball ---
  const desired = tmpCam.set(ballPos.x, ballPos.y + 9, ballPos.z + 15);
  const followK = 1 - Math.exp(-6 * dt);
  camera.position.lerp(desired, followK);
  camera.lookAt(ballPos.x, ballPos.y + 1, ballPos.z);
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const tmpCam = new THREE.Vector3();
let elapsed = 0;

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  update(dt);
  renderer.render(scene, camera);
  sentryCanvasSnapshot(renderer.domElement);
}
animate();

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
