import "./style.css";
import birdSpriteUrl from "./assets/LangChain_Symbol_White.png";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="comparison">
    <div class="panel" style="width: 100%; max-width: 100%;">
      <div class="art-box" id="prop-box" style="position: relative;">
        <div id="art-stage">
          <div id="text-layer"></div>
          <canvas id="source-canvas" style="display: none;"></canvas>
        </div>
      </div>
    </div>
  </div>
  <img id="bird-sprite" src="${birdSpriteUrl}" style="display: none;" alt="" />
`;

const COLS = 160;
const ROWS = 80;
const FONT_SIZE = 9;
const LINE_HEIGHT = 10;
const TARGET_CELL_W = 6;
const TARGET_ROW_W = COLS * TARGET_CELL_W;
const ART_W = TARGET_ROW_W;
const ART_H = ROWS * LINE_HEIGHT;
const BRAILLE_FAMILY = '"SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';
const CELL_SAMPLE_X = 2;
const CELL_SAMPLE_Y = 4;
const FIELD_COLS = COLS * CELL_SAMPLE_X;
const FIELD_ROWS = ROWS * CELL_SAMPLE_Y;
const PARTICLE_N = 5;
const SPRITE_R = 48;
const ATTRACTOR_R = 12;
const LARGE_ATTRACTOR_R = 30;
const FIELD_EMPTY_THRESHOLD = 0.045;
const BRAILLE_DOT_THRESHOLD = 0.14;
const SPRITE_FIELD_GAIN = 0.92;
const SPRITE_BASE_ANGLE = Math.PI / 2;

// Keep the simulation in the same intrinsic coordinate space as the text grid.
let CANVAS_W = ART_W;
let CANVAS_H = ART_H;
let FIELD_SCALE_X = FIELD_COLS / CANVAS_W;
let FIELD_SCALE_Y = FIELD_ROWS / CANVAS_H;

// Tunable parameters (mutable for UI)
let ATTRACTOR_FORCE_1 = 0.1;
let ATTRACTOR_FORCE_2 = 0.05;
let SEPARATION_RADIUS = 135;
let ALIGNMENT_RADIUS = 50;
let COHESION_RADIUS = 60;
let SEPARATION_FORCE = 0.53;
let ALIGNMENT_FORCE = 0.04;
let COHESION_FORCE = 0.02;
let MAX_SPEED = 3.5;
let MIN_SPEED = 0.8;
let SPRITE_ANGLE_TRIM = (-30 * Math.PI) / 180;
let BIRD_TRAIL_DECAY = 0.78;
let ATTRACTOR_TRAIL_DECAY = 0.99;
let BIRD_TRAIL_GAIN = 0.35;
let ATTRACTOR_TRAIL_GAIN = 1.1;

type Rgb = {
  r: number;
  g: number;
  b: number;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
};

type FieldStamp = {
  radiusX: number;
  radiusY: number;
  sizeX: number;
  sizeY: number;
  values: Float32Array;
};

const BIRD_COLOR = { r: 127, g: 200, b: 255 };
const ATTRACTOR_1_STOPS: readonly Rgb[] = [
  { r: 246, g: 255, b: 219 },
  { r: 227, g: 255, b: 143 },
  { r: 46, g: 57, b: 0 },
  { r: 110, g: 137, b: 0 },
];
const ATTRACTOR_2_STOPS: readonly Rgb[] = [
  { r: 235, g: 208, b: 240 },
  { r: 199, g: 142, b: 173 },
  { r: 68, g: 30, b: 51 },
  { r: 136, g: 82, b: 112 },
];

function getRequiredDiv(id: string): HTMLDivElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLDivElement)) throw new Error(`#${id} not found`);
  return element;
}

const BRAILLE_BIT_BY_SAMPLE: readonly number[][] = [
  [0x1, 0x8],
  [0x2, 0x10],
  [0x4, 0x20],
  [0x40, 0x80],
];

const particles: Particle[] = [];
for (let index = 0; index < PARTICLE_N; index++) {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.random() * 40 + 20;
  const speed = Math.random() * 0.5 + 1;
  particles.push({
    x: CANVAS_W / 2 + Math.cos(angle) * radius,
    y: CANVAS_H / 2 + Math.sin(angle) * radius,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    angle: angle,
  });
}

// Load bird sprite from HTML element
let birdImage: HTMLImageElement | null = null;
let birdSpriteSource: CanvasImageSource | null = null;
let birdLoaded = false;

