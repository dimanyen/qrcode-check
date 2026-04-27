const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 4173;
const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const SCAN_PHOTO_DIR = path.join(DATA_DIR, "scan-photos");

app.use(express.json({ limit: "10mb" }));
app.use("/scan-photos", express.static(SCAN_PHOTO_DIR));

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SCAN_PHOTO_DIR)) fs.mkdirSync(SCAN_PHOTO_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ tasks: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function saveScanPhoto(taskId, assetNo, photoDataUrl) {
  if (!photoDataUrl) return null;
  const match = String(photoDataUrl).match(/^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;

  ensureStore();
  const extension = match[1] === "png" ? "png" : "jpg";
  const safeTaskId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, "");
  const safeAssetNo = String(assetNo).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${safeTaskId}-${safeAssetNo}-${Date.now()}.${extension}`;
  const filePath = path.join(SCAN_PHOTO_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
  return `/scan-photos/${filename}`;
}

function toSummary(task) {
  const checked = task.assets.filter((asset) => asset.checkedAt).length;
  return {
    id: task.id,
    name: task.name,
    resourceColumn: task.resourceColumn,
    total: task.assets.length,
    checked,
    missing: task.assets.length - checked,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

app.get("/api/tasks", (_req, res) => {
  const store = readStore();
  res.json(store.tasks.map(toSummary).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post("/api/tasks", (req, res) => {
  const { name, resourceColumn, assets } = req.body;
  const cleanAssets = Array.isArray(assets)
    ? assets
        .map((asset) => ({
          assetNo: String(asset.assetNo || "").trim(),
          raw: asset.raw && typeof asset.raw === "object" ? asset.raw : {},
          checkedAt: null,
          scanPhotoUrl: null
        }))
        .filter((asset) => asset.assetNo)
    : [];

  if (!String(name || "").trim()) {
    return res.status(400).json({ error: "請輸入任務名稱" });
  }
  if (!String(resourceColumn || "").trim()) {
    return res.status(400).json({ error: "請選擇資源編號欄位" });
  }
  if (!cleanAssets.length) {
    return res.status(400).json({ error: "CSV 內沒有可匯入的資產編號" });
  }

  const seen = new Set();
  const uniqueAssets = cleanAssets.filter((asset) => {
    if (seen.has(asset.assetNo)) return false;
    seen.add(asset.assetNo);
    return true;
  });

  const now = new Date().toISOString();
  const task = {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    resourceColumn: String(resourceColumn).trim(),
    assets: uniqueAssets,
    createdAt: now,
    updatedAt: now
  };

  const store = readStore();
  store.tasks.push(task);
  writeStore(store);
  res.status(201).json(toSummary(task));
});

app.get("/api/tasks/:id", (req, res) => {
  const store = readStore();
  const task = store.tasks.find((item) => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: "找不到盤點任務" });
  res.json({ ...task, summary: toSummary(task) });
});

app.post("/api/tasks/:id/scan", (req, res) => {
  const store = readStore();
  const task = store.tasks.find((item) => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: "找不到盤點任務" });

  const assetNo = String(req.body.assetNo || "").trim();
  const asset = task.assets.find((item) => item.assetNo === assetNo);
  if (!asset) return res.status(404).json({ error: "此任務沒有這個資產編號" });

  const now = new Date().toISOString();
  const alreadyChecked = Boolean(asset.checkedAt);
  const scanPhotoUrl = saveScanPhoto(task.id, asset.assetNo, req.body.photoDataUrl);
  asset.checkedAt = asset.checkedAt || now;
  if (scanPhotoUrl) asset.scanPhotoUrl = scanPhotoUrl;
  task.updatedAt = now;
  writeStore(store);
  res.json({ asset, summary: toSummary(task), alreadyChecked });
});

app.get("/api/tasks/:id/export", (req, res) => {
  const store = readStore();
  const task = store.tasks.find((item) => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: "找不到盤點任務" });

  const rawColumns = Array.from(
    task.assets.reduce((columns, asset) => {
      Object.keys(asset.raw || {}).forEach((key) => columns.add(key));
      return columns;
    }, new Set())
  );
  const columns = ["assetNo", "status", "checkedAt", "scanPhotoUrl", ...rawColumns.filter((column) => column !== "assetNo")];
  const escapeCsv = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [
    columns.map(escapeCsv).join(","),
    ...task.assets.map((asset) =>
      columns
        .map((column) => {
          if (column === "assetNo") return escapeCsv(asset.assetNo);
          if (column === "status") return escapeCsv(asset.checkedAt ? "checked" : "missing");
          if (column === "checkedAt") return escapeCsv(asset.checkedAt);
          if (column === "scanPhotoUrl") return escapeCsv(asset.scanPhotoUrl);
          return escapeCsv(asset.raw?.[column]);
        })
        .join(",")
    )
  ];

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(task.name)}-inventory.csv"`);
  res.send(`\uFEFF${rows.join("\n")}`);
});

if (process.env.NODE_ENV === "production") {
  const distDir = path.join(__dirname, "..", "dist");
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
