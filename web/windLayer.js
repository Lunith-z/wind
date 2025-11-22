import * as ColorRamp from "./colorRamp.js?v=2";

const { getColorRamp, DEFAULT_RAMP_NAME } = ColorRamp;

const {
  Cartesian3,
  Color,
  Math: CesiumMath,
  Material,
  PolylineCollection,
  SceneTransforms,
  BillboardCollection,
  BlendOption,
} = Cesium;

const EARTH_RADIUS = 6378137;
const RESET_MARGIN_DEG = 0.04;
// 调试阶段：先关闭空间噪声，观察粒子是否能真实跨域运动。
const FLOW_NOISE_LON_METERS = 0;
const FLOW_NOISE_LAT_METERS = 0;
const FLOW_NOISE_ALT_METERS = 0;
const FLOW_NOISE_SMOOTH_FACTOR = 1.0;

const DEFAULT_LAYER_OPTIONS = {
  maxParticles: 2200,
  // 拉长寿命、放大速度，便于观察粒子跨域运动。
  maxAge: 12000,
  speedFactor: 8.0,
  lineWidth: 2.6,
  fadeOpacity: 0.92,
  trailLength: 24,
  showTrails: true,
  dropRate: 0.002,
  dropRateBump: 0.006,
  verticalScale: 1600,
  levelIndex: 0,
  multiLevel: true,
  levelStride: 1,
  headSize: 12,
  headOpacity: 0.96,
  minHeadOpacity: 0.35,
  maxHeadOpacity: 0.96,
  minTrailOpacity: 0.25,
  maxTrailOpacity: 0.92,
  lengthScale: 3.6,
  minStreakLength: null,
  maxStreakLength: null,
  minBillboardLength: 48,
  uniformStreakLength: null,
  uniformTrailMeters: null,
  uniformStreakThickness: null,
  streakAspect: 0.25,
  minStreakScale: 3.0,
  maxStreakScale: 12.0,
  surfaceClamp: false,
  screenCulling: false,
  updateInterval: 0.02,
  maxActiveCameraHeight: 900000,
  colorRampName: "neonVortex",
  integrationSteps: 2,
  flowGuides: null,
  guideInfluence: 0.45,
  lengthCurve: "sqrt",
  colorCurve: "sqrt",
  lengthLogBase: 8,
  colorLogBase: 6,
  colorLightness: 0.35,
  colorDarkness: 0.18,
  trailTaperPower: 1.3,
  trailTailOpacity: 0.2,
  minWindSpeedRatio: 0.0,
  lifespanClampToDomain: true,
  speedBoost: 1.0,
  softStreakMode: false,
  softStreakMeters: 2000,
  billboardOnly: false,
};

const DEFAULT_STREAM_OPTIONS = {
  levelIndex: 0,
  seedStride: 4,
  seedJitter: 0.45,
  maxSteps: 80,
  stepSeconds: 420,
  speedScale: 1.0,
  lineWidth: 1.8,
  glowPower: 0.18,
  minPathLength: 3,
  clampSurface: false,
  verticalScale: 600,
  colorRampName: "neonVortex",
  colorRamp: null,
  opacity: 0.78,
};
const DEFAULT_GUIDE_OPTIONS = {
  levelIndex: 0,
  seedStride: 3,
  maxSteps: 90,
  stepSeconds: 360,
  clampSurface: false,
};
const DEFAULT_COLOR_RAMP = getColorRamp();

function targetPointsFromTrailLength(value) {
  const numeric =
    value === undefined || value === null
      ? DEFAULT_LAYER_OPTIONS.trailLength
      : Number(value);
  if (!Number.isFinite(numeric)) {
    return Math.max(2, DEFAULT_LAYER_OPTIONS.trailLength);
  }
  return Math.max(2, Math.round(numeric));
}

function isValidWindSample(sample) {
  if (!sample) {
    return false;
  }
  return (
    Number.isFinite(sample.u) &&
    Number.isFinite(sample.v) &&
    Number.isFinite(sample.w)
  );
}

function cloneWind(sample) {
  return sample
    ? {
        u: sample.u,
        v: sample.v,
        w: sample.w,
      }
    : null;
}

function scaleWind(sample, factor) {
  if (!sample) {
    return null;
  }
  return {
    u: sample.u * factor,
    v: sample.v * factor,
    w: sample.w * factor,
  };
}

function colorFromRatio(ramp, ratio, alpha) {
  const sampler =
    ramp && typeof ramp.sample === "function" ? ramp : DEFAULT_COLOR_RAMP;
  const rgb = sampler.sample(ratio);
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return Color.fromBytes(
    Math.round(rgb[0]),
    Math.round(rgb[1]),
    Math.round(rgb[2]),
    a
  );
}

function brightenColor(color, factor = 1.15, lift = 0.04) {
  const out = color.clone();
  out.red = Math.min(1, out.red * factor + lift);
  out.green = Math.min(1, out.green * factor + lift);
  out.blue = Math.min(1, out.blue * factor + lift);
  return out;
}

function normalizeCurveName(value, fallback = "linear") {
  if (typeof value !== "string") {
    return fallback;
  }
  const name = value.toLowerCase();
  if (name === "sqrt" || name === "square-root") {
    return "sqrt";
  }
  if (name === "log" || name === "logarithmic") {
    return "log";
  }
  if (name === "cuberoot" || name === "cubic-root") {
    return "cuberoot";
  }
  if (name === "linear") {
    return "linear";
  }
  return fallback;
}

function mapResponseCurve(ratio, curve = "linear", logBase = 8) {
  const clamped = Math.max(0, Math.min(1, ratio ?? 0));
  const mode = normalizeCurveName(curve, "linear");
  if (mode === "sqrt") {
    return Math.sqrt(clamped);
  }
  if (mode === "log") {
    const base = Math.max(1.2, logBase || 10);
    return Math.log(1 + clamped * (base - 1)) / Math.log(base);
  }
  if (mode === "cuberoot") {
    return Math.cbrt(Math.max(clamped, 0));
  }
  return clamped;
}

function tintColorBySpeed(color, ratio, lightenStrength = 0.35, darkenStrength = 0.18) {
  const lighten = Math.max(0, Math.min(1, (1 - (ratio || 0)) * lightenStrength));
  const darken = Math.max(0, Math.min(1, (ratio || 0) * darkenStrength));
  const tinted = color.clone();
  Color.lerp(tinted, Color.WHITE, lighten, tinted);
  Color.lerp(tinted, Color.BLACK, darken, tinted);
  tinted.alpha = color.alpha;
  return tinted;
}

const PARTICLE_TRAIL_MATERIAL = "ParticleTrail";
let particleTrailMaterialInitialized = false;
function ensureParticleTrailMaterial() {
  if (particleTrailMaterialInitialized) {
    return PARTICLE_TRAIL_MATERIAL;
  }
  Material._materialCache.addMaterial(PARTICLE_TRAIL_MATERIAL, {
    fabric: {
      type: PARTICLE_TRAIL_MATERIAL,
      uniforms: {
        color: Color.WHITE.clone(),
        tailPower: 1.3,
        tailMinimum: 0.18,
      },
      source: `
czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    float progress = clamp(materialInput.s, 0.0, 1.0);
    float tapered = pow(progress, tailPower);
    float visibility = mix(tailMinimum, 1.0, tapered);
    material.diffuse = color.rgb;
    material.alpha = color.a * visibility;
    return material;
}
      `,
    },
    translucent: () => true,
  });
  particleTrailMaterialInitialized = true;
  return PARTICLE_TRAIL_MATERIAL;
}

let particleTexture = null;
function getParticleTexture() {
  if (particleTexture) {
    return particleTexture;
  }
  const width = 130;
  const height = 18;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const stroke = (start, end, alpha, thickness) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.lineCap = "round";
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.moveTo(start, height / 2);
    ctx.lineTo(end, height / 2);
    ctx.stroke();
    ctx.restore();
  };

  ctx.globalCompositeOperation = "lighter";
  stroke(6, width - 6, 0.12, height * 0.85);
  stroke(10, width - 10, 0.3, height * 0.55);
  stroke(18, width - 24, 0.55, height * 0.35);
  stroke(24, width - 18, 0.95, height * 0.22);

  // Head flare
  const headGradient = ctx.createRadialGradient(
    width - 12,
    height / 2,
    0,
    width - 12,
    height / 2,
    12
  );
  headGradient.addColorStop(0, "rgba(255,255,255,0.95)");
  headGradient.addColorStop(0.5, "rgba(255,255,255,0.35)");
  headGradient.addColorStop(1, "rgba(255,255,255,0.02)");
  ctx.fillStyle = headGradient;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(width - 12, height / 2, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  particleTexture = canvas.toDataURL("image/png");
  return particleTexture;
}