async function finalizeBirdSpriteLoad(): Promise<void> {
  if (!birdImage) return;
  try {
    if ("decode" in birdImage) await birdImage.decode();
  } catch (error) {
    console.warn("Bird image decode reported an error, continuing with existing pixels.", error);
  }

  if ("createImageBitmap" in window) {
    birdSpriteSource = await createImageBitmap(birdImage);
  } else {
    birdSpriteSource = birdImage;
  }

  birdLoaded = true;
  console.log("Bird sprite ready:", birdImage.naturalWidth, "x", birdImage.naturalHeight);
  buildRotatedSpriteLUT();
}

function initBirdSprite(): void {
  birdImage = document.getElementById("bird-sprite") as HTMLImageElement | null;
  if (!birdImage) {
    console.error("Bird sprite element not found");
    return;
  }
  birdLoaded = false;
  if (birdImage.complete && birdImage.naturalWidth > 0) {
    void finalizeBirdSpriteLoad();
  } else {
    birdImage.onload = () => {
      void finalizeBirdSpriteLoad();
    };
    birdImage.onerror = (e) => {
      console.error("Bird image failed to load", e);
    };
  }
}

initBirdSprite();

// Rotated sprite LUT
let ROTATION_STEPS = 16;
let rotatedSprites: HTMLCanvasElement[] = [];
let rotatedSpriteFieldStamps: FieldStamp[] = [];

function buildRotatedSpriteLUT(): void {
  if (!birdLoaded || !birdSpriteSource) return;
  const size = SPRITE_R * 2;
  rotatedSprites = [];
  rotatedSpriteFieldStamps = [];
  for (let i = 0; i < ROTATION_STEPS; i++) {
    const angle = (i / ROTATION_STEPS) * Math.PI * 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (context === null) continue;
    context.translate(size / 2, size / 2);
    context.rotate(angle + SPRITE_BASE_ANGLE + SPRITE_ANGLE_TRIM);
    context.drawImage(birdSpriteSource, -size / 2, -size / 2, size, size);
    rotatedSprites.push(canvas);
    rotatedSpriteFieldStamps.push(createCanvasFieldStamp(canvas, SPRITE_FIELD_GAIN));
  }
}

function angleToSpriteIndex(angle: number): number {
  if (rotatedSprites.length === 0) return -1;
  const step = (Math.PI * 2) / rotatedSprites.length;
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.round(normalized / step) % rotatedSprites.length;
}

function angleToSprite(angle: number): HTMLCanvasElement | null {
  const index = angleToSpriteIndex(angle);
  return index < 0 ? null : rotatedSprites[index]!;
}

function angleToSpriteFieldStamp(angle: number): FieldStamp | null {
  const index = angleToSpriteIndex(angle);
  return index < 0 ? null : rotatedSpriteFieldStamps[index]!;
}

const birdBrightnessField = new Float32Array(FIELD_COLS * FIELD_ROWS);
const attractor1BrightnessField = new Float32Array(FIELD_COLS * FIELD_ROWS);
const attractor2BrightnessField = new Float32Array(FIELD_COLS * FIELD_ROWS);

const spriteCache = new Map<number, HTMLCanvasElement>();

function getSpriteCanvas(radius: number): HTMLCanvasElement {
  const cached = spriteCache.get(radius);
  if (cached !== undefined) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = radius * 2;
  canvas.height = radius * 2;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("sprite context not available");
  const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, "rgba(255,255,255,0.45)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.15)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, radius * 2, radius * 2);
  spriteCache.set(radius, canvas);
  return canvas;
}

function spriteAlphaAt(normalizedDistance: number): number {
  if (normalizedDistance >= 1) return 0;
  if (normalizedDistance <= 0.35) return 0.45 + (0.15 - 0.45) * (normalizedDistance / 0.35);
  return 0.15 * (1 - (normalizedDistance - 0.35) / 0.65);
}

function createRadialFieldStamp(radiusPx: number): FieldStamp {
  const fieldRadiusX = radiusPx * FIELD_SCALE_X;
  const fieldRadiusY = radiusPx * FIELD_SCALE_Y;
  const radiusX = Math.ceil(fieldRadiusX);
  const radiusY = Math.ceil(fieldRadiusY);
  const sizeX = radiusX * 2 + 1;
  const sizeY = radiusY * 2 + 1;
  const values = new Float32Array(sizeX * sizeY);
  for (let y = -radiusY; y <= radiusY; y++) {
    for (let x = -radiusX; x <= radiusX; x++) {
      const normalizedDistance = Math.sqrt((x / fieldRadiusX) ** 2 + (y / fieldRadiusY) ** 2);
      values[(y + radiusY) * sizeX + x + radiusX] = spriteAlphaAt(normalizedDistance);
    }
  }
  return { radiusX, radiusY, sizeX, sizeY, values };
}

