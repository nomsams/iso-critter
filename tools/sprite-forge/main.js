// Sprite Forge — loads a GLB/GLTF model and renders it at the game's exact
// isometric projection (2:1 dimetric: HW:HH = 16:8, from src/render/iso.js),
// so the PNGs it exports drop straight into assets/sprites/<name>_<ROT>.png
// with no post-hoc angle correction, unlike the Kenney reference art (see
// ANGLE_CORRECTION in src/render/sprites.js — that constant exists purely
// because Kenney's own camera does NOT hit 2:1, ours here is calibrated to).
//
// The camera angle is solved numerically (bisection against a live projected
// measurement), not hand-derived from trig — see solveElevation() below.
//
// Loaded as a classic (non-module) script, everything below wrapped in one
// async IIFE — NOT `type="module"` with static imports. Static module
// imports need a real origin (module-script fetches are CORS-mode; a
// double-clicked file:// page can't satisfy that even for its own sibling
// files), so this can't be a module if the tool is meant to open with no
// server. Dynamic import() doesn't have that restriction and works from any
// script, including a classic one — used here so Three.js can still load
// straight from the CDN, via the bare specifiers ('three', 'three/addons/…')
// the importmap in index.html maps to full URLs. That importmap is what lets
// this stay a bare specifier at all: GLTFLoader.js and OrbitControls.js each
// do their own internal `import ... from 'three'`, and since importmaps are
// document-scoped (not tied to the entry script being type="module"), the
// browser resolves those the same way it resolves this file's own import()
// calls — both need the map, and both get it. jsdelivr also serves
// `Access-Control-Allow-Origin: *` (verified), a wildcard that matches the
// opaque/null origin a file:// page sends, so the CORS-mode fetch behind
// import() succeeds even with no server. What none of this fixes is the
// "Load selected" dropdown below, which fetches a LOCAL .glb by path —
// fetching a sibling local file (not a remote CORS-friendly one) is a
// separate, harder browser restriction; drag-and-drop / the file picker
// sidestep it entirely since those read the file directly rather than
// fetching it by path, so they're left as the file://-safe way to load a
// model when this is opened with no server.
(async function () {
  "use strict";
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

const KNOWN_MODELS = [
  'bathroomCabinet', 'bathroomCabinetDrawer', 'bathroomMirror', 'bathroomSink', 'bathroomSinkSquare',
  'bathtub', 'bear', 'bedBunk', 'bedDouble', 'bedSingle', 'bench', 'benchCushion', 'benchCushionLow',
  'bookcaseClosed', 'bookcaseClosedDoors', 'bookcaseClosedWide', 'bookcaseOpen', 'bookcaseOpenLow', 'books',
  'cabinetBed', 'cabinetBedDrawer', 'cabinetBedDrawerTable', 'cabinetTelevision', 'cabinetTelevisionDoors',
  'cardboardBoxClosed', 'cardboardBoxOpen', 'ceilingFan', 'chair', 'chairCushion', 'chairDesk',
  'chairModernCushion', 'chairModernFrameCushion', 'chairRounded', 'coatRack', 'coatRackStanding',
  'computerKeyboard', 'computerMouse', 'computerScreen', 'desk', 'deskCorner', 'doorway', 'doorwayFront',
  'doorwayOpen', 'dryer', 'floorCorner', 'floorCornerRound', 'floorFull', 'floorHalf', 'hoodLarge',
  'hoodModern', 'kitchenBar', 'kitchenBarEnd', 'kitchenBlender', 'kitchenCabinet', 'kitchenCabinetCornerInner',
  'kitchenCabinetCornerRound', 'kitchenCabinetDrawer', 'kitchenCabinetUpper', 'kitchenCabinetUpperCorner',
  'kitchenCabinetUpperDouble', 'kitchenCabinetUpperLow', 'kitchenCoffeeMachine', 'kitchenFridge',
  'kitchenFridgeBuiltIn', 'kitchenFridgeLarge', 'kitchenFridgeSmall', 'kitchenMicrowave', 'kitchenSink',
  'kitchenStove', 'kitchenStoveElectric', 'lampRoundFloor', 'lampRoundTable', 'lampSquareCeiling',
  'lampSquareFloor', 'lampSquareTable', 'lampWall', 'laptop', 'loungeChair', 'loungeChairRelax',
  'loungeDesignChair', 'loungeDesignSofa', 'loungeDesignSofaCorner', 'loungeSofa', 'loungeSofaCorner',
  'loungeSofaLong', 'loungeSofaOttoman', 'paneling', 'pillow', 'pillowBlue', 'pillowBlueLong', 'pillowLong',
  'plantSmall1', 'plantSmall2', 'plantSmall3', 'pottedPlant', 'radio', 'rugDoormat', 'rugRectangle',
  'rugRound', 'rugRounded', 'rugSquare', 'shower', 'showerRound', 'sideTable', 'sideTableDrawers', 'speaker',
  'speakerSmall', 'stairs', 'stairsCorner', 'stairsOpen', 'stairsOpenSingle', 'stoolBar', 'stoolBarSquare',
  'table', 'tableCloth', 'tableCoffee', 'tableCoffeeGlass', 'tableCoffeeGlassSquare', 'tableCoffeeSquare',
  'tableCross', 'tableCrossCloth', 'tableGlass', 'tableRound', 'televisionAntenna', 'televisionModern',
  'televisionVintage', 'toaster', 'toilet', 'toiletSquare', 'trashcan', 'wall', 'wallCorner',
  'wallCornerRond', 'wallDoorway', 'wallDoorwayWide', 'wallHalf', 'wallWindow', 'wallWindowSlide', 'washer',
  'washerDryerStacked',
];

const ROT_FILES = ['SE', 'NE', 'NW', 'SW'];
const ROT_AZIMUTH_DEG = [45, 135, 225, 315]; // camera sits in that compass octant, looking back at the origin
const PX_PER_UNIT = 240; // export resolution; the game rescales on draw anyway (see drawSprite), this just needs to be crisp
const MAX_CANVAS = 2048;

// ---------------------------------------------------------------------------
// Calibration: find the camera elevation that makes a flat unit square,
// viewed from azimuth 45°, project to exactly a 2:1 (width:height) diamond —
// the same ratio src/render/iso.js's HW:HH (16:8) defines for the game's own
// tiles. Solved by bisection against Three's own projection math rather than
// assuming a fixed "isometric" angle, so this stays correct even if the
// game's tile ratio ever changes.
function measureDiamondRatio(elevationRad, azimuthRad) {
  const dir = new THREE.Vector3(
    Math.cos(elevationRad) * Math.sin(azimuthRad),
    Math.sin(elevationRad),
    Math.cos(elevationRad) * Math.cos(azimuthRad),
  );
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  cam.position.copy(dir).multiplyScalar(10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  const corners = [
    new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 0, -0.5),
    new THREE.Vector3(-0.5, 0, 0.5), new THREE.Vector3(0.5, 0, 0.5),
  ].map((v) => v.project(cam));
  const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return width / height;
}

function solveElevation(azimuthRad, targetRatio) {
  let lo = 0.001, hi = Math.PI / 2 - 0.001; // ratio falls monotonically from ~huge (grazing) to 1 (top-down)
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (measureDiamondRatio(mid, azimuthRad) > targetRatio) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const ELEVATION = solveElevation(Math.PI / 4, 2);
const ELEVATION_DEG = ELEVATION * 180 / Math.PI;

// ---------------------------------------------------------------------------
// Scene setup

const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// Export/preview camera: fixed calibrated orthographic projection, one of 4
// discrete compass rotations. This is what every screen pixel and every
// exported PNG comes from.
const isoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 200);

// Free-look inspector: a normal perspective camera + OrbitControls, only for
// looking a newly-loaded model over by eye. Never used for export.
const freeCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
freeCamera.position.set(3, 3, 3);
const orbit = new OrbitControls(freeCamera, renderer.domElement);
orbit.target.set(0, 0.5, 0);
orbit.enabled = false;

// Key light rides along with the iso camera (recomputed per rotation) so a
// piece looks lit from the same relative angle in every exported rotation —
// exactly what you'd get from a REAL fixed room light with the object itself
// spinning, which is the convention the game's fixed camera + rotating
// furniture actually needs. A non-rotating hemisphere light keeps shadows
// from ever going fully black.
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
scene.add(keyLight);
scene.add(new THREE.HemisphereLight(0xe8ecff, 0x2a2a30, 1.1));
scene.add(new THREE.AmbientLight(0xffffff, 0.25));

// ---------------------------------------------------------------------------
// Model wrapper: modelInner bakes the raw model's own bbox to "centered
// horizontally, resting on Y=0" once at load time; wrapper applies the live
// scale/offset controls on top, and sits at the footprint's own center so
// offx/offy/offz = 0 always means "centered on the declared footprint."
const wrapper = new THREE.Group();
const modelInner = new THREE.Group();
wrapper.add(modelInner);
scene.add(wrapper);
let currentModel = null;

// Footprint ground grid + outline — visual only, excluded from export.
const footprintGroup = new THREE.Group();
scene.add(footprintGroup);

// Critter scale reference — approximate, and deliberately not chasing false
// precision: the game has no "vertical grid unit" at all (walls, seat
// heights etc. are all authored directly in screen pixels — see WALL_H in
// iso.js, seatH on furniture defs — with no fixed px-per-world-unit ratio,
// since drawSprite() rescales each sprite's width to its own footprint and
// derives height from the art's own aspect ratio). And src/render/critter.js
// draws one rounded blob with ears, not a separate head/body. So: a single
// sphere, sized empirically against a loaded reference model (a 1x1 chair)
// rather than derived from an equation that doesn't actually exist.
const CRITTER_HEIGHT_UNITS = 0.55;
const CRITTER_SEAT_UNITS = 0.22;
const critterGroup = new THREE.Group();
scene.add(critterGroup);
buildCritterReference();

function buildCritterReference() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffb86b, roughness: 0.8, transparent: true, opacity: 0.85 });
  const h = CRITTER_HEIGHT_UNITS;
  const blob = new THREE.Mesh(new THREE.SphereGeometry(h * 0.5, 16, 12), mat);
  blob.scale.set(1, 0.92, 0.96);
  blob.position.y = h * 0.5;
  critterGroup.add(blob);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(h * 0.14, 8, 6), mat);
    ear.scale.set(0.7, 1.3, 0.6);
    ear.position.set(side * h * 0.3, h * 0.92, -h * 0.05);
    critterGroup.add(ear);
  }
  const seatLine = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.012, 0.02),
    new THREE.MeshBasicMaterial({ color: 0x4a7dff }),
  );
  seatLine.position.set(0, CRITTER_SEAT_UNITS, h * 0.34);
  critterGroup.add(seatLine);
}