export class FlowTextureLayer {
  constructor(viewer, windField, options = {}) {
    this.viewer = viewer;
    this.field = windField;
    this.enabled = options.enabled ?? true;
    this.colorRamp =
      options.colorRamp && typeof options.colorRamp.sample === "function"
        ? options.colorRamp
        : getColorRamp(DEFAULT_RAMP_NAME);
    this.width = options.width || 256;
    this.height = options.height || 256;
    this.fade = CesiumMath.clamp(options.fade ?? 0.96, 0.8, 0.995);
    this.speedScale = options.speedScale ?? 1.0;
    this.levelIndex =
      typeof options.levelIndex === "number"
        ? options.levelIndex
        : Math.floor(Math.max(0, windField.levels.length - 1) * 0.5);

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext("2d");

    this.current = this.ctx.createImageData(this.width, this.height);
    this.next = this.ctx.createImageData(this.width, this.height);
    this._seedTexture();
    this.ctx.putImageData(this.current, 0, 0);

    const rect = Cesium.Rectangle.fromDegrees(
      windField.bounds.lonMin,
      windField.bounds.latMin,
      windField.bounds.lonMax,
      windField.bounds.latMax
    );

    this.entity = viewer.entities.add({
      rectangle: {
        coordinates: rect,
        material: new Cesium.ImageMaterialProperty({
          image: this.canvas,
          transparent: true,
          color: Cesium.Color.WHITE,
        }),
      },
    });
  }

  _seedTexture() {
    const data = this.current.data;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const idx = (y * this.width + x) * 4;
        if (Math.random() < 0.06) {
          const ratio = Math.random();
          const rgb = this.colorRamp.sample
            ? this.colorRamp.sample(ratio)
            : [255, 255, 255];
          data[idx] = rgb[0];
          data[idx + 1] = rgb[1];
          data[idx + 2] = rgb[2];
          data[idx + 3] = 200;
        } else {
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          data[idx + 3] = 0;
        }
      }
    }
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.entity) {
      this.entity.show = this.enabled;
    }
  }

  update(deltaSeconds) {
    if (!this.enabled) {
      return;
    }
    const dt = deltaSeconds || 1 / 60;
    const w = this.width;
    const h = this.height;
    const src = this.current.data;
    const dst = this.next.data;
    const bounds = this.field.bounds;
    const lonMin = bounds.lonMin;
    const lonMax = bounds.lonMax;
    const latMin = bounds.latMin;
    const latMax = bounds.latMax;
    const lonSpan = lonMax - lonMin || 1;
    const latSpan = latMax - latMin || 1;
    const dLon = lonSpan / w;
    const dLat = latSpan / h;
    const maxSpeed = Math.max(this.field.maxSpeed, 0.001);

    for (let y = 0; y < h; y += 1) {
      const lat = latMin + (y + 0.5) * dLat;
      const latRad = CesiumMath.toRadians(lat);
      const cosLat = Math.max(Math.cos(latRad), 0.01);
      for (let x = 0; x < w; x += 1) {
        const lon = lonMin + (x + 0.5) * dLon;
        const idxDst = (y * w + x) * 4;
        const wind = this.field.interpolate(lon, lat, this.levelIndex);
        if (isValidWindSample(wind)) {
          const speed = Math.sqrt(
            wind.u * wind.u + wind.v * wind.v + wind.w * wind.w
          );
          const eastMeters = wind.u * dt * this.speedScale;
          const northMeters = wind.v * dt * this.speedScale;
          const dLonPix =
            ((eastMeters / (EARTH_RADIUS * cosLat)) *
              CesiumMath.DEGREES_PER_RADIAN) /
            dLon;
          const dLatPix =
            ((northMeters / EARTH_RADIUS) *
              CesiumMath.DEGREES_PER_RADIAN) /
            dLat;
          const sx = x - dLonPix;
          const sy = y - dLatPix;
          if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
            const isx = sx | 0;
            const isy = sy | 0;
            const idxSrc = (isy * w + isx) * 4;
            const fade = this.fade;
            dst[idxDst] = src[idxSrc] * fade;
            dst[idxDst + 1] = src[idxSrc + 1] * fade;
            dst[idxDst + 2] = src[idxSrc + 2] * fade;
            dst[idxDst + 3] = Math.max(0, src[idxSrc + 3] * fade);
          } else {
            const ratio = Math.min(1, speed / maxSpeed);
            const rgb = this.colorRamp.sample
              ? this.colorRamp.sample(ratio)
              : [255, 255, 255];
            dst[idxDst] = rgb[0];
            dst[idxDst + 1] = rgb[1];
            dst[idxDst + 2] = rgb[2];
            dst[idxDst + 3] = 200;
          }
        } else {
          const idxSrc = idxDst;
          const fade = this.fade;
          dst[idxDst] = src[idxSrc] * fade;
          dst[idxDst + 1] = src[idxSrc + 1] * fade;
          dst[idxDst + 2] = src[idxSrc + 2] * fade;
          dst[idxDst + 3] = Math.max(0, src[idxSrc + 3] * fade);
        }
      }
    }
    this.ctx.putImageData(this.next, 0, 0);
    const tmp = this.current;
    this.current = this.next;
    this.next = tmp;
  }

  destroy() {
    if (this.entity && !this.entity.isDestroyed?.()) {
      this.viewer.entities.remove(this.entity);
    }
    this.entity = null;
  }
}

export class WindField {
  constructor(features, options = {}) {
    this.grid = [];
    this.lonValues = [];
    this.latValues = [];
    this.levels = [];
    this.maxSpeed = 0;
    this.minSpeed = Number.POSITIVE_INFINITY;
    this.bounds = {
      lonMin: Number.POSITIVE_INFINITY,
      lonMax: Number.NEGATIVE_INFINITY,
      latMin: Number.POSITIVE_INFINITY,
      latMax: Number.NEGATIVE_INFINITY,
    };
    this._minHeight = options.minHeight ?? 800;
    this._maxHeight = options.maxHeight ?? 28000;
    this._build(features);
  }

  _build(features) {
    features.forEach((feature) => {
      const { coordinates } = feature.geometry;
      const props = feature.properties;
      const levelIndex = props.level_index;
      const latIndex = props.lat_idx;
      const lonIndex = props.lon_idx;

      if (!this.grid[levelIndex]) {
        this.grid[levelIndex] = [];
      }
      if (!this.grid[levelIndex][latIndex]) {
        this.grid[levelIndex][latIndex] = [];
      }

      this.grid[levelIndex][latIndex][lonIndex] = {
        u: props.U,
        v: props.V,
        w: props.W,
        speed: props.speed,
      };

      this.lonValues[lonIndex] = coordinates[0];
      this.latValues[latIndex] = coordinates[1];
      this.levels[levelIndex] = props.height_level;

      this.maxSpeed = Math.max(this.maxSpeed, props.speed);
      this.minSpeed = Math.min(this.minSpeed, props.speed);

      this.bounds.lonMin = Math.min(this.bounds.lonMin, coordinates[0]);
      this.bounds.lonMax = Math.max(this.bounds.lonMax, coordinates[0]);
      this.bounds.latMin = Math.min(this.bounds.latMin, coordinates[1]);
      this.bounds.latMax = Math.max(this.bounds.latMax, coordinates[1]);
    });

    this.lonValues = this.lonValues.filter((value) => value !== undefined);
    this.latValues = this.latValues.filter((value) => value !== undefined);
    this.levels = this.levels.filter((value) => value !== undefined);
  }

  contains(lon, lat) {
    return this.containsWithMargin(lon, lat, 0);
  }

  containsWithMargin(lon, lat, marginDeg = 0) {
    return (
      lon >= this.bounds.lonMin - marginDeg &&
      lon <= this.bounds.lonMax + marginDeg &&
      lat >= this.bounds.latMin - marginDeg &&
      lat <= this.bounds.latMax + marginDeg
    );
  }

  levelInfo(index) {
    const clamped = Math.min(Math.max(index, 0), Math.max(this.levels.length - 1, 0));
    const value = this.levels[clamped] ?? 0;
    return {
      value,
      altitude: this.altitudeForLevel(clamped),
    };
  }

