/*
 * stitch-core.js — 全景拼接核心（不依賴 DOM，可在瀏覽器或 Node 執行）
 *
 * 流程：特徵偵測 → 配對 → 排序 → 焦距估計 → Bundle Adjustment（旋轉＋焦距）
 *       → 水平校正 → 依所選投影反向映射 → 增益補償 → 接縫搜尋 → 多頻段融合
 */
(function (root) {
"use strict";

const MIN_MATCH_SCORE = 8;
const MAX_FEATURES = 1000;
const RANSAC_ITERATIONS = 1000;
const RANSAC_THRESHOLD = 3.5;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ───────────────────────── 特徵偵測 ─────────────────────────

function boxBlur(gray, width, height, radius) {
  const size = radius * 2 + 1;
  const tmp = new Float32Array(width * height);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) sum += gray[row + clamp(x, 0, width - 1)];
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / size;
      sum += gray[row + Math.min(width - 1, x + radius + 1)] - gray[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) sum += tmp[clamp(y, 0, height - 1) * width + x];
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = Math.round(sum / size);
      sum += tmp[Math.min(height - 1, y + radius + 1) * width + x] - tmp[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}

// 與原版相同的 Harris + 旋轉 BRIEF，但：
//  1) 角點做拋物線次像素定位（對齊精度直接決定重影）
//  2) 以網格限制每格數量，避免特徵全擠在建築紋理上
//  3) 描述子先經過平滑，抗雜訊
function detectFeatures(image) {
  const { width, height, gray } = image;
  const response = new Float32Array(width * height);
  let maxResponse = 0;
  for (let y = 3; y < height - 3; y += 1) {
    for (let x = 3; x < width - 3; x += 1) {
      let xx = 0;
      let yy = 0;
      let xy = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const index = (y + oy) * width + x + ox;
          const gx = gray[index + 1] - gray[index - 1];
          const gy = gray[index + width] - gray[index - width];
          xx += gx * gx;
          yy += gy * gy;
          xy += gx * gy;
        }
      }
      const score = xx * yy - xy * xy - 0.045 * (xx + yy) ** 2;
      response[y * width + x] = score;
      if (score > maxResponse) maxResponse = score;
    }
  }
  if (maxResponse <= 0) return [];

  const threshold = maxResponse * 0.0003;
  const candidates = [];
  for (let y = 22; y < height - 22; y += 1) {
    for (let x = 22; x < width - 22; x += 1) {
      const index = y * width + x;
      const score = response[index];
      if (score < threshold) continue;
      let isMaximum = true;
      for (let oy = -2; oy <= 2 && isMaximum; oy += 1) {
        for (let ox = -2; ox <= 2; ox += 1) {
          if (response[(y + oy) * width + x + ox] > score) {
            isMaximum = false;
            break;
          }
        }
      }
      if (isMaximum) candidates.push({ x, y, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const smooth = boxBlur(gray, width, height, 2);
  const pattern = getBriefPattern();
  const occupied = new Uint8Array(width * height);
  const CELL = 32;
  const PER_CELL = 4;
  const gridWidth = Math.ceil(width / CELL);
  const cellCounts = new Uint8Array(gridWidth * Math.ceil(height / CELL));
  const features = [];
  for (const candidate of candidates) {
    const cellIndex = Math.floor(candidate.y / CELL) * gridWidth + Math.floor(candidate.x / CELL);
    if (cellCounts[cellIndex] >= PER_CELL) continue;
    let blocked = false;
    for (let oy = -4; oy <= 4 && !blocked; oy += 1) {
      for (let ox = -4; ox <= 4; ox += 1) {
        if (occupied[(candidate.y + oy) * width + candidate.x + ox]) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked) continue;
    for (let oy = -4; oy <= 4; oy += 1) {
      for (let ox = -4; ox <= 4; ox += 1) occupied[(candidate.y + oy) * width + candidate.x + ox] = 1;
    }
    cellCounts[cellIndex] += 1;

    const index = candidate.y * width + candidate.x;
    const center = response[index];
    const denominatorX = response[index - 1] - 2 * center + response[index + 1];
    const denominatorY = response[index - width] - 2 * center + response[index + width];
    const subX = denominatorX < 0 ? clamp(0.5 * (response[index - 1] - response[index + 1]) / denominatorX, -0.5, 0.5) : 0;
    const subY = denominatorY < 0 ? clamp(0.5 * (response[index - width] - response[index + width]) / denominatorY, -0.5, 0.5) : 0;

    const angle = getFeatureAngle(smooth, width, candidate.x, candidate.y);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const descriptor = new Uint32Array(8);
    for (let bit = 0; bit < 256; bit += 1) {
      const [ax, ay, bx, by] = pattern[bit];
      const sampleAX = candidate.x + Math.round(ax * cosine - ay * sine);
      const sampleAY = candidate.y + Math.round(ax * sine + ay * cosine);
      const sampleBX = candidate.x + Math.round(bx * cosine - by * sine);
      const sampleBY = candidate.y + Math.round(bx * sine + by * cosine);
      if (smooth[sampleAY * width + sampleAX] < smooth[sampleBY * width + sampleBX]) {
        descriptor[bit >>> 5] |= 1 << (bit & 31);
      }
    }
    features.push({ x: candidate.x + subX, y: candidate.y + subY, score: candidate.score, descriptor });
    if (features.length >= MAX_FEATURES) break;
  }
  return features;
}

let briefPattern = null;

function getBriefPattern() {
  if (briefPattern) return briefPattern;
  let seed = 0x6d2b79f5;
  const randomOffset = () => {
    seed = Math.imul(seed ^ (seed >>> 15), seed | 1);
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61);
    return (((seed ^ (seed >>> 14)) >>> 0) % 31) - 15;
  };
  briefPattern = Array.from({ length: 256 }, () => [randomOffset(), randomOffset(), randomOffset(), randomOffset()]);
  return briefPattern;
}

function getFeatureAngle(gray, width, x, y) {
  let momentX = 0;
  let momentY = 0;
  for (let oy = -8; oy <= 8; oy += 1) {
    for (let ox = -8; ox <= 8; ox += 1) {
      const intensity = gray[(y + oy) * width + x + ox];
      momentX += ox * intensity;
      momentY += oy * intensity;
    }
  }
  return Math.atan2(momentY, momentX);
}

function matchFeatures(firstFeatures, secondFeatures) {
  if (firstFeatures.length < MIN_MATCH_SCORE || secondFeatures.length < MIN_MATCH_SCORE) return null;
  const nearest = (source, target) => source.map((feature) => {
    let bestIndex = -1;
    let bestDistance = Infinity;
    let secondDistance = Infinity;
    for (let index = 0; index < target.length; index += 1) {
      const distance = hammingDistance(feature.descriptor, target[index].descriptor, secondDistance);
      if (distance < bestDistance) {
        secondDistance = bestDistance;
        bestDistance = distance;
        bestIndex = index;
      } else if (distance < secondDistance) {
        secondDistance = distance;
      }
    }
    return { index: bestIndex, bestDistance, secondDistance };
  });
  const forward = nearest(firstFeatures, secondFeatures);
  const backward = nearest(secondFeatures, firstFeatures);
  const correspondences = [];
  for (let index = 0; index < forward.length; index += 1) {
    const result = forward[index];
    if (result.index < 0 || result.bestDistance > 104 || result.bestDistance >= result.secondDistance * 0.9) continue;
    if (backward[result.index].index !== index) continue;
    correspondences.push({ from: secondFeatures[result.index], to: firstFeatures[index] });
  }
  if (correspondences.length < MIN_MATCH_SCORE) return null;

  const fit = estimateHomographyRansac(correspondences);
  if (!fit || fit.inliers.length < MIN_MATCH_SCORE) return null;
  const inlierRatio = fit.inliers.length / correspondences.length;
  if (inlierRatio < 0.16) return null;
  const rangeX = Math.max(...fit.inliers.map((match) => match.to.x)) - Math.min(...fit.inliers.map((match) => match.to.x));
  const rangeY = Math.max(...fit.inliers.map((match) => match.to.y)) - Math.min(...fit.inliers.map((match) => match.to.y));
  const coverage = Math.sqrt((rangeX / Math.max(1, getFeatureBounds(firstFeatures).width)) * (rangeY / Math.max(1, getFeatureBounds(firstFeatures).height)));
  if (coverage < 0.045) return null;
  return {
    homography: fit.homography,
    inlierMatches: fit.inliers,
    inliers: fit.inliers.length,
    inlierRatio,
    coverage
  };
}

function getFeatureBounds(features) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const feature of features) {
    minX = Math.min(minX, feature.x);
    minY = Math.min(minY, feature.y);
    maxX = Math.max(maxX, feature.x);
    maxY = Math.max(maxY, feature.y);
  }
  return { width: maxX - minX, height: maxY - minY };
}

function hammingDistance(first, second, limit = Infinity) {
  let distance = 0;
  for (let index = 0; index < first.length; index += 1) {
    let value = first[index] ^ second[index];
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    distance += (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    if (distance > limit) return distance;
  }
  return distance;
}

function estimateHomographyRansac(matches) {
  let seed = matches.length * 0x45d9f3b;
  const random = (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  let best = null;
  for (let iteration = 0; iteration < RANSAC_ITERATIONS; iteration += 1) {
    const sample = [];
    while (sample.length < 4) {
      const index = random(matches.length);
      if (!sample.includes(index)) sample.push(index);
    }
    const homography = solveHomography(sample.map((index) => matches[index]));
    if (!homography || !isValidHomography(homography)) continue;
    const inliers = [];
    let error = 0;
    for (const match of matches) {
      const projected = projectPoint(homography, match.from.x, match.from.y);
      const distance = Math.hypot(projected.x - match.to.x, projected.y - match.to.y);
      if (distance <= RANSAC_THRESHOLD) {
        inliers.push(match);
        error += distance;
      }
    }
    if (!best || inliers.length > best.inliers.length || (inliers.length === best.inliers.length && error < best.error)) {
      best = { homography, inliers, error };
    }
  }
  if (!best || best.inliers.length < 4) return null;
  const refined = solveHomography(best.inliers);
  if (!refined || !isValidHomography(refined)) return best;
  return { homography: refined, inliers: best.inliers, error: best.error };
}

function solveHomography(matches) {
  if (matches.length < 4) return null;
  const sourceNormalization = normalizePoints(matches.map((match) => match.from));
  const destinationNormalization = normalizePoints(matches.map((match) => match.to));
  const rows = [];
  for (const match of matches) {
    const source = projectPoint(sourceNormalization.matrix, match.from.x, match.from.y);
    const destination = projectPoint(destinationNormalization.matrix, match.to.x, match.to.y);
    const { x, y } = source;
    const u = destination.x;
    const v = destination.y;
    rows.push({ values: [x, y, 1, 0, 0, 0, -u * x, -u * y], target: u });
    rows.push({ values: [0, 0, 0, x, y, 1, -v * x, -v * y], target: v });
  }
  const normal = Array.from({ length: 8 }, () => Array(9).fill(0));
  for (const row of rows) {
    for (let i = 0; i < 8; i += 1) {
      normal[i][8] += row.values[i] * row.target;
      for (let j = 0; j < 8; j += 1) normal[i][j] += row.values[i] * row.values[j];
    }
  }
  const solution = solveLinearSystem(normal);
  if (!solution) return null;
  const normalizedHomography = [...solution, 1];
  return multiplyHomographies(
    invertHomography(destinationNormalization.matrix),
    multiplyHomographies(normalizedHomography, sourceNormalization.matrix)
  );
}

function normalizePoints(points) {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
  const meanDistance = points.reduce((sum, point) => sum + Math.hypot(point.x - center.x, point.y - center.y) / points.length, 0);
  const scale = meanDistance > 1e-9 ? Math.SQRT2 / meanDistance : 1;
  return {
    matrix: [scale, 0, -scale * center.x, 0, scale, -scale * center.y, 0, 0, 1]
  };
}

function solveLinearSystem(matrix) {
  const size = matrix.length;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-10) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let entry = column; entry <= size; entry += 1) matrix[column][entry] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let entry = column; entry <= size; entry += 1) matrix[row][entry] -= factor * matrix[column][entry];
    }
  }
  return matrix.map((row) => row[size]);
}