function layoutFootprint(w, h) {
  footprintGroup.clear();
  const grid = new THREE.GridHelper(Math.max(w, h) * 2, Math.max(w, h) * 2, 0x4a7dff, 0x33354a);
  grid.position.set(w / 2, 0, h / 2);
  footprintGroup.add(grid);
  const pts = [
    new THREE.Vector3(0, 0.002, 0), new THREE.Vector3(w, 0.002, 0),
    new THREE.Vector3(w, 0.002, h), new THREE.Vector3(0, 0.002, h),
    new THREE.Vector3(0, 0.002, 0),
  ];
  const outline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x4a7dff }),
  );
  footprintGroup.add(outline);
  // mark the frontmost (nearest-camera) corner — the sprite's ground anchor
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff5f5f }));
  dot.userData.isAnchorDot = true;
  footprintGroup.add(dot);
}

// ---------------------------------------------------------------------------
// State

const state = {
  rotation: 0, // index into ROT_FILES
  fpW: 1, fpH: 1,
  scale: 1, offx: 0, offy: 0, offz: 0,
  margin: 0.06,
  showGrid: true, showCritter: true,
  freelook: false,
  exportName: '',
};

function currentAzimuthRad() {
  return ROT_AZIMUTH_DEG[state.rotation] * Math.PI / 180;
}

