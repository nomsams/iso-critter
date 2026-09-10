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
// The game's fixed grid-to-pixel ratio (TILE_W in iso.js) — NOT a render
// setting, an object-independent constant. Since this tool's camera is
// calibrated to the game's exact 2:1 tile ratio, 1 world unit measures 32
// game px on EITHER axis, for any object, always. That makes it possible to
// preview a furniture def's `tall` cap exactly: drawSprite() in sprites.js
// draws with `ctx.drawImage(img, ..., dw, dh)`, and a `tall` below the
// sprite's natural height doesn't crop — drawImage stretches the WHOLE
// source into that box — so real furniture in this game is routinely
// squashed well short of a model's true proportions (chair: tall:10, vs.
// this game's critter standing about 20px tall — furniture here is
// typically shorter than the pet, not towering over it, the opposite of
// what real-world Kenney proportions alone would suggest).
const GAME_PX_PER_UNIT = 32;
const MAX_CANVAS = 2048;

// Same 4-direction indexing as RING_DIRS/DIRS in world.js and objects.js —
// 0:+gx  1:+gy  2:-gx  3:-gy — duplicated locally rather than imported since
// this is a standalone tool with no build step pulling in the game's own
// source. Mirrors adjacentCells() in objects.js: an object with a frontDir
// is only usable from that one side (fridge, bookshelf); one with a backDir
// is usable from every side but that one (TV); neither means every side
// works (workbench, plant, lamp, aquarium).
const RING_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const DIR_LABELS = ['+X (east)', '+Z (south)', '−X (west)', '−Z (north)'];
function validApproachSides() {
  if (state.approachMode === 'front') return [state.frontDir];
  if (state.approachMode === 'notback') return [0, 1, 2, 3].filter((d) => d !== state.frontDir);
  return [0, 1, 2, 3];
}
function facingAngle(dirIndex) {
  const [dx, dz] = RING_DIRS[dirIndex];
  return Math.atan2(dx, dz);
}

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

