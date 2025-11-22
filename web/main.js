import {
  WindField,
  WindParticleLayer,
  WindStreamLayer,
} from "./windLayer.js";
import * as ColorRamp from "./colorRamp.js?v=2";

const { DEFAULT_RAMP_NAME, getColorRamp, listColorRampOptions } = ColorRamp;

const WIND_DATA_URL = "./wind_3d_full.geojson";

// 先创建一个不带默认底图的 Viewer
function patchCesiumDerivedCommands() {
  const DrawCommand = Cesium?.DrawCommand;
  if (!DrawCommand || DrawCommand._windPatchApplied) {
    return;
  }
  const wrap = (methodName) => {
    const original = DrawCommand[methodName];
    if (typeof original !== "function") {
      return;
    }
    DrawCommand[methodName] = function patchedDerivedCommand(command, ...args) {
      if (!command || !command.shaderProgram) {
        return undefined;
      }
      return original.call(this, command, ...args);
    };
  };
  wrap("createPickDerivedCommand");
  wrap("createLogDepthCommand");
  wrap("createDerivedCommand");
  DrawCommand._windPatchApplied = true;
}

function patchDrawCommandExecute() {
  const DrawCommand = Cesium?.DrawCommand;
  if (!DrawCommand || DrawCommand._windExecutePatched) {
    return;
  }
  const proto = DrawCommand.prototype;
  if (typeof proto.execute === "function") {
    const originalExecute = proto.execute;
    proto.execute = function patchedExecute(context, passState) {
      if (
        !this.shaderProgram ||
        !this.vertexArray
      ) {
        return;
      }
      try {
        return originalExecute.call(this, context, passState);
      } catch (err) {
        console.warn("Skipped draw command due to missing resources", err);
        return;
      }
    };
  }
  DrawCommand._windExecutePatched = true;
}

function patchCesiumContextDerivedShaders() {
  const Context = Cesium?.Context;
  if (!Context || Context._windPatchApplied) {
    return;
  }
  const original = Context.prototype.getDerivedShaderProgram;
  if (typeof original === "function") {
    Context.prototype.getDerivedShaderProgram = function patchedGetDerivedShaderProgram(
      shaderProgram,
      ...rest
    ) {
      if (!shaderProgram) {
        return undefined;
      }
      return original.call(this, shaderProgram, ...rest);
    };
  }
  Context._windPatchApplied = true;
}

patchCesiumDerivedCommands();
patchDrawCommandExecute();
patchCesiumContextDerivedShaders();
function patchSceneDerivedUpdates() {
  const Scene = Cesium?.Scene;
  if (!Scene || Scene._windDerivedPatched) {
    return;
  }
  const original = Scene.prototype.updateDerivedCommands;
  if (typeof original === "function") {
    Scene.prototype.updateDerivedCommands = function patchedUpdateDerivedCommands(
      command,
      ...rest
    ) {
      if (!command || !command.shaderProgram) {
        return undefined;
      }
      try {
        return original.call(this, command, ...rest);
      } catch (err) {
        console.warn("Skipped derived command due to shader error", err);
        return undefined;
      }
    };
  }
  Scene._windDerivedPatched = true;
}
patchSceneDerivedUpdates();

const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  infoBox: false,
  imageryProvider: false, // 不要默认底图
});

// 全局场景风格：黑色天空 + 高对比地形
viewer.scene.backgroundColor = Cesium.Color.BLACK;
viewer.scene.skyBox = undefined;
viewer.scene.skyAtmosphere.show = false;
viewer.scene.globe.showGroundAtmosphere = false;
viewer.scene.logarithmicDepthBuffer = false; // 关闭场景级对数深度，避免自定义 primitive 缺少派生 shader 时出错
if (viewer.scene?.globe) {
  viewer.scene.globe.logarithmicDepth = false; // 同步关闭地球底层的对数深度命令
}
// Cesium 初始化时仍会创建 LogDepthBuffer，这里强制销毁，防止后续派生 log-depth shader
if (viewer.scene?._logDepthBuffer) {
  try {
    viewer.scene._logDepthBuffer.destroy();
  } catch (err) {
    console.warn("LogDepthBuffer destroy warning:", err);
  }
  viewer.scene._logDepthBuffer = undefined;
}
viewer.scene.globe.baseColor = Cesium.Color.fromBytes(235, 235, 230, 255);
viewer.scene.globe.undergroundColor = Cesium.Color.BLACK;
viewer.scene.globe.enableLighting = true;
viewer.shadows = true;
viewer.scene.globe.castShadows = true;
viewer.scene.globe.receiveShadows = true;
viewer.terrainShadows = Cesium.ShadowMode.ENABLED;
viewer.scene.shadowMap.darkness = 0.45;
viewer.scene.shadowMap.size = 4096;
viewer.scene.light = new Cesium.DirectionalLight({
  direction: new Cesium.Cartesian3(0.25, -0.7, 0.6),
  color: Cesium.Color.WHITE,
  intensity: 1.1,
});

// 调整相机控制，让旋转/缩放更顺手
const controller = viewer.scene.screenSpaceCameraController;
controller.minimumZoomDistance = 500.0;
controller.maximumZoomDistance = 2000000.0;
controller.enableTilt = true;
controller.enableLook = true;

let baseLayer = null;

const defaultColorRamp = getColorRamp(DEFAULT_RAMP_NAME);

const VISUAL_COMPENSATION_OVERRIDES = Object.freeze({
  minStreakLength: 58,
  maxStreakLength: 520,
  minBillboardLength: 64,
  uniformStreakLength: null,
  uniformStreakThickness: null,
  uniformTrailMeters: null,
  lengthCurve: "log",
  lengthLogBase: 4.2,
  lengthScale: 5.0,
  minHeadOpacity: 0.56,
  maxHeadOpacity: 0.98,
  minTrailOpacity: 0.32,
  maxTrailOpacity: 0.95,
  colorLightness: 0.5,
  colorDarkness: 0.18,
  trailTaperPower: 1.6,
  trailTailOpacity: 0.34,
  showTrails: true,
  headSize: 22,
  minWindSpeedRatio: 0.12,
  lifespanClampToDomain: true,
  speedBoost: 20.0,
  billboardOnly: false,
  softStreakMode: false,
  softStreakMeters: 2000,
});