function cameraBasis(azimuthRad) {
  const dir = new THREE.Vector3(
    Math.cos(ELEVATION) * Math.sin(azimuthRad),
    Math.sin(ELEVATION),
    Math.cos(ELEVATION) * Math.cos(azimuthRad),
  );
  isoCamera.position.copy(dir).multiplyScalar(20);
  isoCamera.lookAt(0, 0, 0);
  isoCamera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(isoCamera.matrixWorld, 0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(isoCamera.matrixWorld, 1).normalize();
  return { right, up };
}

function boxCorners(box) {
  const { min, max } = box;
  return [
    [min.x, min.y, min.z], [max.x, min.y, min.z], [min.x, max.y, min.z], [min.x, min.y, max.z],
    [max.x, max.y, min.z], [max.x, min.y, max.z], [min.x, max.y, max.z], [max.x, max.y, max.z],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
}

/** Recompute wrapper transform + camera frustum for the current state. Runs
 *  on every control change and every rotation switch — cheap enough. */
function layout() {
  const { fpW, fpH } = state;
  wrapper.scale.setScalar(state.scale);
  wrapper.position.set(fpW / 2 + state.offx, state.offy, fpH / 2 + state.offz);
  layoutFootprint(fpW, fpH);
  footprintGroup.visible = state.showGrid;
  critterGroup.visible = state.showCritter;
  critterGroup.position.set(fpW / 2, 0, fpH + 0.6); // just past the footprint's far edge, for scale comparison
  // matrixWorld only auto-updates during render, one step behind the
  // transforms just set above — force it now so the Box3 measurements below
  // (which drive the camera frustum) see this call's values, not last call's.
  wrapper.updateMatrixWorld(true);
  critterGroup.updateMatrixWorld(true);

  const { right, up } = cameraBasis(currentAzimuthRad());
  const viewX = (p) => p.dot(right);
  const viewY = (p) => p.dot(up);

  const footCorners = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(fpW, 0, 0),
    new THREE.Vector3(0, 0, fpH), new THREE.Vector3(fpW, 0, fpH),
  ];
  let anchorCorner = footCorners[0], anchorY = Infinity;
  for (const c of footCorners) { const y = viewY(c); if (y < anchorY) { anchorY = y; anchorCorner = c; } }
  const anchorX = viewX(new THREE.Vector3(fpW / 2, 0, fpH / 2));

  const dot = footprintGroup.children.find((c) => c.userData.isAnchorDot);
  if (dot) dot.position.copy(anchorCorner);

  const extentPts = [...footCorners];
  let modelBox = null;
  if (currentModel) {
    modelBox = new THREE.Box3().setFromObject(wrapper);
    extentPts.push(...boxCorners(modelBox));
  }
  if (state.showCritter) extentPts.push(...boxCorners(new THREE.Box3().setFromObject(critterGroup)));

  let topY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const p of extentPts) {
    const y = viewY(p), x = viewX(p);
    if (y > topY) topY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const span = Math.max(topY - anchorY, 0.05);
  const halfW = Math.max(maxX - anchorX, anchorX - minX, 0.05) * (1 + state.margin);

  isoCamera.left = anchorX - halfW;
  isoCamera.right = anchorX + halfW;
  isoCamera.bottom = anchorY; // exact — this is the sprite's ground-contact edge, no padding
  isoCamera.top = anchorY + span * (1 + state.margin);
  isoCamera.updateProjectionMatrix();

  const w = Math.min(MAX_CANVAS, Math.max(8, Math.round((isoCamera.right - isoCamera.left) * PX_PER_UNIT)));
  const h = Math.min(MAX_CANVAS, Math.max(8, Math.round((isoCamera.top - isoCamera.bottom) * PX_PER_UNIT)));
  renderer.setSize(w, h, false);
  // Fit the actual stage pane, whatever size it happens to be — export
  // resolution (w,h above) stays full-res regardless of on-screen display size.
  const availW = Math.max(80, stage.clientWidth - 24);
  const availH = Math.max(80, stage.clientHeight - 24);
  const cssScale = Math.min(1, availH / h, availW / w);
  renderer.domElement.style.width = `${Math.round(w * cssScale)}px`;
  renderer.domElement.style.height = `${Math.round(h * cssScale)}px`;

  // warn (not silently clip) if the model actually reaches past the floor
  // anchor plane — sprites.js's convention has no slack for that
  let warning = '';
  if (modelBox && modelBox.min.y < -0.01) {
    warning = ' ⚠ model sits below the floor — raise vertical offset or check scale.';
  }
  document.getElementById('calib-readout').textContent =
    `elevation ${ELEVATION_DEG.toFixed(2)}° · azimuth ${(currentAzimuthRad() * 180 / Math.PI).toFixed(0)}° · ${w}×${h}px${warning}`;

  renderFrame();
}

function renderFrame() {
  const cam = state.freelook ? freeCamera : isoCamera;
  if (state.freelook) {
    freeCamera.aspect = renderer.domElement.width / renderer.domElement.height;
    freeCamera.updateProjectionMatrix();
    orbit.update();
  } else {
    // keep the key light fixed relative to the export camera, not the world
    const camDir = new THREE.Vector3().subVectors(isoCamera.position, new THREE.Vector3(0, 0, 0)).normalize();
    const lightDir = camDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.6).add(new THREE.Vector3(0, 0.4, 0));
    keyLight.position.copy(lightDir).multiplyScalar(10);
    keyLight.target.position.set(0, 0, 0);
    keyLight.target.updateMatrixWorld();
  }
  renderer.render(scene, cam);
}

