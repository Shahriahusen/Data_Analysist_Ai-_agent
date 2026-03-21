import { useState, useRef, useCallback, useEffect } from "react";

// ─── CSV Parser (no external dep needed) ─────────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim());
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; continue; }
      if (line[i] === ',' && !inQ) { vals.push(cur.trim()); cur = ""; continue; }
      cur += line[i];
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : ""; });
    return obj;
  }).filter(r => Object.values(r).some(v => v !== ""));
}

// ─── Excel Parser using SheetJS from CDN ─────────────────────────────────────
function loadXLSX() {
  return new Promise((res) => {
    if (window.XLSX) { res(window.XLSX); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => res(window.XLSX);
    s.onerror = () => res(null);
    document.head.appendChild(s);
  });
}

async function readFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => {
        try { res(parseCSV(e.target.result)); }
        catch(err) { rej(err); }
      };
      r.onerror = () => rej(new Error("Cannot read file"));
      r.readAsText(file);
    });
  } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await loadXLSX();
    if (!XLSX) throw new Error("Excel library failed to load. Please try CSV.");
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          res(XLSX.utils.sheet_to_json(ws, { defval: "" }));
        } catch(err) { rej(err); }
      };
      r.onerror = () => rej(new Error("Cannot read Excel file"));
      r.readAsArrayBuffer(file);
    });
  } else {
    throw new Error("Unsupported format. Use CSV, XLS, or XLSX.");
  }
}

// ─── Data Cleaning ────────────────────────────────────────────────────────────
function cleanData(rawRows) {
  const log = [];
  if (!rawRows || !rawRows.length) return { data: [], log: ["No data found"] };
  let rows = rawRows.map(r => {
    const n = {};
    for (const k in r) {
      const key = String(k).trim();
      const val = r[k] === null || r[k] === undefined ? "" : r[k];
      n[key] = typeof val === "string" ? val.trim() : val;
    }
    return n;
  });
  const before = rows.length;
  const seen = new Set();
  rows = rows.filter(r => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
  if (before - rows.length > 0) log.push(`Removed ${before - rows.length} duplicate rows`);
  const cols = Object.keys(rows[0] || {});
  cols.forEach(col => {
    const nums = rows.map(r => parseFloat(r[col])).filter(v => !isNaN(v));
    if (nums.length < rows.length * 0.5) return;
    const sorted = [...nums].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    let filled = 0;
    rows = rows.map(r => {
      if (r[col] === "" || r[col] === null || r[col] === undefined) { filled++; return { ...r, [col]: med }; }
      return r;
    });
    if (filled > 0) log.push(`Filled ${filled} blanks in "${col}" with median (${med})`);
  });
  if (!log.length) log.push("Data is already clean ✓");
  return { data: rows, log };
}

function inferTypes(rows) {
  if (!rows.length) return {};
  const t = {};
  Object.keys(rows[0]).forEach(col => {
    const sample = rows.slice(0, 30).map(r => r[col]).filter(v => v !== "");
    const numCount = sample.filter(v => !isNaN(parseFloat(v))).length;
    t[col] = numCount > sample.length * 0.6 ? "number" : "text";
  });
  return t;
}

function buildSummary(rows, cols, types) {
  const nc = cols.filter(c => types[c] === "number");
  const stats = {};
  nc.slice(0, 6).forEach(col => {
    const v = rows.map(r => parseFloat(r[col])).filter(v => !isNaN(v));
    if (!v.length) return;
    const s = v.reduce((a, b) => a + b, 0);
    stats[col] = { min: +Math.min(...v).toFixed(2), max: +Math.max(...v).toFixed(2), avg: +(s / v.length).toFixed(2), sum: +s.toFixed(2) };
  });
  return `Rows:${rows.length}, Columns:[${cols.join(", ")}]\nNumeric stats:${JSON.stringify(stats)}\nFirst 10 rows:${JSON.stringify(rows.slice(0, 10))}`;
}

const fmt = n => { const x = Number(n); return x >= 1e6 ? `${(x/1e6).toFixed(1)}M` : x >= 1e3 ? `${(x/1e3).toFixed(1)}K` : x % 1 === 0 ? x.toString() : x.toFixed(1); };

// ─── Claude API ───────────────────────────────────────────────────────────────
async function callClaude(system, user) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system, messages: [{ role: "user", content: user }] })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.content?.map(b => b.text || "").join("") || "";
}

// ─── Charts ───────────────────────────────────────────────────────────────────
const PAL = ["#6366f1","#06b6d4","#10b981","#f59e0b","#ef4444","#8b5cf6","#ec4899","#14b8a6"];