function createCanvasFieldStamp(canvas: HTMLCanvasElement, alphaScale: number): FieldStamp {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("sprite field context not available");
  const { width, height } = canvas;
  const imageData = context.getImageData(0, 0, width, height).data;
  const radiusX = Math.ceil((width * FIELD_SCALE_X) / 2);
  const radiusY = Math.ceil((height * FIELD_SCALE_Y) / 2);
  const sizeX = radiusX * 2 + 1;
  const sizeY = radiusY * 2 + 1;
  const values = new Float32Array(sizeX * sizeY);
  for (let y = 0; y < sizeY; y++) {
    const sourceY = Math.min(height - 1, Math.max(0, Math.floor(((y + 0.5) / sizeY) * height)));
    for (let x = 0; x < sizeX; x++) {
      const sourceX = Math.min(width - 1, Math.max(0, Math.floor(((x + 0.5) / sizeX) * width)));
      const alpha = imageData[(sourceY * width + sourceX) * 4 + 3]! / 255;
      values[y * sizeX + x] = alpha * alphaScale;
    }
  }
  return { radiusX, radiusY, sizeX, sizeY, values };
}

function splatFieldStamp(
  field: Float32Array,
  centerX: number,
  centerY: number,
  stamp: FieldStamp,
  gain: number,
): void {
  const gridCenterX = Math.round(centerX * FIELD_SCALE_X);
  const gridCenterY = Math.round(centerY * FIELD_SCALE_Y);
  for (let y = -stamp.radiusY; y <= stamp.radiusY; y++) {
    const gridY = gridCenterY + y;
    if (gridY < 0 || gridY >= FIELD_ROWS) continue;
    const fieldRowOffset = gridY * FIELD_COLS;
    const stampRowOffset = (y + stamp.radiusY) * stamp.sizeX;
    for (let x = -stamp.radiusX; x <= stamp.radiusX; x++) {
      const gridX = gridCenterX + x;
      if (gridX < 0 || gridX >= FIELD_COLS) continue;
      const stampValue = stamp.values[stampRowOffset + x + stamp.radiusX]! * gain;
      if (stampValue === 0) continue;
      const fieldIndex = fieldRowOffset + gridX;
      field[fieldIndex] = Math.min(1, field[fieldIndex]! + stampValue);
    }
  }
}

function decayField(field: Float32Array, decay: number): void {
  for (let index = 0; index < field.length; index++) {
    field[index] = field[index]! * decay;
  }
}

const particleFieldStamp = createRadialFieldStamp(SPRITE_R);
const largeAttractorFieldStamp = createRadialFieldStamp(LARGE_ATTRACTOR_R);
const smallAttractorFieldStamp = createRadialFieldStamp(ATTRACTOR_R);

const sourceCanvas = document.getElementById("source-canvas") as HTMLCanvasElement | null;
if (!sourceCanvas) throw new Error("source-canvas not found");
const simulationContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
if (simulationContext === null) throw new Error("simulation context not available");
const sCtx = simulationContext;

const propBox = getRequiredDiv("prop-box");
const artStage = getRequiredDiv("art-stage");
const textLayer = document.getElementById("text-layer") as HTMLDivElement | null;
if (!textLayer) throw new Error("text-layer not found");

sourceCanvas.width = ART_W;
sourceCanvas.height = ART_H;
artStage.style.width = `${ART_W}px`;
artStage.style.height = `${ART_H}px`;

function layoutArtStage(): void {
  const rect = propBox.getBoundingClientRect();
  const scale = Math.min(rect.width / ART_W, rect.height / ART_H);
  const scaledW = ART_W * scale;
  const scaledH = ART_H * scale;
  const offsetX = (rect.width - scaledW) * 0.5;
  const offsetY = (rect.height - scaledH) * 0.5;
  artStage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}
layoutArtStage();
window.addEventListener("resize", layoutArtStage);