// ---------------------------------------------------------------------------
// Loading

const loader = new GLTFLoader();

function loadFromUrl(url, name) {
  setStatus(`loading ${name}…`);
  loader.load(
    url,
    (gltf) => onModelLoaded(gltf, name),
    undefined,
    (err) => {
      // Opened straight off disk (no dev server), fetching a sibling local
      // file like this one just fails outright — a browser restriction
      // distinct from (and not fixed by) this file being a classic script.
      const noServer = location.protocol === 'file:';
      setStatus(
        noServer
          ? `can't fetch "${name}.glb" without a server — drag the .glb in instead (tools/sprite-forge/../../assets/kenney-furniture-kit/extracted/Models/GLTF format/${name}.glb), or run node dev-server.mjs`
          : `failed to load ${name}: ${err.message || err}`,
        true,
      );
    },
  );
}

function onModelLoaded(gltf, name) {
  modelInner.clear();
  const scene3d = gltf.scene;
  const rawBox = new THREE.Box3().setFromObject(scene3d);
  const center = rawBox.getCenter(new THREE.Vector3());
  scene3d.position.set(-center.x, -rawBox.min.y, -center.z);
  modelInner.add(scene3d);
  currentModel = scene3d;
  document.getElementById('export-name').value = name;
  state.exportName = name;
  applyAutoFit(); // Kenney's models come in at real-world meter scale, not grid-cell scale — almost never near 1:1 with the declared footprint, so start from a fit rather than leaving the model tiny/huge by default.
  updateReferencePane();
  layout();
  setStatus(`loaded ${name}`);
}