const PRESETS = {
  clear: {
    particleCount: 500,
    speedFactor: 10.0,
    lineWidth: 1,
    trailLength: 5,
    fadeOpacity: 0.85,
    verticalScale: 900,
    multiLevel: false,
    levelStride: 1,
    colorRampName: "neonVortex",
    view: "oblique",
    surfaceClamp: false,
    layerOverrides: {
      dropRate: 0.002,
      dropRateBump: 0.004,
      headSize: 5.5,
      streakAspect: 0.18,
    },
    message: "清晰查看模式：粒子密度降低，方便对照底图。",
  },
  stream: {
    particleCount: 1200,
    speedFactor: 14.0,
    lineWidth: 1.1,
    trailLength: 12,
    fadeOpacity: 0.9,
    verticalScale: 800,
    multiLevel: false,
    levelStride: 1,
    colorRampName: "neonVortex",
    view: "top",
    surfaceClamp: false,
    layerOverrides: {
      dropRate: 0.0016,
      dropRateBump: 0.0045,
      headSize: 6,
      streakAspect: 0.18,
    },
    message: "流线模式：长轨迹突出整体流向。",
  },
  showcase: {
    particleCount: 1700,
    speedFactor: 18.0,
    lineWidth: 0.9,
    trailLength: 14,
    fadeOpacity: 0.93,
    verticalScale: 1800,
    multiLevel: true,
    levelStride: 2,
    colorRampName: "neonVortex",
    view: "oblique",
    surfaceClamp: false,
    layerOverrides: {
      dropRate: 0.0012,
      dropRateBump: 0.0035,
      headSize: 7,
      headOpacity: 0.95,
      streakAspect: 0.18,
      maxAge: 220,
      integrationSteps: 3,
    },
    message: "展示模式：增强霓虹粒子效果。",
  },
};

const state = {
  field: null,
  layer: null,
  streamLayer: null,
  domainEntity: null,
  heatmapLayer: null,
  heatmapVisible: false,
  trailRenderer: null,
  trailEnabled: true,
  surfaceClamp: false,
  orbit: {
    active: false,
    angle: 0,
    speed: Cesium.Math.toRadians(0.4),
    range: 0,
    pitch: Cesium.Math.toRadians(-32),
    center: null,
  },
  imageryFallback: false,
  colorRampName: DEFAULT_RAMP_NAME,
  colorRamp: defaultColorRamp,
  baseParticleCount: 1000,
  activeParticleCount: 1000,
  dynamicParticleScale: 1,
  manualPause: false,
  lastCameraHeight: 0,
};

if (typeof window !== "undefined") {
  window.windApp = window.windApp || {};
  window.windApp.viewer = viewer;
  window.windApp.state = state;
}

// UI references
const ui = {
  levelSelect: document.getElementById("levelSelect"),
  levelLabel: document.getElementById("levelLabel"),
  multiLevel: document.getElementById("multiLevel"),
  levelStride: document.getElementById("levelStride"),
  levelStrideValue: document.getElementById("levelStrideValue"),
  presetClear: document.getElementById("presetClear"),
  presetStream: document.getElementById("presetStream"),
  presetShowcase: document.getElementById("presetShowcase"),
  viewOblique: document.getElementById("viewOblique"),
  viewTop: document.getElementById("viewTop"),
  viewWest: document.getElementById("viewWest"),
  viewSouth: document.getElementById("viewSouth"),
  viewHeading: document.getElementById("viewHeading"),
  viewHeadingValue: document.getElementById("viewHeadingValue"),
  viewPitch: document.getElementById("viewPitch"),
  viewPitchValue: document.getElementById("viewPitchValue"),
  viewRange: document.getElementById("viewRange"),
  viewRangeValue: document.getElementById("viewRangeValue"),
  applyCustomView: document.getElementById("applyCustomView"),
  orbitStart: document.getElementById("orbitStart"),
  orbitStop: document.getElementById("orbitStop"),
  orbitSpeed: document.getElementById("orbitSpeed"),
  orbitSpeedValue: document.getElementById("orbitSpeedValue"),
  particleCount: document.getElementById("particleCount"),
  particleCountValue: document.getElementById("particleCountValue"),
  speedFactor: document.getElementById("speedFactor"),
  speedFactorValue: document.getElementById("speedFactorValue"),
  lineWidth: document.getElementById("lineWidth"),
  lineWidthValue: document.getElementById("lineWidthValue"),
  trailLength: document.getElementById("trailLength"),
  trailLengthValue: document.getElementById("trailLengthValue"),
  fadeOpacity: document.getElementById("fadeOpacity"),
  fadeOpacityValue: document.getElementById("fadeOpacityValue"),
  verticalScale: document.getElementById("verticalScale"),
  verticalScaleValue: document.getElementById("verticalScaleValue"),
  toggleHeatmap: document.getElementById("toggleHeatmap"),
  trailEffect: document.getElementById("trailEffect"),
  clampSurface: document.getElementById("clampSurface"),
  resetButton: document.getElementById("resetLayer"),
  message: document.getElementById("message"),
  legendTicks: document.getElementById("legendTicks"),
  legendBar: document.getElementById("legendBar"),
  colorScheme: document.getElementById("colorScheme"),
  dynamicParticles: document.getElementById("dynamicParticles"),
  togglePause: document.getElementById("togglePause"),
  pauseIndicator: document.getElementById("pauseIndicator"),
};

const hud = {
  panel: document.getElementById("hudPanel"),
  speed: document.getElementById("hudSpeed"),
  direction: document.getElementById("hudDirection"),
  altitude: document.getElementById("hudAltitude"),
  count: document.getElementById("hudParticleCount"),
};

