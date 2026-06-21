"use client";

import JSZip from "jszip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Mode = "split" | "two";
type ItemStatus = "queued" | "processing" | "ready" | "warning" | "failed";
type Background = "checker" | "dark" | "white" | "blue";

type PairInput = {
  id: string;
  name: string;
  black: ImageData;
  white: ImageData;
  width: number;
  height: number;
};

type BatchItem = {
  id: string;
  name: string;
  status: ItemStatus;
  message: string;
  width?: number;
  height?: number;
  outputWidth?: number;
  outputHeight?: number;
  blob?: Blob;
  url?: string;
  thumbUrl?: string;
  blackUrl?: string;
  whiteUrl?: string;
  processingMs?: number;
  trimApplied?: boolean;
};

type WorkerResponse = {
  id: string;
  ok: boolean;
  width?: number;
  height?: number;
  outputWidth?: number;
  outputHeight?: number;
  image?: ImageData;
  trimApplied?: boolean;
  message?: string;
  warning?: string;
};

const PROMPT = `same object, same composition,
pure black background

same object, same composition,
pure white background`;

function fileBaseName(file: File) {
  return file.name.replace(/\.[^.]+$/, "") || "image";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function statusLabel(status: ItemStatus) {
  if (status === "ready") return "Ready";
  if (status === "warning") return "Review";
  if (status === "failed") return "Failed";
  if (status === "processing") return "Processing";
  return "Queued";
}

async function loadBitmap(file: File) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
      return await createImageBitmap(image);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function imageDataFromBitmap(bitmap: ImageBitmap, sx: number, sy: number, sw: number, sh: number) {
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not read image data.");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return ctx.getImageData(0, 0, sw, sh);
}

async function pairFromSplitFile(file: File): Promise<PairInput> {
  const bitmap = await loadBitmap(file);
  const width = Math.floor(bitmap.width / 2);
  const height = bitmap.height;
  if (width < 8 || height < 8) {
    throw new Error(`${file.name} is too small to split.`);
  }

  const left = imageDataFromBitmap(bitmap, 0, 0, width, height);
  const right = imageDataFromBitmap(bitmap, width, 0, width, height);
  bitmap.close?.();

  const leftBrightness = averageBrightness(left);
  const rightBrightness = averageBrightness(right);
  const black = leftBrightness <= rightBrightness ? left : right;
  const white = leftBrightness <= rightBrightness ? right : left;

  return {
    id: makeId(),
    name: fileBaseName(file),
    black,
    white,
    width,
    height
  };
}

async function pairFromTwoFiles(blackFile: File, whiteFile: File): Promise<PairInput> {
  const [blackBitmap, whiteBitmap] = await Promise.all([loadBitmap(blackFile), loadBitmap(whiteFile)]);
  const width = Math.min(blackBitmap.width, whiteBitmap.width);
  const height = Math.min(blackBitmap.height, whiteBitmap.height);
  if (width < 8 || height < 8) {
    throw new Error(`${blackFile.name} is too small.`);
  }
  const blackRaw = imageDataFromBitmap(blackBitmap, 0, 0, width, height);
  const whiteRaw = imageDataFromBitmap(whiteBitmap, 0, 0, width, height);
  blackBitmap.close?.();
  whiteBitmap.close?.();

  const blackBrightness = averageBrightness(blackRaw);
  const whiteBrightness = averageBrightness(whiteRaw);
  return {
    id: makeId(),
    name: fileBaseName(blackFile).replace(/[-_\s]*(black|dark|bg)$/i, "") || fileBaseName(blackFile),
    black: blackBrightness <= whiteBrightness ? blackRaw : whiteRaw,
    white: blackBrightness <= whiteBrightness ? whiteRaw : blackRaw,
    width,
    height
  };
}

function averageBrightness(image: ImageData) {
  const data = image.data;
  const step = Math.max(4, Math.floor(data.length / 4000 / 4) * 4);
  let total = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += step) {
    total += (data[i] + data[i + 1] + data[i + 2]) / 3;
    count++;
  }
  return count ? total / count : 0;
}