/** Scale so the model's own footprint (X/Z extent) just fills the declared
 *  W x H, and re-center/re-ground it — the natural starting point before
 *  hand-tuning. Re-run from the "Auto-fit" button too, e.g. after changing
 *  footprint cells. */
function applyAutoFit() {
  if (!currentModel) return;
  // modelInner itself is never transformed, but Box3.setFromObject measures
  // in WORLD space via each object's cached matrixWorld — the previous
  // model's leftover wrapper.scale would otherwise silently scale this "raw"
  // reading too. Zeroing wrapper.scale alone isn't enough: matrixWorld is
  // only recomputed lazily (normally during render), so it's still stale
  // right here unless forced.
  wrapper.scale.setScalar(1);
  wrapper.updateMatrixWorld(true);
  const rawSize = new THREE.Box3().setFromObject(modelInner).getSize(new THREE.Vector3());
  const fit = Math.min(state.fpW / (rawSize.x || 1), state.fpH / (rawSize.z || 1));
  state.scale = Number.isFinite(fit) && fit > 0 ? Math.min(6, Math.max(0.05, fit)) : 1;
  state.offx = 0; state.offy = 0; state.offz = 0;
  $('scale').value = state.scale; $('v-scale').textContent = state.scale.toFixed(2);
  $('offx').value = 0; $('offy').value = 0; $('offz').value = 0;
  $('v-offx').textContent = '0.00'; $('v-offy').textContent = '0.00'; $('v-offz').textContent = '0.00';
}

