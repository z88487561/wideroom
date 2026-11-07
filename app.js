"use strict";

// 全景拼接室 — UI 與影像解碼。拼接演算法在 stitch-core.js。
const MATCH_SIDES = [800, 560, 1100]; // 特徵比對的最長邊；失敗時依序換解析度重試（太高解析度的特徵反而較難配對）
const MAX_PHOTOS = 32;
const MAX_OUTPUT_SIDE = 12_000;
const IS_LIGHT_DEVICE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.deviceMemory && navigator.deviceMemory <= 4);
const MAX_OUTPUT_PIXELS = IS_LIGHT_DEVICE ? 3_500_000 : 8_000_000;

const PROJECTION_HINTS = {
  auto: "依視角大小自動選擇：小視角用透視，一般與寬幅橫向全景用圓柱，視角極大或上下也很廣時用球面。",
  perspective: "直線保持筆直，最像單張相機照片；視角超過約 100° 邊緣會被拉伸。",
  cylindrical: "垂直線保持垂直，水平方向展開；適合一般橫向全景與建築。",
  panini: "介於透視與圓柱之間，寬視角建築看起來最自然、不會兩側被拉歪。",
  spherical: "等距柱狀（360° 全景圖格式），直線會彎曲；適合超廣角或要再匯入全景檢視器。",
  stereographic: "立體投影，廣角時保持形狀不變形，中心放大、邊緣壓縮（小行星風格）。"
};
const PROJECTION_NAMES = {
  perspective: "透視", cylindrical: "圓柱", panini: "Panini", spherical: "球面", stereographic: "立體投影"
};

const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const photoListWrap = document.querySelector("#photoListWrap");
const photoList = document.querySelector("#photoList");
const photoCount = document.querySelector("#photoCount");
const stitchButton = document.querySelector("#stitchButton");
const clearButton = document.querySelector("#clearButton");
const progressPanel = document.querySelector("#progressPanel");
const progressLabel = document.querySelector("#progressLabel");
const progressPercent = document.querySelector("#progressPercent");
const progressBar = document.querySelector("#progressBar");
const statusMessage = document.querySelector("#statusMessage");
const resultSection = document.querySelector("#resultSection");
const resultPreview = document.querySelector("#resultPreview");
const resultDetails = document.querySelector("#resultDetails");
const downloadButton = document.querySelector("#downloadButton");
const projectionSelect = document.querySelector("#projectionSelect");
const blendSelect = document.querySelector("#blendSelect");
const gainCheck = document.querySelector("#gainCheck");
const cropCheck = document.querySelector("#cropCheck");
const excludeCheck = document.querySelector("#excludeCheck");
const installButton = document.querySelector("#installButton");
const projectionHint = document.querySelector("#projectionHint");

let photos = [];
let resultCanvas = null;
let resultUrl = null;
let draggedPhotoId = null;
let isBusy = false;
let alignmentCache = null; // { ids, alignment, matchScale }：換投影或融合方式時不必重新比對


fileInput.addEventListener("change", async () => {
  await addFiles(Array.from(fileInput.files || []));
  fileInput.value = "";
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-over");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
  });
}

dropZone.addEventListener("drop", async (event) => {
  if (!isBusy) await addFiles(Array.from(event.dataTransfer.files || []));
});

photoList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || isBusy) return;
  const index = photos.findIndex((photo) => photo.id === button.dataset.id);
  if (index < 0) return;

  if (button.dataset.action === "remove") {
    removePhoto(index);
  } else {
    const targetIndex = index + (button.dataset.action === "left" ? -1 : 1);
    if (targetIndex >= 0 && targetIndex < photos.length) {
      [photos[index], photos[targetIndex]] = [photos[targetIndex], photos[index]];
      renderPhotoList();
    }
  }
});

photoList.addEventListener("dragstart", (event) => {
  const card = event.target.closest(".photo-card");
  if (!card || isBusy) return;
  draggedPhotoId = card.dataset.id;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedPhotoId);
});

photoList.addEventListener("dragover", (event) => {
  const card = event.target.closest(".photo-card");
  if (!card || !draggedPhotoId) return;
  event.preventDefault();
  photoList.querySelectorAll(".drag-target").forEach((item) => item.classList.remove("drag-target"));
  card.classList.add("drag-target");
});