  altitudeForLevel(index) {
    const levelValue = this.levels[index] ?? this.levels[0] ?? 0;
    const normalized = 1 - Math.max(0, Math.min(1, levelValue));
    return CesiumMath.lerp(this._minHeight, this._maxHeight, normalized);
  }

  randomPosition() {
    const lon =
      this.bounds.lonMin +
      (this.bounds.lonMax - this.bounds.lonMin) * (0.01 + Math.random() * 0.98);
    const lat =
      this.bounds.latMin +
      (this.bounds.latMax - this.bounds.latMin) * (0.01 + Math.random() * 0.98);
    return { lon, lat };
  }

  interpolate(lon, lat, levelIndex) {
    const lonIdx = findInterval(this.lonValues, lon);
    const latIdx = findInterval(this.latValues, lat);
    const levelSlice = this.grid[levelIndex];
    if (lonIdx === null || latIdx === null) {
      return null;
    }

    const samples = this._getCellSamples(levelSlice, latIdx, lonIdx);
    if (!samples) {
      return null;
    }
    const { g00, g01, g10, g11 } = samples;

    const lon0 = this.lonValues[lonIdx];
    const lon1 = this.lonValues[lonIdx + 1];
    const lat0 = this.latValues[latIdx];
    const lat1 = this.latValues[latIdx + 1];

    const x = (lon - lon0) / (lon1 - lon0 || 1);
    const y = (lat - lat0) / (lat1 - lat0 || 1);

    const u = bilinear(g00.u, g01.u, g10.u, g11.u, x, y);
    const v = bilinear(g00.v, g01.v, g10.v, g11.v, x, y);
    const w = bilinear(g00.w, g01.w, g10.w, g11.w, x, y);

    return {
      u,
      v,
      w,
      speed: Math.sqrt(u * u + v * v + w * w),
    };
  }

  _getCellSamples(levelSlice, latIdx, lonIdx) {
    if (!levelSlice) {
      return null;
    }
    if (latIdx < 0 || lonIdx < 0 || latIdx + 1 >= levelSlice.length) {
      return null;
    }

    const row0 = levelSlice[latIdx];
    const row1 = levelSlice[latIdx + 1];
    if (!row0 || !row1) {
      return null;
    }
    if (lonIdx + 1 >= row0.length || lonIdx + 1 >= row1.length) {
      return null;
    }
    const g00 = row0[lonIdx];
    const g01 = row0[lonIdx + 1];
    const g10 = row1[lonIdx];
    const g11 = row1[lonIdx + 1];
    if (!g00 || !g01 || !g10 || !g11) {
      return null;
    }
    return { g00, g01, g10, g11 };
  }

}

export class WindParticleLayer {
  constructor(viewer, windField, options = {}) {
    this.viewer = viewer;
    this.field = windField;
    this.options = { ...DEFAULT_LAYER_OPTIONS, ...options };
    this.options.maxParticles = Math.round(this.options.maxParticles);
    this._applyVisualOptionBounds();
    this.levelIndex = clampLevel(
      this.options.levelIndex,
      windField.levels.length
    );
    this.collection = viewer.scene.primitives.add(new PolylineCollection());
    if (BlendOption && this.collection) {
      this.collection.blendOption = BlendOption.ADDITIVE;
    }
    this.billboardCollection = viewer.scene.primitives.add(
      new BillboardCollection({
        scene: viewer.scene,
      })
    );
    if (BlendOption && this.billboardCollection) {
      this.billboardCollection.blendOption = BlendOption.ADDITIVE;
    }
    this.colorRamp =
      this.options.colorRamp && typeof this.options.colorRamp.sample === "function"
        ? this.options.colorRamp
        : getColorRamp(this.options.colorRampName);
    this.updateInterval = CesiumMath.clamp(
      Number(this.options.updateInterval) || DEFAULT_LAYER_OPTIONS.updateInterval,
      0.01,
      0.08
    );
    this.maxActiveCameraHeight =
      Number(this.options.maxActiveCameraHeight) ||
      DEFAULT_LAYER_OPTIONS.maxActiveCameraHeight;
    this.cameraPauseEnabled = true;
    this.paused = false;
    this._cameraPaused = false;
    this._cameraHeight = 0;
    this._intervalAccumulator = 0;
    this.particles = [];
    this._tick = this._tick.bind(this);
    this.viewer.clock.onTick.addEventListener(this._tick);
    this._multiLevelIndices = [];
    this._rebuildMultiLevelIndices();
    this.integrationSteps = Math.max(
      1,
      Math.floor(this.options.integrationSteps || 1)
    );
    this.flowGuides = this.options.flowGuides || null;
    this.guideInfluence = CesiumMath.clamp(
      this.options.guideInfluence ?? 0.45,
      0,
      1
    );
    this.options.flowGuides = this.flowGuides;
    this.options.guideInfluence = this.guideInfluence;
    this._resizeParticlePool();
  }