const rows: HTMLDivElement[] = [];
for (let row = 0; row < ROWS; row++) {
  const proportionalRow = document.createElement("div");
  proportionalRow.className = "art-row";
  proportionalRow.style.height = `${LINE_HEIGHT}px`;
  proportionalRow.style.lineHeight = `${LINE_HEIGHT}px`;
  proportionalRow.style.fontSize = `${FONT_SIZE}px`;
  proportionalRow.style.fontFamily = BRAILLE_FAMILY;
  proportionalRow.style.fontWeight = "400";
  proportionalRow.style.fontStyle = "normal";
  proportionalRow.style.letterSpacing = "0";
  textLayer.appendChild(proportionalRow);
  rows.push(proportionalRow);
}

function getAlphaClass(brightness: number): string {
  const alphaIndex = Math.max(1, Math.min(10, Math.round(brightness * 10)));
  return `a${alphaIndex}`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(from: Rgb, to: Rgb, t: number): Rgb {
  return {
    r: Math.round(lerp(from.r, to.r, t)),
    g: Math.round(lerp(from.g, to.g, t)),
    b: Math.round(lerp(from.b, to.b, t)),
  };
}

function colorFromStops(stops: readonly Rgb[], intensity: number): string {
  if (stops.length === 0) return `rgb(${BIRD_COLOR.r} ${BIRD_COLOR.g} ${BIRD_COLOR.b})`;
  if (stops.length === 1) {
    const stop = stops[0]!;
    return `rgb(${stop.r} ${stop.g} ${stop.b})`;
  }
  const clamped = Math.max(0, Math.min(1, intensity));
  const position = (1 - clamped) * (stops.length - 1);
  const startIndex = Math.min(stops.length - 2, Math.floor(position));
  const localT = position - startIndex;
  const color = lerpColor(stops[startIndex]!, stops[startIndex + 1]!, localT);
  return `rgb(${color.r} ${color.g} ${color.b})`;
}

function renderBrailleCell(
  mask: number,
  totalBrightness: number,
  birdBrightness: number,
  attractor1Brightness: number,
  attractor2Brightness: number,
): string {
  const glyph = String.fromCodePoint(0x2800 + mask);
  const alphaClass = getAlphaClass(totalBrightness);

  if (attractor1Brightness >= birdBrightness && attractor1Brightness >= attractor2Brightness) {
    return `<span class="${alphaClass}" style="color: ${colorFromStops(ATTRACTOR_1_STOPS, attractor1Brightness)}">${glyph}</span>`;
  }
  if (attractor2Brightness >= birdBrightness && attractor2Brightness >= attractor1Brightness) {
    return `<span class="${alphaClass}" style="color: ${colorFromStops(ATTRACTOR_2_STOPS, attractor2Brightness)}">${glyph}</span>`;
  }
  return `<span class="${alphaClass}">${glyph}</span>`;
}

function renderBrailleRows(): void {
  for (let row = 0; row < ROWS; row++) {
    let propHtml = "";
    const fieldRowStart = row * CELL_SAMPLE_Y * FIELD_COLS;
    for (let col = 0; col < COLS; col++) {
      const fieldColStart = col * CELL_SAMPLE_X;
      let mask = 0;
      let totalBrightness = 0;
      let birdBrightness = 0;
      let attractor1Brightness = 0;
      let attractor2Brightness = 0;
      for (let sampleY = 0; sampleY < CELL_SAMPLE_Y; sampleY++) {
        const sampleRowOffset = fieldRowStart + sampleY * FIELD_COLS + fieldColStart;
        for (let sampleX = 0; sampleX < CELL_SAMPLE_X; sampleX++) {
          const sampleIndex = sampleRowOffset + sampleX;
          const birdSample = birdBrightnessField[sampleIndex]!;
          const attractor1Sample = attractor1BrightnessField[sampleIndex]!;
          const attractor2Sample = attractor2BrightnessField[sampleIndex]!;
          const sample = Math.min(1, birdSample + attractor1Sample + attractor2Sample);
          totalBrightness += sample;
          birdBrightness += birdSample;
          attractor1Brightness += attractor1Sample;
          attractor2Brightness += attractor2Sample;
          if (sample >= BRAILLE_DOT_THRESHOLD) mask |= BRAILLE_BIT_BY_SAMPLE[sampleY]![sampleX]!;
        }
      }

      const sampleCount = CELL_SAMPLE_X * CELL_SAMPLE_Y;
      const averageBrightness = totalBrightness / sampleCount;
      if (averageBrightness < FIELD_EMPTY_THRESHOLD || mask === 0) {
        propHtml += " ";
        continue;
      }

      propHtml += renderBrailleCell(
        mask,
        averageBrightness,
        birdBrightness / sampleCount,
        attractor1Brightness / sampleCount,
        attractor2Brightness / sampleCount,
      );
    }
    rows[row]!.innerHTML = propHtml;
  }
}

function render(now: number): void {
  const attractor1X = Math.cos(now * 0.0007) * CANVAS_W * 0.25 + CANVAS_W / 2;
  const attractor1Y = Math.sin(now * 0.0011) * CANVAS_H * 0.3 + CANVAS_H / 2;
  const attractor2X = Math.cos(now * 0.0013 + Math.PI) * CANVAS_W * 0.2 + CANVAS_W / 2;
  const attractor2Y = Math.sin(now * 0.0009 + Math.PI) * CANVAS_H * 0.25 + CANVAS_H / 2;

  // Flocking behavior
  for (let i = 0; i < particles.length; i++) {
    const particle = particles[i]!;

    // Separation, alignment, cohesion
    let sepX = 0,
      sepY = 0,
      sepCount = 0;
    let alignX = 0,
      alignY = 0,
      alignCount = 0;
    let cohX = 0,
      cohY = 0,
      cohCount = 0;

    for (let j = 0; j < particles.length; j++) {
      if (i === j) continue;
      const other = particles[j]!;
      const dx = other.x - particle.x;
      const dy = other.y - particle.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < SEPARATION_RADIUS && dist > 0) {
        sepX -= dx / dist;
        sepY -= dy / dist;
        sepCount++;
      }
      if (dist < ALIGNMENT_RADIUS) {
        alignX += other.vx;
        alignY += other.vy;
        alignCount++;
      }
      if (dist < COHESION_RADIUS) {
        cohX += other.x;
        cohY += other.y;
        cohCount++;
      }
    }

    if (sepCount > 0) {
      particle.vx += (sepX / sepCount) * SEPARATION_FORCE;
      particle.vy += (sepY / sepCount) * SEPARATION_FORCE;
    }
    if (alignCount > 0) {
      const avgVx = alignX / alignCount;
      const avgVy = alignY / alignCount;
      particle.vx += (avgVx - particle.vx) * ALIGNMENT_FORCE;
      particle.vy += (avgVy - particle.vy) * ALIGNMENT_FORCE;
    }
    if (cohCount > 0) {
      const avgX = cohX / cohCount;
      const avgY = cohY / cohCount;
      particle.vx += (avgX - particle.x) * COHESION_FORCE * 0.01;
      particle.vy += (avgY - particle.y) * COHESION_FORCE * 0.01;
    }

    // Attraction to moving points
    const d1x = attractor1X - particle.x;
    const d1y = attractor1Y - particle.y;
    const d2x = attractor2X - particle.x;
    const d2y = attractor2Y - particle.y;
    const dist1 = Math.sqrt(d1x * d1x + d1y * d1y) + 1;
    const dist2 = Math.sqrt(d2x * d2x + d2y * d2y) + 1;

    if (dist1 < dist2) {
      particle.vx += (d1x / dist1) * ATTRACTOR_FORCE_1;
      particle.vy += (d1y / dist1) * ATTRACTOR_FORCE_1;
    } else {
      particle.vx += (d2x / dist2) * ATTRACTOR_FORCE_2;
      particle.vy += (d2y / dist2) * ATTRACTOR_FORCE_2;
    }

    // Limit speed
    const speed = Math.sqrt(particle.vx * particle.vx + particle.vy * particle.vy);
    if (speed > MAX_SPEED) {
      particle.vx = (particle.vx / speed) * MAX_SPEED;
      particle.vy = (particle.vy / speed) * MAX_SPEED;
    } else if (speed < MIN_SPEED && speed > 0) {
      particle.vx = (particle.vx / speed) * MIN_SPEED;
      particle.vy = (particle.vy / speed) * MIN_SPEED;
    }

    // Update angle based on velocity
    particle.angle = Math.atan2(particle.vy, particle.vx);

    // Update position
    particle.x += particle.vx;
    particle.y += particle.vy;

    // Wrap around edges
    if (particle.x < -SPRITE_R) particle.x += CANVAS_W + SPRITE_R * 2;
    if (particle.x > CANVAS_W + SPRITE_R) particle.x -= CANVAS_W + SPRITE_R * 2;
    if (particle.y < -SPRITE_R) particle.y += CANVAS_H + SPRITE_R * 2;
    if (particle.y > CANVAS_H + SPRITE_R) particle.y -= CANVAS_H + SPRITE_R * 2;
  }

  sCtx.fillStyle = "rgba(4,7,14,0.18)";
  sCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  sCtx.globalCompositeOperation = "lighter";

  // Draw bird sprites
  for (let index = 0; index < particles.length; index++) {
    const particle = particles[index]!;
    const sprite = angleToSprite(particle.angle);
    if (sprite) {
      sCtx.drawImage(sprite, particle.x - SPRITE_R, particle.y - SPRITE_R);
    } else {
      // Fallback to gradient sprite while loading
      sCtx.drawImage(getSpriteCanvas(SPRITE_R), particle.x - SPRITE_R, particle.y - SPRITE_R);
    }
  }

  sCtx.globalCompositeOperation = "source-over";

  decayField(birdBrightnessField, BIRD_TRAIL_DECAY);
  decayField(attractor1BrightnessField, ATTRACTOR_TRAIL_DECAY);
  decayField(attractor2BrightnessField, ATTRACTOR_TRAIL_DECAY);
  for (let index = 0; index < particles.length; index++) {
    const particle = particles[index]!;
    splatFieldStamp(
      birdBrightnessField,
      particle.x,
      particle.y,
      angleToSpriteFieldStamp(particle.angle) ?? particleFieldStamp,
      BIRD_TRAIL_GAIN,
    );
  }
  splatFieldStamp(
    attractor1BrightnessField,
    attractor1X,
    attractor1Y,
    largeAttractorFieldStamp,
    ATTRACTOR_TRAIL_GAIN,
  );
  splatFieldStamp(
    attractor2BrightnessField,
    attractor2X,
    attractor2Y,
    smallAttractorFieldStamp,
    ATTRACTOR_TRAIL_GAIN,
  );

  renderBrailleRows();

  requestAnimationFrame(render);
}