photoList.addEventListener("drop", (event) => {
  const card = event.target.closest(".photo-card");
  if (!card || !draggedPhotoId || card.dataset.id === draggedPhotoId) return;
  event.preventDefault();
  const from = photos.findIndex((photo) => photo.id === draggedPhotoId);
  const to = photos.findIndex((photo) => photo.id === card.dataset.id);
  if (from < 0 || to < 0) return;
  const [photo] = photos.splice(from, 1);
  photos.splice(to, 0, photo);
  renderPhotoList();
});

photoList.addEventListener("dragend", () => {
  draggedPhotoId = null;
  photoList.querySelectorAll(".dragging, .drag-target").forEach((item) => {
    item.classList.remove("dragging", "drag-target");
  });
});

clearButton.addEventListener("click", clearPhotos);
stitchButton.addEventListener("click", stitchPhotos);
downloadButton.addEventListener("click", downloadResult);

async function addFiles(files) {
  const imageFiles = files.filter((file) => file.type.startsWith("image/") || /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(file.name));
  if (imageFiles.length === 0) {
    if (files.length > 0) showStatus("請選擇瀏覽器可讀取的圖片檔案。", "error");
    return;
  }

  const room = Math.max(0, MAX_PHOTOS - photos.length);
  const overflow = Math.max(0, imageFiles.length - room);
  const added = [];
  const rejected = [];
  for (const file of imageFiles.slice(0, room)) {
    let url = URL.createObjectURL(file);
    try {
      const image = await loadImage(url);
      added.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        url,
        width: image.naturalWidth,
        height: image.naturalHeight
      });
      image.src = "";
    } catch (error) {
      URL.revokeObjectURL(url);
      rejected.push(file.name);
      console.error("Could not read image:", error);
    }
  }

  photos.push(...added);
  renderPhotoList();
  clearResult();

  if (rejected.length > 0) {
    showStatus(`無法讀取 ${rejected.join("、")}。請確認檔案格式受到此瀏覽器支援。`, "error");
  } else if (overflow > 0) {
    showStatus(`一次最多 ${MAX_PHOTOS} 張，已略過 ${overflow} 張；請分批拼接。`, "warning");
  } else if (added.length > 0) {
    hideStatus();
  }
}

function renderPhotoList() {
  photoList.replaceChildren();
  let displayNumber = 0;
  photos.forEach((photo, index) => {
    const card = document.createElement("li");
    card.className = photo.excluded ? "photo-card excluded" : "photo-card";
    if (photo.excluded) card.title = `已排除：${photo.excluded}`;
    card.draggable = !isBusy;
    card.dataset.id = photo.id;

    const image = document.createElement("img");
    image.className = "photo-thumb";
    image.src = photo.url;
    image.alt = `照片 ${index + 1} 預覽`;
    image.loading = "lazy";

    const order = document.createElement("span");
    order.className = "photo-order";
    order.textContent = photo.excluded ? "排除" : String(++displayNumber).padStart(2, "0");

    const name = document.createElement("span");
    name.className = "photo-name";
    name.textContent = photo.file.name;
    name.title = `${photo.file.name} · ${photo.width} × ${photo.height}`;

    const controls = document.createElement("span");
    controls.className = "photo-controls";
    if (!photo.excluded && index > 0 && !photos[index - 1].excluded) controls.append(createPhotoButton("left", photo.id, "向左移動"));
    if (!photo.excluded && index < photos.length - 1 && !photos[index + 1].excluded) controls.append(createPhotoButton("right", photo.id, "向右移動"));
    controls.append(createPhotoButton("remove", photo.id, "移除照片"));

    card.append(image, order, name, controls);
    photoList.append(card);
  });

  const hasPhotos = photos.length > 0;
  photoListWrap.hidden = !hasPhotos;
  dropZone.hidden = hasPhotos;
  photoCount.textContent = photos.some((photo) => photo.excluded) ? `${activePhotos().length} 張使用中 · ${photos.length - activePhotos().length} 張已排除` : `${photos.length} 張照片`;
  stitchButton.disabled = isBusy || photos.length < 2;
  fileInput.disabled = isBusy;
  clearButton.disabled = isBusy;
  photoList.querySelectorAll("button").forEach((button) => { button.disabled = isBusy; });
  document.querySelector(".add-more").hidden = isBusy;
}