  destroy() {
    this.viewer.clock.onTick.removeEventListener(this._tick);
    if (this.collection && !this.collection.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.collection);
    }
    if (this.billboardCollection && !this.billboardCollection.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.billboardCollection);
    }
    this.particles.length = 0;
  }

  respawn() {
    this.particles.forEach((particle) => {
      this._resetParticle(particle, true);
    });
  }

  updateConfig(patch = {}) {
    const previousMax = this.options.maxParticles;
    const previousStride = this.options.levelStride;
    const toggledShowTrails =
      Object.prototype.hasOwnProperty.call(patch, "showTrails");
    Object.assign(this.options, patch);
    this.options.maxParticles = Math.round(
      CesiumMath.clamp(this.options.maxParticles, 200, 8000)
    );
    this.options.lineWidth = Math.max(0.3, this.options.lineWidth || 0.3);
    this.options.fadeOpacity = CesiumMath.clamp(
      this.options.fadeOpacity,
      0.75,
      0.99
    );
    this.options.verticalScale = Math.max(200, this.options.verticalScale || 200);
    this.options.speedFactor = Math.max(0.05, this.options.speedFactor || 0.05);
    this.options.headSize = CesiumMath.clamp(this.options.headSize || 6, 3, 20);
    this.options.headOpacity = CesiumMath.clamp(
      this.options.headOpacity || 0.9,
      0.2,
      1.0
    );
    if (patch.headOpacity !== undefined) {
      if (patch.maxHeadOpacity === undefined) {
        this.options.maxHeadOpacity = this.options.headOpacity;
      }
      if (patch.minHeadOpacity === undefined) {
        this.options.minHeadOpacity = Math.min(
          this.options.headOpacity * 0.55,
          this.options.headOpacity
        );
      }
    }
    if (patch.fadeOpacity !== undefined) {
      if (patch.maxTrailOpacity === undefined) {
        this.options.maxTrailOpacity = this.options.fadeOpacity;
      }
      if (patch.minTrailOpacity === undefined) {
        this.options.minTrailOpacity = Math.min(
          this.options.fadeOpacity * 0.5,
          this.options.fadeOpacity
        );
      }
    }
    this._applyVisualOptionBounds();

    const stride = Math.max(1, Math.round(this.options.levelStride || 1));
    this.options.levelStride = stride;
    this.integrationSteps = Math.max(
      1,
      Math.floor(this.options.integrationSteps || this.integrationSteps || 1)
    );
    if (patch.colorRamp) {
      this.setColorRamp(patch.colorRamp);
    } else if (patch.colorRampName) {
      this.setColorRamp(getColorRamp(patch.colorRampName));
    }

    if (patch.updateInterval !== undefined) {
      this.updateInterval = CesiumMath.clamp(
        Number(patch.updateInterval) || this.updateInterval,
        0.01,
        0.08
      );
    }

    if (patch.maxActiveCameraHeight !== undefined) {
      this.maxActiveCameraHeight = Math.max(
        100000,
        Number(patch.maxActiveCameraHeight)
      );
      this._updateCameraPause();
    }
    if (patch.flowGuides !== undefined) {
      this.flowGuides = patch.flowGuides;
      this.options.flowGuides = patch.flowGuides;
    }
    if (patch.guideInfluence !== undefined) {
      this.guideInfluence = CesiumMath.clamp(patch.guideInfluence, 0, 1);
      this.options.guideInfluence = this.guideInfluence;
    }

    if (patch.trailLength !== undefined) {
      const newLength = Math.max(2, Math.round(patch.trailLength));
      if (newLength !== this.options.trailLength) {
        this.options.trailLength = newLength;
        this.respawn();
      }
    }

    if (patch.levelIndex !== undefined) {
      this.levelIndex = clampLevel(
        patch.levelIndex,
        this.field.levels.length
      );
      this.respawn();
    }

    if (patch.multiLevel !== undefined) {
      this.options.multiLevel = !!patch.multiLevel;
      this.respawn();
    }

    if (this.options.levelStride !== previousStride) {
      this._rebuildMultiLevelIndices();
      if (this.options.multiLevel) {
        this.respawn();
      }
    }

    if (this.options.maxParticles !== previousMax) {
      this._resizeParticlePool();
    } else {
      this.particles.forEach((particle) => {
        if (particle.line) {
          particle.line.width = this.options.lineWidth;
          if (toggledShowTrails) {
            particle.line.show = !!this.options.showTrails;
          }
        }
        if (particle.billboard) {
          particle.billboard.width = this.options.headSize * 4.5;
          particle.billboard.height = this.options.headSize * 1.8;
        }
        this._applyParticleColors(particle);
      });
    }
  }

  setColorRamp(ramp) {
    if (!ramp || typeof ramp.sample !== "function") {
      return;
    }
    this.colorRamp = ramp;
    this.particles.forEach((particle) => {
      this._applyParticleColors(particle);
    });
  }

  setPaused(paused) {
    this.paused = !!paused;
  }

  isPaused() {
    return this.paused;
  }

  updateCameraHeight(height = 0) {
    this._cameraHeight = Math.max(0, height);
    this._updateCameraPause();
  }

  setCameraPauseEnabled(enabled) {
    this.cameraPauseEnabled = !!enabled;
    this._updateCameraPause();
  }

  isAutoPaused() {
    return this._cameraPaused;
  }

  _updateCameraPause() {
    this._cameraPaused =
      this.cameraPauseEnabled &&
      this._cameraHeight > this.maxActiveCameraHeight;
  }

  _resizeParticlePool() {
    if (this.particles.length > this.options.maxParticles) {
      const excess = this.particles.splice(
        this.options.maxParticles,
        this.particles.length
      );
      excess.forEach((particle) => {
        if (particle.line) {
          this.collection.remove(particle.line);
        }
        if (particle.billboard && !this.billboardCollection.isDestroyed()) {
          this.billboardCollection.remove(particle.billboard);
        }
      });
      return;
    }

    while (this.particles.length < this.options.maxParticles) {
      const particle = this._createParticle();
      this.particles.push(particle);
    }
  }

  _sampleGuide(lonDeg, latDeg) {
    if (!this.flowGuides || this.guideInfluence <= 0) {
      return null;
    }
    return this.flowGuides.sample(lonDeg, latDeg);
  }

  _applyVisualOptionBounds() {
    const opts = this.options;
    opts.showTrails = opts.showTrails !== false;
    opts.fadeOpacity = CesiumMath.clamp(
      opts.fadeOpacity ?? DEFAULT_LAYER_OPTIONS.fadeOpacity,
      0.75,
      0.99
    );
    opts.headOpacity = CesiumMath.clamp(
      opts.headOpacity ?? DEFAULT_LAYER_OPTIONS.headOpacity,
      0.2,
      1.0
    );
    const minHead =
      opts.minHeadOpacity === undefined
        ? opts.headOpacity * 0.55
        : Number(opts.minHeadOpacity);
    opts.minHeadOpacity = CesiumMath.clamp(minHead, 0, opts.headOpacity);
    const maxHead =
      opts.maxHeadOpacity === undefined
        ? opts.headOpacity
        : Number(opts.maxHeadOpacity);
    opts.maxHeadOpacity = CesiumMath.clamp(
      maxHead,
      opts.minHeadOpacity,
      1
    );
    const minTrail =
      opts.minTrailOpacity === undefined
        ? opts.fadeOpacity * 0.5
        : Number(opts.minTrailOpacity);
    const maxTrail =
      opts.maxTrailOpacity === undefined
        ? opts.fadeOpacity
        : Number(opts.maxTrailOpacity);
    opts.minTrailOpacity = CesiumMath.clamp(minTrail, 0, 1);
    opts.maxTrailOpacity = CesiumMath.clamp(
      Math.max(opts.minTrailOpacity, maxTrail),
      opts.minTrailOpacity,
      1
    );
    opts.trailTaperPower = Math.max(0.3, Number(opts.trailTaperPower) || 1.2);
    opts.trailTailOpacity = CesiumMath.clamp(
      Number(opts.trailTailOpacity ?? 0.2),
      0,
      1
    );
    opts.lengthScale = Math.max(0.4, Number(opts.lengthScale) || 1);
    opts.lengthCurve = normalizeCurveName(opts.lengthCurve, "sqrt");
    opts.colorCurve = normalizeCurveName(
      opts.colorCurve,
      opts.lengthCurve
    );
    opts.lengthLogBase = Math.max(2, Number(opts.lengthLogBase) || 8);
    opts.colorLogBase = Math.max(
      2,
      Number(opts.colorLogBase) || opts.lengthLogBase
    );
    opts.colorLightness = Math.max(
      0,
      Math.min(1, Number(opts.colorLightness ?? 0.35))
    );
    opts.colorDarkness = Math.max(
      0,
      Math.min(1, Number(opts.colorDarkness ?? 0.18))
    );
    if (Number.isFinite(opts.minStreakLength)) {
      opts.minStreakLength = Math.max(1, Number(opts.minStreakLength));
    } else {
      opts.minStreakLength = null;
    }
    if (Number.isFinite(opts.maxStreakLength)) {
      const minLength = opts.minStreakLength ?? 1;
      opts.maxStreakLength = Math.max(
        minLength,
        Number(opts.maxStreakLength)
      );
    } else {
      opts.maxStreakLength = null;
    }
    opts.minBillboardLength = Math.max(
      0,
      Number(opts.minBillboardLength ?? DEFAULT_LAYER_OPTIONS.minBillboardLength) || 0
    );
    if (opts.minStreakLength !== null) {
      opts.minStreakLength = Math.max(opts.minBillboardLength, opts.minStreakLength);
    }
    if (opts.maxStreakLength !== null) {
      const minRef = opts.minStreakLength ?? opts.minBillboardLength;
      opts.maxStreakLength = Math.max(minRef, opts.maxStreakLength, opts.minBillboardLength);
    }
    opts.uniformStreakLength =
      Number.isFinite(opts.uniformStreakLength) && opts.uniformStreakLength > 0
        ? Math.max(opts.minBillboardLength, Number(opts.uniformStreakLength))
        : null;
    opts.uniformStreakThickness =
      Number.isFinite(opts.uniformStreakThickness) && opts.uniformStreakThickness > 0
        ? Math.max(1, Number(opts.uniformStreakThickness))
        : null;
    opts.uniformTrailMeters =
      Number.isFinite(opts.uniformTrailMeters) && opts.uniformTrailMeters > 0
        ? Math.max(5, Number(opts.uniformTrailMeters))
        : null;
    if (opts.uniformTrailMeters && targetPointsFromTrailLength(opts.trailLength) < 2) {
      opts.trailLength = 2;
    }
    opts.minWindSpeedRatio = CesiumMath.clamp(
      Number(opts.minWindSpeedRatio ?? DEFAULT_LAYER_OPTIONS.minWindSpeedRatio),
      0,
      1
    );
    opts.lifespanClampToDomain = opts.lifespanClampToDomain !== false;
    opts.speedBoost = Math.max(0.05, Number(opts.speedBoost ?? 1.0));
    opts.softStreakMode = opts.softStreakMode !== false;
    opts.softStreakMeters = Math.max(
      50,
      Number(opts.softStreakMeters ?? DEFAULT_LAYER_OPTIONS.softStreakMeters) || 200
    );
    opts.billboardOnly = opts.billboardOnly === true;
    if (opts.billboardOnly) {
      opts.showTrails = false;
    }
  }

  _applyParticleColors(particle, providedColorRatio = null) {
    if (!particle) {
      return;
    }
    const ratio =
      providedColorRatio ??
      mapResponseCurve(
        particle.speedRatio || 0,
        this.options.colorCurve,
        this.options.colorLogBase
      );
    const minTrailAlpha = Math.min(
      this.options.minTrailOpacity,
      this.options.maxTrailOpacity
    );
    const maxTrailAlpha = Math.max(
      this.options.minTrailOpacity,
      this.options.maxTrailOpacity
    );
    const trailAlpha = CesiumMath.lerp(minTrailAlpha, maxTrailAlpha, ratio);
    if (particle.line?.material?.uniforms) {
      const lineColor = tintColorBySpeed(
        colorFromRatio(this.colorRamp, ratio, trailAlpha),
        ratio,
        this.options.colorLightness,
        this.options.colorDarkness
      );
      particle.line.material.uniforms.color = brightenColor(
        lineColor,
        1.02,
        0.015
      );
      if (typeof particle.line.material.uniforms.glowPower === "number") {
        particle.line.material.uniforms.glowPower = CesiumMath.clamp(
          0.08 + ratio * 0.35,
          0.05,
          0.7
        );
      }
      if (typeof particle.line.material.uniforms.tailPower === "number") {
        particle.line.material.uniforms.tailPower = this.options.trailTaperPower;
      }
      if (typeof particle.line.material.uniforms.tailMinimum === "number") {
        particle.line.material.uniforms.tailMinimum = this.options.trailTailOpacity;
      }
    }
    if (particle.billboard) {
      const minHeadAlpha = Math.min(
        this.options.minHeadOpacity,
        this.options.maxHeadOpacity
      );
      const maxHeadAlpha = Math.max(
        this.options.minHeadOpacity,
        this.options.maxHeadOpacity
      );
      const headAlpha = CesiumMath.lerp(minHeadAlpha, maxHeadAlpha, ratio);
      const headColor = tintColorBySpeed(
        colorFromRatio(this.colorRamp, ratio, headAlpha),
        ratio,
        this.options.colorLightness * 0.8,
        this.options.colorDarkness * 0.8
      );
      particle.billboard.color = brightenColor(headColor, 1.18, 0.04);
    }
  }

  _initializeTrailHistory(particle, headPosition) {
    const targetPoints = targetPointsFromTrailLength(this.options.trailLength);
    if (!particle.line) {
      return;
    }
    const history = particle.history;
    history.length = 0;
    particle.historySegments = particle.historySegments || [];
    particle.historySegments.length = 0;
    particle.trailMeters = 0;
    for (let i = 0; i < targetPoints; i += 1) {
      history.push(Cartesian3.clone(headPosition));
      if (!this.options.softStreakMode && i > 0) {
        particle.historySegments.push(0);
      }
    }
    particle.historySegments.length = this.options.softStreakMode
      ? 0
      : Math.max(0, history.length - 1);
    if (particle.line) {
      particle.line.positions = history;
      particle.line.width = this.options.lineWidth;
      particle.line.show = this.options.showTrails;
    }
  }

  _updateParticleTrailHistory(particle, headPosition, displacement) {
    if (!particle.line) {
      return;
    }
    if (this.options.softStreakMode) {
      this._populateSoftStreak(particle, headPosition, displacement);
      return;
    }
    const history = particle.history;
    const segments = particle.historySegments || (particle.historySegments = []);
    if (!Number.isFinite(particle.trailMeters)) {
      particle.trailMeters = 0;
    }
    const targetPoints = targetPointsFromTrailLength(this.options.trailLength);
    const minPoints = Math.max(2, Math.min(targetPoints, 128));

    if (history.length === 0) {
      history.push(Cartesian3.clone(headPosition));
      particle.trailMeters = 0;
      segments.length = 0;
      return;
    }

    history.push(Cartesian3.clone(headPosition));
    const prev = history[history.length - 2];
    const segmentLength = Cartesian3.distance(prev, headPosition);
    segments.push(segmentLength);
    particle.trailMeters += segmentLength;

    while (history.length > targetPoints) {
      history.shift();
      const removed = segments.shift();
      if (Number.isFinite(removed)) {
        particle.trailMeters -= removed;
      }
    }

    if (this.options.uniformTrailMeters > 0) {
      const targetMeters = this.options.uniformTrailMeters;
      while (
        history.length > minPoints &&
        particle.trailMeters > targetMeters * 1.02
      ) {
        history.shift();
        const removed = segments.shift();
        if (Number.isFinite(removed)) {
          particle.trailMeters -= removed;
        }
      }
    }

    particle.line.positions = history;
  }

  _updatePolylineSegment(particle, headPosition, displacement, altitude) {
    if (!particle.line) {
      return;
    }
    const baseMeters = this.options.softStreakMeters || 2000;
    const maxMeters = baseMeters * 2.0;
    const maxSpeed = Math.max(this.field.maxSpeed || 1, 1e-3);
    const sampleSpeed = displacement.sampleSpeed || particle.speedRatio * maxSpeed || 0;
    const speedRatio = CesiumMath.clamp(sampleSpeed / maxSpeed, 0, 1);
    const minFactor = 0.45;
    const maxFactor = 1.0;
    const factor = CesiumMath.lerp(minFactor, maxFactor, Math.sqrt(speedRatio));
    const segMeters = CesiumMath.clamp(baseMeters * factor, baseMeters * 0.3, maxMeters);

    let east = displacement.eastMeters;
    let north = displacement.northMeters;
    if (!Number.isFinite(east) || !Number.isFinite(north) || (Math.abs(east) < 1e-4 && Math.abs(north) < 1e-4)) {
      const heading = Number.isFinite(particle.heading) ? particle.heading : 0;
      east = Math.sin(heading);
      north = Math.cos(heading);
    }
    const mag = Math.hypot(east, north) || 1;
    const ue = east / mag;
    const un = north / mag;

    const latRad = CesiumMath.toRadians(particle.lat);
    const cosLat = Math.max(Math.cos(latRad), 0.01);

    const lonOffset =
      ((-ue * segMeters) / (EARTH_RADIUS * cosLat)) *
      CesiumMath.DEGREES_PER_RADIAN;
    const latOffset =
      ((-un * segMeters) / EARTH_RADIUS) *
      CesiumMath.DEGREES_PER_RADIAN;

    const tailPosition = Cartesian3.fromDegrees(
      particle.lon + lonOffset,
      particle.lat + latOffset,
      altitude
    );

    particle.line.positions = [tailPosition, headPosition];
  }

  _populateSoftStreak(particle, headPosition, displacement) {
    if (!particle.line) {
      return;
    }
    const history = particle.history;
    const targetPoints = targetPointsFromTrailLength(this.options.trailLength);
    const points = Math.max(2, targetPoints);
    const totalLength =
      this.options.softStreakMeters ||
      this.options.uniformTrailMeters ||
      this.options.uniformStreakLength * 5 ||
      200;
    const stepMeters = totalLength / Math.max(1, points - 1);
    const direction = this._headingComponents(particle, displacement);
    const latRad = CesiumMath.toRadians(particle.lat);
    const cosLat = Math.max(Math.cos(latRad), 0.01);
    while (history.length < points) {
      history.push(Cartesian3.clone(headPosition));
    }
    if (history.length > points) {
      history.length = points;
    }
    for (let i = 0; i < points; i += 1) {
      const offset = stepMeters * i;
      const lonOffset =
        ((direction.east * offset) / (EARTH_RADIUS * cosLat)) *
        CesiumMath.DEGREES_PER_RADIAN;
      const latOffset =
        ((direction.north * offset) / EARTH_RADIUS) *
        CesiumMath.DEGREES_PER_RADIAN;
      const index = points - i - 1;
      history[index] = Cartesian3.fromDegrees(
        particle.lon - lonOffset,
        particle.lat - latOffset,
        headPosition.z
      );
    }
    particle.line.positions = history;
  }

  _headingComponents(particle, displacement) {
    let east = displacement?.eastMeters;
    let north = displacement?.northMeters;
    if (
      !Number.isFinite(east) ||
      !Number.isFinite(north) ||
      (Math.abs(east) < 1e-4 && Math.abs(north) < 1e-4)
    ) {
      const heading = Number.isFinite(particle.heading) ? particle.heading : 0;
      east = Math.sin(heading);
      north = Math.cos(heading);
    }
    const mag = Math.hypot(east, north) || 1;
    return { east: east / mag, north: north / mag };
  }

  _createParticle() {
    const placeholder = Cartesian3.clone(Cartesian3.ZERO);
    const path = [placeholder.clone(), placeholder.clone()];
    const particle = {
      lon: 0,
      lat: 0,
      age: 0,
      levelIndex: 0,
      altitude: 0,
      speedRatio: 0,
      heading: 0,
      history: path,
      historySegments: [],
      trailMeters: 0,
      line: this.options.billboardOnly
        ? null
        : this.collection.add({
            positions: path,
            width: this.options.lineWidth,
            material: Material.fromType(Material.PolylineGlowType, {
              color: Color.WHITE.clone(),
              glowPower: 0.2,
              taperPower: this.options.trailTaperPower,
            }),
            show: this.options.showTrails,
          }),
      billboard: this.billboardCollection.add({
        position: Cartesian3.clone(Cartesian3.ZERO),
        color: colorFromRatio(this.colorRamp, 0, this.options.headOpacity),
        width: this.options.headSize * 4.5,
        height: this.options.headSize * 1.8,
        image: getParticleTexture(),
        alignedAxis: Cartesian3.UNIT_Z,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      }),
      prevLon: 0,
      prevLat: 0,
      prevPosition: null,
      noiseSeed: Math.random() * Math.PI * 2,
      prevWind: null,
    };
    this._resetParticle(particle);
    return particle;
  }

  _resetParticle(particle, keepAge = false) {
    const seed = this.field.randomPosition();
    particle.lon = seed.lon;
    particle.lat = seed.lat;
    particle.prevLon = seed.lon;
    particle.prevLat = seed.lat;
    particle.prevPosition = null;
    particle.prevWind = null;
    particle.heading = 0;
    particle.age = keepAge ? particle.age : Math.random() * this.options.maxAge;
    particle.history.length = 0;

    let levelIndex;
    if (this.options.multiLevel) {
      const indices =
        this._multiLevelIndices && this._multiLevelIndices.length
          ? this._multiLevelIndices
          : [0];
      const picked = Math.floor(Math.random() * indices.length);
      levelIndex = indices[picked];
    } else {
      levelIndex = this.levelIndex;
    }
    particle.levelIndex = levelIndex;

    const altitude = this.field.altitudeForLevel(levelIndex) + 200;
    particle.altitude = altitude;

    const firstPosition = Cartesian3.fromDegrees(
      particle.lon,
      particle.lat,
      altitude
    );
    this._initializeTrailHistory(particle, firstPosition);
    particle.prevPosition = firstPosition.clone();
    if (particle.billboard) {
      particle.billboard.position = firstPosition;
      particle.billboard.color = colorFromRatio(
        this.colorRamp,
        0,
        this.options.headOpacity
      );
      particle.billboard.width = this.options.headSize * 4.5;
      particle.billboard.height = this.options.headSize * 1.8;
      particle.billboard.rotation = 0;
      particle.billboard.show = true;
    }
    this._applyParticleColors(particle, 0);
  }

  _rebuildMultiLevelIndices() {
    const levelsCount = this.field.levels.length;
    const indices = [];
    if (levelsCount === 0) {
      this._multiLevelIndices = indices;
      return;
    }

    const effectiveStride = Math.max(1, Math.round(this.options.levelStride || 1));
    for (let i = 0; i < levelsCount; i += effectiveStride) {
      indices.push(i);
    }
    if (indices.length === 0) {
      indices.push(0);
    }
    this._multiLevelIndices = indices;
  }

  _windToDisplacement(lonDeg, latDeg, wind, deltaSeconds) {
    if (!wind) {
      return null;
    }
    const delta = Math.max(deltaSeconds, 1e-4);
    const latRad = CesiumMath.toRadians(latDeg);
    const cosLat = Math.max(Math.cos(latRad), 0.01);
    let u = wind.u;
    let v = wind.v;
    const minSpeedRatio = Math.max(0, this.options.minWindSpeedRatio || 0);
    if (minSpeedRatio > 0 && this.field?.maxSpeed > 0) {
      const minSpeed = this.field.maxSpeed * minSpeedRatio;
      const planarMag = Math.hypot(u, v);
      if (planarMag < minSpeed) {
        const boost = minSpeed / Math.max(planarMag, 1e-5);
        u *= boost;
        v *= boost;
      }
    }
    const guide = this._sampleGuide(lonDeg, latDeg);
    if (guide && this.guideInfluence > 0) {
      const blend = this.guideInfluence;
      const windMag = Math.hypot(u, v) || 1;
      const guideMag = Math.hypot(guide.u, guide.v) || windMag;
      const wu = u / windMag;
      const wv = v / windMag;
      const gu = guide.u / guideMag;
      const gv = guide.v / guideMag;
      const mixU = CesiumMath.lerp(wu, gu, blend);
      const mixV = CesiumMath.lerp(wv, gv, blend);
      const targetMag = CesiumMath.lerp(windMag, guideMag, blend * 0.65);
      u = mixU * targetMag;
      v = mixV * targetMag;
    }
    const speedScale =
      this.options.speedFactor * (this.options.speedBoost || 1) * delta;
    const eastMeters = u * speedScale;
    const northMeters = v * speedScale;
    const wClamped = CesiumMath.clamp(wind.w, -5, 5);
    const dAlt = wClamped * this.options.verticalScale * delta;
    const dLon =
      ((eastMeters / (EARTH_RADIUS * cosLat)) || 0) *
      CesiumMath.DEGREES_PER_RADIAN;
    const dLat =
      ((northMeters / EARTH_RADIUS) || 0) * CesiumMath.DEGREES_PER_RADIAN;
    return {
      dLon,
      dLat,
      dAlt,
      eastMeters,
      northMeters,
      sampleSpeed:
        Math.sqrt(u * u + v * v + wClamped * wClamped) ||
        (wind.speed ||
          Math.sqrt(wind.u * wind.u + wind.v * wind.v + wind.w * wind.w)),
      windSample: wind,
    };
  }

  _integrateDisplacement(particle, levelIndex, delta, initialWind) {
    const first = this._windToDisplacement(
      particle.lon,
      particle.lat,
      initialWind,
      delta
    );
    if (!first) {
      return null;
    }
    if (this.integrationSteps <= 1) {
      return first;
    }
    const midLon = particle.lon + first.dLon * 0.5;
    const midLat = particle.lat + first.dLat * 0.5;
    if (!this.field.contains(midLon, midLat)) {
      return first;
    }
    const midWind = this.field.interpolate(midLon, midLat, levelIndex);
    if (!midWind) {
      return first;
    }
    const midDisp = this._windToDisplacement(midLon, midLat, midWind, delta);
    if (!midDisp) {
      return first;
    }
    return {
      dLon: (first.dLon + midDisp.dLon) * 0.5,
      dLat: (first.dLat + midDisp.dLat) * 0.5,
      dAlt: (first.dAlt + midDisp.dAlt) * 0.5,
      eastMeters: (first.eastMeters + midDisp.eastMeters) * 0.5,
      northMeters: (first.northMeters + midDisp.northMeters) * 0.5,
      sampleSpeed: (first.sampleSpeed + midDisp.sampleSpeed) * 0.5,
      windSample: midDisp.windSample,
    };
  }

  _resolveAltitude(particle, levelIndex, deltaAlt) {
    const baseAltitude = this.options.surfaceClamp
      ? this.field._minHeight + 120
      : this.field.altitudeForLevel(levelIndex) + 200;
    if (!Number.isFinite(particle.altitude)) {
      particle.altitude = baseAltitude;
    }
    const minAltitude = Math.max(
      this.options.surfaceClamp
        ? this.field._minHeight * 0.95
        : this.field._minHeight * 0.75,
      baseAltitude - this.options.verticalScale * 0.5
    );
    const maxAltitude = Math.min(
      this.field._maxHeight * 1.2,
      baseAltitude + this.options.verticalScale * 1.6
    );
    const delta = CesiumMath.clamp(
      deltaAlt,
      -this.options.verticalScale,
      this.options.verticalScale
    );
    const relaxed = CesiumMath.lerp(particle.altitude, baseAltitude, 0.02);
    const altitude = CesiumMath.clamp(relaxed + delta, minAltitude, maxAltitude);
    particle.altitude = altitude;
    return altitude;
  }

  _tick(clock) {
    if (this.paused || this._cameraPaused) {
      return;
    }
    const delta = clock?.deltaSeconds || 1 / 60;
    this._intervalAccumulator += delta;
    if (this._intervalAccumulator < this.updateInterval) {
      return;
    }
    const stepDelta = Math.min(this._intervalAccumulator, 0.12);
    this._intervalAccumulator = 0;
    this._updateParticles(stepDelta, clock);
  }

  _updateParticles(deltaSeconds, clockRef) {
    const delta = deltaSeconds || 1 / 60;
    const maxSpeed = Math.max(this.field.maxSpeed, 0.001);
    let dirty = false;

    for (const particle of this.particles) {
      const levelIndex = this.options.multiLevel
        ? particle.levelIndex
        : this.levelIndex;
      const withinMargin = this.field.containsWithMargin(
        particle.lon,
        particle.lat,
        RESET_MARGIN_DEG
      );
      let wind = this.field.interpolate(particle.lon, particle.lat, levelIndex);
      if (!isValidWindSample(wind)) {
        if (particle.prevWind && isValidWindSample(particle.prevWind)) {
          wind = cloneWind(particle.prevWind);
        } else {
          if (!withinMargin) {
            this._resetParticle(particle);
          }
          continue;
        }
      }

      const displacement = this._integrateDisplacement(
        particle,
        levelIndex,
        delta,
        wind
      );
      if (!displacement) {
        if (!withinMargin) {
          this._resetParticle(particle);
        }
        continue;
      }

      particle.lon += displacement.dLon;
      particle.lat += displacement.dLat;

      if (
        !this.field.containsWithMargin(
          particle.lon,
          particle.lat,
          RESET_MARGIN_DEG
        )
      ) {
        this._resetParticle(particle);
        continue;
      }

      const altitude = Math.max(
        200,
        this._resolveAltitude(particle, levelIndex, displacement.dAlt)
      );

      const effectiveClock = clockRef || this.viewer?.clock;
      const timeSeconds = effectiveClock?.currentTime?.secondsOfDay || 0;
      const noisePhase = timeSeconds * 0.05 + (particle.noiseSeed || 0);
      const offsetLonMeters = Math.cos(noisePhase) * FLOW_NOISE_LON_METERS;
      const offsetLatMeters = Math.sin(noisePhase * 0.7) * FLOW_NOISE_LAT_METERS;
      const lonOffset =
        offsetLonMeters /
        (Math.max(1e-3, Math.cos(CesiumMath.toRadians(particle.lat))) * EARTH_RADIUS) *
        CesiumMath.DEGREES_PER_RADIAN;
      const latOffset = (offsetLatMeters / EARTH_RADIUS) * CesiumMath.DEGREES_PER_RADIAN;
      const altitudeOffset =
        Math.sin(noisePhase * 1.3) * FLOW_NOISE_ALT_METERS;
      const rawPosition = Cartesian3.fromDegrees(
        particle.lon + lonOffset,
        particle.lat + latOffset,
        altitude + altitudeOffset
      );
      let smoothedPosition;
      if (particle.prevPosition) {
        smoothedPosition = Cartesian3.clone(rawPosition);
        Cartesian3.lerp(
          particle.prevPosition,
          rawPosition,
          FLOW_NOISE_SMOOTH_FACTOR,
          smoothedPosition
        );
      } else {
        smoothedPosition = Cartesian3.clone(rawPosition);
      }
      particle.prevPosition = Cartesian3.clone(smoothedPosition);
      this._updatePolylineSegment(particle, smoothedPosition, displacement, altitude);
      const windForColor = displacement.windSample || wind;
      const speedForColor =
        windForColor?.speed ?? displacement.sampleSpeed ?? wind.speed ?? 0;
      const normalizedSpeed = Math.max(
        0,
        Math.min(1, speedForColor / Math.max(1e-5, maxSpeed))
      );
      const lengthRatio = mapResponseCurve(
        normalizedSpeed,
        this.options.lengthCurve,
        this.options.lengthLogBase
      );
      const colorRatio = mapResponseCurve(
        normalizedSpeed,
        this.options.colorCurve,
        this.options.colorLogBase
      );
      const scene = this.viewer.scene;
      let visible = true;
      if (this.options.screenCulling) {
        const windowCoord = SceneTransforms.wgs84ToWindowCoordinates(
          scene,
          smoothedPosition
        );
        if (!windowCoord) {
          visible = false;
        } else {
          const canvas = scene.canvas;
          const padding = 120;
          visible =
            windowCoord.x >= -padding &&
            windowCoord.x <= canvas.clientWidth + padding &&
            windowCoord.y >= -padding &&
            windowCoord.y <= canvas.clientHeight + padding;
        }
      }

      const altitudeRatio = CesiumMath.clamp(
        (altitude - this.field._minHeight) /
          (this.field._maxHeight - this.field._minHeight || 1),
        0,
        1
      );
      if (particle.billboard) {
        const east = displacement.eastMeters || 0;
        const north = displacement.northMeters || 1e-5;
        const heading = Math.atan2(east, north);
        const fallbackMin =
          this.options.headSize * (this.options.minStreakScale || 2.2);
        const fallbackMax =
          this.options.headSize * (this.options.maxStreakScale || 6.5);
        const minStreak =
          this.options.minStreakLength ?? fallbackMin;
        const maxStreak =
          this.options.maxStreakLength ?? fallbackMax;
        const minBillboardLength = Math.max(
          2,
          this.options.minBillboardLength || 0
        );
        const streakMin = Math.max(minBillboardLength, minStreak, 2);
        const streakMax = Math.max(streakMin, maxStreak, minBillboardLength);
        const baseLength =
          this.options.headSize * (0.9 + this.options.lengthScale * lengthRatio);
        const altitudeScale = 0.7 + altitudeRatio * 0.6;
        let streakLength;
        if (Number.isFinite(this.options.uniformStreakLength) && this.options.uniformStreakLength > 0) {
          streakLength = this.options.uniformStreakLength;
        } else {
          streakLength = CesiumMath.clamp(
            baseLength * altitudeScale,
            streakMin,
            streakMax
          );
        }
        const streakThickness = Number.isFinite(
          this.options.uniformStreakThickness
        )
          ? this.options.uniformStreakThickness
          : Math.max(
              this.options.headSize * 0.8,
              streakLength * (this.options.streakAspect || 0.18)
            );
        particle.billboard.position = smoothedPosition;
        particle.billboard.width = streakLength;
        particle.billboard.height = streakThickness;
        particle.billboard.rotation = -heading;
        particle.billboard.show = visible;
        particle.heading = heading;
      }
      this._applyParticleColors(particle, colorRatio);
      particle.prevLon = particle.lon;
      particle.prevLat = particle.lat;
      particle.prevWind = cloneWind(windForColor || wind);
      if (particle.line) {
        particle.line.show = visible && this.options.showTrails;
      }
      particle.speedRatio = normalizedSpeed;

      particle.age += 1;
      if (
        !this.options.lifespanClampToDomain &&
        particle.age >= this.options.maxAge
      ) {
        this._resetParticle(particle);
        continue;
      }
      if (
        !this.field.containsWithMargin(
          particle.lon,
          particle.lat,
          RESET_MARGIN_DEG
        )
      ) {
        this._resetParticle(particle);
      }
      dirty = true;
    }

    if (dirty) {
      this.viewer.scene.requestRender();
    }
  }
}