// Ground plane — a soft, generously-sized floor so there's always an
// unambiguous "this is Y=0" visual cue no matter how the model/critter are
// scaled or positioned. Separate from the footprint grid (which only marks
// the exact declared cell boundaries) and, like everything in this section,
// excluded from the actual PNG export.
const groundGroup = new THREE.Group();
scene.add(groundGroup);
const groundPlane = new THREE.Mesh(
  new THREE.CircleGeometry(1, 48),
  // Lighter than the page's own near-black background on purpose — a
  // ground plane close in tone to "no ground at all" defeats the entire
  // point of adding it (confirmed live: 0x232430 at 0.55 opacity was
  // numerically present, alpha channel and all, but unreadable next to the
  // page background it was meant to stand out from).
  new THREE.MeshBasicMaterial({ color: 0x4c5066, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
);
groundPlane.rotation.x = -Math.PI / 2;
groundPlane.position.y = -0.001; // a hair below everything else so it never z-fights the grid/shadows sitting at y=0
groundGroup.add(groundPlane);

// Footprint grid + outline — visual only, excluded from export.
const footprintGroup = new THREE.Group();
scene.add(footprintGroup);

// A soft dark ellipse directly under something, the same trick
// src/render/critter.js itself uses (PAL.shadow) — the cheapest, clearest
// way to read "this is standing ON the floor" regardless of camera angle,
// and independent of whether the main grid/ground extends that far.
function makeContactShadow(radiusX, radiusZ, opacity) {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(1, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.set(radiusX, radiusZ, 1);
  mesh.position.y = 0.001;
  return mesh;
}

// Critter scale reference — approximate, and deliberately not chasing false
// precision: the game has no "vertical grid unit" at all (walls, seat
// heights etc. are all authored directly in screen pixels — see WALL_H in
// iso.js, seatH on furniture defs — with no fixed px-per-world-unit ratio,
// since drawSprite() rescales each sprite's width to its own footprint and
// derives height from the art's own aspect ratio). And src/render/critter.js
// draws one rounded blob with ears, not a separate head/body. So: a single
// sphere, sized empirically against a loaded reference model (a 1x1 chair)
// rather than derived from an equation that doesn't actually exist.
//
// Pose mirrors the real distinction the game itself makes (see
// canOccupyObject / adjacentCells in src/world/objects.js): chairs, sofas
// and beds are occupiable — the critter's own footprint cell becomes the
// destination, so sit/lie sit the reference right on top of the model.
// Fridges, bookshelves, coffee machines etc. are ring-approached — used by
// standing in an adjacent cell — so reach/grab plants the critter beside the
// footprint instead, matching actions.js's goto(approachCells) + use(...,
// {pose:'reach'}) followed by hold(item) for fetch_food and its siblings.
const CRITTER_HEIGHT_UNITS = 0.55;
const critterGroup = new THREE.Group();
const critterPoseGroup = new THREE.Group(); // blob+ears live here; pose reshapes THIS, not critterGroup itself
critterGroup.add(critterPoseGroup);
scene.add(critterGroup);
let heldItemMesh = null;
buildCritterReference();

function buildCritterReference() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffb86b, roughness: 0.8, transparent: true, opacity: 0.9 });
  const h = CRITTER_HEIGHT_UNITS;
  critterGroup.add(makeContactShadow(h * 0.62, h * 0.46, 0.4));
  const blob = new THREE.Mesh(new THREE.SphereGeometry(h * 0.5, 16, 12), mat);
  blob.scale.set(1, 0.92, 0.96);
  blob.position.y = h * 0.5;
  critterPoseGroup.add(blob);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(h * 0.14, 8, 6), mat);
    ear.scale.set(0.7, 1.3, 0.6);
    ear.position.set(side * h * 0.3, h * 0.92, -h * 0.05);
    critterPoseGroup.add(ear);
  }
  // A facing marker — critterPoseGroup.rotation.y (set per pose in
  // layoutCritterPose) points this at whatever direction the critter is
  // meant to be looking, so "which way does it face" is something you can
  // actually see instead of having to trust a dropdown.
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(h * 0.09, h * 0.2, 8),
    new THREE.MeshStandardMaterial({ color: 0xe8935a, roughness: 0.8 }),
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, h * 0.55, h * 0.46);
  critterPoseGroup.add(nose);
  // The held item (see c.holding in creature.js: 'raw'/'meal'/'can'/'toy',
  // drawn above the head) — a plain small box stands in for any of them
  // here since this is about calibrating a GRAB HEIGHT, not the art.
  heldItemMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.09, 0.07),
    new THREE.MeshStandardMaterial({ color: 0x6f9bb5, roughness: 0.6 }),
  );
  critterGroup.add(heldItemMesh);
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
  // a shadow under the model itself, not just the critter — same grounding
  // cue, sized to the footprint so it reads as "this piece's own shadow"
  const modelShadow = new THREE.Mesh(
    new THREE.CircleGeometry(1, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
  );
  modelShadow.rotation.x = -Math.PI / 2;
  modelShadow.scale.set(w * 0.47, h * 0.47, 1);
  modelShadow.position.set(w / 2, 0.0015, h / 2);
  footprintGroup.add(modelShadow);
}

// ---------------------------------------------------------------------------
// State