function createPhotoButton(action, id, label) {
  const button = document.createElement("button");
  button.className = "photo-control";
  button.type = "button";
  button.dataset.action = action;
  button.dataset.id = id;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = action === "left" ? "←" : action === "right" ? "→" : "×";
  return button;
}

function removePhoto(index) {
  URL.revokeObjectURL(photos[index].url);
  photos.splice(index, 1);
  renderPhotoList();
  clearResult();
  hideStatus();
}

function clearPhotos() {
  if (isBusy) return;
  photos.forEach((photo) => URL.revokeObjectURL(photo.url));
  photos = [];
  renderPhotoList();
  clearResult();
  hideStatus();
  progressPanel.hidden = true;
}


projectionSelect.addEventListener("change", () => {
  updateProjectionHint();
  rerenderFromCache();
});
for (const control of [blendSelect, gainCheck, cropCheck]) control.addEventListener("change", rerenderFromCache);
updateProjectionHint();

function updateProjectionHint() {
  projectionHint.textContent = PROJECTION_HINTS[projectionSelect.value] || "";
}

function activePhotos() {
  return photos.filter((photo) => !photo.excluded);
}

function samePhotoOrder(ids) {
  const active = activePhotos();
  return ids.length === active.length && ids.every((id, index) => id === active[index].id);
}

async function stitchPhotos() {
  if (isBusy || photos.length < 2) return;
  if (photos.length > MAX_PHOTOS) {
    showStatus(`一次最多支援 ${MAX_PHOTOS} 張照片；請分批拼接或移除部分照片。`, "error");
    return;
  }
  photos.forEach((photo) => { photo.excluded = null; });
  clearResult();
  setBusy(true);
  progressPanel.hidden = false;
  setProgress("分析照片…", 2);
  hideStatus();

  try {
    const longest = Math.max(...photos.map((photo) => Math.max(photo.width, photo.height)));
    let alignment = null;
    let matchScale = 1;
    let lastError = null;
    for (const side of MATCH_SIDES) {
      matchScale = Math.min(1, side / longest);
      try {
        const grays = [];
        for (let index = 0; index < photos.length; index += 1) {
          grays.push(await createGrayImage(photos[index], matchScale));
          setProgress(`讀取照片 ${index + 1} / ${photos.length}…`, 1 + Math.round(3 * (index + 1) / photos.length));
          await yieldToBrowser();
        }
        alignment = await PanoCore.alignPanorama(grays, { onProgress: setProgress, yield: yieldToBrowser, exclude: excludeCheck.checked });
        break;
      } catch (error) {
        lastError = error;
        console.warn(`比對解析度 ${side}px 失敗：${error.message}`);
        if (side !== MATCH_SIDES[MATCH_SIDES.length - 1]) setProgress("換個解析度重試…", 2);
      }
    }
    if (!alignment) throw lastError || new Error("無法對齊這組照片。");

    const original = photos;
    const kept = alignment.order.map((index) => original[index]);
    const skipped = alignment.excluded.map((item) => {
      original[item.index].excluded = item.reason;
      return original[item.index];
    });
    photos = [...kept, ...skipped];
    renderPhotoList();
    alignmentCache = { ids: kept.map((photo) => photo.id), alignment, matchScale };
    await renderFromCache({ base: 60, span: 40, lowConfidence: alignment.lowConfidence, fresh: true, skipped });
  } catch (error) {
    console.error("Panorama stitching failed:", error);
    resultCanvas = null;
    showStatus(`拼接失敗：${error.message || "瀏覽器無法處理這組照片。請減少照片數量或使用較小的圖片後重試。"}`, "error");
  } finally {
    setBusy(false);
  }
}

// 以已完成的對齊結果重新渲染（切換投影／融合方式時使用，不需重新比對）
async function rerenderFromCache() {
  if (isBusy || !alignmentCache || !samePhotoOrder(alignmentCache.ids)) return;
  setBusy(true);
  progressPanel.hidden = false;
  setProgress("重新渲染…", 0);
  try {
    await renderFromCache({ base: 0, span: 100 });
  } catch (error) {
    console.error("Panorama render failed:", error);
    showStatus(`渲染失敗：${error.message || "請改用其他投影或減少照片數量。"}`, "error");
  } finally {
    setBusy(false);
  }
}