function projectPoint(homography, x, y) {
  const denominator = homography[6] * x + homography[7] * y + homography[8];
  if (Math.abs(denominator) < 1e-9) return { x: Infinity, y: Infinity };
  return {
    x: (homography[0] * x + homography[1] * y + homography[2]) / denominator,
    y: (homography[3] * x + homography[4] * y + homography[5]) / denominator
  };
}

function isValidHomography(homography) {
  return homography.every(Number.isFinite)
    && Math.abs(homography[8]) > 1e-9
    && Math.abs(homography[0] * homography[4] - homography[1] * homography[3]) > 1e-7;
}

function multiplyHomographies(first, second) {
  const result = Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let inner = 0; inner < 3; inner += 1) {
        result[row * 3 + column] += first[row * 3 + inner] * second[inner * 3 + column];
      }
    }
  }
  return result;
}

function invertHomography(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const cofactors = [
    e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d
  ];
  const determinant = a * cofactors[0] + b * cofactors[3] + c * cofactors[6];
  if (Math.abs(determinant) < 1e-10) throw new Error("特徵配對的幾何變換無法反轉。");
  return cofactors.map((value) => value / determinant);
}

// ───────────────────────── 3×3 矩陣工具 ─────────────────────────

function m3mul(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}
function m3t(a) { return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]; }
function m3det(a) {
  return a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
}
function m3inv(a) {
  const det = m3det(a);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  return [
    (a[4] * a[8] - a[5] * a[7]) / det, (a[2] * a[7] - a[1] * a[8]) / det, (a[1] * a[5] - a[2] * a[4]) / det,
    (a[5] * a[6] - a[3] * a[8]) / det, (a[0] * a[8] - a[2] * a[6]) / det, (a[2] * a[3] - a[0] * a[5]) / det,
    (a[3] * a[7] - a[4] * a[6]) / det, (a[1] * a[6] - a[0] * a[7]) / det, (a[0] * a[4] - a[1] * a[3]) / det
  ];
}
function rotVec(wx, wy, wz) {
  const theta = Math.hypot(wx, wy, wz);
  if (theta < 1e-14) return [1, -wz, wy, wz, 1, -wx, -wy, wx, 1];
  const kx = wx / theta;
  const ky = wy / theta;
  const kz = wz / theta;
  const s = Math.sin(theta);
  const c = 1 - Math.cos(theta);
  return [
    1 + c * (-kz * kz - ky * ky), -s * kz + c * kx * ky, s * ky + c * kx * kz,
    s * kz + c * kx * ky, 1 + c * (-kz * kz - kx * kx), -s * kx + c * ky * kz,
    -s * ky + c * kx * kz, s * kx + c * ky * kz, 1 + c * (-ky * ky - kx * kx)
  ];
}
function orthogonalize(matrix) {
  let q = matrix.slice();
  for (let i = 0; i < 14; i += 1) {
    const inverse = m3inv(q);
    if (!inverse) return null;
    const inverseT = m3t(inverse);
    for (let k = 0; k < 9; k += 1) q[k] = 0.5 * (q[k] + inverseT[k]);
  }
  return q;
}
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function vnorm(a) {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 1e-12 ? [a[0] / length, a[1] / length, a[2] / length] : [0, 0, 0];
}

// 對稱 3×3 特徵分解（Jacobi），回傳由小到大排序
function eigenSym3(matrix) {
  const a = matrix.slice();
  let v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 30; sweep += 1) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-14) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      const rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      rotation[p * 3 + p] = c; rotation[q * 3 + q] = c;
      rotation[p * 3 + q] = s; rotation[q * 3 + p] = -s;
      const next = m3mul(m3t(rotation), m3mul(a, rotation));
      for (let k = 0; k < 9; k += 1) a[k] = next[k];
      v = m3mul(v, rotation);
    }
  }
  const items = [0, 1, 2].map((i) => ({ value: a[i * 3 + i], vector: [v[i], v[3 + i], v[6 + i]] }));
  items.sort((x, y) => x.value - y.value);
  return items;
}

// ───────────────────────── 焦距與相機旋轉 ─────────────────────────

// 由單應性（已以影像中心為原點）解出兩張照片的焦距（Szeliski 解法）
function focalsFromHomography(homography) {
  const h = homography.map((value) => value / homography[8]);
  const pick = (v1, v2, d1, d2) => {
    if (v1 < v2) [v1, v2] = [v2, v1];
    if (v1 > 0 && v2 > 0) return Math.sqrt(Math.abs(d1) > Math.abs(d2) ? v1 : v2);
    if (v1 > 0) return Math.sqrt(v1);
    return NaN;
  };
  let d1 = h[6] * h[7];
  let d2 = (h[7] - h[6]) * (h[7] + h[6]);
  const second = pick(-(h[0] * h[1] + h[3] * h[4]) / d1, (h[0] * h[0] + h[3] * h[3] - h[1] * h[1] - h[4] * h[4]) / d2, d1, d2);
  d1 = h[0] * h[3] + h[1] * h[4];
  d2 = h[0] * h[0] + h[1] * h[1] - h[3] * h[3] - h[4] * h[4];
  const first = pick(-h[2] * h[5] / d1, (h[5] * h[5] - h[2] * h[2]) / d2, d1, d2);
  return { first, second };
}

