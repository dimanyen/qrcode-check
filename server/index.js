const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const Database = require("better-sqlite3");

const ASSET_CIPHER_KEY = Buffer.from("QRCodeCheck!Fixed@Key#2024$Data!", "utf8"); // 32 bytes

function decryptAssets(b64) {
  const combined = Buffer.from(b64, "base64");
  const iv = combined.subarray(0, 12);
  const payload = combined.subarray(12);
  const authTag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(0, payload.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", ASSET_CIPHER_KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

const app = express();
const PORT = process.env.PORT || 4173;
const DATA_DIR = path.join(__dirname, "..", "data");
const SCAN_PHOTO_DIR = path.join(DATA_DIR, "scan-photos");
const DELETE_TASK_PASSWORD = "dmishandsome";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCAN_PHOTO_DIR)) fs.mkdirSync(SCAN_PHOTO_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "store.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    resource_column TEXT NOT NULL,
    location_column TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    asset_no      TEXT NOT NULL,
    raw           TEXT NOT NULL DEFAULT '{}',
    checked_at    TEXT,
    scan_photo_url TEXT,
    scanned_by    TEXT,
    PRIMARY KEY (task_id, asset_no)
  );
`);

app.use(express.json({ limit: "10mb" }));
app.use("/scan-photos", express.static(SCAN_PHOTO_DIR));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const color = res.statusCode >= 500 ? "\x1b[31m" : res.statusCode >= 400 ? "\x1b[33m" : "\x1b[32m";
    console.log(`${color}${req.method} ${req.path} → ${res.statusCode} (${ms}ms)\x1b[0m`);
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      console.warn(`\x1b[31m[WARN] ${req.method} ${req.path} — connection closed before response finished\x1b[0m`);
    }
  });
  next();
});

function saveScanPhoto(taskId, assetNo, photoDataUrl) {
  if (!photoDataUrl) return null;
  const match = String(photoDataUrl).match(/^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;

  const extension = match[1] === "png" ? "png" : "jpg";
  const safeTaskId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, "");
  const safeAssetNo = String(assetNo).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${safeTaskId}-${safeAssetNo}-${Date.now()}.${extension}`;
  const filePath = path.join(SCAN_PHOTO_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
  return `/scan-photos/${filename}`;
}

function parseScanner(scanner) {
  const name = String(scanner?.name || "").trim();
  const employeeId = String(scanner?.employeeId || "").trim();
  const note = String(scanner?.note || "").trim();
  if (!name) return { error: "請輸入掃描者姓名" };
  if (!/^\d{8}$/.test(employeeId)) return { error: "員工編號需為 8 碼數字" };
  return { name, employeeId, note };
}

function rowToAsset(row) {
  return {
    assetNo: row.asset_no,
    raw: JSON.parse(row.raw || "{}"),
    checkedAt: row.checked_at || null,
    scanPhotoUrl: row.scan_photo_url || null,
    scannedBy: row.scanned_by ? JSON.parse(row.scanned_by) : null
  };
}

const wrap = (fn) => (req, res, next) => {
  try {
    Promise.resolve(fn(req, res, next)).catch(next);
  } catch (err) {
    next(err);
  }
};

function toSummary(task, total, checked) {
  return {
    id: task.id,
    name: task.name,
    resourceColumn: task.resource_column,
    locationColumn: task.location_column || "",
    total,
    checked,
    missing: total - checked,
    createdAt: task.created_at,
    updatedAt: task.updated_at
  };
}

app.get("/api/tasks", wrap((_req, res) => {
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
  const result = tasks.map((task) => {
    const { total, checked } = db
      .prepare("SELECT COUNT(*) as total, COUNT(checked_at) as checked FROM assets WHERE task_id = ?")
      .get(task.id);
    return toSummary(task, total, checked);
  });
  res.json(result);
}));

app.post("/api/tasks", wrap((req, res) => {
  const { name, resourceColumn, locationColumn, encryptedAssets } = req.body;

  let assets;
  try {
    assets = decryptAssets(encryptedAssets);
  } catch {
    return res.status(400).json({ error: "資產資料解密失敗，請重新上傳" });
  }

  if (!String(name || "").trim()) return res.status(400).json({ error: "請輸入任務名稱" });
  if (!String(resourceColumn || "").trim()) return res.status(400).json({ error: "請選擇資源編號欄位" });

  const seen = new Set();
  const cleanAssets = (Array.isArray(assets) ? assets : [])
    .map((asset) => ({
      assetNo: String(asset.assetNo || "").trim(),
      raw: asset.raw && typeof asset.raw === "object" ? asset.raw : {}
    }))
    .filter((asset) => {
      if (!asset.assetNo || seen.has(asset.assetNo)) return false;
      seen.add(asset.assetNo);
      return true;
    });

  if (!cleanAssets.length) return res.status(400).json({ error: "CSV 內沒有可匯入的資產編號" });

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const taskName = String(name).trim();
  const resCol = String(resourceColumn).trim();
  const locCol = String(locationColumn || "").trim();

  const insertTask = db.prepare(
    "INSERT INTO tasks (id, name, resource_column, location_column, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertAsset = db.prepare(
    "INSERT INTO assets (task_id, asset_no, raw) VALUES (?, ?, ?)"
  );

  db.transaction(() => {
    insertTask.run(id, taskName, resCol, locCol, now, now);
    for (const asset of cleanAssets) {
      insertAsset.run(id, asset.assetNo, JSON.stringify(asset.raw));
    }
  })();

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  res.status(201).json(toSummary(task, cleanAssets.length, 0));
}));

app.get("/api/tasks/:id", wrap((req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "找不到盤點任務" });

  const assets = db.prepare("SELECT * FROM assets WHERE task_id = ? ORDER BY asset_no").all(task.id).map(rowToAsset);
  const checked = assets.filter((a) => a.checkedAt).length;
  res.json({ ...task, resourceColumn: task.resource_column, locationColumn: task.location_column, assets, summary: toSummary(task, assets.length, checked) });
}));

app.delete("/api/tasks/:id", wrap((req, res) => {
  const password = String(req.body.password || "");
  if (password !== DELETE_TASK_PASSWORD) return res.status(403).json({ error: "刪除密碼錯誤" });

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "找不到盤點任務" });

  const photoPaths = db
    .prepare("SELECT scan_photo_url FROM assets WHERE task_id = ? AND scan_photo_url IS NOT NULL")
    .all(task.id)
    .map((row) => path.join(SCAN_PHOTO_DIR, path.basename(row.scan_photo_url)));

  db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);

  photoPaths.forEach((p) => { if (fs.existsSync(p)) fs.unlinkSync(p); });

  res.json({ deleted: true, id: task.id });
}));