async function renderFromCache({ base, span, lowConfidence = false, fresh = false, skipped = [] }) {
  const { alignment, matchScale } = alignmentCache;
  const active = activePhotos();
  const sizes = active.map((photo) => ({ width: photo.width, height: photo.height }));
  const layout = PanoCore.computeLayout(alignment, sizes, matchScale, projectionSelect.value, {
    maxPixels: MAX_OUTPUT_PIXELS,
    maxSide: MAX_OUTPUT_SIDE
  });
  const provider = { getImage: (index, scale) => decodePhoto(active[index], scale) };
  const rendered = await PanoCore.renderPanorama(layout, provider, {
    blend: blendSelect.value,
    gain: gainCheck.checked,
    yield: yieldToBrowser,
    onProgress: (label, percent) => setProgress(label, base + Math.round(span * percent / 100))
  });

  let canvas = document.createElement("canvas");
  canvas.width = rendered.width;
  canvas.height = rendered.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("瀏覽器無法建立輸出畫布。");
  context.putImageData(new ImageData(rendered.data, rendered.width, rendered.height), 0, 0);
  if (cropCheck.checked) canvas = cropToLargestOpaqueRectangle(canvas);
  resultCanvas = canvas;

  const previewBlob = await canvasToBlob(createPreviewCanvas(resultCanvas), "image/jpeg", 0.88);
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(previewBlob);
  resultPreview.src = resultUrl;
  resultSection.hidden = false;
  const degrees = Math.round(layout.azimuthSpan * 180 / Math.PI);
  resultDetails.textContent = `${resultCanvas.width.toLocaleString()} × ${resultCanvas.height.toLocaleString()} px · ${active.length} 張照片${skipped.length ? `（另排除 ${skipped.length} 張）` : ""} · 投影：${PROJECTION_NAMES[layout.projection]} · 水平視角約 ${degrees}°`;
  setProgress("完成", 100);

  const skippedNote = skipped.length > 0
    ? `已自動排除 ${skipped.length} 張不符的照片（${skipped.slice(0, 3).map((photo) => photo.file.name).join("、")}${skipped.length > 3 ? " 等" : ""}），原因見縮圖。`
    : "";
  if (layout.warnings.length > 0) {
    showStatus(`${layout.warnings[0]}${skippedNote ? ` ${skippedNote}` : ""}`, "warning");
  } else if (skippedNote) {
    showStatus(`已完成拼接。${skippedNote}`, "warning");
  } else if (lowConfidence) {
    showStatus("已完成拼接，但部分照片的有效特徵較少，請檢查接縫；必要時補拍重疊更多的照片。", "warning");
  } else if (fresh) {
    showStatus("已完成拼接。可直接切換上方的投影方式或融合強度，不必重新比對。");
  } else {
    hideStatus();
  }
}

async function createGrayImage(photo, scale) {
  const image = await decodePhoto(photo, scale);
  const gray = new Uint8Array(image.width * image.height);
  const { data } = image;
  for (let source = 0, target = 0; target < gray.length; source += 4, target += 1) {
    gray[target] = (77 * data[source] + 150 * data[source + 1] + 29 * data[source + 2]) >> 8;
  }
  return { width: image.width, height: image.height, gray };
}

// 解碼並縮放到指定比例。縮小倍率大時逐次減半，避免瀏覽器一次大幅縮小造成鋸齒。
async function decodePhoto(photo, scale) {
  const image = await loadImage(photo.url);
  let source = image;
  try {
    const targetWidth = Math.max(2, Math.round(photo.width * Math.min(1, scale)));
    const targetHeight = Math.max(2, Math.round(photo.height * Math.min(1, scale)));
    let currentWidth = photo.width;
    let currentHeight = photo.height;
    while (currentWidth / 2 >= targetWidth && currentHeight / 2 >= targetHeight) {
      const nextWidth = Math.round(currentWidth / 2);
      const nextHeight = Math.round(currentHeight / 2);
      const step = document.createElement("canvas");
      step.width = nextWidth;
      step.height = nextHeight;
      const stepContext = step.getContext("2d");
      if (!stepContext) throw new Error("瀏覽器無法建立縮放畫布。");
      stepContext.imageSmoothingQuality = "high";
      stepContext.drawImage(source, 0, 0, nextWidth, nextHeight);
      if (source !== image) { source.width = 0; source.height = 0; }
      source = step;
      currentWidth = nextWidth;
      currentHeight = nextHeight;
    }
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("瀏覽器無法建立分析畫布。");
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, targetWidth, targetHeight);
    const { data } = context.getImageData(0, 0, targetWidth, targetHeight);
    canvas.width = 0;
    canvas.height = 0;
    return { width: targetWidth, height: targetHeight, data };
  } finally {
    if (source !== image) { source.width = 0; source.height = 0; }
    image.src = "";
  }
}