function median(values) {
  if (values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

// Bundle Adjustment：同時微調每台相機的旋轉與共用焦距，最小化「射線」誤差。
// 以 Huber 加權（IRLS）抑制錯誤配對；Jacobian 用數值微分（每筆配對只牽涉 2 台相機 + 焦距）。
function bundleAdjust(startRotations, startFocal, constraints, ref, options = {}) {
  const n = startRotations.length;
  let rotations = startRotations.map((matrix) => matrix.slice());
  let focal = startFocal;
  const count = constraints.count;
  const colOf = new Int32Array(n).fill(-1);
  let freeCount = 0;
  for (let camera = 0; camera < n; camera += 1) if (camera !== ref) colOf[camera] = 3 * freeCount++;
  const paramCount = 3 * freeCount + 1;
  const focalColumn = paramCount - 1;
  const huber = options.huber ?? 2.5;
  const scale = startFocal;
  const focalLow = options.focalLow ?? startFocal * 0.5;
  const focalHigh = options.focalHigh ?? startFocal * 2;
  const { ci, cj, ax, ay, bx, by } = constraints;

  const residual = (m, ra, rb, f, out) => {
    let xa = ax[m] / f;
    let ya = ay[m] / f;
    const na = 1 / Math.sqrt(xa * xa + ya * ya + 1);
    xa *= na; ya *= na;
    const za = na;
    let xb = bx[m] / f;
    let yb = by[m] / f;
    const nb = 1 / Math.sqrt(xb * xb + yb * yb + 1);
    xb *= nb; yb *= nb;
    const zb = nb;
    out[0] = scale * (ra[0] * xa + ra[1] * ya + ra[2] * za - (rb[0] * xb + rb[1] * yb + rb[2] * zb));
    out[1] = scale * (ra[3] * xa + ra[4] * ya + ra[5] * za - (rb[3] * xb + rb[4] * yb + rb[5] * zb));
    out[2] = scale * (ra[6] * xa + ra[7] * ya + ra[8] * za - (rb[6] * xb + rb[7] * yb + rb[8] * zb));
  };

  const weights = new Float64Array(count).fill(1);
  const r0 = new Float64Array(3);
  const r1 = new Float64Array(3);
  const evalCost = (rs, f) => {
    let total = 0;
    for (let m = 0; m < count; m += 1) {
      residual(m, rs[ci[m]], rs[cj[m]], f, r0);
      total += weights[m] * (r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2]);
    }
    return total;
  };

  const A = new Float64Array(paramCount * paramCount);
  const g = new Float64Array(paramCount);
  const jac = new Float64Array(21);
  const cols = new Int32Array(7);
  const eps = 1e-6;
  let lambda = 1e-3;
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  for (let iteration = 0; iteration < (options.iterations ?? 40); iteration += 1) {
    for (let m = 0; m < count; m += 1) {
      residual(m, rotations[ci[m]], rotations[cj[m]], focal, r0);
      const magnitude = Math.hypot(r0[0], r0[1], r0[2]);
      weights[m] = magnitude <= huber ? 1 : huber / magnitude;
    }
    const cost = evalCost(rotations, focal);
    A.fill(0);
    g.fill(0);
    for (let m = 0; m < count; m += 1) {
      const a = ci[m];
      const b = cj[m];
      residual(m, rotations[a], rotations[b], focal, r0);
      const sw = Math.sqrt(weights[m]);
      jac.fill(0);
      for (let k = 0; k < 3; k += 1) {
        cols[k] = colOf[a] >= 0 ? colOf[a] + k : -1;
        cols[3 + k] = colOf[b] >= 0 ? colOf[b] + k : -1;
        if (cols[k] >= 0) {
          const perturbed = m3mul(rotVec(axes[k][0] * eps, axes[k][1] * eps, axes[k][2] * eps), rotations[a]);
          residual(m, perturbed, rotations[b], focal, r1);
          for (let row = 0; row < 3; row += 1) jac[row * 7 + k] = (r1[row] - r0[row]) / eps * sw;
        }
        if (cols[3 + k] >= 0) {
          const perturbed = m3mul(rotVec(axes[k][0] * eps, axes[k][1] * eps, axes[k][2] * eps), rotations[b]);
          residual(m, rotations[a], perturbed, focal, r1);
          for (let row = 0; row < 3; row += 1) jac[row * 7 + 3 + k] = (r1[row] - r0[row]) / eps * sw;
        }
      }
      cols[6] = focalColumn;
      residual(m, rotations[a], rotations[b], focal * (1 + eps), r1);
      for (let row = 0; row < 3; row += 1) jac[row * 7 + 6] = (r1[row] - r0[row]) / eps * sw;

      for (let p = 0; p < 7; p += 1) {
        const cp = cols[p];
        if (cp < 0) continue;
        for (let row = 0; row < 3; row += 1) g[cp] += jac[row * 7 + p] * r0[row] * sw;
        for (let q = 0; q < 7; q += 1) {
          const cq = cols[q];
          if (cq < 0) continue;
          A[cp * paramCount + cq] += jac[p] * jac[q] + jac[7 + p] * jac[7 + q] + jac[14 + p] * jac[14 + q];
        }
      }
    }

    let improved = false;
    let converged = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const system = [];
      for (let i = 0; i < paramCount; i += 1) {
        const row = new Array(paramCount + 1);
        for (let j = 0; j < paramCount; j += 1) row[j] = A[i * paramCount + j];
        row[i] = A[i * paramCount + i] * (1 + lambda) + 1e-9;
        row[paramCount] = -g[i];
        system.push(row);
      }
      const delta = solveLinearSystem(system);
      if (!delta) { lambda *= 10; continue; }
      const candidateRotations = rotations.map((matrix, camera) => {
        const o = colOf[camera];
        return o < 0 ? matrix : m3mul(rotVec(delta[o], delta[o + 1], delta[o + 2]), matrix);
      });
      const candidateFocal = clamp(focal * Math.exp(delta[focalColumn]), focalLow, focalHigh);
      const candidateCost = evalCost(candidateRotations, candidateFocal);
      if (candidateCost < cost) {
        rotations = candidateRotations;
        focal = candidateFocal;
        lambda = Math.max(1e-7, lambda / 3);
        improved = true;
        if ((cost - candidateCost) / Math.max(cost, 1e-9) < 1e-7) converged = true;
        break;
      }
      lambda *= 4;
    }
    if (!improved || converged) break;
  }

  let sum = 0;
  const perMatch = new Float64Array(count);
  for (let m = 0; m < count; m += 1) {
    residual(m, rotations[ci[m]], rotations[cj[m]], focal, r0);
    perMatch[m] = Math.hypot(r0[0], r0[1], r0[2]);
    sum += perMatch[m] * perMatch[m];
  }
  return { rotations, focal, rms: Math.sqrt(sum / Math.max(1, count)), perMatch };
}

// 水平校正：讓所有相機的 X 軸盡量落在同一水平面，使地平線保持水平
function waveCorrect(rotations) {
  const moment = new Array(9).fill(0);
  let sumX = [0, 0, 0];
  let sumY = [0, 0, 0];
  let sumZ = [0, 0, 0];
  for (const r of rotations) {
    const x = [r[0], r[3], r[6]];
    const y = [r[1], r[4], r[7]];
    const z = [r[2], r[5], r[8]];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) moment[i * 3 + j] += x[i] * x[j];
      sumX[i] += x[i]; sumY[i] += y[i]; sumZ[i] += z[i];
    }
  }
  const eig = eigenSym3(moment);
  let up;
  if (eig[1].value < 0.05 * eig[2].value) {
    // 視角太小，X 軸近乎共線：改用相機「下」方向平均值
    const xHat = vnorm(sumX);
    const d = vdot(sumY, xHat);
    up = vnorm([sumY[0] - d * xHat[0], sumY[1] - d * xHat[1], sumY[2] - d * xHat[2]]);
  } else {
    up = eig[0].vector;
  }
  if (vdot(up, sumY) < 0) up = [-up[0], -up[1], -up[2]];
  let right = vnorm(vcross(up, sumZ));
  if (right[0] === 0 && right[1] === 0 && right[2] === 0) {
    const d = vdot(sumX, up);
    right = vnorm([sumX[0] - d * up[0], sumX[1] - d * up[1], sumX[2] - d * up[2]]);
  }
  const forward = vcross(right, up);
  const basis = [...right, ...up, ...forward];
  return rotations.map((r) => m3mul(basis, r));
}

// 可靠配對：內點夠多、比例不太低
function isReliable(record) {
  return record.inliers >= 15 && (record.ratio >= 0.2 || record.inliers >= 30);
}