class ScreenTrailRenderer {
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    this.fade = Cesium.Math.clamp(options.fade ?? 0.93, 0.6, 0.995);
    this.intensity = Math.max(0, options.intensity ?? 0.8);
    this.enabled = options.enabled ?? true;
    this.texture = null;
    this._clearBuffer = null;
    const supportsWebGL2 =
      this.viewer?.scene?.context?.webgl2 ||
      (Cesium.FeatureDetection?.supportsWebgl2
        ? Cesium.FeatureDetection.supportsWebgl2()
        : false);
    const varyingToken = supportsWebGL2 ? "in" : "varying";
    const textureFn = supportsWebGL2 ? "texture" : "texture2D";
    const outputToken = supportsWebGL2 ? "out_FragColor" : "gl_FragColor";
    const fragmentShader = `
      uniform sampler2D colorTexture;
      uniform sampler2D trailTexture;
      uniform float fade;
      uniform float intensity;
      ${varyingToken} vec2 v_textureCoordinates;
      void main()
      {
        vec4 current = ${textureFn}(colorTexture, v_textureCoordinates);
        vec4 history = ${textureFn}(trailTexture, v_textureCoordinates);
        vec3 color = current.rgb + history.rgb * fade * intensity;
        float alpha = max(current.a, history.a * fade);
        ${outputToken} = vec4(color, alpha);
      }
    `;
    this.stage = new Cesium.PostProcessStage({
      name: "WindTrailComposite",
      fragmentShader,
      uniforms: {
        trailTexture: () => this._getTexture(),
        fade: () => (this.enabled ? this.fade : 0.0),
        intensity: () => this.intensity,
      },
    });
    viewer.scene.postProcessStages.add(this.stage);
    this._capture = this._capture.bind(this);
    viewer.scene.postRender.addEventListener(this._capture);
  }

  _getTexture() {
    this._ensureTexture();
    if (this.texture) {
      return this.texture;
    }
    const context = this.viewer?.scene?.context;
    if (!context) {
      return undefined;
    }
    if (!this._placeholder) {
      this._placeholder = new Cesium.Texture({
        context,
        width: 1,
        height: 1,
        pixelFormat: Cesium.PixelFormat.RGBA,
        pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      });
    }
    return this._placeholder;
  }

  _ensureTexture() {
    const context = this.viewer?.scene?.context;
    if (!context) {
      return;
    }
    const width = context.drawingBufferWidth || context._drawingBufferWidth || 0;
    const height = context.drawingBufferHeight || context._drawingBufferHeight || 0;
    if (!width || !height) {
      return;
    }
    if (
      this.texture &&
      !this.texture.isDestroyed() &&
      this.texture.width === width &&
      this.texture.height === height
    ) {
      return;
    }
    if (this.texture && !this.texture.isDestroyed()) {
      this.texture.destroy();
    }
    this.texture = new Cesium.Texture({
      context,
      width,
      height,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      sampler: new Cesium.Sampler({
        wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
        wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE,
        minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
        magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
      }),
    });
    this._clearTexture();
  }

  _clearTexture() {
    if (this.texture && !this.texture.isDestroyed()) {
      this.texture.destroy();
    }
    this.texture = null;
    this._clearBuffer = null;
  }

  _capture() {
    if (!this.enabled) {
      this._clearTexture();
      return;
    }
    this._ensureTexture();
    if (!this.texture || this.texture.isDestroyed()) {
      return;
    }
    this.texture.copyFromFramebuffer();
  }

  setEnabled(value) {
    const enabled = !!value;
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    if (!enabled) {
      this._clearTexture();
    }
    this.viewer.scene.requestRender();
  }

  setFade(value) {
    this.fade = Cesium.Math.clamp(value, 0.6, 0.995);
  }

  setIntensity(value) {
    this.intensity = Math.max(0, value);
  }

  destroy() {
    if (this.stage && !this.stage.isDestroyed()) {
      this.viewer.scene.postProcessStages.remove(this.stage);
    }
    if (this.texture && !this.texture.isDestroyed()) {
      this.texture.destroy();
    }
    if (this._placeholder && !this._placeholder.isDestroyed()) {
      this._placeholder.destroy();
    }
    this.viewer.scene.postRender.removeEventListener(this._capture);
  }
}

function ensureTrailRenderer() {
  if (state.trailRenderer) {
    state.trailRenderer.setEnabled(state.trailEnabled);
    return;
  }
  if (!viewer?.scene?.context) {
    return;
  }
  state.trailRenderer = new ScreenTrailRenderer(viewer, {
    fade: 0.965,
    intensity: 1.15,
    enabled: state.trailEnabled,
  });
}

viewer.scene.postRender.addEventListener(function initTrailOnce() {
  ensureTrailRenderer();
  if (state.trailRenderer) {
    viewer.scene.postRender.removeEventListener(initTrailOnce);
  }
});

setupImagery();

// 开启动画，让 clock 驱动粒子
viewer.clock.shouldAnimate = true;
viewer.clock.multiplier = 120;
viewer.clock.onTick.addEventListener(orbitTick);
viewer.clock.onTick.addEventListener(updateHudTick);

viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.scene.fog.enabled = true;
viewer.scene.fog.density = 0.00018;
viewer.scene.fog.minimumBrightness = 0.1;
viewer.scene.postProcessStages.fxaa.enabled = true;

setupInteractionGuards();

let lastCameraUpdateMs = 0;
viewer.camera.changed.addEventListener(() => {
  const now = Date.now();
  if (now - lastCameraUpdateMs < 120) {
    return;
  }
  lastCameraUpdateMs = now;
  handleCameraChanged();
});

