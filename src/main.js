import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";

/* ------------------------------------------------------------------ */
/*  Collab Playground — Yjs CRDT shared canvas + shared code editor   */
/*  Same-browser tabs sync via BroadcastChannel (zero infra needed).  */
/*  Cross-device sync via y-webrtc (optional, toggle in the header).  */
/* ------------------------------------------------------------------ */

const $ = (s) => document.querySelector(s);

const COLORS = ["#ff5f56", "#ffbd2e", "#27c93f", "#5ac8fa", "#bf5af2", "#ff9f0a", "#64d2ff", "#ffd60a"];
const SIGNALING = ["wss://signaling.yjs.dev", "wss://y-webrtc-eu.fly.dev"];

/* ---------- DOM refs ---------- */
const roomInput = $("#roomInput");
const joinBtn = $("#joinBtn");
const copyBtn = $("#copyBtn");
const webrtcToggle = $("#webrtcToggle");
const peersEl = $("#peers");
const board = $("#board");
const overlay = $("#overlayCanvas");
const bctx = board.getContext("2d");
const octx = overlay.getContext("2d");
const editor = $("#editor");
const undoBtn = $("#undoBtn");
const clearBtn = $("#clearBtn");
const brushSize = $("#brushSize");
const swatchesEl = $("#colorSwatches");
const toastEl = $("#toast");
const langSelect = $("#langSelect");

/* ---------- connection state ---------- */
let room = "";
let doc = new Y.Doc();
let bc = null;
let webrtc = null;

let ystrokes = doc.getArray("strokes");
let ytext = doc.getText("code");

/* ---------- local state ---------- */
let myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
let brushColor = myColor;
let myId = Math.random().toString(36).slice(2, 8);
const peers = new Map(); // clientId -> { name, color, x, y, t }
let strokesCache = [];   // committed strokes snapshot
let current = null;      // stroke being drawn locally
let prevText = "";       // local mirror of the shared text
const myName = "guest-" + myId.slice(0, 4);
let myPresence = { id: myId, name: myName, color: myColor, x: null, y: null, t: Date.now() };

/* =========================================================
 *  Canvas sizing (HiDPI aware)
 * ========================================================= */
function resizeCanvas() {
  const rect = board.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  for (const c of [board, overlay]) {
    c.width = Math.max(1, rect.width * dpr);
    c.height = Math.max(1, rect.height * dpr);
    c.style.width = rect.width + "px";
    c.style.height = rect.height + "px";
  }
  redraw();
}
window.addEventListener("resize", resizeCanvas);

/* =========================================================
 *  Drawing
 * ========================================================= */
function drawStroke(ctx, s, w, h) {
  if (!s.points.length) return;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.size * (Math.min(w, h) / 700);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(s.points[0].x * w, s.points[0].y * h);
  for (let i = 1; i < s.points.length; i++) {
    ctx.lineTo(s.points[i].x * w, s.points[i].y * h);
  }
  if (s.points.length === 1) ctx.lineTo(s.points[0].x * w + 0.1, s.points[0].y * h);
  ctx.stroke();
}

function redraw() {
  const w = board.width;
  const h = board.height;
  bctx.clearRect(0, 0, w, h);
  for (const s of strokesCache) drawStroke(bctx, s, w, h);
  if (current) drawStroke(bctx, current, w, h);
}

function snapshotStrokes() {
  strokesCache = ystrokes.toArray().map((s) => ({ ...s }));
  redraw();
}
ystrokes.observe(snapshotStrokes);

function canvasPos(e) {
  const r = board.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

board.addEventListener("pointerdown", (e) => {
  board.setPointerCapture(e.pointerId);
  current = { color: brushColor, size: +brushSize.value, points: [canvasPos(e)] };
  redraw();
});
board.addEventListener("pointermove", (e) => {
  const p = canvasPos(e);
  // broadcast cursor for presence
  myPresence = { id: myId, name: myName, color: myColor, x: p.x, y: p.y, t: Date.now() };
  if (bc) bc.postMessage({ t: "presence", presence: myPresence });
  if (!current) return;
  const last = current.points[current.points.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) > 0.004) {
    current.points.push(p);
    redraw();
  }
});
board.addEventListener("pointerup", () => {
  if (!current) return;
  if (current.points.length) ystrokes.push([current]);
  current = null;
  redraw();
});

/* ---------- overlay: live peer cursors ---------- */
function drawOverlay() {
  const w = overlay.width;
  const h = overlay.height;
  octx.clearRect(0, 0, w, h);
  const now = Date.now();
  for (const [, p] of peers) {
    if (now - p.t > 2500 || p.x == null) continue;
    const x = p.x * w;
    const y = p.y * h;
    octx.fillStyle = p.color;
    octx.beginPath();
    octx.arc(x, y, 6, 0, Math.PI * 2);
    octx.fill();
    octx.strokeStyle = "rgba(0,0,0,0.6)";
    octx.lineWidth = 2;
    octx.stroke();
    octx.font = "12px system-ui";
    const label = p.name;
    const tw = octx.measureText(label).width + 10;
    octx.fillStyle = p.color;
    octx.fillRect(x + 8, y + 8, tw, 18);
    octx.fillStyle = "#0b0e14";
    octx.fillText(label, x + 13, y + 21);
  }
  requestAnimationFrame(drawOverlay);
}

/* =========================================================
 *  Shared text editor sync (Y.Text <-> textarea diff)
 * ========================================================= */