// 以最大生成樹初始化焦距與旋轉，再做 Bundle Adjustment。
// kept：參與的照片（原始索引）；回傳的 rotations 與 kept 同順序。
function estimateCameras(kept, grays, records) {
  const n = kept.length;
  const position = new Map(kept.map((photo, index) => [photo, index]));
  const recs = records.filter((record) => position.has(record.a) && position.has(record.b) && isReliable(record));

  const centered = (record, imageA, imageB) => {
    // record.matches：to = a 的特徵、from = b 的特徵；回傳 B → A 的對應點（以影像中心為原點）
    const swap = record.a !== imageA;
    const grayA = grays[imageA];
    const grayB = grays[imageB];
    return record.matches.map((match) => {
      const pointA = swap ? match.from : match.to;
      const pointB = swap ? match.to : match.from;
      return {
        from: { x: pointB.x - grayB.width / 2, y: pointB.y - grayB.height / 2 },
        to: { x: pointA.x - grayA.width / 2, y: pointA.y - grayA.height / 2 }
      };
    });
  };

  const longSide = Math.max(...kept.map((photo) => Math.max(grays[photo].width, grays[photo].height)));
  const okFocal = (value) => Number.isFinite(value) && value > longSide * 0.35 && value < longSide * 4;
  const focals = [];
  for (const record of recs.slice().sort((x, y) => y.inliers - x.inliers).slice(0, 40)) {
    const homography = solveHomography(centered(record, record.a, record.b));
    if (!homography || !isValidHomography(homography)) continue;
    const { first, second } = focalsFromHomography(homography);
    if (okFocal(first) && okFocal(second)) focals.push(Math.sqrt(first * second));
    else if (okFocal(first)) focals.push(first);
    else if (okFocal(second)) focals.push(second);
  }
  const focal = focals.length ? median(focals) : longSide * 0.85;

  const rotate = (homography, f) => {
    const h = homography.map((value) => value / homography[8]);
    const m = [h[0], h[1], h[2] / f, h[3], h[4], h[5] / f, h[6] * f, h[7] * f, h[8]];
    return orthogonalize(m.map((value) => value / Math.cbrt(m3det(m))));
  };

  // 最大生成樹（以內點數為權重），從連線最多的照片開始
  const adjacency = Array.from({ length: n }, () => []);
  for (const record of recs) {
    const pa = position.get(record.a);
    const pb = position.get(record.b);
    adjacency[pa].push({ other: pb, record });
    adjacency[pb].push({ other: pa, record });
  }
  let root = 0;
  for (let i = 1; i < n; i += 1) {
    const total = (k) => adjacency[k].reduce((sum, edge) => sum + edge.record.inliers, 0);
    if (total(i) > total(root)) root = i;
  }
  const rotations = new Array(n).fill(null);
  rotations[root] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const treeRecords = new Set();
  const inTree = new Set([root]);
  while (inTree.size < n) {
    let best = null;
    for (const from of inTree) {
      for (const edge of adjacency[from]) {
        if (inTree.has(edge.other)) continue;
        if (!best || edge.record.inliers > best.edge.record.inliers) best = { from, edge };
      }
    }
    if (!best) throw new Error("照片之間的連線不完整，無法估算相機參數。");
    const parent = best.from;
    const child = best.edge.other;
    const homography = solveHomography(centered(best.edge.record, kept[parent], kept[child])); // child → parent
    if (!homography || !isValidHomography(homography)) throw new Error("無法估算照片間的幾何關係。");
    const relative = rotate(homography, focal);
    if (!relative) throw new Error("無法估算相機旋轉。");
    rotations[child] = m3mul(rotations[parent], relative);
    treeRecords.add(best.edge.record);
    inTree.add(child);
  }

  const perPairCap = clamp(Math.floor(40000 / Math.max(1, recs.length)), 60, 250);
  const buildConstraints = (excluded) => {
    const c = { ci: [], cj: [], ax: [], ay: [], bx: [], by: [], pair: [], count: 0 };
    recs.forEach((record, recordIndex) => {
      if (excluded.has(recordIndex)) return;
      const pa = position.get(record.a);
      const pb = position.get(record.b);
      const stride = Math.max(1, Math.ceil(record.matches.length / perPairCap));
      for (let index = 0; index < record.matches.length; index += stride) {
        const match = record.matches[index];
        c.ci.push(pa); c.cj.push(pb);
        c.ax.push(match.to.x - grays[record.a].width / 2);
        c.ay.push(match.to.y - grays[record.a].height / 2);
        c.bx.push(match.from.x - grays[record.b].width / 2);
        c.by.push(match.from.y - grays[record.b].height / 2);
        c.pair.push(recordIndex);
      }
    });
    c.count = c.ci.length;
    return c;
  };

  const excluded = new Set();
  let constraints = buildConstraints(excluded);
  if (constraints.count < 4) throw new Error("可用的特徵配對太少，無法估算相機參數。");
  const limits = { focalLow: focal * 0.65, focalHigh: focal * 1.5 };
  let solution = bundleAdjust(rotations, focal, constraints, root, limits);

  // 剔除與整體解不一致的非生成樹配對（常由重複紋理造成），再解一次
  const perPair = new Map();
  for (let m = 0; m < constraints.count; m += 1) {
    if (!perPair.has(constraints.pair[m])) perPair.set(constraints.pair[m], []);
    perPair.get(constraints.pair[m]).push(solution.perMatch[m]);
  }
  let pruned = false;
  for (const [recordIndex, values] of perPair) {
    if (!treeRecords.has(recs[recordIndex]) && median(values) > 6) { excluded.add(recordIndex); pruned = true; }
  }
  if (pruned) {
    constraints = buildConstraints(excluded);
    solution = bundleAdjust(solution.rotations, solution.focal, constraints, root, limits);
  }

  // 每張照片的殘差中位數：用來判斷是否有照片與整體不一致
  const perPhoto = Array.from({ length: n }, () => []);
  for (let m = 0; m < constraints.count; m += 1) {
    perPhoto[constraints.ci[m]].push(solution.perMatch[m]);
    perPhoto[constraints.cj[m]].push(solution.perMatch[m]);
  }
  return {
    rotations: waveCorrect(solution.rotations),
    focal: solution.focal,
    rms: solution.rms,
    photoResidual: perPhoto.map((values) => (values.length ? median(values) : Infinity)),
    minTreeInliers: Math.min(...Array.from(treeRecords, (record) => record.inliers))
  };
}

// 粗篩用：只算雙向最近鄰＋比例測試通過的對應數（不做 RANSAC），用來挑出值得完整比對的照片對
function mutualMatchCount(first, second) {
  const nearest = (source, target) => source.map((feature) => {
    let bestIndex = -1;
    let bestDistance = Infinity;
    let secondDistance = Infinity;
    for (let index = 0; index < target.length; index += 1) {
      const distance = hammingDistance(feature.descriptor, target[index].descriptor, secondDistance);
      if (distance < bestDistance) { secondDistance = bestDistance; bestDistance = distance; bestIndex = index; }
      else if (distance < secondDistance) secondDistance = distance;
    }
    return { index: bestIndex, bestDistance, secondDistance };
  });
  const forward = nearest(first, second);
  const backward = nearest(second, first);
  let count = 0;
  for (let index = 0; index < forward.length; index += 1) {
    const result = forward[index];
    if (result.index < 0 || result.bestDistance > 104 || result.bestDistance >= result.secondDistance * 0.9) continue;
    if (backward[result.index].index === index) count += 1;
  }
  return count;
}