const state = {
  rotation: 0, // index into ROT_FILES
  fpW: 1, fpH: 1,
  scale: 1, offx: 0, offy: 0, offz: 0,
  margin: 0.06, zoom: 1,
  tallCap: 0, // px, 0 = uncapped; mirrors the furniture def's own `tall` field
  showGrid: true, showCritter: true,
  freelook: false,
  exportName: '',
  // 'stand' next to the piece (pure scale reference, the original behaviour)
  // vs 'sit'/'lie' (on top of it — occupiable furniture) vs 'reach' (beside
  // it, holding an item — ring-approached furniture). See the comment above
  // buildCritterReference() for why these two placements differ.
  critterPose: 'stand',
  poseHeight: { sit: 0.24, lie: 0.09, reach: 0.32 },
  // Which side(s) of the footprint this piece can actually be used from —
  // 'all' (workbench/plant/lamp/aquarium), 'front' (fridge/bookshelf, only
  // frontDir), 'notback' (TV, every side but backDir). frontDir doubles as
  // the sit-facing direction (which way the critter looks once seated) since
  // sitting has no approach side of its own to speak of.
  approachMode: 'all',
  frontDir: 1,
  reachSide: 1,
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

/** Shapes and places the critter reference for the selected pose. Sit/lie
 *  sit it on top of the footprint (occupiable furniture — chairs, sofas,
 *  beds); reach/grab stands it beside the footprint holding an item
 *  (ring-approached furniture — fridges, bookshelves, coffee machines); the
 *  default stand keeps the original beside-the-piece scale reference. */
function layoutCritterPose(fpW, fpH) {
  const h = CRITTER_HEIGHT_UNITS;
  critterPoseGroup.rotation.set(0, 0, 0);
  critterPoseGroup.scale.set(1, 1, 1);
  critterPoseGroup.position.set(0, 0, 0);
  heldItemMesh.visible = false;

  if (state.critterPose === 'sit') {
    const seatY = state.poseHeight.sit;
    critterPoseGroup.scale.set(1.08, 0.62, 1.05); // squashed down onto the seat, same idea as pose==='sit' in critter.js
    critterPoseGroup.rotation.y = facingAngle(state.frontDir); // faces the piece's own open/front side, same as a chair's state.face
    critterGroup.position.set(fpW / 2, seatY, fpH / 2);
  } else if (state.critterPose === 'lie') {
    const lieY = state.poseHeight.lie;
    critterPoseGroup.rotation.z = Math.PI / 2; // on its side
    critterPoseGroup.scale.set(0.62, 1.35, 1.05);
    critterGroup.position.set(fpW / 2, lieY + h * 0.28, fpH / 2);
  } else if (state.critterPose === 'reach') {
    // Only stand somewhere this piece can actually be used from — a fridge
    // with approachMode 'front' has exactly one valid side (its frontDir);
    // reachSide is clamped into whatever's valid every time this runs, so
    // switching mode/frontDir can never leave the preview parked on a side
    // the real game would never route a critter to (the back of a fridge).
    const valid = validApproachSides();
    if (!valid.includes(state.reachSide)) state.reachSide = valid[0];
    const [dx, dz] = RING_DIRS[state.reachSide];
    const gap = 0.32;
    const px = dx !== 0 ? (dx > 0 ? fpW + gap : -gap) : fpW / 2;
    const pz = dz !== 0 ? (dz > 0 ? fpH + gap : -gap) : fpH / 2;
    critterGroup.position.set(px, 0, pz);
    critterPoseGroup.rotation.y = facingAngle((state.reachSide + 2) & 3); // faces back toward the piece it's standing beside
    heldItemMesh.visible = true;
    heldItemMesh.position.set(-dx * 0.22, state.poseHeight.reach, -dz * 0.22); // toward the object from wherever the critter's standing
  } else {
    critterGroup.position.set(fpW / 2, 0, fpH + 0.32); // just past the footprint's far edge, for scale comparison
  }
}

/** Mirrors the game's own `tall` cap exactly: drawSprite() in sprites.js
 *  stretches the WHOLE image into a shorter box when the natural height
 *  exceeds `tall` (ctx.drawImage with an explicit dh squashes, it doesn't
 *  crop) — so a furniture def's tall value routinely renders real-proportioned
 *  Kenney models much shorter in-game than the raw model actually is. Applying
 *  that same squash here is what makes this tool's preview actually predict
 *  the in-game result instead of just showing the model's real-world
 *  proportions next to the critter.
 *
 *  Preview only, deliberately — never called before the frustum is fixed for
 *  this layout(), and always undone before an actual export capture. The
 *  exported PNG has to keep the model's true unsquashed proportions: the
 *  squash belongs to whatever `tall` the furniture def ends up with in-game,
 *  applied fresh by sprites.js at draw time, not baked in twice. Returns the
 *  natural (pre-squash) height in game px, for the calibration readout. */
function applyTallCapSquash() {
  if (!currentModel) return 0;
  const box = new THREE.Box3().setFromObject(wrapper);
  const naturalPx = (box.max.y - box.min.y) * GAME_PX_PER_UNIT;
  if (state.tallCap && naturalPx > state.tallCap && naturalPx > 0) {
    wrapper.scale.y *= state.tallCap / naturalPx;
  }
  return naturalPx;
}

/** Recompute wrapper transform + camera frustum for the current state. Runs
 *  on every control change and every rotation switch — cheap enough. */
function layout() {
  const { fpW, fpH } = state;
  wrapper.scale.setScalar(state.scale);
  wrapper.position.set(fpW / 2 + state.offx, state.offy, fpH / 2 + state.offz);
  layoutFootprint(fpW, fpH);
  footprintGroup.visible = state.showGrid;
  groundGroup.visible = state.showGrid;
  const groundR = Math.max(fpW, fpH) * 3 + 3;
  groundPlane.scale.set(groundR, groundR, 1);
  groundPlane.position.set(fpW / 2, -0.001, fpH / 2);
  critterGroup.visible = state.showCritter;
  layoutCritterPose(fpW, fpH);
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

  // Only the footprint + the actual model decide the frustum — this is what
  // ends up in the export, so it's what "correctly framed" has to mean. The
  // 'stand'/'reach' critter deliberately sits OUTSIDE the footprint, off to
  // one side (so it reads as a separate thing standing next to the piece,
  // not part of it), which used to blow the frustum wide open: forcing it
  // symmetric around the footprint's own center turned one lopsided extra
  // object into wasted space on both sides at once. It stays excluded here
  // for exactly that reason — a preview-only aid clipping slightly at
  // extreme zoom is a fair trade for the export never being at the mercy of
  // where a reference prop happens to stand. 'sit'/'lie', though, place it
  // dead center ON the footprint (that's the whole point — checking it
  // against the piece), so including them can only make the view taller,
  // never lopsided, and doing so keeps a tall sit/lie pose from clipping.
  const extentPts = [...footCorners];
  let modelBox = null;
  if (currentModel) {
    modelBox = new THREE.Box3().setFromObject(wrapper);
    extentPts.push(...boxCorners(modelBox));
  }
  if (state.showCritter && (state.critterPose === 'sit' || state.critterPose === 'lie')) {
    extentPts.push(...boxCorners(new THREE.Box3().setFromObject(critterGroup)));
  }

  let topY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const p of extentPts) {
    const y = viewY(p), x = viewX(p);
    if (y > topY) topY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const zoom = state.zoom || 1;
  const span = Math.max(topY - anchorY, 0.05) * (1 + state.margin) / zoom;
  const halfW = Math.max(maxX - anchorX, anchorX - minX, 0.05) * (1 + state.margin) / zoom;

  isoCamera.left = anchorX - halfW;
  isoCamera.right = anchorX + halfW;
  isoCamera.bottom = anchorY; // exact — this is the sprite's ground-contact edge, no padding
  isoCamera.top = anchorY + span;
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
  // Applied last, after every frustum/canvas-size measurement above is
  // already locked in from the model's TRUE bounds — see applyTallCapSquash().
  const naturalPx = applyTallCapSquash();
  const tallInfo = currentModel
    ? state.tallCap
      ? ` · natural ${Math.round(naturalPx)}px → tall:${state.tallCap} squashes to ${Math.round(Math.min(naturalPx, state.tallCap))}px`
      : ` · natural height ${Math.round(naturalPx)}px uncapped (game furniture is typically tall:10-30)`
    : '';
  document.getElementById('calib-readout').textContent =
    `elevation ${ELEVATION_DEG.toFixed(2)}° · azimuth ${(currentAzimuthRad() * 180 / Math.PI).toFixed(0)}° · ${w}×${h}px${warning}${tallInfo}`;

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
  state.tallCap = 0; $('tallcap').value = 0; $('v-tallcap').textContent = 'off'; // a cap tuned for the last model means nothing for this one
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
  resetPoseHeightsToModel(rawSize.y * state.scale);
}

/** A fixed default seat/lie/grab height is wrong as often as it's right —
 *  a bar stool and a bed are both "furniture," off by 5x in height. Rescale
 *  the three pose heights against THIS model's own fitted height so the
 *  critter starts out roughly at the right level instead of buried inside
 *  a tall piece or floating over a short one (confirmed live: a bed ~0.67
 *  units tall left the fixed 0.09 lie-height completely hidden inside the
 *  mattress). Runs on every load/re-fit, so it always tracks the current
 *  model — hand-tuned values only survive within that same model's session. */
function resetPoseHeightsToModel(fittedHeight) {
  const h = Math.max(0.02, fittedHeight || 0.3);
  state.poseHeight.sit = +(h * 0.42).toFixed(2);
  state.poseHeight.lie = +(h * 0.8).toFixed(2);
  state.poseHeight.reach = +(h * 0.55).toFixed(2);
  const info = POSE_INFO[state.critterPose];
  if (info?.height) {
    const slider = $('pose-height');
    slider.max = Math.max(1, h * 1.3).toFixed(2);
    slider.value = state.poseHeight[info.height.key];
    $('v-pose-height').textContent = state.poseHeight[info.height.key].toFixed(2);
  }
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

// known-model search box (a datalist-backed <input>, not a 140-item <select>
// no one wants to scroll — type-to-filter is native, no JS filtering needed)
const knownInput = $('known-model');
const knownList = $('known-model-list');
for (const name of KNOWN_MODELS) {
  const opt = document.createElement('option');
  opt.value = name;
  knownList.appendChild(opt);
}
knownInput.value = 'chair';

function loadTypedKnownModel() {
  const typed = knownInput.value.trim();
  const name = KNOWN_MODELS.includes(typed)
    ? typed
    : KNOWN_MODELS.find((n) => n.toLowerCase() === typed.toLowerCase());
  if (!name) {
    setStatus(`"${typed}" isn't one of the bundled Kenney models — pick a suggestion from the list, or drag in your own .glb instead`, true);
    return;
  }
  knownInput.value = name;
  const url = `/assets/kenney-furniture-kit/extracted/Models/${encodeURIComponent('GLTF format')}/${encodeURIComponent(name)}.glb`;
  loadFromUrl(url, name);
}
$('load-known').addEventListener('click', loadTypedKnownModel);
knownInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadTypedKnownModel(); });

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
bindSlider('tallcap', 'tallCap', 'v-tallcap', (v) => (v > 0 ? `${v}px` : 'off'));
bindSlider('zoom', 'zoom', 'v-zoom', (v) => `${v.toFixed(2)}×`);
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