function setupImagery() {
  const imageryProvider = new Cesium.UrlTemplateImageryProvider({
    url:
      "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maximumLevel: 19,
    credit:
      "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  });
  baseLayer = viewer.imageryLayers.addImageryProvider(imageryProvider);
  applyBaseLayerStyle(baseLayer);
  imageryProvider.errorEvent.addEventListener(() => {
    useFallbackImagery("Esri 影像服务不可用，已切换至 OpenStreetMap。");
  });
}

function applyBaseLayerStyle(layer, isFallback = false) {
  if (!layer) return;
  layer.alpha = isFallback ? 0.95 : 0.92;
  layer.brightness = isFallback ? 1.02 : 1.18;
  layer.saturation = isFallback ? 0.55 : 0.38;
  layer.contrast = isFallback ? 1.08 : 1.22;
  layer.gamma = isFallback ? 0.95 : 0.9;
}

function useFallbackImagery(message) {
  if (state.imageryFallback) {
    return;
  }
  state.imageryFallback = true;
  if (baseLayer) {
    viewer.imageryLayers.remove(baseLayer, true);
  }
  const fallbackProvider = new Cesium.OpenStreetMapImageryProvider({
    url: "https://a.tile.openstreetmap.org/",
    credit: "© OpenStreetMap contributors",
  });
  baseLayer = viewer.imageryLayers.addImageryProvider(fallbackProvider);
  applyBaseLayerStyle(baseLayer, true);
  if (ui?.message && message) {
    ui.message.textContent = message;
  }
}

function updateHudTick() {
  if (!state.layer || !state.field || !hud.speed) {
    return;
  }
  const particles = state.layer.particles || [];
  const total = particles.length;
  if (!total) {
    return;
  }
  const sampleTarget = Math.min(120, total);
  const step = Math.max(1, Math.floor(total / sampleTarget));
  let count = 0;
  let speedSum = 0;
  let altitudeSum = 0;
  let dirX = 0;
  let dirY = 0;

  for (let i = 0; i < total && count < sampleTarget; i += step) {
    const particle = particles[i];
    if (!particle) continue;
    const ratio = particle.speedRatio ?? 0;
    const speed = ratio * (state.field.maxSpeed || 0);
    const heading = particle.heading ?? 0;
    speedSum += speed;
    altitudeSum += particle.altitude || 0;
    dirX += Math.cos(heading);
    dirY += Math.sin(heading);
    count += 1;
  }
  if (!count) {
    return;
  }
  const avgSpeed = speedSum / count;
  const avgAltitude = altitudeSum / count;
  const avgHeading =
    (Cesium.Math.toDegrees(Math.atan2(dirY, dirX)) + 360) % 360;

  hud.speed.textContent = `${avgSpeed.toFixed(1)} m/s`;
  hud.altitude.textContent = `${avgAltitude.toFixed(0)} m`;
  hud.direction.textContent = `${avgHeading.toFixed(0)}°`;
  hud.count.textContent = total.toLocaleString();
}



async function bootstrap() {
  try {
    ui.message.textContent = "加载 GeoJSON 风场数据...";
    const response = await fetch(WIND_DATA_URL);
    if (!response.ok) {
      throw new Error(`无法读取风场数据: ${response.statusText}`);
    }
    const geoJson = await response.json();
    state.field = new WindField(geoJson.features);

    viewField(state.field, "oblique");
    buildColorSchemeOptions();
    buildSpeedLegend(state.field, state.colorRamp);
    buildLevelOptions(state.field);
    updateSurfaceHeatmap();
    refreshFlowGuides({
      levelIndex: Number(ui.levelSelect?.value) || 0,
    });
    initLayer();
    bindControls();
    applyPreset("showcase", { silent: true });
    refreshStreamLayer();
    ui.message.textContent = `已载入 ${geoJson.features.length.toLocaleString()} 个风矢量样本`;
  } catch (error) {
    console.error(error);
    ui.message.textContent = `加载失败: ${error.message}`;
  }
}

function buildSpeedLegend(field, ramp = state.colorRamp) {
  if (!ui.legendTicks) return;
  const container = ui.legendTicks;
  container.innerHTML = "";

  const maxSpeed = field.maxSpeed || 0;
  const prettyMax =
    maxSpeed <= 10
      ? 10
      : maxSpeed <= 20
      ? 20
      : Math.min(60, Math.ceil(maxSpeed / 10) * 10);

  const steps = 6;
  for (let i = 0; i < steps; i += 1) {
    const ratio = i / (steps - 1);
    const value = prettyMax * ratio;
    const tick = document.createElement("div");
    tick.className = "legend-tick";
    tick.style.bottom = `${ratio * 100}%`;
    tick.textContent = value.toFixed(0);
    container.appendChild(tick);
  }

  if (ui.legendBar && ramp?.toCss) {
    const segments = [];
    const gradientSteps = 12;
    for (let i = 0; i <= gradientSteps; i += 1) {
      const ratio = i / gradientSteps;
      segments.push(`${ramp.toCss(ratio)} ${(ratio * 100).toFixed(1)}%`);
    }
    ui.legendBar.style.background = `linear-gradient(to top, ${segments.join(
      ", "
    )})`;
  }
}

function updateOrbitSpeedFromUI() {
  const speedDeg = Number(ui.orbitSpeed?.value) || 0.4;
  state.orbit.speed = Cesium.Math.toRadians(speedDeg);
  if (ui.orbitSpeedValue) {
    ui.orbitSpeedValue.textContent = `${speedDeg.toFixed(1)} °/s`;
  }
}

function stopOrbit(resetCamera = true) {
  if (!state.orbit.active) {
    return;
  }
  state.orbit.active = false;
  if (resetCamera) {
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
}

function startOrbit() {
  if (!state.field) return;
  stopOrbit();
  const { lonMin, lonMax, latMin, latMax } = state.field.bounds;
  const margin = 0.6;
  const rectangle = Cesium.Rectangle.fromDegrees(
    lonMin - margin,
    latMin - margin,
    lonMax + margin,
    latMax + margin
  );
  const center = Cesium.Rectangle.center(rectangle);
  const baseRange =
    Math.max(
      Math.max(lonMax - lonMin, latMax - latMin) * 111000 * 1.6,
      160000
    ) || 160000;
  state.orbit.range = baseRange;
  state.orbit.pitch = Cesium.Math.toRadians(-32);
  state.orbit.center = Cesium.Cartesian3.fromRadians(
    center.longitude,
    center.latitude,
    Math.min(state.field._maxHeight || 20000, 12000) * 0.2
  );
  state.orbit.angle = 0;
  updateOrbitSpeedFromUI();
  state.orbit.active = true;
}

function orbitTick(clock) {
  if (!state.orbit.active || !state.orbit.center) {
    return;
  }
  const delta = clock?.deltaSeconds || 1 / 60;
  state.orbit.angle = (state.orbit.angle + state.orbit.speed * delta) % (Math.PI * 2);
  viewer.camera.lookAt(
    state.orbit.center,
    new Cesium.HeadingPitchRange(
      state.orbit.angle,
      state.orbit.pitch,
      state.orbit.range
    )
  );
}

function setupInteractionGuards() {
  const canvas = viewer.scene.canvas;
  ["pointerdown", "wheel", "touchstart"].forEach((eventName) => {
    canvas.addEventListener(
      eventName,
      () => {
        stopOrbit();
      },
      { passive: true }
    );
  });
}

function getFieldViewContext(field) {
  if (!field) {
    return null;
  }
  const { lonMin, lonMax, latMin, latMax } = field.bounds;
  const margin = 0.8;
  const rectangle = Cesium.Rectangle.fromDegrees(
    lonMin - margin,
    latMin - margin,
    lonMax + margin,
    latMax + margin
  );
  const center = Cesium.Rectangle.center(rectangle);
  const lonSpan = Math.max(1e-3, lonMax - lonMin);
  const latSpan = Math.max(1e-3, latMax - latMin);
  const baseRange =
    Math.max(
      Math.max(lonSpan, latSpan) * 111000 * 1.2,
      120000
    ) || 120000;
  return { rectangle, center, baseRange };
}

function viewField(field, preset = "oblique") {
  stopOrbit();
  const context = getFieldViewContext(field);
  if (!context) {
    return;
  }
  const { rectangle, center, baseRange } = context;

  let heading;
  let pitch;
  let range = baseRange;

  if (preset === "top") {
    heading = Cesium.Math.toRadians(0);
    pitch = Cesium.Math.toRadians(-89);
    range = baseRange * 0.9;
  } else if (preset === "west") {
    heading = Cesium.Math.toRadians(90);
    pitch = Cesium.Math.toRadians(-30);
    range = baseRange * 1.1;
  } else if (preset === "south") {
    heading = Cesium.Math.toRadians(180);
    pitch = Cesium.Math.toRadians(-30);
    range = baseRange * 1.1;
  } else {
    // 默认斜视
    heading = Cesium.Math.toRadians(35);
    pitch = Cesium.Math.toRadians(-40);
  }

  // 直接设置视角，避免从整球放大动画
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromRadians(
      center.longitude,
      center.latitude,
      range
    ),
    orientation: {
      heading,
      pitch,
      roll: 0.0,
    },
  });
  syncCustomViewSliders(
    Cesium.Math.toDegrees(heading),
    Cesium.Math.toDegrees(pitch),
    range / baseRange
  );

  // 在风场范围外画一个边界框，类似参考图中的白色矩形
  if (state.domainEntity) {
    viewer.entities.remove(state.domainEntity);
  }
  state.domainEntity = viewer.entities.add({
    rectangle: {
      coordinates: rectangle,
      material: Cesium.Color.TRANSPARENT,
      outline: true,
      outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
    },
  });
}

function updateCustomViewLabels() {
  if (ui.viewHeading && ui.viewHeadingValue) {
    const heading = Number(ui.viewHeading.value) || 0;
    ui.viewHeadingValue.textContent = `${Math.round(heading)}°`;
  }
  if (ui.viewPitch && ui.viewPitchValue) {
    const pitch = Number(ui.viewPitch.value) || 0;
    ui.viewPitchValue.textContent = `${Math.round(pitch)}°`;
  }
  if (ui.viewRange && ui.viewRangeValue) {
    const rangePercent = Number(ui.viewRange.value) || 100;
    ui.viewRangeValue.textContent = `${Math.round(rangePercent)}%`;
  }
}

function syncCustomViewSliders(headingDeg, pitchDeg, rangeMultiplier = 1) {
  if (!ui.viewHeading || !ui.viewPitch || !ui.viewRange) {
    return;
  }
  const normalizedHeading = ((headingDeg % 360) + 360) % 360;
  ui.viewHeading.value = normalizedHeading.toFixed(0);
  ui.viewPitch.value = Cesium.Math.clamp(pitchDeg, -89, -5).toFixed(0);
  const minRange = Number(ui.viewRange.min) || 60;
  const maxRange = Number(ui.viewRange.max) || 220;
  const targetPercent = Cesium.Math.clamp(
    rangeMultiplier * 100,
    minRange,
    maxRange
  );
  ui.viewRange.value = targetPercent.toFixed(0);
  updateCustomViewLabels();
}

function applyCustomView(auto = false) {
  if (!state.field) {
    return;
  }
  const context = getFieldViewContext(state.field);
  if (!context) {
    return;
  }
  if (!ui.viewHeading || !ui.viewPitch || !ui.viewRange) {
    return;
  }
  stopOrbit();
  const headingDeg = Number(ui.viewHeading.value) || 0;
  const pitchDeg = Number(ui.viewPitch.value) || -40;
  const rangePercent = Cesium.Math.clamp(
    Number(ui.viewRange.value) || 100,
    Number(ui.viewRange.min) || 60,
    Number(ui.viewRange.max) || 220
  );
  const range = context.baseRange * (rangePercent / 100);
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromRadians(
      context.center.longitude,
      context.center.latitude,
      range
    ),
    orientation: {
      heading: Cesium.Math.toRadians(headingDeg),
      pitch: Cesium.Math.toRadians(pitchDeg),
      roll: 0.0,
    },
  });
  if (!auto) {
    syncCustomViewSliders(headingDeg, pitchDeg, rangePercent / 100);
  }
}