// 找出相連的照片群組（只用可靠配對）
function connectedGroups(photos, records) {
  const parent = new Map(photos.map((photo) => [photo, photo]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const inSet = new Set(photos);
  for (const record of records) {
    if (!isReliable(record) || !inSet.has(record.a) || !inSet.has(record.b)) continue;
    parent.set(find(record.a), find(record.b));
  }
  const groups = new Map();
  for (const photo of photos) {
    const key = find(photo);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(photo);
  }
  const weight = (group) => records.reduce((sum, record) => sum + (group.includes(record.a) && group.includes(record.b) && isReliable(record) ? record.inliers : 0), 0);
  return Array.from(groups.values()).sort((x, y) => y.length - x.length || weight(y) - weight(x));
}

// 對所有照片比對、挑出主要全景群組、估計相機。grays 為 [{width,height,gray}]（比對解析度）。
// 回傳：order（原始索引，由左至右）、rotations（與 order 同順序）、excluded（被排除的照片與原因）。
async function alignPanorama(grays, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const tick = options.yield || nextTick;
  const allowExclude = options.exclude !== false;
  const count = grays.length;

  const features = [];
  for (let index = 0; index < count; index += 1) {
    features.push(detectFeatures(grays[index]));
    onProgress(`分析照片 ${index + 1} / ${count}…`, 4 + Math.round(14 * (index + 1) / count));
    await tick();
  }

  // 決定要完整比對哪些照片對：張數少就全比；張數多先用強特徵粗篩
  const candidates = [];
  if (count <= 10) {
    for (let a = 0; a < count; a += 1) for (let b = a + 1; b < count; b += 1) candidates.push([a, b]);
  } else {
    const screen = features.map((list) => list.slice(0, 300));
    const scores = Array.from({ length: count }, () => new Array(count).fill(0));
    let done = 0;
    const total = count * (count - 1) / 2;
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        scores[a][b] = scores[b][a] = mutualMatchCount(screen[a], screen[b]);
        done += 1;
      }
      onProgress(`粗篩照片重疊… ${done} / ${total}`, 18 + Math.round(12 * done / total));
      await tick();
    }
    const chosen = new Set();
    for (let a = 0; a < count; a += 1) {
      const ranked = [];
      for (let b = 0; b < count; b += 1) if (b !== a) ranked.push(b);
      ranked.sort((x, y) => scores[a][y] - scores[a][x]);
      ranked.slice(0, 5).forEach((b) => { if (scores[a][b] >= 6) chosen.add(Math.min(a, b) * count + Math.max(a, b)); });
    }
    for (const key of chosen) candidates.push([Math.floor(key / count), key % count]);
  }

  const records = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const [first, second] = candidates[index];
    const match = matchFeatures(features[first], features[second]);
    if (match && match.inliers >= MIN_MATCH_SCORE) {
      records.push({ a: first, b: second, matches: match.inlierMatches, inliers: match.inliers, ratio: match.inlierRatio });
    }
    if (index % 4 === 0 || index === candidates.length - 1) {
      onProgress(`比對照片 ${index + 1} / ${candidates.length}…`, 30 + Math.round(28 * (index + 1) / candidates.length));
      await tick();
    }
  }

  const excluded = [];
  const reasonFor = (photo, inMain) => {
    const linked = records.some((record) => (record.a === photo || record.b === photo) && isReliable(record));
    return linked && !inMain ? "屬於另一組照片，與主要全景無法連接" : "與其他照片沒有足夠的重疊";
  };
  let kept = Array.from({ length: count }, (_, i) => i);
  const groups = connectedGroups(kept, records);
  if (groups[0].length < 2) throw new Error("找不到彼此有足夠重疊的照片。請確認相鄰畫面至少有約三成重疊。");
  if (groups.length > 1) {
    if (!allowExclude) throw new Error("無法可靠地把所有照片連成一組。請確認照片來自同一段全景、相鄰畫面有明顯重疊，或開啟「智慧排除」。");
    kept = groups[0].slice().sort((x, y) => x - y);
    for (let i = 1; i < groups.length; i += 1) for (const photo of groups[i]) excluded.push({ index: photo, reason: reasonFor(photo, false) });
  }

  onProgress("估計相機焦距與旋轉…", 60);
  await tick();
  let cameras = estimateCameras(kept, grays, records);
  // 殘差明顯偏高的照片（內容與整體不一致）逐一排除後重算
  for (let pass = 0; pass < 3 && allowExclude && kept.length > 2; pass += 1) {
    const typical = median(cameras.photoResidual.filter(Number.isFinite));
    const limit = Math.max(5, 3 * typical);
    let worst = -1;
    cameras.photoResidual.forEach((value, k) => { if (value > limit && (worst < 0 || value > cameras.photoResidual[worst])) worst = k; });
    if (worst < 0) break;
    const photo = kept[worst];
    const remaining = kept.filter((p) => p !== photo);
    const regroup = connectedGroups(remaining, records);
    if (regroup[0].length < 2) break;
    excluded.push({ index: photo, reason: "與其他照片的畫面對不上（可能內容不同或視差過大）" });
    for (let i = 1; i < regroup.length; i += 1) for (const other of regroup[i]) excluded.push({ index: other, reason: "排除問題照片後，與主要全景失去連接" });
    kept = regroup[0].slice().sort((x, y) => x - y);
    cameras = estimateCameras(kept, grays, records);
  }

  // 依相機方位角由左至右排序（接縫與預覽都依此順序）
  const azimuth = cameras.rotations.map((r) => Math.atan2(r[2], r[8]));
  const base = Math.atan2(azimuth.reduce((s, a) => s + Math.sin(a), 0), azimuth.reduce((s, a) => s + Math.cos(a), 0));
  const wrapped = azimuth.map((a) => Math.atan2(Math.sin(a - base), Math.cos(a - base)));
  const sequence = kept.map((_, k) => k).sort((x, y) => wrapped[x] - wrapped[y]);
  return {
    order: sequence.map((k) => kept[k]),
    rotations: sequence.map((k) => cameras.rotations[k]),
    focal: cameras.focal,
    rms: cameras.rms,
    excluded,
    lowConfidence: cameras.rms > 3 || cameras.minTreeInliers < 18
  };
}

// ───────────────────────── 投影 ─────────────────────────
// forward：世界射線 → 正規化平面座標 (u,v)；inverse：(u,v) → 射線。座標軸：x 右、y 下、z 前。

const PROJECTIONS = {
  perspective: {
    label: "透視",
    forward(d, o) {
      if (d[2] < 0.1736) return false;
      o[0] = d[0] / d[2]; o[1] = d[1] / d[2];
      return true;
    },
    inverse(u, v, o) { o[0] = u; o[1] = v; o[2] = 1; return true; }
  },
  cylindrical: {
    label: "圓柱",
    forward(d, o) {
      const h = Math.hypot(d[0], d[2]);
      if (h < 1e-6) return false;
      o[0] = Math.atan2(d[0], d[2]); o[1] = d[1] / h;
      return true;
    },
    inverse(u, v, o) {
      if (Math.abs(u) >= Math.PI) return false;
      o[0] = Math.sin(u); o[1] = v; o[2] = Math.cos(u);
      return true;
    }
  },
  spherical: {
    label: "球面",
    forward(d, o) {
      o[0] = Math.atan2(d[0], d[2]);
      o[1] = Math.atan2(d[1], Math.hypot(d[0], d[2]));
      return true;
    },
    inverse(u, v, o) {
      if (Math.abs(u) > Math.PI || Math.abs(v) > Math.PI / 2) return false;
      const cv = Math.cos(v);
      o[0] = cv * Math.sin(u); o[1] = Math.sin(v); o[2] = cv * Math.cos(u);
      return true;
    }
  },
  panini: {
    label: "Panini",
    forward(d, o) {
      const lon = Math.atan2(d[0], d[2]);
      const lat = Math.atan2(d[1], Math.hypot(d[0], d[2]));
      if (Math.abs(lon) > 2.6 || Math.abs(lat) > 1.4) return false;
      const s = 2 / (1 + Math.cos(lon));
      o[0] = s * Math.sin(lon); o[1] = s * Math.tan(lat);
      return true;
    },
    inverse(u, v, o) {
      const s = 1 + u * u / 4;
      const lon = Math.atan2(u, (4 - u * u) / 4);
      const lat = Math.atan2(v, s);
      const cl = Math.cos(lat);
      o[0] = cl * Math.sin(lon); o[1] = Math.sin(lat); o[2] = cl * Math.cos(lon);
      return true;
    }
  },
  stereographic: {
    label: "立體投影",
    forward(d, o) {
      const length = Math.hypot(d[0], d[1], d[2]);
      const alpha = Math.acos(clamp(d[2] / length, -1, 1));
      if (alpha > 2.9) return false;
      const rho = 2 * Math.tan(alpha / 2);
      const radial = Math.hypot(d[0], d[1]);
      if (radial < 1e-9) { o[0] = 0; o[1] = 0; return true; }
      o[0] = rho * d[0] / radial; o[1] = rho * d[1] / radial;
      return true;
    },
    inverse(u, v, o) {
      const rho = Math.hypot(u, v);
      const alpha = 2 * Math.atan(rho / 2);
      const s = Math.sin(alpha);
      if (rho < 1e-12) { o[0] = 0; o[1] = 0; o[2] = 1; return true; }
      o[0] = s * u / rho; o[1] = s * v / rho; o[2] = Math.cos(alpha);
      return true;
    }
  }
};

const rotateY = (angle) => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};