function blobFromImageData(image: ImageData): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not export PNG.");
  ctx.putImageData(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG export failed."));
    }, "image/png");
  });
}

async function recoverPair(
  worker: Worker,
  pair: PairInput,
  settings: Settings
): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== pair.id) return;
      worker.removeEventListener("message", handleMessage);
      resolve(event.data);
    };
    worker.addEventListener("message", handleMessage);
    worker.postMessage({
      id: pair.id,
      black: pair.black,
      white: pair.white,
      width: pair.width,
      height: pair.height,
      settings
    });
  });
}

type Settings = {
  alphaCleanup: number;
  edgeSmooth: number;
  denoise: number;
  trimBounds: boolean;
  trimPadding: number;
};

export default function Home() {
  const [mode, setMode] = useState<Mode>("split");
  const [items, setItems] = useState<BatchItem[]>([]);
  const [activeId, setActiveId] = useState("");
  const [background, setBackground] = useState<Background>("checker");
  const [blackFiles, setBlackFiles] = useState<File[]>([]);
  const [whiteFiles, setWhiteFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<Settings>({
    alphaCleanup: 62,
    edgeSmooth: 38,
    denoise: 45,
    trimBounds: true,
    trimPadding: 8
  });
  const workerRef = useRef<Worker | null>(null);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    workerRef.current = new Worker("/recover-worker.js");
    return () => {
      workerRef.current?.terminate();
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const activeItem = items.find((item) => item.id === activeId) ?? items[0];
  const readyCount = items.filter((item) => item.status === "ready").length;
  const warningCount = items.filter((item) => item.status === "warning").length;
  const failedCount = items.filter((item) => item.status === "failed").length;
  const hasRealItems = items.length > 0;

  const qualityText = useMemo(() => {
    if (!hasRealItems) return "Drop images to start";
    if (failedCount) return `${readyCount} ready · ${failedCount} failed`;
    if (warningCount) return `${readyCount} ready · ${warningCount} needs review`;
    return `${readyCount} ready`;
  }, [failedCount, hasRealItems, readyCount, warningCount]);

  const processPairs = useCallback(
    async (pairs: PairInput[]) => {
      if (!workerRef.current || pairs.length === 0) return;
      setError("");
      const limitedPairs = pairs.slice(0, 20);
      const queued = limitedPairs.map<BatchItem>((pair) => ({
        id: pair.id,
        name: pair.name,
        status: "queued",
        message: "Queued locally",
        width: pair.width,
        height: pair.height
      }));
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      urlsRef.current = [];
      setItems(queued);
      setActiveId(queued[0]?.id ?? "");

      for (const pair of limitedPairs) {
        const [blackBlob, whiteBlob] = await Promise.all([blobFromImageData(pair.black), blobFromImageData(pair.white)]);
        const blackUrl = URL.createObjectURL(blackBlob);
        const whiteUrl = URL.createObjectURL(whiteBlob);
        urlsRef.current.push(blackUrl, whiteUrl);
        setItems((current) =>
          current.map((item) =>
            item.id === pair.id
              ? { ...item, blackUrl, whiteUrl, status: "processing", message: "Processing" }
              : item
          )
        );
        const started = performance.now();
        const response = await recoverPair(workerRef.current, pair, settings);
        if (!response.ok || !response.image) {
          setItems((current) =>
            current.map((item) =>
              item.id === pair.id
                ? { ...item, status: "failed", message: response.message ?? "Could not recover alpha" }
                : item
            )
          );
          continue;
        }

        const blob = await blobFromImageData(response.image);
        const url = URL.createObjectURL(blob);
        urlsRef.current.push(url);
        const status: ItemStatus = response.warning ? "warning" : "ready";
        const elapsed = Math.max(0.1, (performance.now() - started) / 1000);
        setItems((current) =>
          current.map((item) =>
            item.id === pair.id
              ? {
                  ...item,
                  status,
                  message: response.warning ?? `Ready · ${elapsed.toFixed(1)}s`,
                  blob,
                  url,
                  thumbUrl: url,
                  outputWidth: response.outputWidth,
                  outputHeight: response.outputHeight,
                  processingMs: Math.round(elapsed * 1000),
                  trimApplied: response.trimApplied
                }
              : item
          )
        );
      }
    },
    [settings]
  );

  const handleSplitFiles = useCallback(
    async (files: FileList | File[]) => {
      const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
      if (!imageFiles.length) return;
      try {
        const pairs = await Promise.all(imageFiles.slice(0, 20).map(pairFromSplitFile));
        await processPairs(pairs);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read images.");
      }
    },
    [processPairs]
  );

  const handleTwoFiles = useCallback(
    async (black: File[], white: File[]) => {
      const count = Math.min(black.length, white.length, 20);
      if (!count) return;
      try {
        const pairs = await Promise.all(
          Array.from({ length: count }, (_, index) => pairFromTwoFiles(black[index], white[index]))
        );
        await processPairs(pairs);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read image pairs.");
      }
    },
    [processPairs]
  );

  useEffect(() => {
    if (mode === "two" && blackFiles.length && whiteFiles.length) {
      void handleTwoFiles(blackFiles, whiteFiles);
    }
  }, [blackFiles, handleTwoFiles, mode, whiteFiles]);

  const updateSetting = (key: keyof Settings, value: number | boolean) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const downloadCurrent = async () => {
    if (!activeItem?.blob) return;
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(activeItem.blob);
    anchor.download = `${activeItem.name}-transparent.png`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  };

  const downloadZip = async () => {
    const readyItems = items.filter((item) => item.blob);
    if (!readyItems.length) return;
    if (readyItems.length === 1) {
      await downloadCurrent();
      return;
    }
    const zip = new JSZip();
    for (const item of readyItems) {
      zip.file(`${item.name}-transparent.png`, item.blob as Blob);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "alpharecover-transparent-pngs.zip";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copyCurrent = async () => {
    if (!activeItem?.blob || !("ClipboardItem" in window)) return;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": activeItem.blob })]);
  };

  const pasteFromClipboard = async () => {
    try {
      const clipboardItems = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of clipboardItems) {
        const type = item.types.find((candidate) => candidate.startsWith("image/"));
        if (type) {
          const blob = await item.getType(type);
          files.push(new File([blob], `clipboard-${files.length + 1}.png`, { type }));
        }
      }
      if (files.length) await handleSplitFiles(files);
      else setError("Clipboard does not contain an image.");
    } catch {
      setError("Clipboard access was not allowed. Use Choose images instead.");
    }
  };

  const trySample = async () => {
    try {
      const response = await fetch("/sample-split.svg");
      const blob = await response.blob();
      await handleSplitFiles([new File([blob], "sample-split.svg", { type: "image/svg+xml" })]);
    } catch {
      setError("Could not load the sample image.");
    }
  };

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    if (mode === "split") await handleSplitFiles(files);
  };

  const visibleItems = items.slice(0, 3);
  const moreCount = Math.max(0, items.length - 2);
  const outputCount = items.filter((item) => item.blob).length;

  return (
    <main className="app-shell">
      <div className="app-frame">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" />
            AlphaRecover
          </div>
          <div className="top-copy">Recover transparent PNGs from black / white renders</div>
          <div className="top-actions">
            <span className="badge">Local only</span>
            <a className="ghost-button" href="mailto:feedback@example.com">
              Feedback
            </a>
          </div>
        </header>

        <section className="hero-section">
          <h1>Recover transparency from black &amp; white renders</h1>
          <p>Upload a split render or two matched images. Runs locally in your browser.</p>
          <div className="mode-toggle hero-mode">
            <button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>
              Split image
            </button>
            <button className={mode === "two" ? "active" : ""} onClick={() => setMode("two")}>
              Two images
            </button>
          </div>
        </section>

        <section
          className={`upload-card ${dragging ? "dragging" : ""}`}
          onDragEnter={() => setDragging(true)}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="upload-card-inner">
            <div className="upload-icon">↑</div>
            <h2>Drop your images here</h2>
            <p>{mode === "split" ? "Split black/white image or a batch of split renders" : "Matched black and white image sets in the same order"}</p>
            <div className="upload-actions">
              {mode === "split" ? (
                <label className="primary-button">
                  Choose images
                  <input
                    className="hidden-input"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => event.target.files && void handleSplitFiles(event.target.files)}
                  />
                </label>
              ) : (
                <>
                  <label className="primary-button">
                    Black images
                    <input
                      className="hidden-input"
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(event) => setBlackFiles(Array.from(event.target.files ?? []))}
                    />
                  </label>
                  <label className="secondary-button">
                    White images
                    <input
                      className="hidden-input"
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(event) => setWhiteFiles(Array.from(event.target.files ?? []))}
                    />
                  </label>
                </>
              )}
              <button className="secondary-button" onClick={trySample}>
                Try sample
              </button>
            </div>
          </div>
          <div className="privacy-note">Runs locally. Your images are not uploaded.</div>
        </section>

        {error ? <div className="error-box page-error">{error}</div> : null}

        <section className="result-card">
          <div className="result-card-head">
            <div>
              <h2>Result preview</h2>
              <p>{hasRealItems ? qualityText : "Upload an image to see the recovered PNG here."}</p>
            </div>
            {hasRealItems ? (
              <div className={`quality ${failedCount ? "failed" : warningCount ? "" : "good"}`}>{qualityText}</div>
            ) : null}
          </div>

          <div className="result-layout">
            <div className="formula-preview">
              <PreviewTile title="Black input" subtitle="alpha from black" imageUrl={activeItem?.blackUrl} kind="black" />
              <div className="formula-symbol">+</div>
              <PreviewTile title="White input" subtitle="details from white" imageUrl={activeItem?.whiteUrl} kind="white" />
              <div className="formula-symbol">=</div>
              <PreviewTile
                title="Transparent PNG result"
                subtitle={activeItem?.outputWidth ? `${activeItem.outputWidth} × ${activeItem.outputHeight}` : "preview"}
                imageUrl={activeItem?.url}
                kind={background}
              />
            </div>

            <aside className="result-actions">
              <div className="background-switch">
                <div className="switch-title">Preview background</div>
                <div className="swatches">
                  {(["checker", "dark", "white", "blue"] as Background[]).map((candidate) => (
                    <button
                      aria-label={`Preview on ${candidate} background`}
                      className={`swatch ${candidate === "checker" ? "checker" : candidate === "dark" ? "dark" : candidate === "blue" ? "blue" : ""} ${
                        background === candidate ? "active" : ""
                      }`}
                      key={candidate}
                      onClick={() => setBackground(candidate)}
                    />
                  ))}
                </div>
                <div className="swatch-labels">
                  <span>Checker</span>
                  <span>Black</span>
                  <span>White</span>
                  <span>Light</span>
                </div>
              </div>
              <button className="download-button" disabled={!outputCount} onClick={downloadZip}>
                {outputCount > 1 ? "Download ZIP" : "Download PNG"}
              </button>
              <button className="secondary-button" disabled={!activeItem?.blob} onClick={copyCurrent}>
                Copy current PNG
              </button>
              <div className="export-meta">
                <div>
                  <span>Output</span>
                  <b>
                    {outputCount
                      ? `${outputCount} ${settings.trimBounds ? "trimmed " : ""}PNG${outputCount > 1 ? "s" : ""}`
                      : "None"}
                  </b>
                </div>
                <div>
                  <span>Trim padding</span>
                  <b>{settings.trimBounds ? `${settings.trimPadding}px` : "Off"}</b>
                </div>
                <div>
                  <span>Processing</span>
                  <b>Local</b>
                </div>
              </div>
            </aside>
          </div>

          <div className="batch-strip compact">
            {visibleItems.length
              ? visibleItems.slice(0, 3).map((item, index) => {
                  const displayItem =
                    index === 2 && moreCount > 0
                      ? { ...item, name: `+${moreCount} more`, message: "Queued locally" }
                      : item;
                  return (
                    <button
                      className={`batch-item ${activeId === item.id ? "active" : ""}`}
                      key={item.id}
                      onClick={() => setActiveId(item.id)}
                      type="button"
                    >
                      <div className="tiny-thumb">{item.thumbUrl ? <img src={item.thumbUrl} alt="" /> : null}</div>
                      <div>
                        <div className="batch-name">{displayItem.name}</div>
                        <div className="batch-meta">{displayItem.message || statusLabel(displayItem.status)}</div>
                      </div>
                      <span className={`status-dot ${item.status}`} />
                    </button>
                  );
                })
              : null}
          </div>
        </section>

        <details className="advanced-panel page-advanced">
          <summary>
            <span>Advanced settings</span>
            <span>Optional</span>
          </summary>
          <div className="advanced-content advanced-grid">
            <SliderControl
              label="Alpha Cleanup"
              value={settings.alphaCleanup}
              onChange={(value) => updateSetting("alphaCleanup", value)}
            />
            <SliderControl
              label="Edge Smooth"
              value={settings.edgeSmooth}
              onChange={(value) => updateSetting("edgeSmooth", value)}
            />
            <SliderControl
              label="Denoise"
              value={settings.denoise}
              onChange={(value) => updateSetting("denoise", value)}
            />
            <div className="toggle-control">
              <div className="toggle-row">
                <div className="toggle-title">Trim bounds</div>
                <button
                  aria-label="Toggle trim bounds"
                  className={`switch-button ${settings.trimBounds ? "on" : ""}`}
                  onClick={() => updateSetting("trimBounds", !settings.trimBounds)}
                />
              </div>
              <div className="toggle-sub">Crop empty transparent pixels with 8px padding.</div>
            </div>
          </div>
        </details>

        <section className="support-grid">
          <div className="prompt-card">
            <div className="prompt-head">
              <div>
                <div className="support-title">Need matching inputs?</div>
                <p>Use this prompt to generate black &amp; white renders.</p>
              </div>
              <button className="copy-button" onClick={() => navigator.clipboard.writeText(PROMPT)}>
                Copy prompt
              </button>
            </div>
            <div className="prompt-code">
              same object, same composition,
              <br />
              pure black background
            </div>
          </div>

          <div className="info-card">
            <div className="support-title">How it works</div>
            <ol>
              <li>Generate the same subject on black and white backgrounds.</li>
              <li>Upload a split render or two matched images.</li>
              <li>Get a transparent PNG instantly. All runs locally.</li>
            </ol>
          </div>

          <div className="privacy-card">
            <div className="support-title">100% local &amp; private</div>
            <p>AlphaRecover runs entirely in your browser. Your images never leave your device.</p>
          </div>
        </section>
      </div>
    </main>
  );
}

function PreviewTile({
  title,
  subtitle,
  imageUrl,
  kind
}: {
  title: string;
  subtitle: string;
  imageUrl?: string;
  kind: "black" | "white" | Background;
}) {
  const bgClass =
    kind === "checker"
      ? "checker-bg"
      : kind === "dark" || kind === "black"
        ? "dark-bg"
        : kind === "blue"
          ? "blue-bg"
          : "white-bg";
  return (
    <div className="preview-tile">
      <div className="preview-tile-title">{title}</div>
      <div className="preview-tile-subtitle">{subtitle}</div>
      <div className={`preview-tile-canvas ${bgClass}`}>
        {imageUrl ? <img src={imageUrl} alt={title} /> : <span>Waiting</span>}
      </div>
    </div>
  );
}

function SliderControl({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="control">
      <div className="control-label">
        {label} <span>{value}</span>
      </div>
      <input
        aria-label={label}
        max={100}
        min={0}
        onChange={(event) => onChange(Number(event.target.value))}
        type="range"
        value={value}
      />
      <div className="track" aria-hidden="true">
        <span style={{ width: `${value}%` }} />
      </div>
    </label>
  );
}