function loadFromFile(file) {
  const url = URL.createObjectURL(file);
  const name = file.name.replace(/\.(glb|gltf)$/i, '');
  setStatus(`loading ${file.name}…`);
  loader.load(
    url,
    (gltf) => { URL.revokeObjectURL(url); onModelLoaded(gltf, name); },
    undefined,
    (err) => { URL.revokeObjectURL(url); setStatus(`failed to load ${file.name}: ${err.message || err}`, true); },
  );
}

// ---------------------------------------------------------------------------
// UI wiring

const $ = (id) => document.getElementById(id);

function setStatus(msg, isErr = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = isErr ? 'err' : '';
}

// known-model select
const knownSelect = $('known-model');
for (const name of KNOWN_MODELS) {
  const opt = document.createElement('option');
  opt.value = name; opt.textContent = name;
  knownSelect.appendChild(opt);
}
knownSelect.value = 'chair';
$('load-known').addEventListener('click', () => {
  const name = knownSelect.value;
  const url = `/assets/kenney-furniture-kit/extracted/Models/${encodeURIComponent('GLTF format')}/${encodeURIComponent(name)}.glb`;
  loadFromUrl(url, name);
});

// file input + drag/drop
$('file-input').addEventListener('change', (e) => {
  if (e.target.files[0]) loadFromFile(e.target.files[0]);
});
const dropzone = $('dropzone');
['dragenter', 'dragover'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
  e.preventDefault(); dropzone.classList.add('drag');
}));
['dragleave', 'drop'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
  e.preventDefault(); dropzone.classList.remove('drag');
}));
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) loadFromFile(file);
});

$('export-name').addEventListener('input', (e) => { state.exportName = e.target.value.trim(); });

// footprint / placement controls
function bindNumber(id, key, onChange = layout) {
  $(id).addEventListener('input', (e) => { state[key] = Number(e.target.value); onChange(); });
}
bindNumber('fp-w', 'fpW');
bindNumber('fp-h', 'fpH');

function bindSlider(id, key, valueId, fmt = (v) => v.toFixed(2)) {
  const el = $(id), out = $(valueId);
  el.addEventListener('input', () => {
    state[key] = Number(el.value);
    if (out) out.textContent = fmt(state[key]);
    layout();
  });
}
bindSlider('scale', 'scale', 'v-scale');
bindSlider('offx', 'offx', 'v-offx');
bindSlider('offz', 'offz', 'v-offz');
bindSlider('offy', 'offy', 'v-offy');
// margin slider is authored 0-30 (percent); state.margin wants a 0-0.3 fraction
$('margin').value = state.margin * 100;
$('margin').addEventListener('input', (e) => {
  state.margin = Number(e.target.value) / 100;
  $('v-margin').textContent = `${e.target.value}%`;
  layout();
});

$('auto-center').addEventListener('click', () => { applyAutoFit(); layout(); });

$('show-grid').addEventListener('change', (e) => { state.showGrid = e.target.checked; layout(); });
$('show-critter').addEventListener('change', (e) => { state.showCritter = e.target.checked; layout(); });
$('freelook').addEventListener('change', (e) => {
  state.freelook = e.target.checked;
  orbit.enabled = state.freelook;
  $('freelook-badge').style.display = state.freelook ? 'block' : 'none';
  if (state.freelook && currentModel) {
    const box = new THREE.Box3().setFromObject(wrapper);
    const size = box.getSize(new THREE.Vector3()).length() || 2;
    freeCamera.position.set(size, size * 0.8, size);
    orbit.target.copy(box.getCenter(new THREE.Vector3()));
  }
  layout();
});

