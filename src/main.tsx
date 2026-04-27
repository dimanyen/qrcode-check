import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Papa from "papaparse";
import { QRCodeSVG } from "qrcode.react";
import { Html5Qrcode, type Html5QrcodeCameraScanConfig } from "html5-qrcode";
import { Camera, CheckCircle2, ClipboardPaste, Download, FileUp, Printer, QrCode, RefreshCw, Upload, X } from "lucide-react";
import "./styles.css";

type TaskSummary = {
  id: string;
  name: string;
  resourceColumn: string;
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
};

type TaskDetail = {
  id: string;
  name: string;
  resourceColumn: string;
  assets: Asset[];
  createdAt: string;
  updatedAt: string;
  summary: TaskSummary;
};

type ParsedCsv = {
  fields: string[];
  rows: Record<string, string>[];
};

const api = {
  async listTasks(): Promise<TaskSummary[]> {
    const response = await fetch("/api/tasks");
    return response.json();
  },
  async getTask(id: string): Promise<TaskDetail> {
    const response = await fetch(`/api/tasks/${id}`);
    if (!response.ok) throw new Error((await response.json()).error || "讀取任務失敗");
    return response.json();
  },
  async createTask(payload: { name: string; resourceColumn: string; assets: { assetNo: string; raw: Record<string, string> }[] }) {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error((await response.json()).error || "建立任務失敗");
    return response.json() as Promise<TaskSummary>;
  },
  async scan(taskId: string, assetNo: string) {
    const response = await fetch(`/api/tasks/${taskId}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetNo })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "盤點失敗");
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

function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(new URLSearchParams(location.search).get("task"));
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
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
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <QrCode size={28} />
          <div>
            <h1>資產盤點</h1>
            <p>CSV 匯入、QR 標籤、即時確認</p>
          </div>
        </div>
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
          {tasks.map((item) => (
            <button
              key={item.id}
              className={`task-row ${item.id === selectedTaskId ? "active" : ""}`}
              onClick={() => setSelectedTaskId(item.id)}
            >
              <span>{item.name}</span>
              <small>
                {item.checked}/{item.total} 已盤點
              </small>
            </button>
          ))}
          {!tasks.length && <p className="empty">尚未建立盤點任務。</p>}
        </section>
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
  const [resourceColumn, setResourceColumn] = useState("");
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
        parsed = applyParsedCsv(result, "貼上 CSV");
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
        assets: csv.rows.map((row) => ({ assetNo: row[resourceColumn], raw: row }))
      });
      setName("");
      setCsv(null);
      setCsvText("");
      setResourceColumn("");
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
  const checkedRatio = task.summary.total ? Math.round((task.summary.checked / task.summary.total) * 100) : 0;
  const scanHref = `/scan?task=${task.id}`;
  const recentAssets = [...task.assets]
    .filter((asset) => asset.checkedAt)
    .sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt)))
    .slice(0, 8);

  return (
    <>
      <header className="workspace-header">
        <div>
          <h2>{task.name}</h2>
          <p>
            資源欄位：{task.resourceColumn} · 建立時間：{formatDate(task.createdAt)}
          </p>
        </div>
        <div className="actions">
          <a className="secondary-button" href={scanHref}>
            <Camera size={16} />
            開啟掃描
          </a>
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
            <span>QR 標籤 Grid</span>
            <button className="icon-button" onClick={onRefresh} title="重新整理">
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="qr-grid">
            {task.assets.map((asset) => (
              <article className={`qr-tile ${asset.checkedAt ? "checked" : ""}`} key={asset.assetNo}>
                <QRCodeSVG value={getScanUrl(task.id, asset.assetNo)} size={112} includeMargin />
                <strong>{asset.assetNo}</strong>
                <span>{asset.checkedAt ? "已盤點" : "待盤點"}</span>
              </article>
            ))}
          </div>
        </div>

        <div className="panel side-panel">
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
                    <span>{formatDate(asset.checkedAt)}</span>
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
  const [scanState, setScanState] = useState<"scanning" | "processing">("scanning");
  const [lastAssetNo, setLastAssetNo] = useState("");
  const [manualAssetNo, setManualAssetNo] = useState(new URLSearchParams(location.search).get("asset") || "");
  const readerId = "qr-reader";

  const checkedLookup = useMemo(() => new Set(task?.assets.filter((asset) => asset.checkedAt).map((asset) => asset.assetNo)), [task]);

  const markScanned = useCallback(async (rawValue: string) => {
    if (!taskId) {
      setStatus("error");
      setMessage("缺少任務代碼，請從任務頁開啟掃描。");
      return;
    }
    const assetNo = parseAssetNo(rawValue);
    if (!assetNo) {
      setStatus("error");
      setMessage("沒有偵測到有效的資產編號。");
      return;
    }
    try {
      const result = await api.scan(taskId, assetNo);
      setLastAssetNo(assetNo);
      setStatus("ok");
      setMessage(`${assetNo} 已完成盤點${result.alreadyChecked ? "，先前已掃描過" : ""}`);
      navigator.vibrate?.(80);
      await onLoadTask(taskId);
    } catch (err) {
      setLastAssetNo(assetNo);
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "盤點失敗");
    }
  }, [onLoadTask, taskId]);

  async function handleDetected(rawValue: string) {
    const now = Date.now();
    const decoded = rawValue.trim();
    const lastDecoded = lastDecodedRef.current;
    if (!decoded || processingRef.current) return;
    if (lastDecoded?.value === decoded && now - lastDecoded.scannedAt < 2200) return;

    processingRef.current = true;
    lastDecodedRef.current = { value: decoded, scannedAt: now };
    setScanState("processing");
    await markScanned(decoded);
    window.setTimeout(() => {
      processingRef.current = false;
      setScanState("scanning");
    }, 900);
  }

  useEffect(() => {
    if (taskId) onLoadTask(taskId);
  }, [taskId]);

  useEffect(() => {
    const assetFromUrl = new URLSearchParams(location.search).get("asset");
    if (!taskId || !assetFromUrl || initialAssetHandledRef.current) return;
    initialAssetHandledRef.current = true;
    handleDetected(assetFromUrl);
  }, [taskId, markScanned]);

  useEffect(() => {
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
        setStatus("error");
        setMessage("無法開啟相機，請確認瀏覽器權限，或使用手動輸入。");
      }
    });

    return () => {
      disposed = true;
      scanner
        .stop()
        .catch(() => undefined)
        .finally(() => scanner.clear());
    };
  }, [taskId, markScanned]);

  return (
    <main className="scan-shell">
      <header className="scan-header">
        <a href={taskId ? `/?task=${taskId}` : "/"}>返回任務</a>
        <div>
          <h1>{task?.name || "資產盤點掃描"}</h1>
          <p>{task ? `${task.summary.checked}/${task.summary.total} 已盤點` : "讀取任務中..."}</p>
        </div>
      </header>

      <section className="scanner-panel">
        <div className="scanner-frame">
          <div id={readerId} />
          <div className={`scan-badge ${scanState}`}>
            {scanState === "processing" ? "偵測到 QR，執行盤點中" : "自動偵測 QR Code"}
          </div>
        </div>
        {message && <div className={`notice ${status === "error" ? "error" : "success"}`}>{message}</div>}
        {lastAssetNo && (
          <div className={`detected-card ${status === "error" ? "error" : "success"}`}>
            <span>最近偵測</span>
            <strong>{lastAssetNo}</strong>
          </div>
        )}
        <div className="manual-scan">
          <input value={manualAssetNo} onChange={(event) => setManualAssetNo(event.target.value)} placeholder="手動輸入資產編號" />
          <button className="primary-button" onClick={() => handleDetected(manualAssetNo)}>
            <CheckCircle2 size={16} />
            確認
          </button>
        </div>
      </section>

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
