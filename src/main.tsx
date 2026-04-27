import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Papa from "papaparse";
import { QRCodeSVG } from "qrcode.react";
import { Html5Qrcode, type Html5QrcodeCameraScanConfig } from "html5-qrcode";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  ImageIcon,
  ListChecks,
  Printer,
  QrCode,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";
import "./styles.css";

type TaskSummary = {
  id: string;
  name: string;
  resourceColumn: string;
  locationColumn: string;
  total: number;
  checked: number;
  missing: number;
  createdAt: string;
  updatedAt: string;
};

type Asset = {
  assetNo: string;
  raw: Record<string, string>;
  checkedAt: string | null;
  scanPhotoUrl?: string | null;
  scannedBy?: ScannerInfo | null;
};

type TaskDetail = {
  id: string;
  name: string;
  resourceColumn: string;
  locationColumn: string;
  assets: Asset[];
  createdAt: string;
  updatedAt: string;
  summary: TaskSummary;
};

type ParsedCsv = {
  fields: string[];
  rows: Record<string, string>[];
};

type PendingScan = {
  assetNo: string;
  rawValue: string;
  photoDataUrl: string | null;
};

type ScannerInfo = {
  name: string;
  employeeId: string;
  note?: string;
};

const SCANNER_STORAGE_KEY = "qrcode-check-scanner";

const ASSET_CIPHER_KEY = "QRCodeCheck!Fixed@Key#2024$Data!"; // 32 bytes, AES-256-GCM

async function encryptAssets(assets: { assetNo: string; raw: Record<string, string> }[]): Promise<string> {
  const keyBytes = new TextEncoder().encode(ASSET_CIPHER_KEY);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(assets));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...combined));
}