function updateSurfaceHeatmap() {
  if (!state.field) {
    return;
  }
  if (!state.heatmapVisible) {
    if (state.heatmapLayer) {
      viewer.imageryLayers.remove(state.heatmapLayer, true);
      state.heatmapLayer = null;
    }
    return;
  }

  const field = state.field;
  const lonCount = field.lonValues?.length || 0;
  const latCount = field.latValues?.length || 0;
  if (!lonCount || !latCount) {
    return;
  }

  if (state.heatmapLayer) {
    viewer.imageryLayers.remove(state.heatmapLayer, true);
    state.heatmapLayer = null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = lonCount;
  canvas.height = latCount;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(lonCount, latCount);
  const baseSlice = field.grid[0];
  const speedRange = Math.max(field.maxSpeed - field.minSpeed, 0.001);
  const ramp = state.colorRamp;

  for (let latIdx = 0; latIdx < latCount; latIdx += 1) {
    for (let lonIdx = 0; lonIdx < lonCount; lonIdx += 1) {
      const sample = baseSlice?.[latIdx]?.[lonIdx];
      const speed = sample?.speed ?? field.minSpeed;
      const ratio = (speed - field.minSpeed) / speedRange;
      const rgb = ramp?.sample ? ramp.sample(ratio) : [255, 255, 255];
      const px = lonIdx;
      const py = latCount - latIdx - 1;
      const index = (py * lonCount + px) * 4;
      imageData.data[index] = Math.round(rgb[0]);
      imageData.data[index + 1] = Math.round(rgb[1]);
      imageData.data[index + 2] = Math.round(rgb[2]);
      imageData.data[index + 3] = Math.round(255 * 0.48);
    }
  }

  ctx.putImageData(imageData, 0, 0);
  const rectangle = Cesium.Rectangle.fromDegrees(
    field.bounds.lonMin,
    field.bounds.latMin,
    field.bounds.lonMax,
    field.bounds.latMax
  );

  const provider = new Cesium.SingleTileImageryProvider({
    url: canvas.toDataURL("image/png"),
    rectangle,
  });
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  layer.alpha = 0.5;
  layer.saturation = 1.05;
  layer.brightness = 1.05;
  layer.contrast = 1.05;
  state.heatmapLayer = layer;
}

function initLayer() {
  const options = {
    maxParticles: Number(ui.particleCount.value),
    speedFactor: Number(ui.speedFactor.value),
    lineWidth: Number(ui.lineWidth.value),
    trailLength: Number(ui.trailLength.value),
    fadeOpacity: Number(ui.fadeOpacity.value),
    verticalScale: Number(ui.verticalScale.value),
    levelIndex: Number(ui.levelSelect.value) || 0,
    multiLevel: ui.multiLevel.checked,
    levelStride: Number(ui.levelStride.value) || 1,
    screenCulling: false,
    colorRamp: state.colorRamp,
    colorRampName: state.colorRampName,
    surfaceClamp: state.surfaceClamp,
    ...VISUAL_COMPENSATION_OVERRIDES,
  };

  if (state.layer) {
    state.layer.destroy();
  }
  state.layer = new WindParticleLayer(viewer, state.field, options);
  const currentHeight =
    viewer.camera?.positionCartographic?.height || state.lastCameraHeight || 0;
  state.lastCameraHeight = currentHeight;
  state.layer.updateCameraHeight(currentHeight);
  state.layer.setPaused(state.manualPause);
  if (ui.togglePause) {
    ui.togglePause.textContent = state.manualPause ? "恢复粒子" : "暂停粒子";
  }
  updatePauseIndicator();
  applyDynamicParticleCount(currentHeight);
  updateLabels();
}

function refreshFlowGuides() {
  // 已停用 flow guides，保留空实现以兼容旧调用。
}

function refreshStreamLayer(options = {}) {
  const layer = ensureStreamLayer();
  if (!layer || !state.field) {
    return;
  }
  const sliderVertical = Number(ui.verticalScale?.value);
  const baseVertical = Number.isFinite(sliderVertical)
    ? sliderVertical
    : 1200;
  const sliderStride = Number(ui.levelStride?.value);
  const seedStride = Number.isFinite(sliderStride)
    ? Math.max(2, Math.round(sliderStride + 2))
    : 3;
  const defaults = {
    levelIndex: Number(ui.levelSelect?.value) || 0,
    clampSurface: state.surfaceClamp,
    colorRamp: state.colorRamp,
    colorRampName: state.colorRampName,
    verticalScale: Math.max(80, baseVertical * 0.45),
    seedStride,
    stepSeconds: 420,
    maxSteps: 70,
    speedScale: 1.2,
    lineWidth: 2.4,
    glowPower: 0.2,
    opacity: 0.78,
  };
  try {
    layer.update({ ...defaults, ...options });
  } catch (err) {
    console.warn("Refresh stream layer skipped:", err);
  }
}

function ensureStreamLayer() {
  if (state.streamLayer) {
    return state.streamLayer;
  }
  if (!state.field) {
    return null;
  }
  try {
    state.streamLayer = new WindStreamLayer(viewer, state.field, {
      levelIndex: Number(ui.levelSelect?.value) || 0,
      clampSurface: state.surfaceClamp,
      colorRamp: state.colorRamp,
      colorRampName: state.colorRampName,
      seedStride: 3,
      stepSeconds: 420,
      maxSteps: 70,
      speedScale: 1.2,
      lineWidth: 2.4,
      glowPower: 0.2,
      opacity: 0.78,
      verticalScale: Math.max(
        80,
        (Number(ui.verticalScale?.value) || 1200) * 0.45
      ),
    });
  } catch (err) {
    console.warn("Create stream layer failed:", err);
    state.streamLayer = null;
  }
  return state.streamLayer;
}

function updateLabels() {
  applyDynamicParticleCount(undefined, { updateLayer: false });
  ui.speedFactorValue.textContent = ui.speedFactor.value;
  ui.lineWidthValue.textContent = ui.lineWidth.value;
  ui.trailLengthValue.textContent = ui.trailLength.value;
  ui.fadeOpacityValue.textContent = ui.fadeOpacity.value;
  ui.verticalScaleValue.textContent = `${ui.verticalScale.value} m`;
  ui.levelStrideValue.textContent = ui.levelStride.value;
  if (ui.orbitSpeed) {
    updateOrbitSpeedFromUI();
  }
  if (ui.multiLevel && ui.multiLevel.checked) {
    ui.levelLabel.textContent = "多层";
    ui.levelSelect.disabled = true;
    ui.levelStride.disabled = false;
  } else {
    ui.levelSelect.disabled = false;
    ui.levelStride.disabled = true;
    const idx = Number(ui.levelSelect.value) || 0;
    const info = state.field?.levelInfo(idx);
    if (info) {
      ui.levelLabel.textContent = `${info.altitude.toFixed(
        0
      )} m (${info.value.toFixed(3)})`;
    }
  }
}

function bindControls() {
  // 视角预设按钮
  if (ui.viewOblique) {
    ui.viewOblique.addEventListener("click", () => {
      if (state.field) {
        viewField(state.field, "oblique");
      }
    });
  }
  if (ui.viewTop) {
    ui.viewTop.addEventListener("click", () => {
      if (state.field) {
        viewField(state.field, "top");
      }
    });
  }
  if (ui.viewWest) {
    ui.viewWest.addEventListener("click", () => {
      if (state.field) {
        viewField(state.field, "west");
      }
    });
  }
  if (ui.viewSouth) {
    ui.viewSouth.addEventListener("click", () => {
      if (state.field) {
        viewField(state.field, "south");
      }
    });
  }
  if (ui.applyCustomView) {
    ui.applyCustomView.addEventListener("click", () => {
      applyCustomView();
    });
  }
  ["viewHeading", "viewPitch", "viewRange"].forEach((id) => {
    const input = ui[id];
    if (!input) {
      return;
    }
    input.addEventListener("input", () => {
      updateCustomViewLabels();
      applyCustomView(true);
    });
  });
  if (ui.orbitStart) {
    ui.orbitStart.addEventListener("click", () => {
      startOrbit();
    });
  }
  if (ui.orbitStop) {
    ui.orbitStop.addEventListener("click", () => {
      stopOrbit();
    });
  }
  if (ui.orbitSpeed) {
    ui.orbitSpeed.addEventListener("input", () => {
      updateOrbitSpeedFromUI();
    });
  }
  if (ui.colorScheme) {
    ui.colorScheme.addEventListener("change", (event) => {
      const next = event.target.value;
      setActiveColorRamp(next);
    });
  }
  if (ui.dynamicParticles) {
    ui.dynamicParticles.addEventListener("change", () => {
      applyDynamicParticleCount(undefined);
    });
  }
  if (ui.trailEffect) {
    ui.trailEffect.checked = state.trailEnabled;
    ui.trailEffect.addEventListener("change", () => {
      state.trailEnabled = ui.trailEffect.checked;
      ensureTrailRenderer();
      state.trailRenderer?.setEnabled(state.trailEnabled);
    });
  }
  if (ui.clampSurface) {
    ui.clampSurface.checked = state.surfaceClamp;
    ui.clampSurface.addEventListener("change", () => {
      state.surfaceClamp = ui.clampSurface.checked;
      if (state.layer) {
        state.layer.updateConfig({ surfaceClamp: state.surfaceClamp });
      }
      refreshFlowGuides({ clampSurface: state.surfaceClamp });
      refreshStreamLayer({ clampSurface: state.surfaceClamp });
    });
  }
  if (ui.togglePause) {
    ui.togglePause.addEventListener("click", () => {
      state.manualPause = !state.manualPause;
      ui.togglePause.textContent = state.manualPause ? "恢复粒子" : "暂停粒子";
      if (state.layer) {
        state.layer.setPaused(state.manualPause);
      }
      updatePauseIndicator();
    });
  }

  [
    "particleCount",
    "speedFactor",
    "lineWidth",
    "trailLength",
    "fadeOpacity",
    "verticalScale",
    "levelStride",
  ].forEach((id) => {
    ui[id].addEventListener("input", () => {
      updateLabels();
      queueLayerUpdate();
    });
  });

  ui.levelSelect.addEventListener("change", () => {
    updateLabels();
    if (state.layer) {
      state.layer.updateConfig({ levelIndex: Number(ui.levelSelect.value) });
    }
    refreshStreamLayer({ levelIndex: Number(ui.levelSelect.value) || 0 });
  });

  ui.multiLevel.addEventListener("change", () => {
    updateLabels();
    if (state.layer) {
      state.layer.updateConfig({ multiLevel: ui.multiLevel.checked });
    }
  });

  ui.resetButton.addEventListener("click", () => {
    state.layer?.respawn();
  });

  if (ui.toggleHeatmap) {
    ui.toggleHeatmap.checked = state.heatmapVisible;
    ui.toggleHeatmap.addEventListener("change", () => {
      state.heatmapVisible = ui.toggleHeatmap.checked;
      updateSurfaceHeatmap();
    });
  }

  // 一键清晰查看预设：降低密度、缩短轨迹、关闭多层
  if (ui.presetClear) {
    ui.presetClear.addEventListener("click", () => applyPreset("clear"));
  }

  // 流线方向模式：更长轨迹、适中粒子数，强调流动方向
  if (ui.presetStream) {
    ui.presetStream.addEventListener("click", () => applyPreset("stream"));
  }

  // 展示模式：多层高粒子数，增强垂直夸张，接近示意图效果
  if (ui.presetShowcase) {
    ui.presetShowcase.addEventListener("click", () =>
      applyPreset("showcase")
    );
  }

  updateCustomViewLabels();
}

function applyPreset(name, options = {}) {
  const preset = PRESETS[name];
  if (!preset) {
    return;
  }
  const setValue = (input, value) => {
    if (!input || value === undefined || value === null) {
      return;
    }
    input.value = String(value);
  };
  setValue(ui.particleCount, preset.particleCount);
  setValue(ui.speedFactor, preset.speedFactor);
  setValue(ui.lineWidth, preset.lineWidth);
  setValue(ui.trailLength, preset.trailLength);
  setValue(ui.fadeOpacity, preset.fadeOpacity);
  setValue(ui.verticalScale, preset.verticalScale);
  setValue(ui.levelStride, preset.levelStride);
  if (typeof preset.multiLevel === "boolean" && ui.multiLevel) {
    ui.multiLevel.checked = preset.multiLevel;
  }
  if (typeof preset.levelIndex === "number" && ui.levelSelect) {
    const maxIndex = Math.max(ui.levelSelect.options.length - 1, 0);
    const clamped = Cesium.Math.clamp(
      Math.floor(preset.levelIndex),
      0,
      maxIndex
    );
    ui.levelSelect.value = String(clamped);
  }
  if (preset.colorRampName) {
    setActiveColorRamp(preset.colorRampName);
  }
  if (typeof preset.surfaceClamp === "boolean" && ui.clampSurface) {
    state.surfaceClamp = preset.surfaceClamp;
    ui.clampSurface.checked = preset.surfaceClamp;
  }
  updateLabels();
  queueLayerUpdate();
  if (state.layer && preset.layerOverrides) {
    state.layer.updateConfig({
      ...preset.layerOverrides,
      ...VISUAL_COMPENSATION_OVERRIDES,
    });
  }
  if (!options.skipView && preset.view && state.field) {
    viewField(state.field, preset.view);
  }
  if (!options.silent && preset.message && ui.message) {
    ui.message.textContent = preset.message;
  }
}

let updateHandle = null;
function queueLayerUpdate() {
  if (updateHandle) {
    cancelAnimationFrame(updateHandle);
  }
  updateHandle = requestAnimationFrame(() => {
    updateHandle = null;
    if (!state.layer) {
      return;
    }
    const maxParticles = computeParticleTarget();
    updateParticleCountValueLabel();
    state.layer.updateConfig({
      maxParticles,
      speedFactor: Number(ui.speedFactor.value),
      lineWidth: Number(ui.lineWidth.value),
      trailLength: Number(ui.trailLength.value),
      fadeOpacity: Number(ui.fadeOpacity.value),
      verticalScale: Number(ui.verticalScale.value),
      levelStride: Number(ui.levelStride.value) || 1,
      levelIndex: Number(ui.levelSelect.value) || 0,
      multiLevel: !!ui.multiLevel.checked,
      surfaceClamp: state.surfaceClamp,
      screenCulling: state.layer?.options?.screenCulling ?? false,
      ...VISUAL_COMPENSATION_OVERRIDES,
    });
    refreshFlowGuides();
    refreshStreamLayer();
  });
}

function buildColorSchemeOptions() {
  if (!ui.colorScheme) return;
  ui.colorScheme.innerHTML = "";
  const options = listColorRampOptions();
  options.forEach(({ name, label }) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = label;
    if (name === state.colorRampName) {
      option.selected = true;
    }
    ui.colorScheme.appendChild(option);
  });
}