editor.addEventListener("input", () => {
  const next = editor.value;
  let p = 0;
  const min = Math.min(prevText.length, next.length);
  while (p < min && prevText[p] === next[p]) p++;
  let s = 0;
  while (s < min - p && prevText[prevText.length - 1 - s] === next[next.length - 1 - s]) s++;
  const removed = prevText.length - p - s;
  const inserted = next.slice(p, next.length - s);
  doc.transact(() => {
    if (removed) ytext.delete(p, removed);
    if (inserted) ytext.insert(p, inserted);
  }, "local");
  prevText = next;
});

ytext.observe((ev, tr) => {
  if (tr.origin === "local") return;
  const next = ytext.toString();
  editor.value = next;
  prevText = next;
});

langSelect.addEventListener("change", () => {
  editor.placeholder =
    langSelect.value === "md"
      ? "# Start writing — shared markdown, live for everyone."
      : langSelect.value === "py"
        ? "# Start typing — everyone in this room sees your keystrokes live."
        : langSelect.value === "txt"
          ? "Start typing — everyone sees this live."
          : "// Start typing — everyone in this room sees your keystrokes live.";
});

/* =========================================================
 *  Presence (peer list + cursors) via BroadcastChannel
 * ========================================================= */
function colorFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function renderPeers() {
  peersEl.innerHTML = "";
  const now = Date.now();
  for (const [, p] of peers) {
    if (now - p.t > 2500) continue;
    const dot = document.createElement("div");
    dot.className = "peer-dot";
    dot.style.background = p.color;
    dot.textContent = p.name[0].toUpperCase();
    dot.title = p.name;
    peersEl.appendChild(dot);
  }
}
setInterval(renderPeers, 700);

/* =========================================================
 *  Connection
 * ========================================================= */
function teardown() {
  if (bc) { try { bc.close(); } catch {} }
  if (webrtc) { try { webrtc.destroy(); } catch {} }
  bc = null;
  webrtc = null;
  peers.clear();
}

function connect(newRoom) {
  teardown();
  room = newRoom.toLowerCase().trim() || "lobby";
  history.replaceState(null, "", "#" + room);
  roomInput.value = room;

  doc = new Y.Doc();
  ystrokes = doc.getArray("strokes");
  ytext = doc.getText("code");

  // BroadcastChannel provider — syncs every tab in this browser, zero infra.
  bc = new BroadcastChannel("collab-" + room);
  bc.onmessage = ({ data }) => {
    if (data.t === "u") Y.applyUpdate(doc, data.u, "remote");
    else if (data.t === "s") Y.applyUpdate(doc, data.u, "remote");
    else if (data.t === "sync") bc.postMessage({ t: "s", u: Y.encodeStateAsUpdate(doc) });
    else if (data.t === "presence") {
      if (data.presence.id !== myId) {
        peers.set(data.presence.id, data.presence);
      }
    }
  };

  doc.on("update", (update, origin) => {
    if (origin !== "remote" && bc) bc.postMessage({ t: "u", u: update });
  });

  // Ask for state, and offer ours.
  bc.postMessage({ t: "sync" });
  bc.postMessage({ t: "s", u: Y.encodeStateAsUpdate(doc) });

  // Optional WebRTC provider — syncs across devices/other browsers.
  if (webrtcToggle.checked) {
    try {
      webrtc = new WebrtcProvider(room, doc, { signaling: SIGNALING });
    } catch (err) {
      console.warn("WebRTC provider failed to start:", err);
    }
  }

  // Local doc listeners (rebind to the new doc)
  ystrokes.observe(snapshotStrokes);
  ytext.observe((ev, tr) => {
    if (tr.origin === "local") return;
    const next = ytext.toString();
    editor.value = next;
    prevText = next;
  });

  // Load current state into the UI
  snapshotStrokes();
  prevText = ytext.toString();
  editor.value = prevText;

  toast(`Joined room “${room}” — ${webrtcToggle.checked ? "tabs + devices" : "tabs in this browser"} stay in sync`);
}

/* ---------- wiring ---------- */
joinBtn.addEventListener("click", () => connect(roomInput.value));
roomInput.addEventListener("keydown", (e) => e.key === "Enter" && connect(roomInput.value));
copyBtn.addEventListener("click", async () => {
  const url = location.origin + location.pathname + "#" + room;
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied — open it in another tab, browser, or device!");
  } catch {
    toast(url);
  }
});
undoBtn.addEventListener("click", () => {
  if (ystrokes.length > 0) ystrokes.delete(ystrokes.length - 1, 1);
});
clearBtn.addEventListener("click", () => ystrokes.delete(0, ystrokes.length));

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

/* ---------- color swatches ---------- */
for (const c of COLORS) {
  const b = document.createElement("button");
  b.className = "swatch";
  b.style.background = c;
  b.title = c;
  b.addEventListener("click", () => {
    brushColor = c;
    for (const s of swatchesEl.children) s.classList.toggle("active", s === b);
  });
  swatchesEl.appendChild(b);
}
swatchesEl.children[0]?.classList.add("active");

/* ---------- boot ---------- */
resizeCanvas();
requestAnimationFrame(drawOverlay);
setInterval(() => {
  // presence heartbeat so peer dots stay fresh even without mouse movement
  if (bc) bc.postMessage({ t: "presence", presence: { ...myPresence, t: Date.now() } });
}, 1200);
setInterval(() => {
  // prune stale peers
  const now = Date.now();
  for (const [id, p] of peers) if (now - p.t > 5000) peers.delete(id);
}, 3000);

const initialRoom = decodeURIComponent(location.hash.slice(1)) || Math.random().toString(36).slice(2, 8);
connect(initialRoom);
