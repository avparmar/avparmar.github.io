import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// ---------- Firebase ----------
const firebaseConfig = {
  apiKey: "AIzaSyD6Pl8vI79OnBSbMku3GbXbc9a8REScBeE",
  authDomain: "poker-tournament-zinc.firebaseapp.com",
  projectId: "poker-tournament-zinc",
  storageBucket: "poker-tournament-zinc.firebasestorage.app",
  messagingSenderId: "104603161659",
  appId: "1:104603161659:web:267b23a0c72ecde290781e"
};
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

const configRef = doc(db, "config", "event");
const liveRef = doc(db, "live", "state");
const signupsCol = collection(db, "signups");

// ---------- Blind schedule ----------
// 20 levels, no antes. Rebuys are unlimited through the end of Level 4
// (index 3, right before the first break). The one-time top-off is
// offered starting at that same break.
const BLIND_LEVELS = [
  { sb: 75, bb: 150 },
  { sb: 100, bb: 200 },
  { sb: 150, bb: 300 },
  { sb: 200, bb: 400 },
  { brk: true, mins: 10, label: "Bathroom break — rebuy period ends" },
  { sb: 300, bb: 600 },
  { sb: 500, bb: 1000 },
  { sb: 1000, bb: 2000 },
  { sb: 1500, bb: 3000 },
  { sb: 2000, bb: 4000 },
  { sb: 3000, bb: 6000 },
  { brk: true, mins: 30, label: "Dinner break" },
  { sb: 4000, bb: 8000 },
  { sb: 5000, bb: 10000 },
  { sb: 6000, bb: 12000 },
  { sb: 8000, bb: 16000 },
  { sb: 10000, bb: 20000 },
  { sb: 12000, bb: 24000 },
  { brk: true, mins: 10, label: "Break" },
  { sb: 15000, bb: 30000 },
  { sb: 20000, bb: 40000 },
  { sb: 25000, bb: 50000 },
  { sb: 30000, bb: 60000 }
];
BLIND_LEVELS.forEach((lv) => { if (!lv.mins) lv.mins = 20; });
const FIRST_BREAK_INDEX = BLIND_LEVELS.findIndex((lv) => lv.brk);

const DEFAULT_CONFIG = {
  name: "Poker Tournament",
  dateISO: "2026-09-19T15:00",
  location: "TBD — add your address in Host Settings",
  venmo: "@adi2015",
  buyIn: 50,
  rebuyPrice: 50,
  topOffPrice: 25,
  startingStack: 10000,
  rebuyStack: 10000,
  capacity: 16,
  hostPin: "1919"
};
const DEFAULT_LIVE = {
  phase: "setup", levelIndex: 0, levelEndsAt: null, remainingMs: null,
  seating: null, eliminations: [], chipCounts: {}, chipCountsAt: null, chipCountsLabel: null
};

// ---------- Local state ----------
let CONFIG = null;
let LIVE = null;
let SIGNUPS = [];
let activeTab = "signup";
let hostUnlocked = false;
try { hostUnlocked = localStorage.getItem("pokerHostUnlocked") === "1"; } catch (e) {}
let clockInterval = null;
let countdownInterval = null;
let seededConfig = false, seededLive = false;

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function fmtMoney(n) { return "$" + Math.round(n).toLocaleString(); }
function fmtChips(n) { return n.toLocaleString(); }

function confirmedList() { return SIGNUPS.filter((p) => p.confirmed); }
function pendingList() { return SIGNUPS.filter((p) => !p.confirmed); }
function findPlayer(id) { return SIGNUPS.find((p) => p.id === id) || null; }

function potTotals() {
  const confirmed = confirmedList();
  let rebuys = 0, topOffs = 0;
  confirmed.forEach((p) => { rebuys += p.rebuys || 0; if (p.topOff) topOffs += 1; });
  const projected = confirmed.length * CONFIG.buyIn + rebuys * CONFIG.rebuyPrice + topOffs * CONFIG.topOffPrice;
  return { confirmed: confirmed.length, projected, rebuys, topOffs };
}
function levelLabel(lv) {
  if (lv.brk) return lv.label;
  return lv.sb.toLocaleString() + " / " + lv.bb.toLocaleString();
}
function levelIndexToNumber(idx) {
  let n = 0;
  for (let i = 0; i <= idx; i++) if (!BLIND_LEVELS[i].brk) n++;
  return n;
}
function remainingAfterEliminations() {
  return confirmedList().length - (LIVE.eliminations || []).length;
}
function chipTallyLabel() {
  if (!LIVE || LIVE.phase === "setup" || LIVE.levelIndex == null) return "Tournament start";
  const lv = BLIND_LEVELS[LIVE.levelIndex];
  if (lv && lv.brk) {
    let breakNum = 0;
    for (let i = 0; i <= LIVE.levelIndex; i++) if (BLIND_LEVELS[i].brk) breakNum++;
    return "Break " + breakNum;
  }
  return "Level " + levelIndexToNumber(LIVE.levelIndex);
}