export class WindFlowGuides {
  constructor(windField, options = {}) {
    this.field = windField;
    this.options = { ...DEFAULT_GUIDE_OPTIONS, ...options };
    this._grid = [];
    this._build();
  }

  update(options = {}) {
    this.options = { ...this.options, ...options };
    this._build();
  }

  _build() {
    const lonValues = this.field.lonValues || [];
    const latValues = this.field.latValues || [];
    const latCount = latValues.length;
    const lonCount = lonValues.length;
    this._grid = new Array(latCount)
      .fill(null)
      .map(() => new Array(lonCount).fill(null));
    if (!latCount || !lonCount) {
      return;
    }
    const levelIndex = clampLevel(this.options.levelIndex, this.field.levels.length);
    const seeds = this._generateSeeds();
    seeds.forEach(({ lon, lat }) => {
      let currentLon = lon;
      let currentLat = lat;
      for (let step = 0; step < this.options.maxSteps; step += 1) {
        if (!this.field.contains(currentLon, currentLat)) {
          break;
        }
        const wind = this.field.interpolate(currentLon, currentLat, levelIndex);
        if (!wind) {
          break;
        }
        this._accumulate(currentLon, currentLat, wind);
        const disp = this._basicDisplacement(currentLat, wind);
        currentLon += disp.dLon;
        currentLat += disp.dLat;
      }
    });
  }

