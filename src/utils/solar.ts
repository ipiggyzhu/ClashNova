/**
 * 太阳位置计算(NOAA 算法), 从 solar-calculator@0.3.0 内联而来。
 * 仅保留昼夜地球着色需要的三个函数: century / equationOfTime / declination。
 * 内联的原因: 本应用是离线桌面端, 不适合运行时从 CDN 拉依赖。
 */

const deg2rad = (n: number): number => (Math.PI * n) / 180
const rad2deg = (n: number): number => (180 * n) / Math.PI

/** 太阳平黄经 (deg) */
function meanLongitude(t: number): number {
  const r = (280.46646 + t * (36000.76983 + t * 3032e-7)) % 360
  return r < 0 ? r + 360 : r
}

/** 太阳平近点角 (deg) */
function meanAnomaly(t: number): number {
  return 357.52911 + t * (35999.05029 - 1537e-7 * t)
}

/** 中心差 (deg) */
function equationOfCenter(t: number): number {
  const m = deg2rad(meanAnomaly(t))
  return (
    Math.sin(m) * (1.914602 - t * (0.004817 + 14e-6 * t)) +
    Math.sin(m * 2) * (0.019993 - 101e-6 * t) +
    Math.sin(m * 3) * 289e-6
  )
}

/** 真黄经 (deg) */
function trueLongitude(t: number): number {
  return meanLongitude(t) + equationOfCenter(t)
}

/** 视黄经 (deg) */
function apparentLongitude(t: number): number {
  return trueLongitude(t) - 0.00569 - 0.00478 * Math.sin(deg2rad(125.04 - 1934.136 * t))
}

const J2000 = Date.UTC(2000, 0, 1, 12)

/** 儒略世纪数 (自 J2000 起) */
export function century(dt: number): number {
  return (dt - J2000) / 315576e7
}

/** 黄赤交角 (deg) */
function obliquityOfEcliptic(t: number): number {
  const base = 23 + (26 + (21.448 - t * (46.815 + t * (59e-5 - t * 0.001813))) / 60) / 60
  const omega = 125.04 - 1934.136 * t
  return base + 0.00256 * Math.cos(deg2rad(omega))
}

/** 太阳赤纬 (deg) */
export function declination(t: number): number {
  return rad2deg(
    Math.asin(Math.sin(deg2rad(obliquityOfEcliptic(t))) * Math.sin(deg2rad(apparentLongitude(t)))),
  )
}

/** 轨道偏心率 */
function orbitEccentricity(t: number): number {
  return 0.016708634 - t * (42037e-9 + 1267e-10 * t)
}

/** 时差 (分钟) */
export function equationOfTime(t: number): number {
  const eps = deg2rad(obliquityOfEcliptic(t))
  const l0 = deg2rad(meanLongitude(t))
  const e = orbitEccentricity(t)
  const m = deg2rad(meanAnomaly(t))
  const y = Math.tan(eps / 2) ** 2
  const value =
    y * Math.sin(2 * l0) -
    2 * e * Math.sin(m) +
    4 * e * y * Math.sin(m) * Math.cos(2 * l0) -
    0.5 * y * y * Math.sin(4 * l0) -
    1.25 * e * e * Math.sin(2 * m)
  return rad2deg(value) * 4
}

/**
 * 给定时间戳, 返回太阳直下点的 [经度, 纬度] (deg)。
 * 昼夜着色器据此计算晨昏线, 让当前处于夜晚的大陆呈现夜面(城市灯光)。
 */
export function sunPosAt(dt: number): [number, number] {
  const day = new Date(dt).setUTCHours(0, 0, 0, 0)
  const t = century(dt)
  const longitude = ((day - dt) / 864e5) * 360 - 180
  return [longitude - equationOfTime(t) / 4, declination(t)]
}