function cropToLargestOpaqueRectangle(source) {
  const context = source.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("無法裁切全景邊界。");
  const { width, height } = source;
  const pixels = context.getImageData(0, 0, width, height).data;
  const columnHeights = new Uint32Array(width);
  const stack = new Int32Array(width + 1);
  let best = { x: 0, y: 0, width, height, area: 0 };

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      columnHeights[x] = pixels[rowOffset + x * 4 + 3] >= 64 ? columnHeights[x] + 1 : 0;
    }

    let stackSize = 0;
    for (let x = 0; x <= width; x += 1) {
      const currentHeight = x === width ? 0 : columnHeights[x];
      while (stackSize > 0 && columnHeights[stack[stackSize - 1]] > currentHeight) {
        const bar = stack[--stackSize];
        const left = stackSize > 0 ? stack[stackSize - 1] + 1 : 0;
        const rectangleHeight = columnHeights[bar];
        const rectangleWidth = x - left;
        const area = rectangleHeight * rectangleWidth;
        if (area > best.area) {
          best = { x: left, y: y - rectangleHeight + 1, width: rectangleWidth, height: rectangleHeight, area };
        }
      }
      stack[stackSize++] = x;
    }
  }

  if (best.width < width * 0.2 || best.height < height * 0.2) return source;
  const cropped = document.createElement("canvas");
  cropped.width = best.width;
  cropped.height = best.height;
  const croppedContext = cropped.getContext("2d");
  if (!croppedContext) throw new Error("無法建立裁切後的全景。");
  croppedContext.drawImage(source, best.x, best.y, best.width, best.height, 0, 0, best.width, best.height);
  source.width = 0;
  source.height = 0;
  return cropped;
}

function createPreviewCanvas(source) {
  const maxPreviewWidth = 1800;
  const scale = Math.min(1, maxPreviewWidth / source.width);
  const preview = document.createElement("canvas");
  preview.width = Math.max(1, Math.round(source.width * scale));
  preview.height = Math.max(1, Math.round(source.height * scale));
  const context = preview.getContext("2d");
  if (!context) throw new Error("無法產生預覽圖片。");
  context.drawImage(source, 0, 0, preview.width, preview.height);
  return preview;
}

async function downloadResult() {
  if (!resultCanvas) return;
  downloadButton.disabled = true;
  try {
    const blob = await canvasToBlob(resultCanvas, "image/jpeg", 0.94);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `panorama-${new Date().toISOString().slice(0, 10)}.jpg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.error("Could not export panorama:", error);
    showStatus(`無法匯出圖片：${error.message || "請確認裝置記憶體足夠後重試。"}`, "error");
  } finally {
    downloadButton.disabled = false;
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("瀏覽器無法產生圖片檔。"));
    }, type, quality);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("圖片解碼失敗。"));
    image.src = url;
  });
}

function setBusy(busy) {
  isBusy = busy;
  stitchButton.querySelector("span:first-child").textContent = busy ? "拼接中…" : "開始拼接";
  for (const control of [projectionSelect, blendSelect, gainCheck, cropCheck, excludeCheck]) control.disabled = busy;
  renderPhotoList();
}

function setProgress(label, percent) {
  const value = Math.max(0, Math.min(100, percent));
  progressLabel.textContent = label;
  progressPercent.textContent = `${value}%`;
  progressBar.style.width = `${value}%`;
}

function showStatus(message, kind = "") {
  statusMessage.textContent = message;
  statusMessage.className = `status-message${kind ? ` ${kind}` : ""}`;
  statusMessage.hidden = false;
}

function hideStatus() {
  statusMessage.hidden = true;
  statusMessage.textContent = "";
  statusMessage.className = "status-message";
}

function clearResult() {
  resultCanvas = null;
  alignmentCache = null;
  resultSection.hidden = true;
  resultPreview.removeAttribute("src");
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── PWA：離線快取與安裝 ──
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((error) => console.warn("Service worker 註冊失敗：", error));
  });
}

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installButton.hidden = true;
});
window.addEventListener("appinstalled", () => { installButton.hidden = true; });