// compass buttons
const compassEl = $('compass');
ROT_FILES.forEach((label, i) => {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.title = `View from ${label}`;
  btn.addEventListener('click', () => setRotation(i));
  compassEl.appendChild(btn);
});
function setRotation(i) {
  state.rotation = i;
  [...compassEl.children].forEach((b, idx) => b.classList.toggle('active', idx === i));
  updateReferencePane();
  layout();
}
setRotation(0);

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowRight') setRotation((state.rotation + 1) & 3);
  if (e.key === 'ArrowLeft') setRotation((state.rotation + 3) & 3);
});

// free-look render loop (only needed while orbiting; iso view is static per-change)
function tick() {
  if (state.freelook) renderFrame();
  requestAnimationFrame(tick);
}
tick();

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layout, 80);
});

// ---------------------------------------------------------------------------
// Reference pane — Kenney's own pre-rendered sprite for the same model/rot,
// when the loaded model is one of the known set. Pure sanity-check aid.

function updateReferencePane() {
  const wrap = $('refimgwrap');
  const name = state.exportName;
  const rot = ROT_FILES[state.rotation];
  if (!name || !KNOWN_MODELS.includes(name)) {
    wrap.innerHTML = '<span id="refstatus">no reference for this model</span>';
    return;
  }
  const url = `/assets/kenney-furniture-kit/extracted/Isometric/${encodeURIComponent(name)}_${rot}.png`;
  wrap.innerHTML = '';
  const img = new Image();
  img.alt = `${name}_${rot} (Kenney reference)`;
  img.onerror = () => { wrap.innerHTML = '<span id="refstatus">no reference PNG found</span>'; };
  img.src = url;
  wrap.appendChild(img);
}

// ---------------------------------------------------------------------------
// Export

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function captureCurrentRotation() {
  const prevGrid = footprintGroup.visible, prevCritter = critterGroup.visible, prevFree = state.freelook;
  footprintGroup.visible = false;
  critterGroup.visible = false;
  state.freelook = false;
  renderFrame();
  return new Promise((resolve) => {
    renderer.domElement.toBlob((blob) => {
      footprintGroup.visible = prevGrid;
      critterGroup.visible = prevCritter;
      state.freelook = prevFree;
      renderFrame();
      resolve(blob);
    }, 'image/png');
  });
}

$('export-one').addEventListener('click', async () => {
  if (!currentModel) { setStatus('load a model first', true); return; }
  const name = state.exportName || 'sprite';
  const rot = ROT_FILES[state.rotation];
  const blob = await captureCurrentRotation();
  download(blob, `${name}_${rot}.png`);
  setStatus(`exported ${name}_${rot}.png`);
});

$('export-all').addEventListener('click', async () => {
  if (!currentModel) { setStatus('load a model first', true); return; }
  const name = state.exportName || 'sprite';
  const startRotation = state.rotation;
  for (let i = 0; i < ROT_FILES.length; i++) {
    setRotation(i);
    const blob = await captureCurrentRotation();
    download(blob, `${name}_${ROT_FILES[i]}.png`);
    setStatus(`exported ${name}_${ROT_FILES[i]}.png (${i + 1}/4)`);
    await new Promise((r) => setTimeout(r, 120)); // let each download start before the next
  }
  setRotation(startRotation);
  setStatus(`exported all 4 rotations for ${name}`);
});

setStatus(`ready — calibrated elevation ${ELEVATION_DEG.toFixed(2)}° for exact 2:1 tiles`);
layout();

// console debug hook — inspect live scene state while iterating on this tool
window.spriteForge = {
  scene, wrapper, footprintGroup, critterGroup, isoCamera, state, THREE, renderer,
  renderFrame, layout, captureCurrentRotation,
};
})();