requestAnimationFrame(render);

// ImGui-style controls
type SliderConfig = {
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
};

const sliders: SliderConfig[] = [
  {
    label: "Attractor 1 Force",
    min: 0,
    max: 0.5,
    step: 0.01,
    get: () => ATTRACTOR_FORCE_1,
    set: (v) => (ATTRACTOR_FORCE_1 = v),
  },
  {
    label: "Attractor 2 Force",
    min: 0,
    max: 0.5,
    step: 0.01,
    get: () => ATTRACTOR_FORCE_2,
    set: (v) => (ATTRACTOR_FORCE_2 = v),
  },
  {
    label: "Bird Trail Decay",
    min: 0.7,
    max: 0.99,
    step: 0.01,
    get: () => BIRD_TRAIL_DECAY,
    set: (v) => (BIRD_TRAIL_DECAY = v),
  },
  {
    label: "Attractor Trail Decay",
    min: 0.7,
    max: 0.99,
    step: 0.01,
    get: () => ATTRACTOR_TRAIL_DECAY,
    set: (v) => (ATTRACTOR_TRAIL_DECAY = v),
  },
  {
    label: "Bird Trail Gain",
    min: 0.1,
    max: 1.5,
    step: 0.05,
    get: () => BIRD_TRAIL_GAIN,
    set: (v) => (BIRD_TRAIL_GAIN = v),
  },
  {
    label: "Attractor Trail Gain",
    min: 0.1,
    max: 1.5,
    step: 0.05,
    get: () => ATTRACTOR_TRAIL_GAIN,
    set: (v) => (ATTRACTOR_TRAIL_GAIN = v),
  },
  {
    label: "Separation Radius",
    min: 10,
    max: 80,
    step: 1,
    get: () => SEPARATION_RADIUS,
    set: (v) => (SEPARATION_RADIUS = v),
  },
  {
    label: "Alignment Radius",
    min: 10,
    max: 100,
    step: 1,
    get: () => ALIGNMENT_RADIUS,
    set: (v) => (ALIGNMENT_RADIUS = v),
  },
  {
    label: "Cohesion Radius",
    min: 10,
    max: 120,
    step: 1,
    get: () => COHESION_RADIUS,
    set: (v) => (COHESION_RADIUS = v),
  },
  {
    label: "Separation Force",
    min: 0,
    max: 0.3,
    step: 0.01,
    get: () => SEPARATION_FORCE,
    set: (v) => (SEPARATION_FORCE = v),
  },
  {
    label: "Alignment Force",
    min: 0,
    max: 0.2,
    step: 0.01,
    get: () => ALIGNMENT_FORCE,
    set: (v) => (ALIGNMENT_FORCE = v),
  },
  {
    label: "Cohesion Force",
    min: 0,
    max: 0.2,
    step: 0.01,
    get: () => COHESION_FORCE,
    set: (v) => (COHESION_FORCE = v),
  },
  {
    label: "Max Speed",
    min: 0.5,
    max: 5,
    step: 0.1,
    get: () => MAX_SPEED,
    set: (v) => (MAX_SPEED = v),
  },
  {
    label: "Min Speed",
    min: 0.1,
    max: 3,
    step: 0.1,
    get: () => MIN_SPEED,
    set: (v) => (MIN_SPEED = v),
  },
  {
    label: "Sprite Angle Trim",
    min: -45,
    max: 45,
    step: 1,
    get: () => (SPRITE_ANGLE_TRIM * 180) / Math.PI,
    set: (v) => {
      SPRITE_ANGLE_TRIM = (v * Math.PI) / 180;
      buildRotatedSpriteLUT();
    },
  },
  {
    label: "Rotation Steps",
    min: 4,
    max: 36,
    step: 1,
    get: () => ROTATION_STEPS,
    set: (v) => {
      ROTATION_STEPS = v;
      buildRotatedSpriteLUT();
    },
  },
];