  _generateSeeds() {
    const seeds = [];
    const lonValues = this.field.lonValues || [];
    const latValues = this.field.latValues || [];
    const stride = Math.max(1, Math.round(this.options.seedStride || 2));
    for (let latIdx = stride; latIdx < latValues.length - stride; latIdx += stride) {
      for (let lonIdx = stride; lonIdx < lonValues.length - stride; lonIdx += stride) {
        seeds.push({
          lon: lonValues[lonIdx],
          lat: latValues[latIdx],
        });
      }
    }
    return seeds;
  }

  _basicDisplacement(latDeg, wind) {
    const seconds = Math.max(this.options.stepSeconds, 60);
    const latRad = CesiumMath.toRadians(latDeg);
    const cosLat = Math.max(Math.cos(latRad), 0.01);
    const eastMeters = wind.u * seconds;
    const northMeters = wind.v * seconds;
    return {
      dLon:
        ((eastMeters / (EARTH_RADIUS * cosLat)) || 0) *
        CesiumMath.DEGREES_PER_RADIAN,
      dLat:
        ((northMeters / EARTH_RADIUS) || 0) *
        CesiumMath.DEGREES_PER_RADIAN,
    };
  }

  _accumulate(lon, lat, wind) {
    const lonIdx = nearestIndex(this.field.lonValues, lon);
    const latIdx = nearestIndex(this.field.latValues, lat);
    if (lonIdx === null || latIdx === null) {
      return;
    }
    if (!this._grid[latIdx][lonIdx]) {
      this._grid[latIdx][lonIdx] = { u: 0, v: 0, count: 0 };
    }
    const cell = this._grid[latIdx][lonIdx];
    cell.u += wind.u;
    cell.v += wind.v;
    cell.count += 1;
  }