// Critter pose — see layoutCritterPose() for what each one actually does.
const POSE_INFO = {
  stand: { explainer: "Beside the piece — same as the scale reference, just named for what it's checking.", height: null },
  sit: {
    explainer: 'On top of the footprint, like a chair/sofa (an occupiable piece — the game targets the cell itself, not a ring around it). Dial the height to match the model\'s actual seat, then use that value for seatH on the furniture def.',
    height: { key: 'sit', label: 'Seat height', min: 0, max: 1 },
  },
  lie: {
    explainer: "On top of the footprint, like a bed. Dial the height to match the mattress top.",
    height: { key: 'lie', label: 'Lie height', min: 0, max: 0.6 },
  },
  reach: {
    explainer: "Beside the footprint, like a fridge/bookshelf/coffee machine (ring-approached — goto(approachCells) then use(...,{pose:'reach'}) in actions.js). The small block is the held item (c.holding in creature.js) — dial its height to where a grabbed item should appear.",
    height: { key: 'reach', label: 'Grab height', min: 0, max: 1 },
  },
};
function setCritterPose(pose) {
  state.critterPose = pose;
  for (const btn of $('pose-buttons').children) btn.classList.toggle('active', btn.dataset.pose === pose);
  const info = POSE_INFO[pose];
  $('pose-explainer').textContent = info.explainer;
  const heightRow = $('pose-height-row');
  if (info.height) {
    heightRow.hidden = false;
    $('pose-height-label').textContent = info.height.label;
    $('pose-height').min = info.height.min;
    $('pose-height').max = info.height.max;
    $('pose-height').value = state.poseHeight[info.height.key];
    $('v-pose-height').textContent = state.poseHeight[info.height.key].toFixed(2);
  } else {
    heightRow.hidden = true;
  }
  refreshApproachUI();
  layout();
}
for (const btn of $('pose-buttons').children) {
  btn.addEventListener('click', () => setCritterPose(btn.dataset.pose));
}
$('pose-height').addEventListener('input', (e) => {
  const key = POSE_INFO[state.critterPose].height.key;
  state.poseHeight[key] = Number(e.target.value);
  $('v-pose-height').textContent = state.poseHeight[key].toFixed(2);
  layout();
});