const controlsPanel = document.createElement("div");
controlsPanel.style.cssText = `
  position: fixed;
  top: 10px;
  right: 10px;
  background: rgba(30, 30, 30, 0.95);
  color: #ddd;
  padding: 12px;
  border-radius: 6px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px;
  z-index: 1000;
  min-width: 220px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  display: none;
`;

const titleRow = document.createElement("div");
titleRow.style.cssText =
  "display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;";
const title = document.createElement("div");
title.textContent = "Flock Controls";
title.style.cssText = "font-weight: 600; font-size: 13px;";
titleRow.appendChild(title);

const btnRow = document.createElement("div");
btnRow.style.cssText = "display: flex; gap: 4px;";

const importBtn = document.createElement("button");
importBtn.textContent = "⬇";
importBtn.title = "Import JSON";
importBtn.style.cssText = `
  background: #444;
  border: 1px solid #666;
  color: #ccc;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
`;
importBtn.onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    const params = JSON.parse(text);
    if (params.ATTRACTOR_FORCE_1 !== undefined) ATTRACTOR_FORCE_1 = params.ATTRACTOR_FORCE_1;
    if (params.ATTRACTOR_FORCE_2 !== undefined) ATTRACTOR_FORCE_2 = params.ATTRACTOR_FORCE_2;
    if (params.BIRD_TRAIL_DECAY !== undefined) BIRD_TRAIL_DECAY = params.BIRD_TRAIL_DECAY;
    if (params.ATTRACTOR_TRAIL_DECAY !== undefined)
      ATTRACTOR_TRAIL_DECAY = params.ATTRACTOR_TRAIL_DECAY;
    if (params.BIRD_TRAIL_GAIN !== undefined) BIRD_TRAIL_GAIN = params.BIRD_TRAIL_GAIN;
    if (params.ATTRACTOR_TRAIL_GAIN !== undefined)
      ATTRACTOR_TRAIL_GAIN = params.ATTRACTOR_TRAIL_GAIN;
    if (params.SEPARATION_RADIUS !== undefined) SEPARATION_RADIUS = params.SEPARATION_RADIUS;
    if (params.ALIGNMENT_RADIUS !== undefined) ALIGNMENT_RADIUS = params.ALIGNMENT_RADIUS;
    if (params.COHESION_RADIUS !== undefined) COHESION_RADIUS = params.COHESION_RADIUS;
    if (params.SEPARATION_FORCE !== undefined) SEPARATION_FORCE = params.SEPARATION_FORCE;
    if (params.ALIGNMENT_FORCE !== undefined) ALIGNMENT_FORCE = params.ALIGNMENT_FORCE;
    if (params.COHESION_FORCE !== undefined) COHESION_FORCE = params.COHESION_FORCE;
    if (params.MAX_SPEED !== undefined) MAX_SPEED = params.MAX_SPEED;
    if (params.MIN_SPEED !== undefined) MIN_SPEED = params.MIN_SPEED;
    if (params.SPRITE_ANGLE_TRIM_DEG !== undefined) {
      SPRITE_ANGLE_TRIM = (params.SPRITE_ANGLE_TRIM_DEG * Math.PI) / 180;
      buildRotatedSpriteLUT();
    }
    updateSliders();
    importBtn.textContent = "✓";
    setTimeout(() => (importBtn.textContent = "⬇"), 1000);
  } catch {
    importBtn.textContent = "✗";
    setTimeout(() => (importBtn.textContent = "⬇"), 1000);
  }
};
btnRow.appendChild(importBtn);