// 決定畫布大小、投影中心與每張照片的覆蓋範圍。
// sizes：每張照片原始像素寬高；matchScale：比對時的縮放；alignment 來自 alignPanorama（已依 order 排好）
function computeLayout(alignment, sizes, matchScale, projectionKey, limits = {}) {
  const maxPixels = limits.maxPixels ?? 8_000_000;
  const maxSide = limits.maxSide ?? 12_000;
  const fFull = alignment.focal / matchScale;
  let rotations = alignment.rotations.map((matrix) => matrix.slice());
  const SAMPLES = 24;

  const borderRays = (size) => {
    const hx = size.width / 2 / fFull;
    const hy = size.height / 2 / fFull;
    const rays = [];
    for (let i = 0; i <= SAMPLES; i += 1) {
      const t = i / SAMPLES;
      rays.push([-hx + 2 * hx * t, -hy], [-hx + 2 * hx * t, hy], [-hx, -hy + 2 * hy * t], [hx, -hy + 2 * hy * t]);
    }
    return rays;
  };
  const worldRays = (rs) => rs.map((matrix, k) => borderRays(sizes[k]).map(([x, y]) => {
    const n = 1 / Math.sqrt(x * x + y * y + 1);
    const cx = x * n; const cy = y * n; const cz = n;
    return [matrix[0] * cx + matrix[1] * cy + matrix[2] * cz,
      matrix[3] * cx + matrix[4] * cy + matrix[5] * cz,
      matrix[6] * cx + matrix[7] * cy + matrix[8] * cz];
  }));

  // 以平均視線方向為基準，把方位角範圍置中
  let rays = worldRays(rotations);
  const meanView = vnorm(rotations.reduce((acc, r) => [acc[0] + r[2], acc[1] + r[5], acc[2] + r[8]], [0, 0, 0]));
  const baseAzimuth = Math.atan2(meanView[0], meanView[2]);
  const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
  let azMin = Infinity; let azMax = -Infinity;
  for (const cameraRays of rays) {
    for (const d of cameraRays) {
      const a = wrap(Math.atan2(d[0], d[2]) - baseAzimuth);
      azMin = Math.min(azMin, a); azMax = Math.max(azMax, a);
    }
  }
  const yaw = rotateY(-(baseAzimuth + (azMin + azMax) / 2));
  rotations = rotations.map((matrix) => m3mul(yaw, matrix));
  rays = worldRays(rotations);

  let elMin = Infinity; let elMax = -Infinity;
  for (const cameraRays of rays) {
    for (const d of cameraRays) {
      const e = Math.atan2(d[1], Math.hypot(d[0], d[2]));
      elMin = Math.min(elMin, e); elMax = Math.max(elMax, e);
    }
  }
  const azimuthSpan = azMax - azMin;
  const elevationSpan = elMax - elMin;

  let key = projectionKey;
  if (!key || key === "auto") {
    if (azimuthSpan <= 0.96 && elevationSpan <= 0.87) key = "perspective";
    else if (azimuthSpan <= 4.4 && elevationSpan <= 1.5) key = "cylindrical";
    else key = "spherical";
  }
  const projection = PROJECTIONS[key];
  const warnings = [];
  if (key === "perspective" && azimuthSpan > 2.1) warnings.push("視角超過約 120°，透視投影的邊緣會被極度拉伸，建議改用圓柱或球面。");

  let umin = Infinity; let umax = -Infinity; let vmin = Infinity; let vmax = -Infinity;
  const out = [0, 0];
  const boxes = rays.map((cameraRays) => {
    const box = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
    for (const d of cameraRays) {
      if (!projection.forward(d, out)) continue;
      box.u0 = Math.min(box.u0, out[0]); box.u1 = Math.max(box.u1, out[0]);
      box.v0 = Math.min(box.v0, out[1]); box.v1 = Math.max(box.v1, out[1]);
    }
    umin = Math.min(umin, box.u0); umax = Math.max(umax, box.u1);
    vmin = Math.min(vmin, box.v0); vmax = Math.max(vmax, box.v1);
    return box;
  });
  if (!Number.isFinite(umin) || !Number.isFinite(vmin) || umax <= umin || vmax <= vmin) {
    throw new Error("這個投影無法容納目前的視角，請改用其他投影。");
  }

  const widthFull = (umax - umin) * fFull;
  const heightFull = (vmax - vmin) * fFull;
  const sigma = Math.min(1, Math.sqrt(maxPixels / (widthFull * heightFull)), maxSide / widthFull, maxSide / heightFull);
  const fOut = fFull * sigma;
  return {
    projection: key,
    rotations,
    fFull,
    sigma,
    fOut,
    umin,
    vmin,
    width: Math.max(1, Math.ceil((umax - umin) * fOut)),
    height: Math.max(1, Math.ceil((vmax - vmin) * fOut)),
    boxes,
    photoSizes: sizes,
    azimuthSpan,
    elevationSpan,
    warnings
  };
}


// ───────────────────────── 反向映射 warp ─────────────────────────

// 把一張照片投到畫布的矩形區域。valid：1=影像內部，2=邊緣外擴 margin 像素（用邊緣顏色延伸）
function warpPhoto(projection, rotation, src, srcFocal, canvasFocal, umin, vmin, roi, out, valid, margin) {
  const { width: sw, height: sh, data } = src;
  const cx = sw / 2;
  const cy = sh / 2;
  const dir = [0, 0, 0];
  const r = rotation;
  const channels = 3;
  for (let y = 0; y < roi.h; y += 1) {
    const v = vmin + (roi.y0 + y + 0.5) / canvasFocal;
    for (let x = 0; x < roi.w; x += 1) {
      const index = y * roi.w + x;
      const u = umin + (roi.x0 + x + 0.5) / canvasFocal;
      if (!projection.inverse(u, v, dir)) { valid[index] = 0; continue; }
      // 相機座標 = Rᵀ · 世界射線
      const camZ = r[2] * dir[0] + r[5] * dir[1] + r[8] * dir[2];
      if (camZ <= 1e-6) { valid[index] = 0; continue; }
      const camX = r[0] * dir[0] + r[3] * dir[1] + r[6] * dir[2];
      const camY = r[1] * dir[0] + r[4] * dir[1] + r[7] * dir[2];
      const sx = srcFocal * camX / camZ + cx - 0.5;
      const sy = srcFocal * camY / camZ + cy - 0.5;
      let state = 0;
      if (sx >= -0.5 && sx <= sw - 0.5 && sy >= -0.5 && sy <= sh - 0.5) state = 1;
      else if (margin > 0 && sx >= -0.5 - margin && sx <= sw - 0.5 + margin && sy >= -0.5 - margin && sy <= sh - 0.5 + margin) state = 2;
      valid[index] = state;
      if (state === 0) continue;
      const px = clamp(sx, 0, sw - 1);
      const py = clamp(sy, 0, sh - 1);
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = px - x0;
      const fy = py - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const o = index * channels;
      out[o] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
      out[o + 1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
      out[o + 2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
    }
  }
}

// ───────────────────────── 曝光（增益）補償 ─────────────────────────
// 最小二乘：讓每對照片在重疊區的平均亮度一致，並以先驗把增益拉回 1。逐通道求解。
function computeGains(low, width, height) {
  const n = low.length;
  const sigmaN = 10;
  const sigmaG = 0.15;
  const pairs = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      let count = 0;
      const sumI = [0, 0, 0];
      const sumJ = [0, 0, 0];
      const vi = low[i].valid;
      const vj = low[j].valid;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const p = y * width + x;
          if (vi[p] !== 1 || vj[p] !== 1) continue;
          count += 1;
          for (let c = 0; c < 3; c += 1) { sumI[c] += low[i].rgb[p * 3 + c]; sumJ[c] += low[j].rgb[p * 3 + c]; }
        }
      }
      if (count > 200) pairs.push({ i, j, count, meanI: sumI.map((s) => s / count), meanJ: sumJ.map((s) => s / count) });
    }
  }
  const gains = new Float32Array(n * 3).fill(1);
  for (let c = 0; c < 3; c += 1) {
    const system = Array.from({ length: n }, () => new Array(n + 1).fill(0));
    for (let i = 0; i < n; i += 1) system[i][i] = 1e-6;
    for (const pair of pairs) {
      const { i, j, count } = pair;
      const mi = pair.meanI[c];
      const mj = pair.meanJ[c];
      system[i][i] += count * (mi * mi / (sigmaN * sigmaN) + 1 / (sigmaG * sigmaG));
      system[j][j] += count * (mj * mj / (sigmaN * sigmaN) + 1 / (sigmaG * sigmaG));
      system[i][j] -= count * mi * mj / (sigmaN * sigmaN);
      system[j][i] -= count * mi * mj / (sigmaN * sigmaN);
      system[i][n] += count / (sigmaG * sigmaG);
      system[j][n] += count / (sigmaG * sigmaG);
    }
    const solution = solveLinearSystem(system);
    if (!solution) continue;
    for (let i = 0; i < n; i += 1) gains[i * 3 + c] = clamp(solution[i], 0.6, 1.6);
  }
  return gains;
}