function setActiveColorRamp(name) {
  const resolved = name || DEFAULT_RAMP_NAME;
  state.colorRampName = resolved;
  state.colorRamp = getColorRamp(resolved);
  if (ui.colorScheme && ui.colorScheme.value !== resolved) {
    ui.colorScheme.value = resolved;
  }
  if (state.layer) {
    state.layer.setColorRamp(state.colorRamp);
  }
  if (state.field) {
    buildSpeedLegend(state.field, state.colorRamp);
    updateSurfaceHeatmap();
  }
  refreshStreamLayer({ colorRamp: state.colorRamp, colorRampName: resolved });
}

function computeParticleTarget(heightOverride) {
  if (!ui.particleCount) {
    return state.activeParticleCount || state.baseParticleCount || 0;
  }
  const base = Number(ui.particleCount.value) || state.baseParticleCount || 200;
  state.baseParticleCount = base;
  let scale = 1;
  if (ui.dynamicParticles?.checked) {
    const height =
      heightOverride ?? state.lastCameraHeight ?? viewer.camera?.positionCartographic?.height ?? 0;
    const minHeight = 60000;
    const maxHeight = 900000;
    const normalized = Cesium.Math.clamp(
      (height - minHeight) / (maxHeight - minHeight || 1),
      0,
      1
    );
    scale = Cesium.Math.lerp(1, 0.35, normalized);
  }
  const target = Math.max(200, Math.round(base * scale));
  state.dynamicParticleScale = scale;
  state.activeParticleCount = target;
  return target;
}