const api = {
  async listTasks(): Promise<TaskSummary[]> {
    const response = await fetch("/api/tasks");
    if (!response.ok) throw new Error((await response.json()).error || "讀取任務列表失敗");
    return response.json();
  },
  async getTask(id: string): Promise<TaskDetail> {
    const response = await fetch(`/api/tasks/${id}`);
    if (!response.ok) throw new Error((await response.json()).error || "讀取任務失敗");
    return response.json();
  },
  async createTask(payload: {
    name: string;
    resourceColumn: string;
    locationColumn: string;
    assets: { assetNo: string; raw: Record<string, string> }[];
  }) {
    const { assets, ...rest } = payload;
    const encryptedAssets = await encryptAssets(assets);
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rest, encryptedAssets })
    });
    if (!response.ok) throw new Error((await response.json()).error || "建立任務失敗");
    return response.json() as Promise<TaskSummary>;
  },
  async scan(taskId: string, assetNo: string, photoDataUrl: string | null | undefined, scanner: ScannerInfo) {
    const response = await fetch(`/api/tasks/${taskId}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetNo, photoDataUrl, scanner })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "盤點失敗");
    return payload;
  },
  async deleteTask(taskId: string, password: string) {
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "刪除任務失敗");
    return payload;
  }
};

function getScanUrl(taskId: string, assetNo: string) {
  const url = new URL("/scan", window.location.origin);
  url.searchParams.set("task", taskId);
  url.searchParams.set("asset", assetNo);
  return url.toString();
}

function parseAssetNo(value: string) {
  const text = value.trim();
  try {
    const url = new URL(text);
    return url.searchParams.get("asset") || text;
  } catch {
    return text;
  }
}

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
}

function guessLocationColumn(fields: string[]) {
  return fields.find((field) => ["存放位置", "地點", "位置", "location", "Location"].includes(field)) || "";
}

function getAssetLocation(task: TaskDetail, asset: Asset) {
  const fallbackColumn = guessLocationColumn(Object.keys(asset.raw || {}));
  const column = task.locationColumn || fallbackColumn;
  return column ? asset.raw?.[column] || "" : "";
}

function shouldAutoStartCamera() {
  const userAgent = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod/i.test(userAgent) || navigator.maxTouchPoints > 1;
}

function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(new URLSearchParams(location.search).get("task"));
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const isScanPage = location.pathname === "/scan";

  const refreshTasks = useCallback(async () => {
    setTasks(await api.listTasks());
  }, []);

  const loadTask = useCallback(async (id: string) => {
    setLoading(true);
    setError("");
    try {
      setTask(await api.getTask(id));
      setSelectedTaskId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  async function deleteTask(taskToDelete: TaskSummary) {
    const confirmed = window.confirm(`確定要刪除「${taskToDelete.name}」？此動作會刪除任務、盤點狀態與盤點照片。`);
    if (!confirmed) return;

    const password = window.prompt("請輸入刪除密碼");
    if (password == null) return;

    setError("");
    try {
      await api.deleteTask(taskToDelete.id, password);
      const updatedTasks = await api.listTasks();
      setTasks(updatedTasks);
      if (selectedTaskId === taskToDelete.id) {
        setSelectedTaskId(updatedTasks[0]?.id || null);
        setTask(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "刪除任務失敗");
    }
  }

  useEffect(() => {
    refreshTasks();
  }, []);

  useEffect(() => {
    if (selectedTaskId) loadTask(selectedTaskId);
  }, [selectedTaskId]);

  if (isScanPage) {
    return <ScannerPage task={task} taskId={selectedTaskId} onLoadTask={loadTask} />;
  }

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand">
            <QrCode size={28} />
            <div className="sidebar-full">
              <h1>資產盤點</h1>
              <p>CSV 匯入、QR 標籤、即時確認</p>
            </div>
          </div>
          <button
            className="icon-button sidebar-toggle"
            type="button"
            onClick={() => setSidebarCollapsed((value) => !value)}
            title={sidebarCollapsed ? "展開側欄" : "收合側欄"}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        {sidebarCollapsed ? (
          <div className="sidebar-mini" aria-label="側欄已收合">
            <span>{tasks.length}</span>
            <small>任務</small>
          </div>
        ) : (
          <div className="sidebar-content">
            <TaskImporter
              onCreated={async (created) => {
                await refreshTasks();
                setSelectedTaskId(created.id);
              }}
            />
            <section className="task-list" aria-label="盤點任務">
              <div className="section-title">
                <span>任務</span>
                <button className="icon-button" onClick={refreshTasks} title="重新整理">
                  <RefreshCw size={16} />
                </button>
              </div>
              {tasks.map((item) => {
                const progress = item.total ? Math.round((item.checked / item.total) * 100) : 0;
                return (
                  <div key={item.id} className={`task-row ${item.id === selectedTaskId ? "active" : ""}`}>
                    <button className="task-select" type="button" onClick={() => setSelectedTaskId(item.id)}>
                      <span>{item.name}</span>
                      <small>
                        {item.checked}/{item.total} 已盤點 · {progress}%
                      </small>
                      <span className="task-progress" aria-label={`盤點進度 ${progress}%`}>
                        <span style={{ width: `${progress}%` }} />
                      </span>
                    </button>
                    <button className="task-delete" type="button" onClick={() => deleteTask(item)} title="刪除任務">
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
              {!tasks.length && <p className="empty">尚未建立盤點任務。</p>}
            </section>
          </div>
        )}
      </aside>

      <section className="workspace">
        {error && <div className="notice error">{error}</div>}
        {loading && <div className="notice">讀取任務中...</div>}
        {!task && !loading && <EmptyState />}
        {task && <TaskWorkspace task={task} onRefresh={() => loadTask(task.id)} />}
      </section>
    </main>
  );
}

function TaskImporter({ onCreated }: { onCreated: (task: TaskSummary) => void }) {
  const [name, setName] = useState("");
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [csvText, setCsvText] = useState("");
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const pasteSeq = useRef(0);
  const [resourceColumn, setResourceColumn] = useState("");
  const [locationColumn, setLocationColumn] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function applyParsedCsv(result: Papa.ParseResult<Record<string, string>>, fallbackName: string) {
    if (result.errors.length) {
      setError(result.errors[0].message);
      return false;
    }

    const fields = result.meta.fields?.filter(Boolean) || [];
    const rows = result.data.filter((row) => Object.values(row).some((value) => String(value ?? "").trim()));
    if (!fields.length) {
      setError("CSV 內容缺少標題列");
      return false;
    }
    if (!rows.length) {
      setError("CSV 內沒有可匯入的資料列");
      return false;
    }

    setCsv({ fields, rows });
    setResourceColumn(fields[0] || "");
    setLocationColumn(guessLocationColumn(fields));
    if (!name) setName(fallbackName);
    return true;
  }

  function handleFile(file: File | undefined) {
    if (!file) return;
    setError("");
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete(result) {
        applyParsedCsv(result, file.name.replace(/\.[^.]+$/, ""));
      },
      error(err) {
        setError(err.message);
      }
    });
  }

  function parsePastedCsv() {
    const text = csvText.trim();
    if (!text) {
      setError("請先貼上 CSV 文字");
      return false;
    }

    setError("");
    let parsed = false;
    Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      complete(result) {
        const now = new Date();
        const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const timePart = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        pasteSeq.current += 1;
        const defaultName = `${datePart} ${timePart} #${pasteSeq.current}`;
        parsed = applyParsedCsv(result, defaultName);
      },
      error(err: Error) {
        setError(err.message);
      }
    });
    if (parsed) setPasteModalOpen(false);
    return parsed;
  }

  async function submit() {
    if (!csv) return setError("請先選擇 CSV 檔或貼上 CSV 文字");
    setSubmitting(true);
    setError("");
    try {
      const created = await api.createTask({
        name,
        resourceColumn,
        locationColumn,
        assets: csv.rows.map((row) => ({ assetNo: row[resourceColumn], raw: row }))
      });
      setName("");
      setCsv(null);
      setCsvText("");
      setResourceColumn("");
      setLocationColumn("");
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "上傳失敗");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="importer">
      <label>
        <span>任務名稱</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：2026 Q2 辦公室資產盤點" />
      </label>
      <label className="file-drop">
        <FileUp size={18} />
        <span>{csv ? `${csv.rows.length} 筆資料已載入` : "選擇資產 CSV"}</span>
        <input type="file" accept=".csv,text/csv" onChange={(event) => handleFile(event.target.files?.[0])} />
      </label>
      <button className="secondary-button" type="button" onClick={() => setPasteModalOpen(true)}>
        <ClipboardPaste size={16} />
        貼上 CSV 文字
      </button>
      {pasteModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="paste-modal" role="dialog" aria-modal="true" aria-labelledby="paste-csv-title">
            <header className="modal-header">
              <h2 id="paste-csv-title">貼上 CSV 文字</h2>
              <button className="icon-button" type="button" onClick={() => setPasteModalOpen(false)} title="關閉">
                <X size={16} />
              </button>
            </header>
            <label>
              <span>CSV 內容</span>
              <textarea
                className="csv-textarea"
                value={csvText}
                onChange={(event) => setCsvText(event.target.value)}
                placeholder={"資產編號,資產名稱,存放位置\n0000000001,筆記型電腦,台北辦公室"}
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setPasteModalOpen(false)}>
                取消
              </button>
              <button className="primary-button" type="button" onClick={parsePastedCsv}>
                <ClipboardPaste size={16} />
                解析 CSV
              </button>
            </div>
          </section>
        </div>
      )}
      {csv && (
        <>
          <label>
            <span>資源編號欄位</span>
            <select value={resourceColumn} onChange={(event) => setResourceColumn(event.target.value)}>
              {csv.fields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>地點欄位</span>
            <select value={locationColumn} onChange={(event) => setLocationColumn(event.target.value)}>
              <option value="">不指定</option>
              {csv.fields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {error && <div className="notice error compact">{error}</div>}
      <button className="primary-button" onClick={submit} disabled={submitting}>
        <Upload size={16} />
        {submitting ? "建立中..." : "上傳並建立任務"}
      </button>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <QrCode size={48} />
      <h2>建立盤點任務後即可產生 QR 標籤</h2>
      <p>左側上傳 CSV，選擇資源編號欄位後，系統會產生資產清單與可列印的 QR grid。</p>
    </div>
  );
}

function TaskWorkspace({ task, onRefresh }: { task: TaskDetail; onRefresh: () => void }) {
  const [viewMode, setViewMode] = useState<"qr" | "list">("qr");
  const [copiedScanUrl, setCopiedScanUrl] = useState(false);
  const [inventoryStatusFilter, setInventoryStatusFilter] = useState<"all" | "checked" | "missing">("all");
  const [inventoryQuery, setInventoryQuery] = useState("");
  const checkedRatio = task.summary.total ? Math.round((task.summary.checked / task.summary.total) * 100) : 0;
  const scanHref = `/scan?task=${task.id}`;
  const scanUrl = new URL(scanHref, window.location.origin).toString();
  const recentAssets = [...task.assets]
    .filter((asset) => asset.checkedAt)
    .sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt)))
    .slice(0, 8);
  const filteredAssets = useMemo(() => {
    const query = inventoryQuery.trim().toLowerCase();
    return task.assets.filter((asset) => {
      if (inventoryStatusFilter === "checked" && !asset.checkedAt) return false;
      if (inventoryStatusFilter === "missing" && asset.checkedAt) return false;
      if (!query) return true;

      const searchableText = [
        asset.assetNo,
        asset.raw["資產名稱"],
        asset.raw.name,
        asset.raw.Name,
        getAssetLocation(task, asset),
        asset.scannedBy?.name,
        asset.scannedBy?.employeeId,
        asset.scannedBy?.note
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchableText.includes(query);
    });
  }, [inventoryQuery, inventoryStatusFilter, task]);

  async function copyScanUrl() {
    await navigator.clipboard.writeText(scanUrl);
    setCopiedScanUrl(true);
    window.setTimeout(() => setCopiedScanUrl(false), 1600);
  }

  return (
    <>
      <header className="workspace-header">
        <div>
          <h2>{task.name}</h2>
          <p>
            資源欄位：{task.resourceColumn}
            {task.locationColumn ? ` · 地點欄位：${task.locationColumn}` : ""} · 建立時間：{formatDate(task.createdAt)}
          </p>
        </div>
        <div className="actions">
          <a className="secondary-button" href={`/api/tasks/${task.id}/export`}>
            <Download size={16} />
            匯出狀態
          </a>
          <button className="secondary-button" onClick={() => window.print()}>
            <Printer size={16} />
            列印 QR
          </button>
        </div>
      </header>

      <div className="stats">
        <Metric label="總資產" value={task.summary.total} />
        <Metric label="已盤點" value={task.summary.checked} />
        <Metric label="未盤點" value={task.summary.missing} />
        <Metric label="完成率" value={`${checkedRatio}%`} />
      </div>

      <section className="content-grid">
        <div className="panel">
          <div className="section-title">
            <div className="view-tabs" role="tablist" aria-label="任務檢視">
              <button className={viewMode === "qr" ? "active" : ""} type="button" onClick={() => setViewMode("qr")}>
                <QrCode size={16} />
                QR 標籤
              </button>
              <button className={viewMode === "list" ? "active" : ""} type="button" onClick={() => setViewMode("list")}>
                <ListChecks size={16} />
                盤點清單
              </button>
            </div>
            <button className="icon-button" onClick={onRefresh} title="重新整理">
              <RefreshCw size={16} />
            </button>
          </div>
          {viewMode === "qr" ? (
            <div className="qr-grid">
              {task.assets.map((asset) => (
                <article className={`qr-tile ${asset.checkedAt ? "checked" : ""}`} key={asset.assetNo}>
                  <QRCodeSVG value={getScanUrl(task.id, asset.assetNo)} size={112} includeMargin />
                  <strong>{asset.assetNo}</strong>
                </article>
              ))}
            </div>
          ) : (
            <>
              <div className="inventory-filters">
                <label className="inventory-search">
                  <Search size={16} />
                  <input
                    value={inventoryQuery}
                    onChange={(event) => setInventoryQuery(event.target.value)}
                    placeholder="搜尋資產、地點、盤點人、備註"
                  />
                </label>
                <div className="filter-tabs" role="tablist" aria-label="盤點狀態篩選">
                  <button className={inventoryStatusFilter === "all" ? "active" : ""} type="button" onClick={() => setInventoryStatusFilter("all")}>
                    全部
                  </button>
                  <button
                    className={inventoryStatusFilter === "checked" ? "active" : ""}
                    type="button"
                    onClick={() => setInventoryStatusFilter("checked")}
                  >
                    已盤點
                  </button>
                  <button
                    className={inventoryStatusFilter === "missing" ? "active" : ""}
                    type="button"
                    onClick={() => setInventoryStatusFilter("missing")}
                  >
                    待盤點
                  </button>
                </div>
                <span className="filter-count">
                  {filteredAssets.length}/{task.assets.length} 筆
                </span>
              </div>
              <div className="inventory-list">
                {filteredAssets.map((asset) => (
                  <article className={`inventory-row ${asset.checkedAt ? "checked" : ""}`} key={asset.assetNo}>
                    <div className="inventory-main">
                      <strong>{asset.assetNo}</strong>
                      <span>{asset.raw["資產名稱"] || asset.raw.name || asset.raw.Name || "未命名資產"}</span>
                    </div>
                    <div className="inventory-location">
                      <span>地點</span>
                      <strong>{getAssetLocation(task, asset) || "-"}</strong>
                    </div>
                    <div className="inventory-status">
                      <span className={asset.checkedAt ? "status-pill checked" : "status-pill"}>{asset.checkedAt ? "已盤點" : "待盤點"}</span>
                      <small>{formatDate(asset.checkedAt)}</small>
                    </div>
                    <div className="inventory-scanner">
                      <small>盤點人</small>
                      <span>{asset.scannedBy?.name || "-"}</span>
                      <small>{asset.scannedBy?.employeeId || ""}</small>
                    </div>
                    <div className="inventory-note">
                      <small>備註</small>
                      <span>{asset.scannedBy?.note || "-"}</span>
                    </div>
                    <div className="inventory-photo">
                      {asset.scanPhotoUrl ? (
                        <a href={asset.scanPhotoUrl} target="_blank" rel="noreferrer" title="開啟照片">
                          <img src={asset.scanPhotoUrl} alt={`${asset.assetNo} 盤點照片`} />
                        </a>
                      ) : (
                        <span>
                          <ImageIcon size={18} />
                        </span>
                      )}
                    </div>
                  </article>
                ))}
                {!filteredAssets.length && <p className="empty inventory-empty">沒有符合條件的資產。</p>}
              </div>
            </>
          )}
        </div>

        <div className="panel side-panel">
          <div className="scan-share-card">
            <div className="section-title">
              <span>分享盤點入口</span>
            </div>
            <div className="share-qr">
              <QRCodeSVG value={scanUrl} size={132} includeMargin />
            </div>
            <input className="share-url" value={scanUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
            <div className="share-actions">
              <button className="secondary-button" type="button" onClick={copyScanUrl}>
                <Copy size={16} />
                {copiedScanUrl ? "已複製" : "複製網址"}
              </button>
              <a className="secondary-button" href={scanHref} target="_blank" rel="noreferrer">
                <ExternalLink size={16} />
                開啟
              </a>
            </div>
            <p className="share-hint">把這個網址或 QR Code 提供給盤點者，對方會直接進入掃描頁。</p>
          </div>

          <div className="section-title">
            <span>近期盤點</span>
          </div>
          {recentAssets.length ? (
            <div className="asset-list">
              {recentAssets.map((asset) => (
                <div className="asset-row" key={asset.assetNo}>
                  <CheckCircle2 size={18} />
                  <div>
                    <strong>{asset.assetNo}</strong>
                    <span>{asset.scannedBy ? `${asset.scannedBy.name} · ${formatDate(asset.checkedAt)}` : formatDate(asset.checkedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">尚無掃描紀錄。</p>
          )}
        </div>
      </section>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ScannerPage({
  task,
  taskId,
  onLoadTask
}: {
  task: TaskDetail | null;
  taskId: string | null;
  onLoadTask: (id: string) => Promise<void>;
}) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const processingRef = useRef(false);
  const lastDecodedRef = useRef<{ value: string; scannedAt: number } | null>(null);
  const initialAssetHandledRef = useRef(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
  const [scanState, setScanState] = useState<"scanning" | "processing" | "confirming">("scanning");
  const [lastAssetNo, setLastAssetNo] = useState("");
  const [manualAssetNo, setManualAssetNo] = useState(new URLSearchParams(location.search).get("asset") || "");
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [pendingNote, setPendingNote] = useState("");
  const [cameraEnabled, setCameraEnabled] = useState(shouldAutoStartCamera);
  const [cameraMessage, setCameraMessage] = useState("");
  const [scannerInfo, setScannerInfo] = useState<ScannerInfo | null>(() => {
    try {
      const saved = window.localStorage.getItem(SCANNER_STORAGE_KEY);
      if (!saved) return null;
      const parsed = JSON.parse(saved) as ScannerInfo;
      if (!parsed.name?.trim() || !/^\d{8}$/.test(parsed.employeeId || "")) return null;
      return { name: parsed.name.trim(), employeeId: parsed.employeeId };
    } catch {
      return null;
    }
  });
  const [scannerDraft, setScannerDraft] = useState<ScannerInfo>(() => scannerInfo || { name: "", employeeId: "" });
  const [scannerError, setScannerError] = useState("");
  const readerId = "qr-reader";

  const checkedLookup = useMemo(() => new Set(task?.assets.filter((asset) => asset.checkedAt).map((asset) => asset.assetNo)), [task]);

  function saveScannerInfo() {
    const name = scannerDraft.name.trim();
    const employeeId = scannerDraft.employeeId.trim();
    if (!name) {
      setScannerError("請輸入掃描者姓名");
      return;
    }
    if (!/^\d{8}$/.test(employeeId)) {
      setScannerError("員工編號需為 8 碼數字");
      return;
    }

    const nextScanner = { name, employeeId };
    window.localStorage.setItem(SCANNER_STORAGE_KEY, JSON.stringify(nextScanner));
    setScannerInfo(nextScanner);
    setScannerDraft(nextScanner);
    setScannerError("");
  }

  function editScannerInfo() {
    setScannerDraft(scannerInfo || { name: "", employeeId: "" });
    setScannerInfo(null);
    setScannerError("");
    setCameraEnabled(shouldAutoStartCamera());
    setCameraMessage("");
  }

  function startCamera() {
    setCameraMessage("");
    setCameraEnabled(true);
  }

  function captureScannerPhoto() {
    const video = document.querySelector<HTMLVideoElement>(`#${readerId} video`);
    if (!video || !video.videoWidth || !video.videoHeight) return null;

    const canvas = document.createElement("canvas");
    const maxWidth = 1280;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  const confirmScan = useCallback(async () => {
    if (!taskId || !pendingScan) return;
    if (!scannerInfo) {
      setStatus("error");
      setMessage("請先填寫掃描者資料");
      return;
    }
    const assetNo = pendingScan.assetNo;
    setScanState("processing");
    try {
      const result = await api.scan(taskId, assetNo, pendingScan.photoDataUrl, {
        ...scannerInfo,
        note: pendingNote.trim()
      });
      setLastAssetNo(assetNo);
      setStatus("ok");
      setMessage(`${assetNo} 已完成盤點${result.alreadyChecked ? "，先前已掃描過" : ""}`);
      setPendingScan(null);
      setPendingNote("");
      navigator.vibrate?.(80);
      await onLoadTask(taskId);
      window.setTimeout(() => {
        processingRef.current = false;
        setScanState("scanning");
      }, 700);
    } catch (err) {
      setLastAssetNo(assetNo);
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "盤點失敗");
      setScanState("confirming");
    }
  }, [onLoadTask, pendingNote, pendingScan, scannerInfo, taskId]);

  function cancelPendingScan() {
    setPendingScan(null);
    setPendingNote("");
    processingRef.current = false;
    setScanState("scanning");
  }

  const prepareScanConfirmation = useCallback((rawValue: string) => {
    if (!taskId) {
      setStatus("error");
      setMessage("缺少任務代碼，請從任務頁開啟掃描。");
      return false;
    }
    const assetNo = parseAssetNo(rawValue);
    if (!assetNo) {
      setStatus("error");
      setMessage("沒有偵測到有效的資產編號。");
      return false;
    }

    setLastAssetNo(assetNo);
    setPendingScan({ assetNo, rawValue, photoDataUrl: captureScannerPhoto() });
    setPendingNote("");
    setStatus("idle");
    setMessage("");
    setScanState("confirming");
    return true;
  }, [taskId]);

  async function handleDetected(rawValue: string) {
    const now = Date.now();
    const decoded = rawValue.trim();
    const lastDecoded = lastDecodedRef.current;
    if (!decoded || processingRef.current) return;
    if (lastDecoded?.value === decoded && now - lastDecoded.scannedAt < 2200) return;

    processingRef.current = true;
    lastDecodedRef.current = { value: decoded, scannedAt: now };
    const prepared = prepareScanConfirmation(decoded);
    if (!prepared) {
      processingRef.current = false;
      setScanState("scanning");
    }
  }

  useEffect(() => {
    if (taskId) onLoadTask(taskId);
  }, [taskId]);

  useEffect(() => {
    const assetFromUrl = new URLSearchParams(location.search).get("asset");
    if (!scannerInfo || !taskId || !assetFromUrl || initialAssetHandledRef.current) return;
    initialAssetHandledRef.current = true;
    handleDetected(assetFromUrl);
  }, [scannerInfo, taskId, prepareScanConfirmation]);

  useEffect(() => {
    if (!scannerInfo || !cameraEnabled) return;
    let disposed = false;
    const scanner = new Html5Qrcode(readerId);
    scannerRef.current = scanner;

    const scanConfig: Html5QrcodeCameraScanConfig = {
      fps: 10,
      qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
        const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight, 280) * 0.82);
        return { width: size, height: size };
      },
      aspectRatio: 1.333
    };
    const onSuccess = (decodedText: string) => {
      if (disposed) return;
      handleDetected(decodedText);
    };
    const startScanner = async () => {
      try {
        await scanner.start({ facingMode: { exact: "environment" } }, scanConfig, onSuccess, () => undefined);
      } catch {
        if (disposed) return;
        try {
          await scanner.start({ facingMode: "environment" }, scanConfig, onSuccess, () => undefined);
        } catch {
          if (disposed) return;
          await scanner.start({ facingMode: "user" }, scanConfig, onSuccess, () => undefined);
        }
      }
    };

    startScanner().catch(() => {
      if (!disposed) {
        setCameraEnabled(false);
        setStatus("error");
        setCameraMessage("相機未啟動，可手動輸入資產編號，或允許權限後再啟動相機。");
      }
    });

    return () => {
      disposed = true;
      scanner
        .stop()
        .catch(() => undefined)
        .finally(() => scanner.clear());
    };
  }, [cameraEnabled, scannerInfo, taskId, prepareScanConfirmation]);

  return (
    <main className="scan-shell">
      <header className="scan-header">
        <div>
          <span className="scan-kicker">盤點入口</span>
          <h1>{task?.name || "資產盤點掃描"}</h1>
          <p>{task ? `${task.summary.checked}/${task.summary.total} 已盤點` : "讀取任務中..."}</p>
        </div>
      </header>

      {!scannerInfo && (
        <section className="scanner-identity-panel">
          <h2>掃描者資料</h2>
          <label>
            <span>姓名</span>
            <input value={scannerDraft.name} onChange={(event) => setScannerDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label>
            <span>員工編號</span>
            <input
              value={scannerDraft.employeeId}
              inputMode="numeric"
              maxLength={8}
              onChange={(event) =>
                setScannerDraft((current) => ({ ...current, employeeId: event.target.value.replace(/\D/g, "").slice(0, 8) }))
              }
              placeholder="8 碼數字"
            />
          </label>
          {scannerError && <div className="notice error compact">{scannerError}</div>}
          <button className="primary-button" type="button" onClick={saveScannerInfo}>
            <CheckCircle2 size={16} />
            開始掃描
          </button>
        </section>
      )}

      {scannerInfo && (
        <div className="scanner-meta">
          <span>掃描者：{scannerInfo.name} · {scannerInfo.employeeId}</span>
          <button className="secondary-button" type="button" onClick={editScannerInfo}>
            更換掃描者
          </button>
        </div>
      )}

      {scannerInfo && (
        <section className="scanner-panel">
          {cameraEnabled ? (
            <div className="scanner-frame">
              <div id={readerId} />
              <div className={`scan-badge ${scanState}`}>
                {scanState === "processing" ? "儲存盤點中" : scanState === "confirming" ? "請確認此資產" : "自動偵測 QR Code"}
              </div>
            </div>
          ) : (
            <div className="scanner-placeholder">
              <QrCode size={36} />
              <strong>相機尚未啟動</strong>
              {cameraMessage && <span>{cameraMessage}</span>}
              <button className="secondary-button" type="button" onClick={startCamera}>
                啟動相機
              </button>
            </div>
          )}
          {pendingScan && (
            <div className="confirm-scan-card">
              <div>
                <span>待確認資產</span>
                <strong>{pendingScan.assetNo}</strong>
              </div>
              {pendingScan.photoDataUrl ? (
                <img src={pendingScan.photoDataUrl} alt="掃描當下照片" />
              ) : (
                <p className="empty">目前沒有可儲存的相機畫面。</p>
              )}
              <label>
                <span>本次盤點備註</span>
                <textarea
                  className="scanner-note-input"
                  value={pendingNote}
                  onChange={(event) => setPendingNote(event.target.value)}
                  placeholder="選填，例如：資產外觀正常、位置與清冊不符"
                />
              </label>
              <div className="confirm-actions">
                <button className="secondary-button" type="button" onClick={cancelPendingScan}>
                  取消
                </button>
                <button className="primary-button" type="button" onClick={confirmScan} disabled={scanState === "processing"}>
                  <CheckCircle2 size={16} />
                  確認盤點
                </button>
              </div>
            </div>
          )}
          {message && <div className={`notice ${status === "error" ? "error" : "success"}`}>{message}</div>}
          {lastAssetNo && !pendingScan && (
            <div className={`detected-card ${status === "error" ? "error" : "success"}`}>
              <span>最近偵測</span>
              <strong>{lastAssetNo}</strong>
            </div>
          )}
          <div className="manual-scan">
            <input value={manualAssetNo} onChange={(event) => setManualAssetNo(event.target.value)} placeholder="手動輸入資產編號" />
            <button className="primary-button" onClick={() => handleDetected(manualAssetNo)}>
              <CheckCircle2 size={16} />
              建立確認
            </button>
          </div>
        </section>
      )}

      {task && (
        <section className="scan-list">
          {task.assets.map((asset) => (
            <div className={`scan-row ${checkedLookup.has(asset.assetNo) ? "done" : ""}`} key={asset.assetNo}>
              <span>{asset.assetNo}</span>
              <small>{asset.checkedAt ? formatDate(asset.checkedAt) : "待盤點"}</small>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