// ───────────────────────── 接縫搜尋 ─────────────────────────
// 依序把每張照片併入「已拼好的馬賽克」，在重疊區用動態規劃找一條代價最低的路徑，
// 代價 = 顏色差 + 梯度差 + 邊緣懲罰 + 偏離重疊區中央的懲罰。回傳每個像素屬於哪張照片。
function computeOwnerMap(low, width, height) {
  const n = low.length;
  const total = width * height;
  const owner = new Uint8Array(total).fill(255);
  const mosaic = new Uint8ClampedArray(total * 3);
  const mosaicValid = new Uint8Array(total);
  for (let p = 0; p < total; p += 1) {
    if (low[0].valid[p] === 1) {
      owner[p] = 0; mosaicValid[p] = 1;
      mosaic[p * 3] = low[0].rgb[p * 3]; mosaic[p * 3 + 1] = low[0].rgb[p * 3 + 1]; mosaic[p * 3 + 2] = low[0].rgb[p * 3 + 2];
    }
  }
  const lumA = new Float32Array(total);
  const lumB = new Float32Array(total);
  const INF = 1e7;

  for (let k = 1; k < n; k += 1) {
    const rgb = low[k].rgb;
    const validK = low[k].valid;
    let overlapCount = 0;
    let mx = 0; let my = 0; let mc = 0; let kx = 0; let ky = 0; let kc = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        const inMosaic = mosaicValid[p] === 1;
        const inK = validK[p] === 1;
        if (inMosaic) { mx += x; my += y; mc += 1; }
        if (inK) { kx += x; ky += y; kc += 1; }
        if (inMosaic && inK) overlapCount += 1;
      }
    }
    if (kc === 0) continue;
    const assignExclusive = () => {
      for (let p = 0; p < total; p += 1) {
        if (validK[p] === 1 && mosaicValid[p] === 0) {
          owner[p] = k; mosaicValid[p] = 1;
          mosaic[p * 3] = rgb[p * 3]; mosaic[p * 3 + 1] = rgb[p * 3 + 1]; mosaic[p * 3 + 2] = rgb[p * 3 + 2];
        }
      }
    };
    if (overlapCount < 16) { assignExclusive(); continue; }

    for (let p = 0; p < total; p += 1) {
      lumA[p] = 0.299 * mosaic[p * 3] + 0.587 * mosaic[p * 3 + 1] + 0.114 * mosaic[p * 3 + 2];
      lumB[p] = 0.299 * rgb[p * 3] + 0.587 * rgb[p * 3 + 1] + 0.114 * rgb[p * 3 + 2];
    }
    const horizontal = Math.abs(kx / kc - mx / mc) >= Math.abs(ky / kc - my / mc);
    const positive = horizontal ? kx / kc > mx / mc : ky / kc > my / mc;
    const lines = horizontal ? height : width;
    const length = horizontal ? width : height;
    const at = (line, pos) => (horizontal ? line * width + pos : pos * width + line);
    const isOverlap = (p) => mosaicValid[p] === 1 && validK[p] === 1;

    const lo = new Int32Array(lines).fill(-1);
    const hi = new Int32Array(lines).fill(-1);
    for (let line = 0; line < lines; line += 1) {
      for (let pos = 0; pos < length; pos += 1) {
        if (!isOverlap(at(line, pos))) continue;
        if (lo[line] < 0) lo[line] = pos;
        hi[line] = pos;
      }
    }

    const gradient = (lum, p) => {
      const left = p % width > 0 ? lum[p - 1] : lum[p];
      const right = p % width < width - 1 ? lum[p + 1] : lum[p];
      const up = p >= width ? lum[p - width] : lum[p];
      const down = p < total - width ? lum[p + width] : lum[p];
      return [right - left, down - up];
    };
    const pixelCost = (line, pos) => {
      const p = at(line, pos);
      const dr = mosaic[p * 3] - rgb[p * 3];
      const dg = mosaic[p * 3 + 1] - rgb[p * 3 + 1];
      const db = mosaic[p * 3 + 2] - rgb[p * 3 + 2];
      const color = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
      const [gax, gay] = gradient(lumA, p);
      const [gbx, gby] = gradient(lumB, p);
      const gradDiff = Math.hypot(gax - gbx, gay - gby) * 0.5;
      const edge = (Math.hypot(gax, gay) + Math.hypot(gbx, gby)) * 0.25;
      const half = (hi[line] - lo[line]) / 2 + 1;
      const t = (pos - (lo[line] + hi[line]) / 2) / half;
      return color + 0.8 * gradDiff + 0.3 * edge + 0.5 + 6 * t * t;
    };

    const seam = new Float32Array(lines).fill(NaN);
    let line = 0;
    while (line < lines) {
      if (lo[line] < 0) { line += 1; continue; }
      const start = line;
      while (line < lines && lo[line] >= 0) line += 1;
      const end = line - 1;
      let runLo = Infinity; let runHi = -Infinity;
      for (let l = start; l <= end; l += 1) { runLo = Math.min(runLo, lo[l]); runHi = Math.max(runHi, hi[l]); }
      const span = runHi - runLo + 1;
      const back = new Int8Array((end - start + 1) * span);
      let previous = new Float32Array(span);
      let current = new Float32Array(span);
      for (let pos = 0; pos < span; pos += 1) {
        const real = runLo + pos;
        previous[pos] = real >= lo[start] && real <= hi[start] && isOverlap(at(start, real)) ? pixelCost(start, real) : INF;
      }
      for (let l = start + 1; l <= end; l += 1) {
        for (let pos = 0; pos < span; pos += 1) {
          let best = Infinity;
          let bestOffset = 0;
          for (let offset = -3; offset <= 3; offset += 1) {
            const q = pos + offset;
            if (q < 0 || q >= span) continue;
            const value = previous[q] + 1.5 * Math.abs(offset);
            if (value < best) { best = value; bestOffset = offset; }
          }
          const real = runLo + pos;
          const cost = real >= lo[l] && real <= hi[l] && isOverlap(at(l, real)) ? pixelCost(l, real) : INF;
          current[pos] = best + cost;
          back[(l - start) * span + pos] = bestOffset;
        }
        [previous, current] = [current, previous];
      }
      let bestPos = 0;
      for (let pos = 1; pos < span; pos += 1) if (previous[pos] < previous[bestPos]) bestPos = pos;
      let pos = bestPos;
      for (let l = end; l >= start; l -= 1) {
        seam[l] = runLo + pos;
        if (l > start) pos += back[(l - start) * span + pos];
      }
    }

    for (let l = 0; l < lines; l += 1) {
      if (lo[l] < 0) continue;
      for (let pos = lo[l]; pos <= hi[l]; pos += 1) {
        const p = at(l, pos);
        if (!isOverlap(p)) continue;
        const takeNew = positive ? pos > seam[l] : pos < seam[l];
        if (takeNew) {
          owner[p] = k;
          mosaic[p * 3] = rgb[p * 3]; mosaic[p * 3 + 1] = rgb[p * 3 + 1]; mosaic[p * 3 + 2] = rgb[p * 3 + 2];
        }
      }
    }
    assignExclusive();
  }
  return owner;
}

// ───────────────────────── 金字塔與多頻段融合 ─────────────────────────

function pyrDown(src, width, height, channels) {
  const w2 = width >> 1;
  const h2 = height >> 1;
  const tmp = new Float32Array(w2 * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let i = 0; i < w2; i += 1) {
      const c = 2 * i;
      const m2 = Math.max(0, c - 2); const m1 = Math.max(0, c - 1);
      const p1 = Math.min(width - 1, c + 1); const p2 = Math.min(width - 1, c + 2);
      for (let ch = 0; ch < channels; ch += 1) {
        tmp[(y * w2 + i) * channels + ch] = (src[(y * width + m2) * channels + ch] + src[(y * width + p2) * channels + ch]
          + 4 * (src[(y * width + m1) * channels + ch] + src[(y * width + p1) * channels + ch])
          + 6 * src[(y * width + c) * channels + ch]) / 16;
      }
    }
  }
  const out = new Float32Array(w2 * h2 * channels);
  for (let j = 0; j < h2; j += 1) {
    const c = 2 * j;
    const m2 = Math.max(0, c - 2); const m1 = Math.max(0, c - 1);
    const p1 = Math.min(height - 1, c + 1); const p2 = Math.min(height - 1, c + 2);
    for (let i = 0; i < w2; i += 1) {
      for (let ch = 0; ch < channels; ch += 1) {
        out[(j * w2 + i) * channels + ch] = (tmp[(m2 * w2 + i) * channels + ch] + tmp[(p2 * w2 + i) * channels + ch]
          + 4 * (tmp[(m1 * w2 + i) * channels + ch] + tmp[(p1 * w2 + i) * channels + ch])
          + 6 * tmp[(c * w2 + i) * channels + ch]) / 16;
      }
    }
  }
  return out;
}

// 與 pyrDown 的取樣格點一致：偶數位置直接取值，奇數位置取相鄰平均
function pyrUp(src, width, height, channels) {
  const w2 = width * 2;
  const h2 = height * 2;
  const tmp = new Float32Array(w2 * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < w2; x += 1) {
      const i = x >> 1;
      const j = Math.min(width - 1, i + 1);
      for (let ch = 0; ch < channels; ch += 1) {
        const a = src[(y * width + i) * channels + ch];
        tmp[(y * w2 + x) * channels + ch] = x & 1 ? 0.5 * (a + src[(y * width + j) * channels + ch]) : a;
      }
    }
  }
  const out = new Float32Array(w2 * h2 * channels);
  for (let y = 0; y < h2; y += 1) {
    const i = y >> 1;
    const j = Math.min(height - 1, i + 1);
    for (let x = 0; x < w2; x += 1) {
      for (let ch = 0; ch < channels; ch += 1) {
        const a = tmp[(i * w2 + x) * channels + ch];
        out[(y * w2 + x) * channels + ch] = y & 1 ? 0.5 * (a + tmp[(j * w2 + x) * channels + ch]) : a;
      }
    }
  }
  return out;
}

const BLEND_PRESETS = {
  sharp: 0.006, // 窄融合：接縫處少重影，但色差較明顯
  normal: 0.03,
  soft: 0.08 // 寬融合：接縫更平滑，視差處可能略糊
};