  sample(lon, lat) {
    const lonIdx = nearestIndex(this.field.lonValues, lon);
    const latIdx = nearestIndex(this.field.latValues, lat);
    if (lonIdx === null || latIdx === null) {
      return null;
    }
    const cell = this._grid?.[latIdx]?.[lonIdx];
    if (!cell || !cell.count) {
      return null;
    }
    return {
      u: cell.u / cell.count,
      v: cell.v / cell.count,
    };
  }
}

function bilinear(g00, g01, g10, g11, x, y) {
  const rx = Math.max(0, Math.min(1, x));
  const ry = Math.max(0, Math.min(1, y));
  return (
    g00 * (1 - rx) * (1 - ry) +
    g01 * rx * (1 - ry) +
    g10 * (1 - rx) * ry +
    g11 * rx * ry
  );
}

function findInterval(values, target) {
  if (values.length < 2) {
    return null;
  }

  const first = values[0];
  const last = values[values.length - 1];
  const ascending = last >= first;

  if (ascending) {
    if (target < first || target > last) {
      return null;
    }
  } else if (target > first || target < last) {
    return null;
  }

  for (let i = 0; i < values.length - 1; i += 1) {
    const v0 = values[i];
    const v1 = values[i + 1];
    const min = Math.min(v0, v1);
    const max = Math.max(v0, v1);
    if (target >= min && target <= max) {
      return i;
    }
  }
  return null;
}