function BarChart({ data, xKey, yKey, height = 180 }) {
  if (!data?.length || !xKey || !yKey) return <Empty text="Select columns to display chart" />;
  const vals = data.map(r => parseFloat(r[yKey]) || 0);
  const max = Math.max(...vals, 1);
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height, padding: "4px 2px 26px", minWidth: Math.max(data.length * 46, 200) }}>
        {data.map((r, i) => {
          const v = vals[i], h = `${(v / max) * 100}%`;
          return (
            <div key={i} title={`${r[xKey]}: ${v}`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, height: "100%", cursor: "default" }}>
              <span style={{ fontSize: 9, color: PAL[i % PAL.length], fontWeight: 700 }}>{fmt(v)}</span>
              <div style={{ width: "100%", background: PAL[i % PAL.length], borderRadius: "3px 3px 0 0", height: h, marginTop: "auto", minHeight: 3 }} />
              <span style={{ fontSize: 9, color: "#64748b", textAlign: "center", maxWidth: 44, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(r[xKey]).slice(0, 8)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LineChart({ data, xKey, yKey, color = "#6366f1", height = 140 }) {
  if (!data?.length || data.length < 2 || !yKey) return <Empty text="Need at least 2 rows" />;
  const vals = data.map(r => parseFloat(r[yKey]) || 0);
  const minV = Math.min(...vals), maxV = Math.max(...vals), range = maxV - minV || 1;
  const W = 500, H = height, p = 20;
  const pts = vals.map((v, i) => [p + (i / (vals.length - 1)) * (W - p * 2), H - p - ((v - minV) / range) * (H - p * 2)]);
  const d = pts.map((pt, i) => `${i === 0 ? "M" : "L"}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(" ");
  return (
    <div style={{ background: "#f8fafc", borderRadius: 8, padding: 8, overflowX: "auto" }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ minWidth: 260, display: "block" }}>
        <path d={`${d} L${pts[pts.length-1][0]},${H-p} L${pts[0][0]},${H-p} Z`} fill={`${color}15`} />
        <path d={d} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
        {pts.map((pt, i) => <circle key={i} cx={pt[0]} cy={pt[1]} r="3.5" fill={color} />)}
        {data.map((r, i) => <text key={i} x={pts[i][0]} y={H - 4} fontSize="8" fill="#94a3b8" textAnchor="middle">{String(r[xKey]).slice(0, 7)}</text>)}
      </svg>
    </div>
  );
}

function PieChart({ data, nameKey, valueKey, size = 130 }) {
  if (!data?.length || !valueKey) return <Empty text="Select columns" />;
  const items = data.slice(0, 7);
  const vals = items.map(r => Math.abs(parseFloat(r[valueKey]) || 0));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const cx = size / 2, cy = size / 2, r = size / 2 - 6;
  let cum = -Math.PI / 2;
  const slices = vals.map((v, i) => {
    const a = (v / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(cum), y1 = cy + r * Math.sin(cum);
    cum += a;
    return { d: `M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${a > Math.PI ? 1 : 0},1 ${(cx + r * Math.cos(cum)).toFixed(1)},${(cy + r * Math.sin(cum)).toFixed(1)} Z`, c: PAL[i % PAL.length], pct: ((v / total) * 100).toFixed(1), name: String(items[i][nameKey]).slice(0, 16) };
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {slices.map((s, i) => <path key={i} d={s.d} fill={s.c} />)}
        <circle cx={cx} cy={cy} r={r * 0.38} fill="white" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: s.c, flexShrink: 0 }} />
            <span style={{ color: "#334155" }}>{s.name}</span>
            <span style={{ color: s.c, fontWeight: 700, marginLeft: 4 }}>{s.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HBar({ data, nameKey, valueKey }) {
  if (!data?.length) return null;
  const vals = data.map(r => parseFloat(r[valueKey]) || 0);
  const max = Math.max(...vals, 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {data.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
          <span style={{ width: 80, color: "#94a3b8", textAlign: "right", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(r[nameKey]).slice(0, 12)}</span>
          <div style={{ flex: 1, background: "#1e293b", borderRadius: 4, height: 14 }}>
            <div style={{ width: `${(vals[i] / max) * 100}%`, height: "100%", background: PAL[i % PAL.length], borderRadius: 4 }} />
          </div>
          <span style={{ width: 60, color: "#e2e8f0", fontWeight: 700, textAlign: "right", fontSize: 11 }}>{fmt(vals[i])}</span>
        </div>
      ))}
    </div>
  );
}

function Gauge({ value, max, label, color }) {
  const pct = Math.min(Number(value) / (Number(max) || 1), 1);
  const angle = pct * 180 - 90;
  const r = 48, cx = 65, cy = 65;
  const xy = deg => { const rad = deg * Math.PI / 180; return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]; };
  const [x1, y1] = xy(-180), [x2, y2] = xy(0), [px, py] = xy(angle - 90);
  return (
    <svg width="130" height="85" viewBox="0 0 130 85">
      <path d={`M${x1},${y1} A${r},${r} 0 0,1 ${x2},${y2}`} fill="none" stroke="#1e293b" strokeWidth="9" strokeLinecap="round" />
      <path d={`M${x1},${y1} A${r},${r} 0 0,1 ${px.toFixed(1)},${py.toFixed(1)}`} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" />
      <text x="65" y="62" textAnchor="middle" fontSize="14" fontWeight="800" fill="#f1f5f9">{fmt(value)}</text>
      <text x="65" y="76" textAnchor="middle" fontSize="8" fill="#64748b">{String(label).slice(0, 14)}</text>
    </svg>
  );
}

function Empty({ text }) {
  return <div style={{ padding: "20px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>{text}</div>;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ rows, cols, types }) {
  const nc = cols.filter(c => types[c] === "number");
  const tc = cols.filter(c => types[c] === "text");
  const sum = col => rows.reduce((a, r) => a + (parseFloat(r[col]) || 0), 0);
  const avg = col => { const v = rows.map(r => parseFloat(r[col])).filter(v => !isNaN(v)); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0; };
  const max = col => Math.max(...rows.map(r => parseFloat(r[col]) || 0));
  const topCol = nc[0] || "", lbl = tc[0] || cols[0] || "";
  const top5 = topCol ? [...rows].sort((a,b)=>(parseFloat(b[topCol])||0)-(parseFloat(a[topCol])||0)).slice(0,5) : [];
  const KPC = ["#6366f1","#06b6d4","#10b981","#f59e0b"];
  const KPI = ["💰","📊","🎯","⚡"];
  return (
    <div style={{ background: "#0f172a", borderRadius: 12, padding: 16, color: "#e2e8f0" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", marginBottom: 14 }}>
        📊 Live Dashboard &nbsp;<span style={{ color:"#475569", fontWeight:400, fontSize:11 }}>{rows.length} rows · {cols.length} cols</span>
      </div>
      {/* KPI row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10, marginBottom:14 }}>
        {nc.slice(0,4).map((col,i)=>(
          <div key={col} style={{ background:"#1e293b", borderRadius:10, padding:"12px 14px", borderLeft:`3px solid ${KPC[i]}` }}>
            <div style={{ fontSize:10, color:"#64748b", marginBottom:3 }}>{KPI[i]} {col}</div>
            <div style={{ fontSize:20, fontWeight:800, color:KPC[i] }}>{fmt(sum(col))}</div>
            <div style={{ fontSize:9, color:"#475569", marginTop:2 }}>avg {fmt(avg(col))} · max {fmt(max(col))}</div>
          </div>
        ))}
        <div style={{ background:"#1e293b", borderRadius:10, padding:"12px 14px", borderLeft:"3px solid #8b5cf6" }}>
          <div style={{ fontSize:10, color:"#64748b", marginBottom:3 }}>📋 Total Rows</div>
          <div style={{ fontSize:20, fontWeight:800, color:"#8b5cf6" }}>{rows.length.toLocaleString()}</div>
          <div style={{ fontSize:9, color:"#475569", marginTop:2 }}>{cols.length} cols · {nc.length} numeric</div>
        </div>
      </div>
      {/* Charts row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))", gap:10, marginBottom:10 }}>
        <div style={{ background:"#1e293b", borderRadius:10, padding:12 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", marginBottom:8 }}>📈 {nc[0]||"—"} Trend</div>
          {nc[0] ? <LineChart data={rows.slice(0,16)} xKey={tc[0]||cols[0]} yKey={nc[0]} color="#06b6d4" height={120} /> : <Empty text="No numeric column" />}
        </div>
        <div style={{ background:"#1e293b", borderRadius:10, padding:12 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", marginBottom:8 }}>📊 {nc[1]||nc[0]||"—"} by {tc[0]||cols[0]}</div>
          <BarChart data={rows.slice(0,10)} xKey={tc[0]||cols[0]} yKey={nc[1]||nc[0]||""} height={130} />
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))", gap:10, marginBottom:10 }}>
        <div style={{ background:"#1e293b", borderRadius:10, padding:12 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", marginBottom:8 }}>🏆 Top 5 by {topCol}</div>
          {top5.length > 0 ? (
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
              <thead><tr><th style={{ color:"#475569", padding:"3px 0", textAlign:"left" }}>{lbl}</th><th style={{ color:"#475569", padding:"3px 0", textAlign:"right" }}>{topCol}</th></tr></thead>
              <tbody>{top5.map((r,i)=>(
                <tr key={i}><td style={{ padding:"4px 0", color:"#94a3b8", maxWidth:80, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{String(r[lbl]).slice(0,14)}</td>
                <td style={{ padding:"4px 0", color:["#fbbf24","#94a3b8","#a78bfa","#64748b","#475569"][i], fontWeight:700, textAlign:"right" }}>{fmt(parseFloat(r[topCol]))}</td></tr>
              ))}</tbody>
            </table>
          ) : <Empty text="No data" />}
        </div>
        <div style={{ background:"#1e293b", borderRadius:10, padding:12 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", marginBottom:8 }}>🥧 {nc[0]} Distribution</div>
          <PieChart data={rows.slice(0,7)} nameKey={tc[0]||cols[0]} valueKey={nc[0]||""} size={100} />
        </div>
        <div style={{ background:"#1e293b", borderRadius:10, padding:12 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", marginBottom:8 }}>📉 Category Comparison</div>
          <HBar data={top5} nameKey={lbl} valueKey={topCol} />
        </div>
      </div>
      {nc.length > 0 && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10 }}>
          {nc.slice(0,4).map((col,i)=>(
            <div key={col} style={{ background:"#1e293b", borderRadius:10, padding:12, textAlign:"center" }}>
              <div style={{ fontSize:10, color:"#64748b", marginBottom:4 }}>Avg {col}</div>
              <Gauge value={avg(col).toFixed(1)} max={max(col)} label={col} color={KPC[i%4]} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [files, setFiles] = useState([]);
  const [activeIdx, setActiveIdx] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");
  const [sideOpen, setSideOpen] = useState(true);
  const [insightsMap, setInsightsMap] = useState({});
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [question, setQuestion] = useState("");
  const [answersMap, setAnswersMap] = useState({});
  const [answerLoading, setAnswerLoading] = useState(false);
  const [chartType, setChartType] = useState("bar");
  const [chartX, setChartX] = useState("");
  const [chartY, setChartY] = useState("");
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState("");
  const [sortDir, setSortDir] = useState("asc");
  const [exportMsg, setExportMsg] = useState("");
  const fileRef = useRef();

  const active = activeIdx !== null && files[activeIdx] ? files[activeIdx] : null;
  const rows = active?.data || [];
  const cols = active?.cols || [];
  const types = active?.types || {};
  const nc = cols.filter(c => types[c] === "number");
  const tc = cols.filter(c => types[c] === "text");

  const processFile = useCallback(async (file) => {
    setUploadErr("");
    setUploading(true);
    try {
      const raw = await readFile(file);
      if (!raw || !raw.length) throw new Error("File has no data rows. Check that row 1 has headers.");
      const { data, log } = cleanData(raw);
      const t = inferTypes(data);
      const c = Object.keys(data[0] || {});
      if (!c.length) throw new Error("Could not detect columns. Ensure the file has a header row.");
      const ncols = c.filter(x => t[x] === "number");
      const tcols = c.filter(x => t[x] === "text");
      const entry = {
        id: Date.now() + Math.random(),
        name: file.name, size: (file.size / 1024).toFixed(1) + " KB",
        data, cols: c, types: t, log,
        rowCount: data.length, colCount: c.length,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      };
      setFiles(prev => {
        const next = [...prev, entry];
        const idx = next.length - 1;
        setActiveIdx(idx);
        setChartX(tcols[0] || c[0] || "");
        setChartY(ncols[0] || c[1] || c[0] || "");
        return next;
      });
      setTab("dashboard");
      setSearch(""); setSortCol("");
    } catch (e) {
      setUploadErr("❌ " + e.message);
    }
    setUploading(false);
  }, []);

  const handleFiles = useCallback((fileList) => {
    Array.from(fileList).forEach(f => processFile(f));
  }, [processFile]);

  const onDrop = e => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files); };
  const onDragOver = e => { e.preventDefault(); setDrag(true); };

  const removeFile = (idx) => {
    setFiles(prev => {
      const next = prev.filter((_, i) => i !== idx);
      setActiveIdx(next.length > 0 ? Math.max(0, Math.min(idx, next.length - 1)) : null);
      return next;
    });
  };

  const switchFile = (idx) => {
    setActiveIdx(idx);
    const f = files[idx];
    if (f) {
      const ncols = f.cols.filter(c => f.types[c] === "number");
      const tcols = f.cols.filter(c => f.types[c] === "text");
      setChartX(tcols[0] || f.cols[0] || "");
      setChartY(ncols[0] || f.cols[1] || f.cols[0] || "");
    }
    setTab("dashboard");
  };

  const genInsights = async () => {
    if (!active) return;
    setInsightsLoading(true);
    try {
      const r = await callClaude(
        "You are a senior data analyst. Give exactly 5 numbered specific plain-English business insights using real numbers from the data. Be concise and actionable.",
        `Dataset:\n${buildSummary(rows, cols, types)}`
      );
      setInsightsMap(p => ({ ...p, [active.id]: r }));
    } catch (e) { setInsightsMap(p => ({ ...p, [active.id]: "⚠️ " + e.message })); }
    setInsightsLoading(false);
  };

  const askAI = async (q) => {
    const query = (q || question).trim();
    if (!query || !active) return;
    setQuestion(query); setAnswerLoading(true);
    const key = active.id + "|" + query;
    try {
      const r = await callClaude(
        "You are a helpful data analyst. Answer the user's question concisely using real numbers from the dataset.",
        `Dataset:\n${buildSummary(rows, cols, types)}\n\nQuestion: ${query}`
      );
      setAnswersMap(p => ({ ...p, [key]: r }));
    } catch (e) { setAnswersMap(p => ({ ...p, [key]: "⚠️ " + e.message })); }
    setAnswerLoading(false);
  };

  const exportCSV = () => {
    if (!rows.length) return;
    const csv = [cols.join(","), ...rows.map(r => cols.map(c => `"${String(r[c]).replace(/"/g,'""')}"`).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = (active?.name || "data").replace(/\.[^.]+$/, "") + "_cleaned.csv";
    a.click(); setExportMsg("✅ CSV saved!"); setTimeout(() => setExportMsg(""), 2500);
  };

  const exportJSON = () => {
    if (!rows.length) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }));
    a.download = (active?.name || "data").replace(/\.[^.]+$/, "") + ".json";
    a.click(); setExportMsg("✅ JSON saved!"); setTimeout(() => setExportMsg(""), 2500);
  };

  const filtered = rows.filter(r => !search || cols.some(c => String(r[c]).toLowerCase().includes(search.toLowerCase())));
  const sorted = sortCol ? [...filtered].sort((a, b) => {
    const na = parseFloat(a[sortCol]), nb = parseFloat(b[sortCol]);
    const cmp = !isNaN(na) && !isNaN(nb) ? na - nb : String(a[sortCol]).localeCompare(String(b[sortCol]));
    return sortDir === "asc" ? cmp : -cmp;
  }) : filtered;

  const currentInsight = active ? insightsMap[active.id] : "";
  const currentAnswer = active && question ? answersMap[active.id + "|" + question] : "";
  const chips = ["Show sales trend","Top 5 by revenue","Which category leads?","Any outliers?","What is the average?","Summarize this data","Compare all groups"];

  return (
    <div style={{ fontFamily: "'Segoe UI',system-ui,sans-serif", background: "#f1f5f9", minHeight: "100vh", fontSize: 14, color: "#1e293b" }}>

      {/* ── HEADER ── */}
      <div style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)", color: "#fff", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", position: "sticky", top: 0, zIndex: 200, boxShadow: "0 2px 12px rgba(79,70,229,.4)" }}>
        <button onClick={() => setSideOpen(p => !p)} title="Toggle Sidebar" style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", borderRadius: 8, padding: "7px 11px", cursor: "pointer", fontSize: 16, flexShrink: 0 }}>☰</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.3px" }}>📊 AI Data Analyst</div>
          <div style={{ fontSize: 10, opacity: .75 }}>Upload CSV / Excel · Dashboard · Charts · AI Insights · Ask AI</div>
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
          {active && <>
            <button onClick={exportCSV} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", borderRadius: 7, padding: "6px 11px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>⬇ CSV</button>
            <button onClick={exportJSON} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", borderRadius: 7, padding: "6px 11px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>⬇ JSON</button>
          </>}
          {exportMsg && <span style={{ fontSize: 11, background: "rgba(255,255,255,.25)", padding: "4px 10px", borderRadius: 10 }}>{exportMsg}</span>}
          {active && <div style={{ background: "rgba(255,255,255,.2)", padding: "5px 11px", borderRadius: 18, fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✅ {active.name}</div>}
        </div>
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 56px)" }}>

        {/* ── SIDEBAR ── */}
        {sideOpen && (
          <div style={{ width: 255, flexShrink: 0, background: "#fff", borderRight: "1px solid #e2e8f0", padding: 14, display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", maxHeight: "calc(100vh - 56px)", position: "sticky", top: 56 }}>

            {/* Upload Zone */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .8, color: "#94a3b8", marginBottom: 8 }}>Upload File</div>
              <div
                onClick={() => { setUploadErr(""); fileRef.current.click(); }}
                onDrop={onDrop} onDragOver={onDragOver} onDragLeave={() => setDrag(false)}
                style={{ border: `2px dashed ${drag ? "#6366f1" : "#c7d2fe"}`, background: drag ? "#e0e7ff" : "#eef2ff", borderRadius: 10, padding: "20px 10px", textAlign: "center", cursor: "pointer", transition: ".2s", userSelect: "none" }}>
                <div style={{ fontSize: 30, marginBottom: 5 }}>📂</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#4338ca" }}>{uploading ? "Processing…" : "Click or Drag & Drop"}</div>
                <div style={{ fontSize: 10, color: "#818cf8", marginTop: 2 }}>CSV · XLS · XLSX</div>
                <div style={{ fontSize: 10, color: "#a5b4fc", marginTop: 1 }}>Multiple files supported</div>
              </div>
              <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx" multiple style={{ display: "none" }} onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />
              {uploading && (
                <div style={{ marginTop: 8, padding: "8px 10px", background: "#eef2ff", borderRadius: 8, fontSize: 12, color: "#6366f1", textAlign: "center" }}>
                  ⏳ Reading and cleaning file…
                </div>
              )}
              {uploadErr && (
                <div style={{ marginTop: 8, padding: "8px 10px", background: "#fef2f2", borderRadius: 8, fontSize: 12, color: "#dc2626", borderLeft: "3px solid #ef4444", lineHeight: 1.5 }}>
                  {uploadErr}
                </div>
              )}
            </div>

            {/* File History */}
            {files.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .8, color: "#94a3b8", marginBottom: 8 }}>Files ({files.length})</div>
                {files.map((f, i) => (
                  <div key={f.id} onClick={() => switchFile(i)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: i === activeIdx ? "#eef2ff" : "#f8fafc", borderRadius: 8, cursor: "pointer", border: `1px solid ${i === activeIdx ? "#c7d2fe" : "transparent"}`, marginBottom: 5, transition: ".15s" }}>
                    <span style={{ fontSize: 18 }}>{f.name.toLowerCase().endsWith(".csv") ? "📄" : "📊"}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                      <div style={{ fontSize: 10, color: "#94a3b8" }}>{f.rowCount} rows · {f.colCount} cols · {f.size}</div>
                    </div>
                    {i === activeIdx && <span style={{ fontSize: 9, background: "#6366f1", color: "#fff", padding: "2px 6px", borderRadius: 8, flexShrink: 0 }}>Active</span>}
                    <button onClick={e => { e.stopPropagation(); removeFile(i); }} style={{ background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", fontSize: 14, padding: 2, flexShrink: 0 }} title="Remove">✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Cleaning Log */}
            {active?.log?.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .8, color: "#94a3b8", marginBottom: 6 }}>Cleaning Log</div>
                <div style={{ fontSize: 11, background: "#f0fdf4", color: "#15803d", borderLeft: "3px solid #22c55e", padding: "8px 10px", borderRadius: 6, lineHeight: 1.8 }}>
                  {active.log.map((l, i) => <div key={i}>✅ {l}</div>)}
                </div>
              </div>
            )}

            {/* Columns */}
            {cols.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .8, color: "#94a3b8", marginBottom: 6 }}>Columns ({cols.length})</div>
                <div style={{ maxHeight: 185, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                  {cols.map(c => (
                    <div key={c} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", background: "#f8fafc", borderRadius: 6, fontSize: 11 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 138, color: "#334155" }}>{c}</span>
                      <span style={{ fontSize: 9, background: types[c] === "number" ? "#dbeafe" : "#fce7f3", color: types[c] === "number" ? "#1d4ed8" : "#9d174d", padding: "1px 6px", borderRadius: 4, flexShrink: 0, marginLeft: 4 }}>{types[c]}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Quick Stats */}
            {rows.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .8, color: "#94a3b8", marginBottom: 6 }}>Quick Stats</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {[["Rows", rows.length], ["Cols", cols.length], ["Numeric", nc.length], ["Text", tc.length]].map(([l, v]) => (
                    <div key={l} style={{ background: "#f8fafc", borderRadius: 8, padding: "7px 9px" }}>
                      <div style={{ fontSize: 10, color: "#94a3b8" }}>{l}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#4338ca" }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── MAIN ── */}
        <div style={{ flex: 1, minWidth: 0, padding: 16, overflowX: "hidden" }}>
          {!active ? (
            <div style={{ background: "#fff", borderRadius: 14, padding: "50px 20px", textAlign: "center", boxShadow: "0 1px 4px rgba(0,0,0,.07)", maxWidth: 560, margin: "0 auto" }}>
              <div style={{ fontSize: 54, marginBottom: 14 }}>📊</div>
              <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 8 }}>Upload your data file to begin</div>
              <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.8, marginBottom: 20 }}>
                {sideOpen ? "Click the upload box in the sidebar." : "Open the sidebar (☰) and upload a file."}<br/>
                Supports CSV, XLS, and XLSX. Upload multiple files and switch between them anytime.
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                {["🧹 Auto clean","🖥️ Dashboard","📈 Charts","🔍 Search & Sort","💡 AI Insights","🤖 Ask AI","⬇ Export"].map(f => (
                  <span key={f} style={{ fontSize: 11, background: "#eef2ff", color: "#4338ca", border: "1px solid #c7d2fe", padding: "5px 12px", borderRadius: 20 }}>{f}</span>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,.07)" }}>
              {/* Tabs */}
              <div style={{ display: "flex", borderBottom: "2px solid #f1f5f9", marginBottom: 18, gap: 2, overflowX: "auto" }}>
                {[["dashboard","🖥️ Dashboard"],["preview","📋 Preview"],["charts","📈 Charts"],["insights","💡 AI Insights"],["query","🤖 Ask AI"]].map(([id, label]) => (
                  <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 14px", fontSize: 12, cursor: "pointer", background: "none", border: "none", borderBottom: `2px solid ${tab === id ? "#6366f1" : "transparent"}`, color: tab === id ? "#6366f1" : "#94a3b8", fontWeight: tab === id ? 700 : 400, marginBottom: -2, whiteSpace: "nowrap", transition: ".15s" }}>{label}</button>
                ))}
              </div>

              {/* DASHBOARD */}
              {tab === "dashboard" && <Dashboard rows={rows} cols={cols} types={types} />}

              {/* PREVIEW */}
              {tab === "preview" && (
                <div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search any value…"
                      style={{ flex: 1, minWidth: 140, border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", fontSize: 12, outline: "none", color: "#334155" }} />
                    <select value={sortCol} onChange={e => setSortCol(e.target.value)} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", fontSize: 12, background: "#fff", color: "#334155" }}>
                      <option value="">Sort by…</option>
                      {cols.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <button onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", fontSize: 12, background: "#fff", cursor: "pointer", color: "#334155" }}>{sortDir === "asc" ? "↑ Asc" : "↓ Desc"}</button>
                    <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0 }}>{sorted.length}/{rows.length} rows</span>
                  </div>
                  <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid #e2e8f0" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead><tr>{cols.map(c => (
                        <th key={c} onClick={() => { setSortCol(c); setSortDir(d => sortCol === c ? (d === "asc" ? "desc" : "asc") : "asc"); }}
                          style={{ background: "#eef2ff", color: "#4338ca", fontWeight: 700, padding: "9px 12px", textAlign: "left", whiteSpace: "nowrap", borderBottom: "1px solid #e2e8f0", cursor: "pointer", userSelect: "none" }}>
                          {c} {sortCol === c ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                        </th>
                      ))}</tr></thead>
                      <tbody>{sorted.slice(0, 30).map((r, i) => (
                        <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                          {cols.map(c => <td key={c} style={{ padding: "7px 12px", whiteSpace: "nowrap", color: "#334155", borderBottom: "1px solid #f1f5f9", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{String(r[c]).slice(0, 50)}</td>)}
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>Showing {Math.min(30, sorted.length)} of {sorted.length} rows · Click column header to sort</div>
                </div>
              )}

              {/* CHARTS */}
              {tab === "charts" && (
                <div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", background: "#f8fafc", padding: "10px 12px", borderRadius: 10, alignItems: "center" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>Chart type:</span>
                    <select value={chartType} onChange={e => setChartType(e.target.value)} style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "6px 10px", fontSize: 12, background: "#fff" }}>
                      <option value="bar">📊 Bar Chart</option>
                      <option value="line">📈 Line Chart</option>
                      <option value="pie">🥧 Pie Chart</option>
                    </select>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>X:</span>
                    <select value={chartX} onChange={e => setChartX(e.target.value)} style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "6px 10px", fontSize: 12, background: "#fff", maxWidth: 160 }}>
                      {cols.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>Y:</span>
                    <select value={chartY} onChange={e => setChartY(e.target.value)} style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "6px 10px", fontSize: 12, background: "#fff", maxWidth: 160 }}>
                      {(chartType === "pie" ? cols : nc).map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1e293b", marginBottom: 12 }}>
                    {chartType === "bar" ? "📊" : chartType === "line" ? "📈" : "🥧"} {chartX} vs {chartY}
                  </div>
                  {chartType === "bar" && <BarChart data={rows.slice(0, 20)} xKey={chartX} yKey={chartY} height={210} />}
                  {chartType === "line" && <LineChart data={rows.slice(0, 20)} xKey={chartX} yKey={chartY} height={190} />}
                  {chartType === "pie" && <PieChart data={rows.slice(0, 8)} nameKey={chartX} valueKey={chartY} size={150} />}
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8 }}>Showing up to 20 rows · Change X/Y above to explore different views</div>
                </div>
              )}

              {/* INSIGHTS */}
              {tab === "insights" && (
                <div>
                  {!currentInsight && !insightsLoading && (
                    <div style={{ textAlign: "center", padding: "32px 20px" }}>
                      <div style={{ fontSize: 46, marginBottom: 12 }}>💡</div>
                      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Generate AI Insights</div>
                      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20, maxWidth: 380, margin: "0 auto 20px" }}>Claude AI reads your actual data and produces 5 specific, numbered business insights with real values.</div>
                      <button onClick={genInsights} style={{ background: "linear-gradient(135deg,#6366f1,#7c3aed)", color: "#fff", border: "none", borderRadius: 10, padding: "12px 28px", fontSize: 14, cursor: "pointer", fontWeight: 700 }}>✨ Generate Insights</button>
                    </div>
                  )}
                  {insightsLoading && <div style={{ textAlign: "center", padding: "40px", color: "#6366f1" }}><div style={{ fontSize: 38 }}>🧠</div><div style={{ marginTop: 8, fontWeight: 600 }}>Claude AI is analyzing your data…</div></div>}
                  {currentInsight && (
                    <div>
                      <div style={{ background: "#f8faff", border: "1px solid #e0e7ff", borderRadius: 10, padding: "16px 18px", fontSize: 13, lineHeight: 1.9, color: "#1e293b", whiteSpace: "pre-wrap" }}>{currentInsight}</div>
                      <button onClick={genInsights} style={{ marginTop: 10, background: "#f1f5f9", color: "#6366f1", border: "1px solid #c7d2fe", borderRadius: 8, padding: "7px 16px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>🔄 Regenerate</button>
                    </div>
                  )}
                </div>
              )}

              {/* ASK AI */}
              {tab === "query" && (
                <div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key === "Enter" && askAI()}
                      placeholder="Ask anything about your data…"
                      style={{ flex: 1, border: "1.5px solid #e2e8f0", borderRadius: 8, padding: "10px 14px", fontSize: 13, outline: "none", background: "#fff", color: "#1e293b" }} />
                    <button onClick={() => askAI()} disabled={answerLoading} style={{ background: "linear-gradient(135deg,#6366f1,#7c3aed)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 13, cursor: "pointer", fontWeight: 700, opacity: answerLoading ? .6 : 1 }}>{answerLoading ? "⏳" : "Ask"}</button>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                    {chips.map(c => <span key={c} onClick={() => askAI(c)} style={{ fontSize: 11, background: "#eef2ff", color: "#4338ca", border: "1px solid #c7d2fe", padding: "4px 11px", borderRadius: 20, cursor: "pointer" }}>{c}</span>)}
                  </div>
                  {answerLoading && <div style={{ textAlign: "center", padding: "28px", color: "#6366f1" }}><div style={{ fontSize: 30 }}>🧠</div><div style={{ marginTop: 6, fontWeight: 600 }}>Analyzing…</div></div>}
                  {currentAnswer && !answerLoading && (
                    <div style={{ background: "#f8faff", border: "1px solid #e0e7ff", borderLeft: "4px solid #6366f1", borderRadius: 10, padding: "14px 16px" }}>
                      <div style={{ fontSize: 11, color: "#6366f1", fontWeight: 700, marginBottom: 6 }}>🤖 AI Answer</div>
                      <div style={{ fontSize: 13, lineHeight: 1.85, color: "#1e293b", whiteSpace: "pre-wrap" }}>{currentAnswer}</div>
                    </div>
                  )}
                  {!currentAnswer && !answerLoading && <div style={{ background: "#f8fafc", borderRadius: 8, padding: "20px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>Type a question or click an example chip above</div>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