// Approach direction — which side(s) this piece can be used from, and (for
// reach/grab) which of those valid sides is currently being previewed. See
// validApproachSides()/RING_DIRS above: this mirrors frontDir/backDir on the
// actual furniture def, not a UI convenience invented for this tool alone.
const APPROACH_HINTS = {
  all: 'Matches adjacentCells() in objects.js: no frontDir/backDir on the def means every side works — workbench, plant, lamp, aquarium.',
  front: "Matches a def with frontDir set: usable from exactly one side — fridge (door swings toward the room), bookshelf, a stand-and-use toilet. The back is never valid, on purpose.",
  notback: 'Matches a def with backDir set: usable from every side except one — TV (any side but behind the screen).',
};
function refreshApproachUI() {
  const dirButtons = $('frontdir-buttons');
  dirButtons.style.opacity = state.approachMode === 'all' ? 0.4 : 1;
  for (const btn of dirButtons.children) btn.disabled = state.approachMode === 'all';
  $('approach-hint').textContent = APPROACH_HINTS[state.approachMode];

  const reachRow = $('reach-side-row');
  if (state.critterPose === 'reach') {
    reachRow.hidden = false;
    const valid = validApproachSides();
    if (!valid.includes(state.reachSide)) state.reachSide = valid[0];
    $('reach-side-label').textContent =
      `${DIR_LABELS[state.reachSide]}${valid.length < 4 ? ` (${valid.length}/4 sides valid)` : ''}`;
  } else {
    reachRow.hidden = true;
  }
}
for (const btn of $('approach-mode-buttons').children) {
  btn.addEventListener('click', () => {
    state.approachMode = btn.dataset.mode;
    for (const b of $('approach-mode-buttons').children) b.classList.toggle('active', b === btn);
    refreshApproachUI();
    layout();
  });
}
for (const btn of $('frontdir-buttons').children) {
  btn.addEventListener('click', () => {
    state.frontDir = Number(btn.dataset.dir);
    for (const b of $('frontdir-buttons').children) b.classList.toggle('active', b === btn);
    refreshApproachUI();
    layout();
  });
}
function cycleReachSide(delta) {
  const valid = validApproachSides();
  const i = valid.indexOf(state.reachSide);
  state.reachSide = valid[(i + delta + valid.length) % valid.length];
  refreshApproachUI();
  layout();
}
$('reach-side-prev').addEventListener('click', () => cycleReachSide(-1));
$('reach-side-next').addEventListener('click', () => cycleReachSide(1));
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
  const prevGrid = footprintGroup.visible, prevGround = groundGroup.visible,
    prevCritter = critterGroup.visible, prevFree = state.freelook;
  const prevScaleY = wrapper.scale.y; // undo any tall-cap preview squash — never export it, see applyTallCapSquash()
  footprintGroup.visible = false;
  groundGroup.visible = false;
  critterGroup.visible = false;
  state.freelook = false;
  wrapper.scale.y = state.scale;
  renderFrame();
  return new Promise((resolve) => {
    renderer.domElement.toBlob((blob) => {
      footprintGroup.visible = prevGrid;
      groundGroup.visible = prevGround;
      critterGroup.visible = prevCritter;
      state.freelook = prevFree;
      wrapper.scale.y = prevScaleY;
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
  scene, wrapper, footprintGroup, groundGroup, critterGroup, critterPoseGroup, heldItemMesh,
  isoCamera, state, THREE, renderer, renderFrame, layout, captureCurrentRotation, setCritterPose,
  validApproachSides, cycleReachSide, applyTallCapSquash,
};
})();