async function renderPanorama(layout, provider, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const tick = options.yield || nextTick;
  const projection = PROJECTIONS[layout.projection];
  const n = layout.rotations.length;
  const W = layout.width;
  const H = layout.height;

  // 1) 低解析度：用來估增益與找接縫
  const sLow = Math.min(1, 1000 / Math.max(W, H));
  const wl = Math.max(2, Math.ceil(W * sLow));
  const hl = Math.max(2, Math.ceil(H * sLow));
  const fLow = layout.fOut * sLow;
  const low = [];
  for (let k = 0; k < n; k += 1) {
    const image = await provider.getImage(k, Math.min(1, layout.sigma * sLow));
    const srcFocal = layout.fFull * image.width / layout.photoSizes[k].width;
    const rgb = new Uint8ClampedArray(wl * hl * 3);
    const valid = new Uint8Array(wl * hl);
    const temp = new Float32Array(wl * hl * 3);
    warpPhoto(projection, layout.rotations[k], image, srcFocal, fLow, layout.umin, layout.vmin, { x0: 0, y0: 0, w: wl, h: hl }, temp, valid, 0);
    for (let i = 0; i < temp.length; i += 1) rgb[i] = temp[i];
    low.push({ rgb, valid });
    onProgress("對齊預覽…", Math.round(10 * (k + 1) / n));
    await tick();
  }

  let gains = new Float32Array(n * 3).fill(1);
  if (options.gain !== false) {
    gains = computeGains(low, wl, hl);
    for (let k = 0; k < n; k += 1) {
      const rgb = low[k].rgb;
      for (let p = 0; p < wl * hl; p += 1) {
        rgb[p * 3] *= gains[k * 3]; rgb[p * 3 + 1] *= gains[k * 3 + 1]; rgb[p * 3 + 2] *= gains[k * 3 + 2];
      }
    }
  }
  onProgress("尋找最佳接縫…", 14);
  await tick();
  const owner = computeOwnerMap(low, wl, hl);
  onProgress("尋找最佳接縫…", 20);
  await tick();

  // 2) 全解析度多頻段融合
  const blendWidth = Math.sqrt(W * H) * (BLEND_PRESETS[options.blend] ?? BLEND_PRESETS.normal);
  const bands = clamp(Math.ceil(Math.log2(Math.max(2, blendWidth))) - 1, 1, 7);
  const align = 1 << bands;
  const Wa = Math.ceil(W / align) * align;
  const Ha = Math.ceil(H / align) * align;
  const levelSize = (level) => [Wa >> level, Ha >> level];
  const numerator = [];
  const denominator = [];
  for (let level = 0; level <= bands; level += 1) {
    const [lw, lh] = levelSize(level);
    numerator.push(new Float32Array(lw * lh * 3));
    denominator.push(new Float32Array(lw * lh));
  }
  const margin = Math.max(2, Math.ceil(0.7 / sLow));

  for (let k = 0; k < n; k += 1) {
    const image = await provider.getImage(k, Math.min(1, layout.sigma));
    const srcFocal = layout.fFull * image.width / layout.photoSizes[k].width;
    const box = layout.boxes[k];
    const pad = 6;
    let x0 = Math.floor((box.u0 - layout.umin) * layout.fOut - pad);
    let y0 = Math.floor((box.v0 - layout.vmin) * layout.fOut - pad);
    let x1 = Math.ceil((box.u1 - layout.umin) * layout.fOut + pad);
    let y1 = Math.ceil((box.v1 - layout.vmin) * layout.fOut + pad);
    x0 = Math.max(0, Math.floor(x0 / align) * align);
    y0 = Math.max(0, Math.floor(y0 / align) * align);
    x1 = Math.min(Wa, Math.ceil(x1 / align) * align);
    y1 = Math.min(Ha, Math.ceil(y1 / align) * align);
    const roi = { x0, y0, w: x1 - x0, h: y1 - y0 };
    if (roi.w <= 0 || roi.h <= 0) continue;

    const rgb = new Float32Array(roi.w * roi.h * 3);
    const valid = new Uint8Array(roi.w * roi.h);
    warpPhoto(projection, layout.rotations[k], image, srcFocal, layout.fOut, layout.umin, layout.vmin, roi, rgb, valid, margin);
    const gr = gains[k * 3]; const gg = gains[k * 3 + 1]; const gb = gains[k * 3 + 2];
    const weight = new Float32Array(roi.w * roi.h);
    for (let y = 0; y < roi.h; y += 1) {
      // 把低解析度的歸屬圖（one-hot）雙線性放大，得到邊緣柔和的 level-0 權重
      const fy = (roi.y0 + y + 0.5) * sLow - 0.5;
      const ly0 = clamp(Math.floor(fy), 0, hl - 1);
      const ly1 = Math.min(hl - 1, ly0 + 1);
      const ty = clamp(fy - ly0, 0, 1);
      for (let x = 0; x < roi.w; x += 1) {
        const index = y * roi.w + x;
        if (valid[index] === 0) continue;
        const fx = (roi.x0 + x + 0.5) * sLow - 0.5;
        const lx0 = clamp(Math.floor(fx), 0, wl - 1);
        const lx1 = Math.min(wl - 1, lx0 + 1);
        const tx = clamp(fx - lx0, 0, 1);
        const a = owner[ly0 * wl + lx0] === k ? 1 : 0;
        const b = owner[ly0 * wl + lx1] === k ? 1 : 0;
        const c = owner[ly1 * wl + lx0] === k ? 1 : 0;
        const d = owner[ly1 * wl + lx1] === k ? 1 : 0;
        weight[index] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
        rgb[index * 3] *= gr; rgb[index * 3 + 1] *= gg; rgb[index * 3 + 2] *= gb;
      }
    }

    // Gaussian 金字塔 → Laplacian 頻帶，依權重累加
    // 正規化卷積：影像範圍外不是「黑色」而是「不存在」，否則邊緣（例如全景上緣）會被黑色拖暗而出現色帶
    const gauss = [rgb];
    const wPyr = [weight];
    let premult = rgb;
    let maskLevel = new Float32Array(roi.w * roi.h);
    for (let i = 0; i < valid.length; i += 1) maskLevel[i] = valid[i] ? 1 : 0;
    for (let level = 1; level <= bands; level += 1) {
      const pw = roi.w >> (level - 1);
      const ph = roi.h >> (level - 1);
      premult = pyrDown(premult, pw, ph, 3);
      maskLevel = pyrDown(maskLevel, pw, ph, 1);
      const normalized = new Float32Array(premult.length);
      for (let i = 0; i < maskLevel.length; i += 1) {
        const m = maskLevel[i];
        if (m > 1e-3) {
          normalized[i * 3] = premult[i * 3] / m;
          normalized[i * 3 + 1] = premult[i * 3 + 1] / m;
          normalized[i * 3 + 2] = premult[i * 3 + 2] / m;
        }
      }
      gauss.push(normalized);
      wPyr.push(pyrDown(wPyr[level - 1], pw, ph, 1));
    }
    for (let level = 0; level < bands; level += 1) {
      const lw = roi.w >> level;
      const lh = roi.h >> level;
      const up = pyrUp(gauss[level + 1], lw >> 1, lh >> 1, 3);
      const band = gauss[level];
      for (let i = 0; i < band.length; i += 1) band[i] -= up[i];
    }
    for (let level = 0; level <= bands; level += 1) {
      const lw = roi.w >> level;
      const lh = roi.h >> level;
      const ox = roi.x0 >> level;
      const oy = roi.y0 >> level;
      const [gw] = levelSize(level);
      const band = gauss[level];
      const wl2 = wPyr[level];
      const num = numerator[level];
      const den = denominator[level];
      for (let y = 0; y < lh; y += 1) {
        for (let x = 0; x < lw; x += 1) {
          const wv = wl2[y * lw + x];
          if (wv <= 0) continue;
          const target = (oy + y) * gw + ox + x;
          const source = (y * lw + x) * 3;
          num[target * 3] += band[source] * wv;
          num[target * 3 + 1] += band[source + 1] * wv;
          num[target * 3 + 2] += band[source + 2] * wv;
          den[target] += wv;
        }
      }
    }
    onProgress("多頻段融合…", 20 + Math.round(70 * (k + 1) / n));
    await tick();
  }

  // 3) 正規化並由頂層往下重建
  const resolved = [];
  for (let level = 0; level <= bands; level += 1) {
    const num = numerator[level];
    const den = denominator[level];
    const out = new Float32Array(den.length * 3);
    for (let i = 0; i < den.length; i += 1) {
      if (den[i] > 1e-6) {
        out[i * 3] = num[i * 3] / den[i]; out[i * 3 + 1] = num[i * 3 + 1] / den[i]; out[i * 3 + 2] = num[i * 3 + 2] / den[i];
      }
    }
    resolved.push(out);
  }
  let image = resolved[bands];
  for (let level = bands - 1; level >= 0; level -= 1) {
    const [lw, lh] = levelSize(level + 1);
    const up = pyrUp(image, lw, lh, 3);
    const band = resolved[level];
    for (let i = 0; i < up.length; i += 1) up[i] += band[i];
    image = up;
    await tick();
  }
  const pixels = new Uint8ClampedArray(W * H * 4);
  const coverage = denominator[0];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const source = y * Wa + x;
      const target = (y * W + x) * 4;
      pixels[target] = image[source * 3];
      pixels[target + 1] = image[source * 3 + 1];
      pixels[target + 2] = image[source * 3 + 2];
      pixels[target + 3] = coverage[source] >= 0.5 ? 255 : 0;
    }
  }
  onProgress("完成", 100);
  return { width: W, height: H, data: pixels, gains, bands };
}

root.PanoCore = {
  detectFeatures,
  alignPanorama,
  computeLayout,
  renderPanorama,
  PROJECTIONS,
  BLEND_PRESETS,
  // 以下供測試使用
  focalsFromHomography,
  bundleAdjust,
  waveCorrect,
  warpPhoto
};
if (typeof module !== "undefined" && module.exports) module.exports = root.PanoCore;
})(typeof self !== "undefined" ? self : globalThis);
