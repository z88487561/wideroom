# 全景拼接室 WIDEROOM

純瀏覽器的全景拼接 PWA，照片不會上傳。可安裝到桌面或手機主畫面，之後完全離線使用。

## 使用方式
- **直接開檔**：用瀏覽器開啟 `index.html`（可用，但不能安裝成 App、也沒有離線快取）。
- **PWA（建議）**：把整個資料夾放到任何 https 網站（GitHub Pages、Netlify、Cloudflare Pages 都行），
  或本機測試用 `python3 -m http.server` 後開 `http://localhost:8000`。
  瀏覽器網址列會出現「安裝」，頁面右上角也會出現「安裝 App」按鈕。

## 檔案
- `stitch-core.js`：拼接演算法（不依賴 DOM，Node 也能跑）
- `app.js`：介面、照片解碼、PWA 註冊
- `index.html` / `styles.css`：頁面
- `manifest.webmanifest`、`sw.js`、`icons/`：PWA。**修改任何程式檔後，請把 `sw.js` 的 `VERSION` 加 1**，使用者才會拿到新版

## 流程
1. Harris 角點（次像素、網格分散）＋ 旋轉 BRIEF，最長邊 800 px 比對（失敗時自動改用 560、1100 px 重試）
2. 照片超過 10 張時先用強特徵粗篩，只對可能重疊的照片對做完整比對
3. 以可靠配對建圖，只保留最大的一組（其餘自動排除）
4. 最大生成樹初始化焦距與旋轉 → Bundle Adjustment 整體最佳化
5. 殘差明顯偏高的照片再排除一次，重新最佳化
6. 水平校正、依方位角由左至右排序
7. 依所選投影反向映射（透視／圓柱／Panini／球面／立體投影）
8. 增益補償 → 動態規劃接縫 → 多頻段融合（正規化卷積，邊緣不會被黑色拖暗）

切換投影、融合強度、曝光補償、裁切時沿用對齊結果重新渲染，不必重新比對。

## 參數
- `app.js`：`MAX_PHOTOS`（一次最多張數，預設 32）、`MATCH_SIDES`、`MAX_OUTPUT_PIXELS`（手機預設較低）
- `stitch-core.js`：`MAX_FEATURES`、`RANSAC_THRESHOLD`、`BLEND_PRESETS`、`isReliable()`（排除的嚴格程度）

## 已知限制
- 假設由同一位置旋轉拍攝；近物的大視差無法完全消除，只能靠接縫避開
- 單列橫向全景；不支援 360° 閉環與多列拼接
- 未做鏡頭畸變與暈影校正、HDR、內容感知填補
- 運算在主執行緒進行（每步會讓出控制權）；32 張時處理期間頁面較不靈敏