const jsonBtn = document.createElement("button");
jsonBtn.textContent = "{ }";
jsonBtn.title = "Export JSON";
jsonBtn.style.cssText = `
  background: #444;
  border: 1px solid #666;
  color: #ccc;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
`;
jsonBtn.onclick = () => {
  const params = {
    ATTRACTOR_FORCE_1,
    ATTRACTOR_FORCE_2,
    BIRD_TRAIL_DECAY,
    ATTRACTOR_TRAIL_DECAY,
    BIRD_TRAIL_GAIN,
    ATTRACTOR_TRAIL_GAIN,
    SEPARATION_RADIUS,
    ALIGNMENT_RADIUS,
    COHESION_RADIUS,
    SEPARATION_FORCE,
    ALIGNMENT_FORCE,
    COHESION_FORCE,
    MAX_SPEED,
    MIN_SPEED,
    SPRITE_ANGLE_TRIM_DEG: (SPRITE_ANGLE_TRIM * 180) / Math.PI,
  };
  const json = JSON.stringify(params, null, 2);
  void navigator.clipboard.writeText(json).then(() => {
    jsonBtn.textContent = "✓";
    setTimeout(() => (jsonBtn.textContent = "{ }"), 1000);
  });
};
btnRow.appendChild(jsonBtn);
titleRow.appendChild(btnRow);
controlsPanel.appendChild(titleRow);