app.post("/api/tasks/:id/scan", wrap((req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "找不到盤點任務" });

  const assetNo = String(req.body.assetNo || "").trim();
  const assetRow = db.prepare("SELECT * FROM assets WHERE task_id = ? AND asset_no = ?").get(task.id, assetNo);
  if (!assetRow) return res.status(404).json({ error: "此任務沒有這個資產編號" });

  const scanner = parseScanner(req.body.scanner);
  if (scanner.error) return res.status(400).json({ error: scanner.error });

  const now = new Date().toISOString();
  const alreadyChecked = Boolean(assetRow.checked_at);
  const scanPhotoUrl = saveScanPhoto(task.id, assetNo, req.body.photoDataUrl);

  db.prepare(
    "UPDATE assets SET checked_at = COALESCE(checked_at, ?), scanned_by = ?, scan_photo_url = COALESCE(?, scan_photo_url) WHERE task_id = ? AND asset_no = ?"
  ).run(now, JSON.stringify(scanner), scanPhotoUrl, task.id, assetNo);

  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, task.id);

  const updatedAssetRow = db.prepare("SELECT * FROM assets WHERE task_id = ? AND asset_no = ?").get(task.id, assetNo);
  const asset = rowToAsset(updatedAssetRow);
  const { total, checked } = db
    .prepare("SELECT COUNT(*) as total, COUNT(checked_at) as checked FROM assets WHERE task_id = ?")
    .get(task.id);

  res.json({ asset, summary: toSummary(task, total, checked), alreadyChecked });
}));

app.get("/api/tasks/:id/export", wrap((req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "找不到盤點任務" });

  const assets = db.prepare("SELECT * FROM assets WHERE task_id = ? ORDER BY asset_no").all(task.id).map(rowToAsset);

  const rawColumns = Array.from(
    assets.reduce((cols, asset) => {
      Object.keys(asset.raw || {}).forEach((key) => cols.add(key));
      return cols;
    }, new Set())
  );
  const columns = [
    "assetNo", "status", "checkedAt", "location",
    "scannerName", "scannerEmployeeId", "scannerNote", "scanPhotoUrl",
    ...rawColumns.filter((col) => col !== "assetNo")
  ];
  const escapeCsv = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [
    columns.map(escapeCsv).join(","),
    ...assets.map((asset) =>
      columns.map((col) => {
        if (col === "assetNo") return escapeCsv(asset.assetNo);
        if (col === "status") return escapeCsv(asset.checkedAt ? "checked" : "missing");
        if (col === "checkedAt") return escapeCsv(asset.checkedAt);
        if (col === "location") return escapeCsv(asset.raw?.[task.location_column]);
        if (col === "scannerName") return escapeCsv(asset.scannedBy?.name);
        if (col === "scannerEmployeeId") return escapeCsv(asset.scannedBy?.employeeId);
        if (col === "scannerNote") return escapeCsv(asset.scannedBy?.note);
        if (col === "scanPhotoUrl") return escapeCsv(asset.scanPhotoUrl);
        return escapeCsv(asset.raw?.[col]);
      }).join(",")
    )
  ];

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(task.name)}-inventory.csv"`);
  res.send(`﻿${rows.join("\n")}`);
}));

if (process.env.NODE_ENV === "production") {
  const distDir = path.join(__dirname, "..", "dist");
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`\x1b[31m[ERROR] ${req.method} ${req.path}\x1b[0m`);
  console.error(err);
  if (res.headersSent) {
    console.error("[ERROR] Headers already sent, cannot send JSON error response");
    return;
  }
  res.status(err.status || 500).json({ error: err.message || "伺服器發生錯誤，請稍後再試" });
});

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