function nearestIndex(values, target) {
  if (!values || values.length === 0) {
    return null;
  }
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = values[mid];
    if (value === target) {
      return mid;
    }
    if (value < target) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const clampedLow = Math.min(Math.max(low, 0), values.length - 1);
  const clampedHigh = Math.min(Math.max(high, 0), values.length - 1);
  const lowDist = Math.abs(values[clampedLow] - target);
  const highDist = Math.abs(values[clampedHigh] - target);
  return lowDist <= highDist ? clampedLow : clampedHigh;
}

function clampLevel(index, length) {
  return Math.min(Math.max(Math.floor(index), 0), Math.max(length - 1, 0));
}

export class WindStreamLayer {
  constructor(viewer, windField, options = {}) {
    this.viewer = viewer;
    this.field = windField;
    this.options = { ...DEFAULT_STREAM_OPTIONS, ...options };
    this.collection = viewer.scene.primitives.add(new PolylineCollection());
    this._colorRamp =
      this.options.colorRamp && typeof this.options.colorRamp.sample === "function"
        ? this.options.colorRamp
        : getColorRamp(this.options.colorRampName || DEFAULT_RAMP_NAME);
    this._rebuild();
  }

  destroy() {
    if (this.collection && !this.collection.isDestroyed?.()) {
      this.viewer.scene.primitives.remove(this.collection);
    }
    this.collection = null;
  }

  update(options = {}) {
    this.options = { ...this.options, ...options };
    this._colorRamp =
      this.options.colorRamp && typeof this.options.colorRamp.sample === "function"
        ? this.options.colorRamp
        : getColorRamp(this.options.colorRampName || DEFAULT_RAMP_NAME);
    this._rebuild();
  }

  _rebuild() {
    if (!this.collection || !this.field) {
      return;
    }
    this.collection.removeAll();
    const levelIndex = clampLevel(this.options.levelIndex, this.field.levels.length);
    const seeds = this._generateSeeds();
    seeds.forEach(({ lon, lat }) => {
      const result = this._integrateStream(lon, lat, levelIndex);
      if (!result || result.positions.length < this.options.minPathLength) {
        return;
      }
      const color = brightenColor(
        colorFromRatio(this._colorRamp || DEFAULT_COLOR_RAMP, result.intensity, this.options.opacity),
        1.08,
        0.04
      );
      this.collection.add({
        positions: result.positions,
        width: this.options.lineWidth,
        material: Material.fromType(Material.PolylineGlowType, {
          color,
          glowPower: CesiumMath.clamp(
            this.options.glowPower * (0.9 + result.intensity * 0.6),
            0.05,
            0.8
          ),
        }),
      });
    });
  }

  _generateSeeds() {
    const seeds = [];
    const lonValues = this.field.lonValues || [];
    const latValues = this.field.latValues || [];
    const stride = Math.max(1, Math.round(this.options.seedStride || 2));
    const jitter = this.options.seedJitter ?? 0.35;
    for (let latIdx = stride; latIdx < latValues.length - stride; latIdx += stride) {
      for (let lonIdx = stride; lonIdx < lonValues.length - stride; lonIdx += stride) {
        const lon =
          lonValues[lonIdx] + (Math.random() - 0.5) * jitter * 0.05;
        const lat =
          latValues[latIdx] + (Math.random() - 0.5) * jitter * 0.05;
        seeds.push({ lon, lat });
      }
    }
    return seeds;
  }

  _integrateStream(startLon, startLat, levelIndex) {
    const positions = [];
    let lon = startLon;
    let lat = startLat;
    const clampSurface = !!this.options.clampSurface;
    const maxSteps = Math.max(6, Math.round(this.options.maxSteps));
    const verticalScale = Math.max(0, this.options.verticalScale || 0);
    let peakSpeed = 0;
    const baseAltitude = clampSurface
      ? this.field._minHeight + 80
      : this.field.altitudeForLevel(levelIndex) + 180;

    positions.push(Cartesian3.fromDegrees(lon, lat, baseAltitude));
    for (let step = 0; step < maxSteps; step += 1) {
      if (!this.field.contains(lon, lat)) {
        break;
      }
      const wind = this.field.interpolate(lon, lat, levelIndex);
      if (!wind) {
        break;
      }
      const displacement = this._windToDisplacement(lat, wind);
      lon += displacement.dLon;
      lat += displacement.dLat;
      peakSpeed = Math.max(peakSpeed, displacement.sampleSpeed);
      const altitude = clampSurface
        ? baseAltitude
        : baseAltitude + CesiumMath.clamp(displacement.dAlt * verticalScale, -verticalScale, verticalScale);
      positions.push(Cartesian3.fromDegrees(lon, lat, altitude));
    }

    return {
      positions,
      intensity: peakSpeed > 0 ? CesiumMath.clamp(peakSpeed / (this.field.maxSpeed || 1), 0, 1) : 0,
    };
  }

  _windToDisplacement(latDeg, wind) {
    const seconds = Math.max(this.options.stepSeconds, 30);
    const scale = this.options.speedScale || 1;
    const latRad = CesiumMath.toRadians(latDeg);
    const cosLat = Math.max(Math.cos(latRad), 0.01);
    const eastMeters = wind.u * seconds * scale;
    const northMeters = wind.v * seconds * scale;
    const dAlt = CesiumMath.clamp(wind.w || 0, -5, 5);
    return {
      dLon:
        ((eastMeters / (EARTH_RADIUS * cosLat)) || 0) *
        CesiumMath.DEGREES_PER_RADIAN,
      dLat:
        ((northMeters / EARTH_RADIUS) || 0) *
        CesiumMath.DEGREES_PER_RADIAN,
      dAlt,
      sampleSpeed:
        wind.speed ??
        Math.sqrt((wind.u || 0) ** 2 + (wind.v || 0) ** 2 + (wind.w || 0) ** 2),
    };
  }
}