function updateParticleCountValueLabel() {
  if (!ui.particleCountValue) return;
  const active = state.activeParticleCount || Number(ui.particleCount?.value) || 0;
  if (ui.dynamicParticles?.checked && state.dynamicParticleScale < 0.999) {
    ui.particleCountValue.textContent = `${active.toLocaleString()} (${Math.round(
      state.dynamicParticleScale * 100
    )}%)`;
  } else {
    ui.particleCountValue.textContent = active.toLocaleString();
  }
}

function applyDynamicParticleCount(heightOverride, options = {}) {
  const { updateLayer = true } = options;
  const target = computeParticleTarget(heightOverride);
  updateParticleCountValueLabel();
  if (updateLayer && state.layer) {
    state.layer.updateConfig({ maxParticles: target });
  }
}

function handleCameraChanged() {
  const height = viewer.camera?.positionCartographic?.height || 0;
  state.lastCameraHeight = height;
  if (state.layer) {
    state.layer.updateCameraHeight(height);
  }
  if (ui.dynamicParticles?.checked) {
    applyDynamicParticleCount(height);
  } else {
    computeParticleTarget(height);
    updateParticleCountValueLabel();
  }
  updatePauseIndicator();
}

function updatePauseIndicator() {
  if (!ui.pauseIndicator) return;
  const statuses = [];
  if (state.manualPause) {
    statuses.push("手动暂停");
  }
  if (state.layer?.isAutoPaused()) {
    statuses.push("相机过远自动暂停");
  }
  ui.pauseIndicator.textContent = statuses.length
    ? statuses.join(" · ")
    : "动画运行中";
}

function buildLevelOptions(field) {
  ui.levelSelect.innerHTML = "";
  field.levels.forEach((value, index) => {
    const option = document.createElement("option");
    const info = field.levelInfo(index);
    option.value = index;
    option.textContent = `${index.toString().padStart(2, "0")} - ${
      info.altitude > 1000
        ? `${(info.altitude / 1000).toFixed(1)} km`
        : `${info.altitude.toFixed(0)} m`
    }`;
    if (index === Math.floor(field.levels.length * 0.75)) {
      option.selected = true;
    }
    ui.levelSelect.appendChild(option);
  });
}

bootstrap();
if (typeof window !== "undefined") {
  window.initLayer = initLayer;
  window.applyPreset = applyPreset;
}
