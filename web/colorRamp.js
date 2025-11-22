const COLOR_RAMPS = {
  electroNeon: {
    label: "电光荧彩",
    gamma: 0.65,
    stops: [
      { stop: 0.0, color: [10, 255, 242] }, // 青色
      { stop: 0.2, color: [70, 0, 255] }, // 紫蓝
      { stop: 0.4, color: [255, 35, 190] }, // 品红
      { stop: 0.6, color: [255, 140, 0] }, // 荧橙
      { stop: 0.8, color: [255, 255, 0] }, // 明黄
      { stop: 1.0, color: [255, 255, 255] }, // 白色高光
    ],
  },
  aurora: {
    label: "极光高光",
    gamma: 0.85,
    stops: [
      { stop: 0.0, color: [14, 48, 140] },
      { stop: 0.32, color: [32, 166, 214] },
      { stop: 0.55, color: [60, 205, 111] },
      { stop: 0.78, color: [247, 215, 90] },
      { stop: 1.0, color: [236, 72, 33] },
    ],
  },
  neonVortex: {
    label: "霓虹风暴",
    gamma: 0.72,
    stops: [
      { stop: 0.0, color: [13, 34, 58] },
      { stop: 0.18, color: [7, 78, 104] },
      { stop: 0.38, color: [24, 135, 139] },
      { stop: 0.62, color: [68, 204, 120] },
      { stop: 0.8, color: [165, 255, 123] },
      { stop: 1.0, color: [255, 248, 160] },
    ],
  },
  blues: {
    label: "深海蓝",
    gamma: 0.9,
    stops: [
      { stop: 0.0, color: [2, 16, 53] },
      { stop: 0.2, color: [11, 47, 116] },
      { stop: 0.45, color: [21, 86, 194] },
      { stop: 0.7, color: [69, 149, 235] },
      { stop: 1.0, color: [157, 209, 255] },
    ],
  },
  magma: {
    label: "熔岩",
    gamma: 0.78,
    stops: [
      { stop: 0.0, color: [20, 11, 44] },
      { stop: 0.25, color: [91, 5, 64] },
      { stop: 0.5, color: [187, 55, 84] },
      { stop: 0.75, color: [246, 137, 73] },
      { stop: 1.0, color: [251, 230, 97] },
    ],
  },
};

export const DEFAULT_RAMP_NAME = "electroNeon";

function lerp(a, b, t) {
  return a + (b - a) * t;
}

class ColorRamp {
  constructor({ stops, gamma = 1 }) {
    this.stops = stops;
    this.gamma = gamma;
  }

  sample(ratio) {
    const clamped = Math.max(0, Math.min(0.9999, ratio));
    const mapped = Math.pow(clamped, this.gamma);
    for (let i = 0; i < this.stops.length - 1; i += 1) {
      const current = this.stops[i];
      const next = this.stops[i + 1];
      if (mapped >= current.stop && mapped <= next.stop) {
        const local =
          (mapped - current.stop) / (next.stop - current.stop || 1);
        return [
          lerp(current.color[0], next.color[0], local),
          lerp(current.color[1], next.color[1], local),
          lerp(current.color[2], next.color[2], local),
        ];
      }
    }
    const last = this.stops[this.stops.length - 1].color;
    return [last[0], last[1], last[2]];
  }

  toCss(ratio, alpha = 1) {
    return colorArrayToCss(this.sample(ratio), alpha);
  }
}

const rampCache = {};

function getColorRamp(name = DEFAULT_RAMP_NAME) {
  const key = COLOR_RAMPS[name] ? name : DEFAULT_RAMP_NAME;
  if (!rampCache[key]) {
    rampCache[key] = new ColorRamp(COLOR_RAMPS[key]);
  }
  return rampCache[key];
}

function listColorRampOptions() {
  return Object.entries(COLOR_RAMPS).map(([name, meta]) => ({
    name,
    label: meta.label,
  }));
}

function sampleRampColor(ratio, name = DEFAULT_RAMP_NAME) {
  return getColorRamp(name).sample(ratio);
}

function colorArrayToCss(rgb, alpha = 1) {
  const r = Math.round(rgb[0]);
  const g = Math.round(rgb[1]);
  const b = Math.round(rgb[2]);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export {
  getColorRamp,
  listColorRampOptions,
  sampleRampColor,
  colorArrayToCss,
  ColorRamp,
};

export default {
  getColorRamp,
  listColorRampOptions,
  sampleRampColor,
  colorArrayToCss,
  DEFAULT_RAMP_NAME,
  ColorRamp,
};