// ---------- Firestore wiring ----------
function startListeners() {
  onSnapshot(configRef, async (snap) => {
    if (!snap.exists()) {
      if (!seededConfig) { seededConfig = true; await setDoc(configRef, DEFAULT_CONFIG); }
      return;
    }
    CONFIG = { ...DEFAULT_CONFIG, ...snap.data() };
    render();
  }, (err) => console.warn("config listener error", err));

  onSnapshot(liveRef, async (snap) => {
    if (!snap.exists()) {
      if (!seededLive) { seededLive = true; await setDoc(liveRef, DEFAULT_LIVE); }
      return;
    }
    LIVE = { ...DEFAULT_LIVE, ...snap.data() };
    render();
  }, (err) => console.warn("live listener error", err));

  const q = query(signupsCol, orderBy("ts", "asc"));
  onSnapshot(q, (qsnap) => {
    SIGNUPS = qsnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => console.warn("signups listener error", err));
}

// ---------- Signup actions ----------
async function submitSignup(name, note, message) {
  name = (name || "").trim();
  if (!name) return;
  await addDoc(signupsCol, {
    name, note: (note || "").trim(), message: (message || "").trim(), confirmed: false,
    rebuys: 0, topOff: false, ts: Date.now()
  });
}
async function toggleConfirmed(id) {
  const p = findPlayer(id); if (!p) return;
  if (!p.confirmed && confirmedList().length >= CONFIG.capacity) {
    if (!confirm("That's past your " + CONFIG.capacity + "-seat capacity. Confirm anyway?")) return;
  }
  await updateDoc(doc(db, "signups", id), { confirmed: !p.confirmed });
}
async function toggleTopOff(id) {
  const p = findPlayer(id); if (!p) return;
  await updateDoc(doc(db, "signups", id), { topOff: !p.topOff });
}
async function setRebuys(id, delta) {
  const p = findPlayer(id); if (!p) return;
  await updateDoc(doc(db, "signups", id), { rebuys: Math.max(0, (p.rebuys || 0) + delta) });
}
async function removeSignup(id) {
  if (!confirm("Remove this sign-up?")) return;
  await deleteDoc(doc(db, "signups", id));
}
async function saveEventSettings(form) {
  await setDoc(configRef, {
    name: form.name.value.trim() || CONFIG.name,
    dateISO: form.dateISO.value || CONFIG.dateISO,
    location: form.location.value.trim(),
    venmo: form.venmo.value.trim() || CONFIG.venmo,
    buyIn: Math.max(0, Number(form.buyIn.value) || 0),
    rebuyPrice: Math.max(0, Number(form.rebuyPrice.value) || 0),
    topOffPrice: Math.max(0, Number(form.topOffPrice.value) || 0),
    capacity: Math.max(2, Number(form.capacity.value) || 16),
    hostPin: form.hostPin.value.trim() || CONFIG.hostPin
  }, { merge: true });
}

// ---------- Host unlock ----------
function tryUnlock(pin) {
  if (pin === CONFIG.hostPin) {
    hostUnlocked = true;
    try { localStorage.setItem("pokerHostUnlocked", "1"); } catch (e) {}
    render();
  } else { alert("Wrong PIN."); }
}
function lockHost() {
  hostUnlocked = false;
  try { localStorage.removeItem("pokerHostUnlocked"); } catch (e) {}
  render();
}

// ---------- Live tournament controls ----------
async function startLevel(idx, carryRemaining) {
  const lv = BLIND_LEVELS[idx];
  const ms = carryRemaining != null ? carryRemaining : lv.mins * 60000;
  await setDoc(liveRef, {
    levelIndex: idx, levelEndsAt: Date.now() + ms, remainingMs: null, phase: "running"
  }, { merge: true });
}
async function pauseClock() {
  if (LIVE.phase !== "running") return;
  const remainingMs = Math.max(0, LIVE.levelEndsAt - Date.now());
  await setDoc(liveRef, { remainingMs, levelEndsAt: null, phase: "paused" }, { merge: true });
}
async function resumeClock() {
  if (LIVE.phase !== "paused") return;
  await startLevel(LIVE.levelIndex, LIVE.remainingMs || 0);
}
async function nextLevel() { await startLevel(Math.min(BLIND_LEVELS.length - 1, LIVE.levelIndex + 1), null); }
async function prevLevel() { await startLevel(Math.max(0, LIVE.levelIndex - 1), null); }
async function restartLevel() { await startLevel(LIVE.levelIndex, null); }
async function beginTournament() {
  const chipCounts = {};
  confirmedList().forEach((p) => { chipCounts[p.id] = CONFIG.startingStack; });
  await setDoc(liveRef, {
    eliminations: [], chipCounts, chipCountsAt: Date.now(), chipCountsLabel: "Tournament start"
  }, { merge: true });
  await generateSeating();
  await startLevel(0, null);
}

// Blinds advance on their own once the clock is running: when a level's
// timer hits zero we move straight to the next one, unless that next one
// is a scheduled break — then we stop and wait for the host to hit Resume
// (which is also the natural moment to update chip stacks).
let autoAdvancing = false;
async function advanceAfterExpiry() {
  if (autoAdvancing) return;
  autoAdvancing = true;
  try {
    const nextIdx = LIVE.levelIndex + 1;
    if (nextIdx >= BLIND_LEVELS.length) {
      await setDoc(liveRef, { phase: "paused", remainingMs: 0, levelEndsAt: null }, { merge: true });
      return;
    }
    const nextLv = BLIND_LEVELS[nextIdx];
    if (nextLv.brk) {
      await setDoc(liveRef, {
        levelIndex: nextIdx, phase: "paused", remainingMs: nextLv.mins * 60000, levelEndsAt: null
      }, { merge: true });
    } else {
      await setDoc(liveRef, {
        levelIndex: nextIdx, phase: "running", levelEndsAt: Date.now() + nextLv.mins * 60000, remainingMs: null
      }, { merge: true });
    }
  } finally {
    autoAdvancing = false;
  }
}
function checkAutoAdvance() {
  if (!CONFIG || !LIVE) return;
  if (LIVE.phase !== "running" || !LIVE.levelEndsAt) return;
  if (Date.now() < LIVE.levelEndsAt) return;
  advanceAfterExpiry();
}
async function generateSeating() {
  const players = confirmedList().filter((p) => (LIVE.eliminations || []).indexOf(p.id) === -1);
  const ids = players.map((p) => p.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  // Firestore rejects arrays that directly contain other arrays, so each
  // table is stored as a map with an `ids` array field, not a bare array.
  const rawTables = ids.length <= 9 ? [ids] : [ids.slice(0, Math.ceil(ids.length / 2)), ids.slice(Math.ceil(ids.length / 2))];
  const tables = rawTables.map((t) => ({ ids: t }));
  await setDoc(liveRef, { seating: { tables } }, { merge: true });
}
async function markEliminated(id) {
  if (!id) return;
  const eliminations = [...(LIVE.eliminations || []), id];
  let seating = LIVE.seating;
  if (seating) seating = { tables: seating.tables.map((t) => ({ ids: t.ids.filter((pid) => pid !== id) })) };
  await setDoc(liveRef, { eliminations, seating }, { merge: true });
}
async function restoreEliminated(id) {
  if (!id) return;
  const elimList = LIVE.eliminations || [];
  if (elimList.indexOf(id) === -1) return;
  const eliminations = elimList.filter((eid) => eid !== id);
  let seating = LIVE.seating;
  if (seating && seating.tables.length) {
    const tables = seating.tables.map((t) => ({ ids: t.ids.slice() }));
    let minIdx = 0;
    for (let i = 1; i < tables.length; i++) if (tables[i].ids.length < tables[minIdx].ids.length) minIdx = i;
    tables[minIdx] = { ids: [...tables[minIdx].ids, id] };
    seating = { tables };
  }
  await setDoc(liveRef, { eliminations, seating }, { merge: true });
}
async function resetTournament() {
  if (!confirm("Reset the live tournament (seating, blind clock, eliminations, chip tallies)? Sign-ups are kept.")) return;
  await setDoc(liveRef, DEFAULT_LIVE);
}
async function saveChipTally(form) {
  const chipCounts = {};
  confirmedList().forEach((p) => {
    const v = Number(form["chip_" + p.id]?.value);
    if (!isNaN(v) && v >= 0) chipCounts[p.id] = v;
  });
  await setDoc(liveRef, { chipCounts, chipCountsAt: Date.now(), chipCountsLabel: chipTallyLabel() }, { merge: true });
}

// ---------- Rendering ----------
function renderHeader() {
  const confirmed = confirmedList().length;
  return `
    <div class="hero">
      <img class="hero-logo" src="logo-badge-wood.webp" alt="Grand Royale Survival Tournament badge">
      <div class="hero-content">
        <div class="hero-text">
          <div class="eyebrow">Home Tournament</div>
          <h1>${esc(CONFIG.name)}</h1>
          <div class="meta">
            <span>📍 ${esc(CONFIG.location)}</span>
          </div>
        </div>
        <div class="seat-meter"><div class="num">${confirmed} / ${CONFIG.capacity}</div><div class="lbl">Seats confirmed</div></div>
      </div>
    </div>
    ${renderTopRow()}
    <div class="tabs">${tabBtn("signup", "Sign Up")}${tabBtn("rules", "Rules & Blinds")}${tabBtn("live", "Live Day")}</div>
  `;
}

function renderCountdownBanner() {
  if (LIVE.phase !== "setup") return "";
  const d = new Date(CONFIG.dateISO);
  if (isNaN(d.getTime())) return "";
  const dateStr = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) + " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const msLeft = d.getTime() - Date.now();
  if (msLeft <= 0) {
    return `<div class="countdown-banner">
      <div class="cb-eyebrow">Kickoff time has arrived</div>
      <div class="cb-sub">Waiting for the host to begin — see you at the table.</div>
    </div>`;
  }
  const parts = msToParts(msLeft);
  return `<div class="countdown-banner">
    <div class="cb-eyebrow">Chips will fly in</div>
    <div class="cb-grid" id="event-countdown">
      <div class="cb-seg"><span class="cb-num" id="cd-d">${pad2(parts.d)}</span><span class="cb-lbl">Days</span></div>
      <span class="cb-colon">:</span>
      <div class="cb-seg"><span class="cb-num" id="cd-h">${pad2(parts.h)}</span><span class="cb-lbl">Hrs</span></div>
      <span class="cb-colon">:</span>
      <div class="cb-seg"><span class="cb-num" id="cd-m">${pad2(parts.m)}</span><span class="cb-lbl">Min</span></div>
      <span class="cb-colon">:</span>
      <div class="cb-seg"><span class="cb-num" id="cd-s">${pad2(parts.s)}</span><span class="cb-lbl">Sec</span></div>
    </div>
    <div class="cb-sub">${esc(dateStr)}</div>
  </div>`;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function msToParts(ms) {
  const totalSec = Math.floor(ms / 1000);
  return {
    d: Math.floor(totalSec / 86400),
    h: Math.floor((totalSec % 86400) / 3600),
    m: Math.floor((totalSec % 3600) / 60),
    s: totalSec % 60
  };
}
function tabBtn(id, label) {
  return `<button class="tab-btn${activeTab === id ? " active" : ""}" data-tab="${id}">${label}</button>`;
}

function renderSignupTab() {
  const confirmed = confirmedList(), pending = pendingList();
  let html = '<div class="grid-2"><div>';

  html += `<div class="card"><h2>Confirmed roster (${confirmed.length}/${CONFIG.capacity})</h2>`;
  html += confirmed.length ? renderRosterTable(confirmed, false) : `<div class="empty-note">No one confirmed yet.</div>`;
  if (pending.length) {
    html += `<h2 style="margin-top:18px;font-size:16px;">Pending deposit confirmation (${pending.length})</h2>`;
    html += renderRosterTable(pending, true);
  }
  html += `</div></div>`;

  html += `<div><div class="card"><h2>Reserve a seat</h2>
    <div class="venmo-row">
      <div class="sub">Send ${fmtMoney(CONFIG.buyIn)} to <strong>${esc(CONFIG.venmo)}</strong> on Venmo, then submit this form with your name. I'll flip you to "Confirmed" once the payment lands — you're not locked in until you see that. Buy-ins aren't refundable for a no-show.</div>
      <div class="venmo-qr-wrap">
        <img class="venmo-qr" src="venmo.jpg" alt="Venmo QR code for ${esc(CONFIG.venmo)}">
        <div class="venmo-qr-label">Scan to pay</div>
      </div>
    </div>
    <form id="signup-form">
      <div class="field"><label>Name</label><input name="name" required maxlength="40" placeholder="e.g. Edward Lee"></div>
      <div class="field"><label>Message (optional, shown on the roster)</label><input name="message" maxlength="60" placeholder="e.g. bringing a +1, first time playing"></div>
      <div class="field"><label>Note to host (optional, private)</label><input name="note" maxlength="80" placeholder="already sent the $50, etc. — only I see this"></div>
      <button class="btn" type="submit">Submit</button>
    </form>
    <div class="empty-note" style="margin-top:12px;">Just want to deal instead of play? Let me know directly and I'll pencil you in.</div>
    </div>`;
  html += renderHostBox("signup");
  html += `</div></div>`;
  return html;
}

function renderRosterTable(list, pending) {
  const rows = list.map((p) => `<tr>
    <td class="roster-name">${esc(p.name)}</td>
    <td class="roster-note">${p.message ? esc(p.message) : ""}</td>
  </tr>`).join("");
  return `<table class="roster-table"><tbody>${rows}</tbody></table>`;
}
function renderPrizePoolCard() {
  const pot = potTotals();
  return `<div class="countdown-banner">
    <div class="cb-eyebrow">Estimated prize pool</div>
    <div class="cb-num">${fmtMoney(pot.projected)}</div>
    <div class="cb-sub">Buy-in ${fmtMoney(CONFIG.buyIn)} · rebuy ${fmtMoney(CONFIG.rebuyPrice)} (unlimited through Level 4) · top-off ${fmtMoney(CONFIG.topOffPrice)} (one-time, at the first break)</div>
  </div>`;
}
function renderTopRow() {
  const cd = renderCountdownBanner();
  const pool = renderPrizePoolCard();
  if (cd) return `<div class="grid-2 top-row">${cd}${pool}</div>`;
  return `<div class="top-row">${pool}</div>`;
}

function renderHostBox(context) {
  let html = '<div class="card host-box">';
  if (!hostUnlocked) {
    html += `<div class="locked-msg">Host controls are locked.</div>
      <div class="pin-row"><input id="pin-input" type="password" placeholder="Host PIN" maxlength="12">
      <button class="btn secondary" id="unlock-btn">Unlock</button></div></div>`;
    return html;
  }
  html += `<div style="display:flex;justify-content:space-between;align-items:center;">
    <strong style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink-dim);">Host controls</strong>
    <button class="icon-btn" id="lock-btn">Lock</button></div>`;

  if (context === "signup") {
    html += '<div style="margin-top:12px;">';
    SIGNUPS.forEach((p) => {
      html += `<div class="roster-row compact">
        <span><span class="name">${esc(p.name)}</span>${p.message ? `<span class="note">💬 ${esc(p.message)}</span>` : ""}${p.note ? `<span class="note">🔒 ${esc(p.note)}</span>` : ""}</span>
        <span class="pill${p.confirmed ? " on" : " warn"}" data-act="toggle-confirmed" data-id="${p.id}" style="cursor:pointer;">${p.confirmed ? "Confirmed" : "Pending"}</span>
        <button class="icon-btn" data-act="remove" data-id="${p.id}" title="Remove">✕</button>
      </div>`;
    });
    html += "</div>";
    html += `<details style="margin-top:14px;"><summary style="cursor:pointer;font-size:13px;color:var(--ink-dim);">Event settings</summary>${renderEventSettingsForm()}</details>`;
  } else if (context === "live") {
    const confirmed = confirmedList();
    const elimSet = new Set(LIVE.eliminations || []);
    const activeCount = confirmed.filter((p) => !elimSet.has(p.id)).length;
    html += '<div style="margin-top:12px;">';
    if (confirmed.length) {
      html += `<div class="host-section-label">Players</div>`;
      html += `<form id="tally-form">`;
      confirmed.forEach((p) => {
        const isOut = elimSet.has(p.id);
        html += `<div class="roster-row live-row${isOut ? " eliminated" : ""}">
          <span class="name">${esc(p.name)}${isOut ? '<span class="elim-tag">Eliminated</span>' : ""}</span>
          <span class="stepper">Rebuys <button type="button" data-act="rebuy-dec" data-id="${p.id}">−</button>${p.rebuys || 0}<button type="button" data-act="rebuy-inc" data-id="${p.id}">+</button></span>
          <span class="pill${p.topOff ? " on" : ""}" data-act="toggle-topoff" data-id="${p.id}" style="cursor:pointer;">Top-off</span>
          <input class="chip-input" type="number" min="0" step="25" name="chip_${p.id}" value="${LIVE.chipCounts && LIVE.chipCounts[p.id] != null ? LIVE.chipCounts[p.id] : ""}" placeholder="Chips">
          ${isOut
            ? `<button type="button" class="icon-btn" data-act="restore" data-id="${p.id}" title="Restore player">↺</button>`
            : (activeCount > 1 ? `<button type="button" class="icon-btn" data-act="eliminate" data-id="${p.id}" title="Mark eliminated">✕</button>` : "<span></span>")}
        </div>`;
      });
      html += `<button class="btn secondary" type="submit" style="margin-top:12px;">Save chip counts</button></form>`;
    } else {
      html += `<div class="empty-note">No confirmed players yet.</div>`;
    }
    html += "</div>";
  }
  html += "</div>";
  return html;
}

function renderEventSettingsForm() {
  const e = CONFIG;
  return `<form id="settings-form" style="margin-top:12px;">
    <div class="field"><label>Event name</label><input name="name" value="${esc(e.name)}"></div>
    <div class="field"><label>Date &amp; time</label><input type="datetime-local" name="dateISO" value="${esc(e.dateISO)}"></div>
    <div class="field"><label>Location</label><input name="location" value="${esc(e.location)}"></div>
    <div class="field"><label>Venmo handle</label><input name="venmo" value="${esc(e.venmo)}"></div>
    <div class="field"><label>Buy-in ($)</label><input type="number" min="0" name="buyIn" value="${e.buyIn}"></div>
    <div class="field"><label>Rebuy price ($)</label><input type="number" min="0" name="rebuyPrice" value="${e.rebuyPrice}"></div>
    <div class="field"><label>Top-off price ($)</label><input type="number" min="0" name="topOffPrice" value="${e.topOffPrice}"></div>
    <div class="field"><label>Capacity (seats)</label><input type="number" min="2" name="capacity" value="${e.capacity}"></div>
    <div class="field"><label>Host PIN</label><input name="hostPin" maxlength="12" value="${esc(e.hostPin)}"></div>
    <button class="btn secondary" type="submit">Save settings</button>
  </form>`;
}

function renderRulesTab() {
  const e = CONFIG, pot = potTotals();
  const cutoffNum = levelIndexToNumber(FIRST_BREAK_INDEX - 1);
  let html = '<div class="grid-2"><div>';

  html += `<div class="card"><h2>Format</h2>
    <div class="sub">No-Limit Hold'em · standard multi-table tournament, no late registration</div>
    <ul class="rules-list">
      <li>Everyone's seated and playing from Level 1 — no new entrants once cards are in the air.</li>
      <li>Starting stack: <strong>${fmtChips(e.startingStack)}</strong> in chips for the ${fmtMoney(e.buyIn)} buy-in.</li>
      <li><strong>Unlimited rebuys</strong> (${fmtMoney(e.rebuyPrice)} each for a full ${fmtChips(e.rebuyStack)}-chip stack) through the end of Level ${cutoffNum}, while your count is at or below starting stack.</li>
      <li>One-time optional top-off (${fmtMoney(e.topOffPrice)}) at the first break — brings your stack up to, but not past, the ${fmtChips(e.startingStack)} starting stack.</li>
      <li>Top 3 finishers are paid. See the payout split below.</li>
      <li>Buy-ins and rebuys are non-refundable.</li>
    </ul></div>`;

  html += `<div class="card"><h2>Table balancing</h2><ul class="rules-list">
    <li>9 or fewer confirmed players: one table from the start.</li>
    <li>10–18 confirmed players: two tables, split as evenly as possible.</li>
    <li>Once eliminations bring the field to 9 or fewer, combine onto one table — use "Re-shuffle seating" on the Live Day tab.</li>
    <li>Dealer button moves clockwise; deal yourself or rotate the deal each hand, host's call.</li>
  </ul></div>`;

  html += `<div class="card"><h2>House rules</h2><ul class="rules-list">
    <li class="warn-line">The 7-2 game is not on this time.</li>
    <li>Verbal declarations of a raise or call are binding; string bets (pushing chips in more than one motion without declaring) aren't allowed.</li>
    <li>An all-in player is live only for the pot(s) they covered — side pots form for the rest.</li>
  </ul></div>`;

  html += "</div>";

  html += '<div><div class="card"><h2>Payouts</h2>' +
    `<div class="sub">Estimated on the current pool of ${fmtMoney(pot.projected)}</div>` +
    `<div class="payout-row">${payoutCard("1st", 50, pot.projected, true)}${payoutCard("2nd", 30, pot.projected, false)}${payoutCard("3rd", 20, pot.projected, false)}</div></div>`;

  html += `<div class="card"><h2>Blind schedule</h2><div class="sub">${BLIND_LEVELS.filter((l) => !l.brk).length} levels</div>
    <div class="table-scroll"><table class="blinds"><thead><tr><th>Level</th><th>Blinds</th><th>Length</th></tr></thead><tbody>`;
  let levelNum = 0;
  BLIND_LEVELS.forEach((lv, idx) => {
    if (!lv.brk) levelNum++;
    const isCurrent = LIVE && LIVE.phase !== "setup" && LIVE.levelIndex === idx;
    html += `<tr class="${lv.brk ? "brk" : ""}${isCurrent ? " current" : ""}"><td>${lv.brk ? "—" : levelNum}${isCurrent ? ' <span class="now-badge">Now</span>' : ""}</td>
      <td class="num">${levelLabel(lv)}</td><td class="num">${lv.mins} min</td></tr>`;
  });
  html += "</tbody></table></div></div>";

  html += `<div class="card shirt-card"><h2>👀</h2>
    <div class="sub">Dm me.</div>
    <img class="shirt-img" src="shirt.jpeg" alt="Grand Royale Survival Tournament shirt, green tee on a wood floor">
  </div>`;

  html += "</div></div>";
  return html;
}
function payoutCard(place, pct, pool, first) {
  return `<div class="payout-card${first ? " first" : ""}"><div class="place">${place}</div><div class="pct">${pct}%</div><div class="amt">${fmtMoney(pool * pct / 100)}</div></div>`;
}

function renderLiveTab() {
  const confirmed = confirmedList();
  const pot = potTotals();
  let html = "";

  if (LIVE.phase === "setup") {
    html += `<div class="banner info">The clock hasn't started. When everyone's seated and chipped up, hit "Begin tournament" below to shuffle seating and start Level 1 — blinds will advance on their own from there, and the clock will pause automatically at each scheduled break.</div>`;
  }

  const lv = BLIND_LEVELS[LIVE.levelIndex];
  const nextLv = BLIND_LEVELS[LIVE.levelIndex + 1];
  html += `<div class="clock-card${LIVE.phase === "paused" ? " paused" : ""}" id="clock-card">
    <div class="level-badge">${lv.brk ? "Break" : "Level " + levelIndexToNumber(LIVE.levelIndex)}${LIVE.phase === "paused" ? " · Paused" : ""}</div>
    <div class="countdown" id="countdown-num">--:--</div>
    <div class="blinds-now${lv.brk ? " brk-text" : ""}">${levelLabel(lv)}</div>
    ${!lv.brk ? '<div class="blinds-lbl">Blinds</div>' : ""}
    ${nextLv ? `<div class="next-up">Next: ${levelLabel(nextLv)}</div>` : `<div class="next-up">Final scheduled level</div>`}
  </div>`;

  if (hostUnlocked) {
    html += '<div class="btn-row" style="margin-top:14px;">';
    if (LIVE.phase === "setup") {
      html += `<button class="btn gold" id="begin-btn">Begin tournament</button>`;
    } else {
      if (LIVE.phase === "running") html += `<button class="btn secondary" id="pause-btn">Pause</button>`;
      if (LIVE.phase === "paused") html += `<button class="btn" id="resume-btn">Resume</button>`;
      html += `<button class="btn secondary" id="restart-btn">↺ Restart level</button>
        <button class="btn secondary" id="prev-btn">← Prev level</button>
        <button class="btn secondary" id="next-btn">Next level →</button>
        <button class="btn danger" id="reset-btn">Reset tournament</button>`;
    }
    html += "</div>";
  }
  if (LIVE.phase === "paused" && lv.brk) {
    html += `<div class="banner warn" style="margin-top:14px;">${hostUnlocked
      ? "On break — update chip counts below, then hit Resume when you're ready to continue."
      : "On break — the host will resume shortly."}</div>`;
  }

  const remaining = remainingAfterEliminations();
  if (LIVE.seating && LIVE.seating.tables.some((t) => t.ids.length)) {
    if (remaining <= 9 && LIVE.seating.tables.length > 1) {
      html += `<div class="banner warn" style="margin-top:16px;">Down to ${remaining} players — time to combine onto one table.</div>`;
    }
    html += '<div class="table-oval-wrap">';
    LIVE.seating.tables.forEach((t, ti) => {
      const ids = t.ids;
      if (!ids.length) return;
      html += `<div class="table-oval-box"><h3>Table ${ti + 1} · ${ids.length} players</h3><div class="table-oval">`;
      ids.forEach((id) => {
        const p = findPlayer(id);
        if (!p) return;
        const chips = LIVE.chipCounts && LIVE.chipCounts[id] != null ? LIVE.chipCounts[id] : null;
        html += `<div class="seat"><span class="seat-name">${esc(p.name)}</span>${chips != null ? `<span class="seat-chips">${fmtChips(chips)}</span>` : ""}</div>`;
      });
      html += "</div></div>";
    });
    html += "</div>";
  }
  if (hostUnlocked && LIVE.phase !== "setup") {
    html += `<div class="btn-row" style="margin-top:12px;"><button class="btn secondary" id="reshuffle-btn">Re-shuffle seating</button></div>`;
  }

  // Chip tally
  if (LIVE.phase !== "setup") {
    const stillIn = confirmed.filter((p) => (LIVE.eliminations || []).indexOf(p.id) === -1);
    html += `<div class="card" style="margin-top:20px;"><h2>Chip counts</h2>`;
    html += LIVE.chipCountsAt
      ? `<div class="sub">${esc(LIVE.chipCountsLabel || "Last update")} · ${new Date(LIVE.chipCountsAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</div>`
      : `<div class="sub">Not tallied yet — a good moment is any break.</div>`;
    const withCounts = stillIn.filter((p) => LIVE.chipCounts && LIVE.chipCounts[p.id] != null)
      .sort((a, b) => (LIVE.chipCounts[b.id] || 0) - (LIVE.chipCounts[a.id] || 0));
    if (withCounts.length) {
      withCounts.forEach((p, i) => {
        html += `<div class="standings-row"><span class="place-num">${i + 1}</span><span>${esc(p.name)}</span><span class="payout mono">${fmtChips(LIVE.chipCounts[p.id])}</span></div>`;
      });
    } else {
      html += `<div class="empty-note">No chip counts recorded yet.</div>`;
    }
    html += "</div>";
  }

  // Standings (eliminations)
  html += '<div class="card" style="margin-top:20px;"><h2>Standings</h2>';
  if (!confirmed.length) {
    html += `<div class="empty-note">No confirmed players yet.</div>`;
  } else if (LIVE.phase === "setup") {
    html += `<div class="empty-note">Standings and payouts will show up here once the tournament begins.</div>`;
  } else {
    const elim = LIVE.eliminations || [];
    const rows = [];
    if (remaining === 1 && confirmed.length > 1) {
      const winnerId = confirmed.map((p) => p.id).find((id) => elim.indexOf(id) === -1);
      rows.push({ place: 1, id: winnerId });
    }
    for (let i = elim.length - 1; i >= 0; i--) rows.push({ place: confirmed.length - i, id: elim[i] });
    rows.forEach((r) => {
      const p = findPlayer(r.id);
      if (!p) return;
      const top = r.place <= 3;
      const pct = r.place === 1 ? 50 : r.place === 2 ? 30 : r.place === 3 ? 20 : 0;
      html += `<div class="standings-row${top ? " top" : ""}"><span class="place-num">${r.place}</span><span>${esc(p.name)}</span>${top ? `<span class="payout">${fmtMoney(pot.projected * pct / 100)} payout</span>` : ""}</div>`;
    });
    if (remaining > 1) html += `<div class="empty-note" style="margin-top:8px;">${remaining} players still in it.</div>`;
    else if (confirmed.length === 1) html += `<div class="empty-note" style="margin-top:8px;">Only one confirmed player — standings need at least two to mean anything.</div>`;
  }
  html += "</div>";

  html += renderHostBox("live");
  return html;
}

function scrollToCurrentBlind() {
  const row = document.querySelector("table.blinds tr.current");
  const container = document.querySelector(".table-scroll");
  if (row && container) {
    container.scrollTop = row.offsetTop - container.clientHeight / 2 + row.clientHeight / 2;
  }
}

function positionSeats() {
  document.querySelectorAll(".table-oval").forEach((oval) => {
    const seats = oval.querySelectorAll(".seat");
    const n = seats.length;
    seats.forEach((seat, i) => {
      const angle = ((-90 + i * (360 / n)) * Math.PI) / 180;
      seat.style.left = 50 + 42 * Math.cos(angle) + "%";
      seat.style.top = 50 + 40 * Math.sin(angle) + "%";
    });
  });
}
function tickClock() {
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = setInterval(() => {
    const el = $("countdown-num");
    if (!el) return;
    if (LIVE.phase === "running" && LIVE.levelEndsAt) {
      let msLeft = LIVE.levelEndsAt - Date.now();
      if (msLeft < 0) msLeft = 0;
      const totalSec = Math.floor(msLeft / 1000);
      const mm = Math.floor(totalSec / 60), ss = totalSec % 60;
      el.textContent = (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
      const card = $("clock-card");
      if (msLeft === 0 && card) card.style.outline = "3px solid var(--red)";
    } else if (LIVE.phase === "paused" && LIVE.remainingMs != null) {
      const mm = Math.floor(LIVE.remainingMs / 60000), ss = Math.floor((LIVE.remainingMs % 60000) / 1000);
      el.textContent = (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
    }
  }, 250);
}

function tickCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  if (LIVE.phase !== "setup") return;
  const target = new Date(CONFIG.dateISO).getTime();
  if (isNaN(target) || target - Date.now() <= 0) return;
  countdownInterval = setInterval(() => {
    const grid = $("event-countdown");
    if (!grid) { clearInterval(countdownInterval); return; }
    const msLeft = target - Date.now();
    if (msLeft <= 0) { render(); return; }
    const p = msToParts(msLeft);
    $("cd-d").textContent = pad2(p.d);
    $("cd-h").textContent = pad2(p.h);
    $("cd-m").textContent = pad2(p.m);
    $("cd-s").textContent = pad2(p.s);
  }, 1000);
}

function render() {
  if (!CONFIG || !LIVE) return;
  let html = renderHeader();
  html += `<div class="tab-panel${activeTab === "signup" ? " active" : ""}">${activeTab === "signup" ? renderSignupTab() : ""}</div>`;
  html += `<div class="tab-panel${activeTab === "rules" ? " active" : ""}">${activeTab === "rules" ? renderRulesTab() : ""}</div>`;
  html += `<div class="tab-panel${activeTab === "live" ? " active" : ""}">${activeTab === "live" ? renderLiveTab() : ""}</div>`;
  html += `<footer class="note">Final Table — built for ${esc(CONFIG.name)}. Everyone sees the same live board; host controls are PIN-locked.</footer>`;
  $("app").innerHTML = html;
  if (activeTab === "live") { positionSeats(); tickClock(); }
  if (activeTab === "rules") scrollToCurrentBlind();
  tickCountdown();
  wireEvents();
}

function wireEvents() {
  document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => { activeTab = b.dataset.tab; render(); }));

  const sf = $("signup-form");
  if (sf) sf.addEventListener("submit", (ev) => { ev.preventDefault(); submitSignup(sf.name.value, sf.note.value, sf.message.value); sf.reset(); });

  const unlockBtn = $("unlock-btn");
  if (unlockBtn) unlockBtn.addEventListener("click", () => tryUnlock($("pin-input").value));
  const pinInput = $("pin-input");
  if (pinInput) pinInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") tryUnlock(pinInput.value); });
  const lockBtn = $("lock-btn");
  if (lockBtn) lockBtn.addEventListener("click", lockHost);

  document.querySelectorAll('[data-act="toggle-confirmed"]').forEach((el) => el.addEventListener("click", () => toggleConfirmed(el.dataset.id)));
  document.querySelectorAll('[data-act="toggle-topoff"]').forEach((el) => el.addEventListener("click", () => toggleTopOff(el.dataset.id)));
  document.querySelectorAll('[data-act="rebuy-inc"]').forEach((el) => el.addEventListener("click", () => setRebuys(el.dataset.id, 1)));
  document.querySelectorAll('[data-act="rebuy-dec"]').forEach((el) => el.addEventListener("click", () => setRebuys(el.dataset.id, -1)));
  document.querySelectorAll('[data-act="remove"]').forEach((el) => el.addEventListener("click", () => removeSignup(el.dataset.id)));
  document.querySelectorAll('[data-act="eliminate"]').forEach((el) => el.addEventListener("click", () => markEliminated(el.dataset.id)));
  document.querySelectorAll('[data-act="restore"]').forEach((el) => el.addEventListener("click", () => restoreEliminated(el.dataset.id)));

  const settingsForm = $("settings-form");
  if (settingsForm) settingsForm.addEventListener("submit", (ev) => { ev.preventDefault(); saveEventSettings(settingsForm); });

  const tallyForm = $("tally-form");
  if (tallyForm) tallyForm.addEventListener("submit", (ev) => { ev.preventDefault(); saveChipTally(tallyForm); });

  const beginBtn = $("begin-btn"); if (beginBtn) beginBtn.addEventListener("click", beginTournament);
  const pauseBtn = $("pause-btn"); if (pauseBtn) pauseBtn.addEventListener("click", pauseClock);
  const resumeBtn = $("resume-btn"); if (resumeBtn) resumeBtn.addEventListener("click", resumeClock);
  const nextBtn = $("next-btn"); if (nextBtn) nextBtn.addEventListener("click", nextLevel);
  const prevBtn = $("prev-btn"); if (prevBtn) prevBtn.addEventListener("click", prevLevel);
  const restartBtn = $("restart-btn"); if (restartBtn) restartBtn.addEventListener("click", restartLevel);
  const resetBtn = $("reset-btn"); if (resetBtn) resetBtn.addEventListener("click", resetTournament);
  const reshuffleBtn = $("reshuffle-btn"); if (reshuffleBtn) reshuffleBtn.addEventListener("click", generateSeating);
}

setInterval(checkAutoAdvance, 1000);
startListeners();