const sliderInputs: HTMLInputElement[] = [];
const sliderValueSpans: HTMLSpanElement[] = [];

for (const slider of sliders) {
  const row = document.createElement("div");
  row.style.cssText = "margin-bottom: 8px;";

  const labelRow = document.createElement("div");
  labelRow.style.cssText = "display: flex; justify-content: space-between; margin-bottom: 2px;";

  const label = document.createElement("label");
  label.textContent = slider.label;
  label.style.cssText = "color: #aaa;";

  const valueSpan = document.createElement("span");
  valueSpan.style.cssText = "color: #fff; font-family: monospace;";
  valueSpan.textContent = slider.get().toFixed(slider.step < 1 ? 2 : 0);
  sliderValueSpans.push(valueSpan);

  labelRow.appendChild(label);
  labelRow.appendChild(valueSpan);
  row.appendChild(labelRow);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(slider.min);
  input.max = String(slider.max);
  input.step = String(slider.step);
  input.value = String(slider.get());
  input.style.cssText = `
    width: 100%;
    accent-color: #6a9fb5;
    background: #333;
  `;
  input.oninput = () => {
    const v = parseFloat(input.value);
    slider.set(v);
    valueSpan.textContent = v.toFixed(slider.step < 1 ? 2 : 0);
  };
  sliderInputs.push(input);

  row.appendChild(input);
  controlsPanel.appendChild(row);
}

function updateSliders(): void {
  for (let i = 0; i < sliders.length; i++) {
    const slider = sliders[i]!;
    const input = sliderInputs[i]!;
    const valueSpan = sliderValueSpans[i]!;
    input.value = String(slider.get());
    valueSpan.textContent = slider.get().toFixed(slider.step < 1 ? 2 : 0);
  }
}

document.body.appendChild(controlsPanel);

// Toggle button
const toggleBtn = document.createElement("button");
toggleBtn.textContent = "⛭";
toggleBtn.title = "Toggle flock controls";
toggleBtn.style.cssText = `
  position: fixed;
  top: 10px;
  right: 10px;
  background: rgba(30, 30, 30, 0.9);
  border: 1px solid #666;
  color: #ccc;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  z-index: 1001;
`;
toggleBtn.onclick = () => {
  const isVisible = controlsPanel.style.display !== "none";
  controlsPanel.style.display = isVisible ? "none" : "block";
  toggleBtn.style.display = isVisible ? "block" : "none";
};
controlsPanel.addEventListener("mouseleave", () => {
  controlsPanel.style.display = "none";
  toggleBtn.style.display = "block";
});
document.body.appendChild(toggleBtn);
