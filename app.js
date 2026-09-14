/* Intermedia Job Tracker — app logic (Firebase/Firestore backend). */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore, doc, collection, onSnapshot, query, orderBy, limit,
  setDoc, updateDoc, deleteDoc, addDoc, serverTimestamp, arrayUnion, increment
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

(function(){
"use strict";

/* ============================== constants ============================== */

var STATUS_META = {
  "Task Received":      { c:"--neutral", s:"--neutral-soft" },
  "Figma Design Stage":  { c:"--violet",  s:"--violet-soft" },
  "Development Stage":   { c:"--progress",s:"--progress-soft" },
  "Client Review":       { c:"--warn",    s:"--warn-soft" },
  "Client Revision":     { c:"--critical",s:"--critical-soft" },
  "On Hold":             { c:"--neutral", s:"--neutral-soft" },
  "Completed":           { c:"--good",    s:"--good-soft" },
  "Cancelled":           { c:"--ink-3",   s:"--surface-2" }
};
var TERMINAL_STATUSES = ["Completed", "Cancelled"];
var CAT_FIELD = { design: "timeDesign", development: "timeDevelopment", adminContent: "timeAdminContent" };
var CAT_LABEL = { design: "Design", development: "Development", adminContent: "Admin & Content" };
var AUDIT_QUERY_LIMIT = 500;
var FIELD_LABELS = {
  ticket: "Name", ticketLink: "Ticket link", hubspotLabel: "HubSpot label", hubspotLink: "HubSpot link",
  assetLabel: "Asset label", assetLink: "Asset link", requestor: "Requestor",
  dateRequested: "Date requested", dateNeeded: "Date needed", status: "Status", assignedTo: "Assigned to",
  dateSubmitted: "Date submitted", timeDesign: "Design hrs", timeDevelopment: "Development hrs", timeAdminContent: "Admin & Content hrs"
};

/* ============================== firebase ============================== */

var fbApp = null, db = null;
var fatalError = null;

try {
  if (!firebaseConfig || firebaseConfig.apiKey === "YOUR_API_KEY"){
    fatalError = "firebase-config.js hasn't been filled in yet. Copy firebase-config.sample.js to firebase-config.js and paste in your Firebase project's config values.";
  } else {
    fbApp = initializeApp(firebaseConfig);
    db = getFirestore(fbApp);
  }
} catch (e){
  fatalError = "Could not initialize Firebase: " + (e && e.message ? e.message : e);
}

/* ============================== state ============================== */

// STATE mirrors the live Firestore collections. It's rebuilt (not merged)
// on every snapshot, so it's always a faithful copy of the server — no
// separate "publish" step, no whole-document conflicts.
var STATE = {
  meta: null,
  projects: [],
  tickets: [],
  auditLog: []
};
var LOADED = { meta:false, projects:false, tickets:false, auditLog:false };
var booted = false;
var connError = null;

var UI = {                // ephemeral, per-view UI state (never synced)
  projectId: null,
  view: "active",         // 'active' | 'all'
  search: "",
  statusFilter: "all",
  page: 1,
  pageSize: 50,
  widgetCollapsed: false,
  mode: "none",           // 'none' | 'tracking' | 'admin' — which PIN this device unlocked
  modal: null,            // {type, ...}
  historyOpen: false
};

/* ============================== utils ============================== */

function esc(str){
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, function(c){
    return { "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c];
  });
}
function escAttr(str){ return esc(str); }
function uid(prefix){ return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

function fmtHours(n){
  if (n === null || n === undefined || isNaN(n)) return "—";
  var r = Math.round(n * 100) / 100;
  var s = r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  if (s === "" || s === "-") s = "0";
  return s + "h";
}
function fmtPlainNum(n){
  if (n === null || n === undefined || isNaN(n)) return "";
  var r = Math.round(n * 100) / 100;
  return r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
function fmtDate(iso){
  if (!iso) return null;
  var d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear();
}
function todayISO(){
  var d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function fmtDateTime(iso){
  if (!iso) return "—";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
  var h12 = h % 12; if (h12 === 0) h12 = 12;
  return d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear() + ", " + h12 + ":" + m + (h >= 12 ? " PM" : " AM");
}
function debounce(fn, ms){
  var t = null;
  return function(){
    var args = arguments, ctx = this;
    clearTimeout(t);
    t = setTimeout(function(){ fn.apply(ctx, args); }, ms);
  };
}

function sha256Hex(str){
  var enc = new TextEncoder().encode(str);
  return crypto.subtle.digest("SHA-256", enc).then(function(buf){
    var arr = Array.from(new Uint8Array(buf));
    return arr.map(function(b){ return b.toString(16).padStart(2, "0"); }).join("");
  });
}

function canManage(){ return UI.mode === "admin"; }
function canLogTime(){ return UI.mode === "admin" || UI.mode === "tracking"; }

/* ============================== edit history ============================== */

function logAudit(summary){
  if (!db) return;
  var mode = UI.mode === "admin" ? "admin" : (UI.mode === "tracking" ? "tracking" : "unknown");
  addDoc(collection(db, "auditLog"), { ts: serverTimestamp(), mode: mode, summary: summary })
    .catch(function(e){ console.error("[tracker] failed to log audit entry", e); });
}

function fieldDisplay(v){
  return (v === undefined || v === null || v === "") ? "—" : String(v);
}

function diffTicketFields(oldT, newT){
  var changes = [];
  Object.keys(FIELD_LABELS).forEach(function(k){
    var a = fieldDisplay(oldT ? oldT[k] : undefined);
    var b = fieldDisplay(newT[k]);
    if (a !== b) changes.push(FIELD_LABELS[k] + ": " + a + " → " + b);
  });
  return changes;
}

/* ============================== backup export ============================== */

function backupPayload(){
  return {
    exportedAt: new Date().toISOString(),
    toolName: STATE.meta.toolName,
    agency: STATE.meta.agency,
    client: STATE.meta.client,
    projects: STATE.projects,
    tickets: STATE.tickets
  };
}

function copyBackupToClipboard(){
  var json = JSON.stringify(backupPayload(), null, 2);
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(json).then(function(){
      toast("Backup copied — paste it into a text file to save.", "good");
    }).catch(function(){
      selectBackupTextarea();
      toast("Couldn’t copy automatically — the text below is selected, press Ctrl/Cmd+C.", "error");
    });
  } else {
    selectBackupTextarea();
    toast("Clipboard isn’t available here — the text below is selected, press Ctrl/Cmd+C.", "error");
  }
}

function selectBackupTextarea(){
  var ta = document.getElementById("backup-json");
  if (ta){ ta.focus(); ta.select(); }
}

function securityKey(){ return "edmTracker.security.v2"; }
function readLocalSecurity(){
  try{
    var raw = localStorage.getItem(securityKey());
    if (!raw) return null;
    return JSON.parse(raw);
  }catch(e){ return null; }
}
function writeLocalSecurity(obj){
  try{ localStorage.setItem(securityKey(), JSON.stringify(obj)); }catch(e){}
}
function clearLocalSecurity(){
  try{ localStorage.removeItem(securityKey()); }catch(e){}
}

/* ============================== pool math ============================== */

function poolBundle(pool){
  var t = (pool.topups || []).reduce(function(a,x){ return a + (x.hours||0); }, 0);
  return (pool.initialHours || 0) + t;
}

function newTicketsFor(projectId){
  return STATE.tickets.filter(function(t){ return t.project === projectId && !t.historical; });
}

function activeConsumed(project){
  var extra = newTicketsFor(project.id);
  if (project.pool.mode === "unified"){
    var sum = extra.reduce(function(a,t){
      return a + (t.timeDesign||0) + (t.timeDevelopment||0) + (t.timeAdminContent||0);
    }, 0);
    return project.pool.baselineConsumed + sum;
  }
  var out = {};
  Object.keys(project.pool.categories).forEach(function(catKey){
    var field = CAT_FIELD[catKey];
    var sum = extra.reduce(function(a,t){ return a + (t[field]||0); }, 0);
    out[catKey] = project.pool.categories[catKey].baselineConsumed + sum;
  });
  return out;
}

function healthTone(remaining, bundle){
  if (!bundle || bundle <= 0) return "neutral";
  var ratio = remaining / bundle;
  if (remaining < 0 || ratio < 0.05) return "critical";
  if (ratio < 0.20) return "warn";
  return "good";
}

/* ============================== filtering ============================== */

function projectById(id){
  return STATE.projects.filter(function(p){ return p.id === id; })[0];
}

function filteredTickets(){
  var proj = UI.projectId;
  var list = STATE.tickets.filter(function(t){ return t.project === proj; });
  if (UI.view === "active"){
    list = list.filter(function(t){ return TERMINAL_STATUSES.indexOf(t.status) === -1; });
  }
  if (UI.statusFilter !== "all"){
    list = list.filter(function(t){ return t.status === UI.statusFilter; });
  }
  if (UI.search.trim()){
    var q = UI.search.trim().toLowerCase();
    list = list.filter(function(t){
      return (t.ticket||"").toLowerCase().indexOf(q) !== -1 ||
             (t.requestor||"").toLowerCase().indexOf(q) !== -1 ||
             (t.hubspotLabel||"").toLowerCase().indexOf(q) !== -1;
    });
  }
  // newest first by dateRequested, tickets without a date last
  list = list.slice().sort(function(a,b){
    var da = a.dateRequested || "", db2 = b.dateRequested || "";
    if (da === db2) return (b.id||"").localeCompare(a.id||"");
    return da < db2 ? 1 : -1;
  });
  return list;
}

/* ============================== rendering ============================== */

function render(){
  var root = document.getElementById("app-root");
  if (fatalError){ root.innerHTML = tplFatal(fatalError); return; }
  if (!booted){
    root.innerHTML = connError ? tplFatal(connError, "Can’t connect yet") : tplLoading();
    return;
  }
  root.innerHTML = tplApp();
  wireEvents(root);
}

function tplLoading(){
  return '<div class="app-loading">Loading tracker…</div>';
}

function tplFatal(msg, heading){
  return (
    '<div class="app-fatal"><div class="app-fatal-box"><h2>' + esc(heading || "Tracker isn’t set up yet") + '</h2>' +
    '<p>' + esc(msg) + '</p>' +
    '<p>See <code>README.md</code> in this project for setup steps.</p>' +
    "</div></div>"
  );
}

function tplApp(){
  return (
    tplTopbar() +
    '<div class="main-wrap">' +
      tplBanner() +
      tplToolrow() +
      tplTableCard() +
    '</div>' +
    tplWidget() +
    (UI.modal ? tplModal() : "") +
    '<div class="toast-wrap" id="toast-wrap" aria-live="polite"></div>'
  );
}

function tplBanner(){
  if (connError){
    return '<div class="banner banner-error"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>' +
      esc(connError) + "</div>";
  }
  return "";
}

function tplTopbar(){
  var projects = STATE.projects;
  var tabs = projects.map(function(p){
    return '<button class="tab-btn" role="tab" aria-selected="' + (p.id===UI.projectId) + '" data-act="switch-project" data-id="' + p.id + '">' + esc(p.name) + "</button>";
  }).join("");

  var lockBtn;
  if (UI.mode === "admin"){
    lockBtn = '<button class="lockbtn unlocked" data-act="open-lock-menu" title="Admin mode unlocked on this device">' +
      svgUnlock() + " Admin mode</button>";
  } else if (UI.mode === "tracking"){
    lockBtn = '<button class="lockbtn unlocked tracking" data-act="open-lock-menu" title="Tracking mode unlocked on this device">' +
      svgClock() + " Tracking mode</button>";
  } else {
    lockBtn = '<button class="lockbtn" data-act="open-unlock" title="Enter PIN to edit">' + svgLock() + " Edit mode</button>";
  }

  var mark = STATE.meta.logoDataUri
    ? '<img src="' + STATE.meta.logoDataUri + '" alt="Shore360 Agency">'
    : "S";
  var markClass = STATE.meta.logoDataUri ? "brand-mark has-logo" : "brand-mark";

  return (
    '<div class="topbar"><div class="topbar-inner">' +
      '<div class="brand"><div class="' + markClass + '">' + mark + '</div><div class="brand-text"><h1>Intermedia Job Tracker</h1><span>Shore360 Agency</span></div></div>' +
      '<div class="tabs" role="tablist">' + tabs + "</div>" +
      lockBtn +
    "</div></div>"
  );
}

function svgLock(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'; }
function svgUnlock(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-3.86"/></svg>'; }
function svgSearch(){ return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>'; }
function svgPlus(){ return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>'; }
function svgEdit(){ return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'; }
function svgTrash(){ return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>'; }
function svgClock(){ return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>'; }
function svgChevron(dir){ return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M' + (dir==="down" ? "6 9l6 6 6-6" : "18 15l-6-6-6 6") + '"/></svg>'; }
function svgExternal(){ return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>'; }

function tplToolrow(){
  var opts = ['<option value="all"' + (UI.statusFilter==="all"?" selected":"") + ">All statuses</option>"]
    .concat(STATE.meta.statusList.map(function(s){
      return '<option value="' + escAttr(s) + '"' + (UI.statusFilter===s?" selected":"") + ">" + esc(s) + "</option>";
    })).join("");

  var addBtn = canManage() ? '<button class="btn btn-primary" data-act="open-add-ticket">' + svgPlus() + " New ticket</button>" : "";

  return (
    '<div class="toolrow">' +
      '<div class="search-box">' + svgSearch() + '<input type="text" placeholder="Search ticket, requestor…" value="' + escAttr(UI.search) + '" data-act="search"></div>' +
      '<select data-act="filter-status">' + opts + "</select>" +
      '<div class="tabs" role="tablist" style="margin-left:4px">' +
        '<button class="tab-btn" aria-selected="' + (UI.view==="active") + '" data-act="switch-view" data-view="active">Active</button>' +
        '<button class="tab-btn" aria-selected="' + (UI.view==="all") + '" data-act="switch-view" data-view="all">All tickets</button>' +
      "</div>" +
      '<div style="flex:1"></div>' +
      addBtn +
    "</div>"
  );
}

function tplLink(label, url, fallbackText){
  if (url){
    return '<a class="linklet" href="' + escAttr(url) + '" target="_blank" rel="noopener noreferrer">' +
      esc(label || fallbackText || "Open") + svgExternal() + "</a>";
  }
  if (label){
    return '<span class="linklet empty" title="No link on file">' + esc(label) + "</span>";
  }
  return '<span class="linklet empty">—</span>';
}

function tplStatusCell(t){
  var meta = STATUS_META[t.status] || STATUS_META["Task Received"];
  if (!canManage()){
    return '<span class="badge" style="color:var(' + meta.c + ');background:var(' + meta.s + ')">' +
      '<span class="dot"></span>' + esc(t.status) + "</span>";
  }
  var opts = STATE.meta.statusList.map(function(s){
    var m = STATUS_META[s] || STATUS_META["Task Received"];
    return '<option value="' + escAttr(s) + '"' + (t.status===s?" selected":"") + ">" + esc(s) + "</option>";
  }).join("");
  return '<span class="status-wrap"><select class="status-select" style="color:var(' + meta.c + ');background-color:var(' + meta.s + ')" data-act="set-status" data-id="' + t.id + '">' + opts + '</select><svg class="chevron" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg></span>';
}

function tplAssignedCell(t){
  var list = STATE.meta.assigneeList || [];
  if (!canManage()){
    if (!t.assignedTo){
      return '<span class="assignee unassigned"><span class="avatar">–</span>Unassigned</span>';
    }
    return '<span class="assignee"><span class="avatar">' + esc(t.assignedTo.slice(0,1).toUpperCase()) + '</span>' + esc(t.assignedTo) + "</span>";
  }
  var opts = ['<option value=""' + (!t.assignedTo?" selected":"") + ">Unassigned</option>"]
    .concat(list.map(function(name){
      return '<option value="' + escAttr(name) + '"' + (t.assignedTo===name?" selected":"") + ">" + esc(name) + "</option>";
    })).join("");
  return '<span class="assignee-wrap"><select class="assignee-select" data-act="set-assignee" data-id="' + t.id + '">' + opts + '</select><svg class="chevron" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg></span>';
}

function tplTimeUsedCell(t){
  function line(label, v){
    return v == null ? "" : '<span><i>' + label + '</i><b>' + fmtHours(v) + "</b></span>";
  }
  if (UI.mode === "tracking"){
    var val = t.timeDevelopment == null ? "" : t.timeDevelopment;
    return (
      '<div class="time-used time-used-track">' +
        line("D", t.timeDesign) +
        '<span class="tu-dev-edit"><i>Dv</i><input type="number" inputmode="decimal" step="0.25" min="0" class="dev-time-input" data-act="set-devtime" data-id="' + t.id + '" value="' + escAttr(val) + '" placeholder="0" title="Log development hours"></span>' +
        line("A", t.timeAdminContent) +
      "</div>"
    );
  }
  if (t.timeDesign == null && t.timeDevelopment == null && t.timeAdminContent == null){
    return '<div class="time-used tu-empty">—</div>';
  }
  return '<div class="time-used">' + line("D", t.timeDesign) + line("Dv", t.timeDevelopment) + line("A", t.timeAdminContent) + "</div>";
}

function tplRow(t){
  var actions = canManage() ? (
    '<div class="row-actions">' +
      '<button class="iconbtn" data-act="open-edit-ticket" data-id="' + t.id + '" title="Edit">' + svgEdit() + "</button>" +
      '<button class="iconbtn" data-act="delete-ticket" data-id="' + t.id + '" title="Delete">' + svgTrash() + "</button>" +
    "</div>"
  ) : "";

  var needed = t.dateNeeded ? '<span class="needed">Needed ' + fmtDate(t.dateNeeded) + "</span>" : "";
  var dateReqCell = t.dateRequested ? (fmtDate(t.dateRequested) + needed) : (t.dateRawNote ? esc(t.dateRawNote) : (needed || "—"));

  return (
    '<tr class="' + (t.historical ? "is-historical" : "") + '" data-row-id="' + t.id + '">' +
      '<td class="cell-ticket">' + tplTicketNameCell(t) + "</td>" +
      "<td>" + tplLink(t.hubspotLabel, t.hubspotLink, "HubSpot email") + "</td>" +
      "<td>" + tplLink(t.assetLabel, t.assetLink, "Asset") + "</td>" +
      '<td class="req-name">' + esc(t.requestor || "—") + "</td>" +
      '<td class="datecell">' + dateReqCell + "</td>" +
      "<td>" + tplStatusCell(t) + "</td>" +
      "<td>" + tplAssignedCell(t) + "</td>" +
      '<td class="datecell">' + (t.dateSubmitted ? fmtDate(t.dateSubmitted) : "—") + "</td>" +
      "<td>" + tplTimeUsedCell(t) + "</td>" +
      "<td>" + actions + "</td>" +
    "</tr>"
  );
}

function tplTicketNameCell(t){
  var name = t.ticketLink
    ? '<a class="t-name" title="' + escAttr(t.ticket) + '" href="' + escAttr(t.ticketLink) + '" target="_blank" rel="noopener noreferrer">' + esc(t.ticket) + "</a>"
    : '<span class="t-name" title="' + escAttr(t.ticket) + '">' + esc(t.ticket) + "</span>";
  return name;
}

function tplTableCard(){
  var all = filteredTickets();
  var isAll = UI.view === "all";
  var pageSize = UI.pageSize;
  var totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  var page = Math.min(UI.page, totalPages);
  var pageItems = isAll ? all.slice((page-1)*pageSize, page*pageSize) : all;

  var rows = pageItems.map(tplRow).join("");
  var body = rows || (
    '<tr><td colspan="10"><div class="empty-state"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg><div>No tickets match here.</div></div></td></tr>'
  );

  var pager = isAll && all.length > pageSize ? (
    '<div class="pager">' +
      '<button class="btn btn-sm" data-act="page-prev" ' + (page<=1?"disabled":"") + ">Prev</button>" +
      '<span>Page ' + page + " of " + totalPages + " · " + all.length + " tickets</span>" +
      '<button class="btn btn-sm" data-act="page-next" ' + (page>=totalPages?"disabled":"") + ">Next</button>" +
    "</div>"
  ) : "";

  var heading = isAll ? "All tickets" : "Active tickets";
  var sub = isAll ? "Full history for this project, most recent first." : "Everything still in motion — completed and cancelled tickets are hidden.";

  return (
    '<div class="section-head"><h2>' + heading + '</h2><span class="count">' + all.length + " shown</span></div>" +
    '<p class="section-sub">' + sub + "</p>" +
    '<div class="table-card"><div class="table-scroll"><table class="tix">' +
      "<thead><tr>" +
        "<th>Project ticket</th>" +
        "<th>HubSpot email</th>" +
        "<th>Asset link</th>" +
        "<th>Requestor</th>" +
        "<th>Requested / needed</th>" +
        "<th>Status</th>" +
        "<th>Assigned to</th>" +
        "<th>Submitted</th>" +
        "<th>Time used</th>" +
        '<th><span class="visually-hidden">Actions</span></th>' +
      "</tr></thead>" +
      "<tbody>" + body + "</tbody>" +
    "</table></div>" + pager + "</div>"
  );
}

/* ---------- sticky hours widget ---------- */

function tplWidget(){
  var project = projectById(UI.projectId);
  if (!project) return "";
  var collapsedClass = UI.widgetCollapsed ? " collapsed" : "";

  var pillTone, pillRemaining;
  var body;
  if (project.pool.mode === "unified"){
    var bundle = poolBundle(project.pool);
    var consumed = activeConsumed(project);
    var remaining = bundle - consumed;
    var tone = healthTone(remaining, bundle);
    pillTone = tone; pillRemaining = remaining;
    body = tplHwPool(project.pool.label || "Service hours", consumed, bundle, remaining, tone);
  } else {
    var cats = Object.keys(project.pool.categories);
    var consumedMap = activeConsumed(project);
    var worst = "good";
    var chunks = cats.map(function(catKey){
      var cat = project.pool.categories[catKey];
      var b = poolBundle(cat);
      var c = consumedMap[catKey];
      var r = b - c;
      var tone = healthTone(r, b);
      if (tone === "critical") worst = "critical";
      else if (tone === "warn" && worst !== "critical") worst = "warn";
      return tplHwPool(CAT_LABEL[catKey], c, b, r, tone);
    }).join("");
    pillTone = worst;
    body = chunks;
  }

  var pillLabel = project.pool.mode === "unified"
    ? fmtPlainNum(pillRemaining) + "h left"
    : "hours";

  var addBtn = canManage() ? '<button class="btn btn-sm btn-primary" data-act="open-add-hours" data-project="' + project.id + '" style="flex:1">' + svgPlus() + " Add hours</button>" : "";
  var historyBtn = project.legacyPools && project.legacyPools.length
    ? '<button class="hw-history-link" data-act="open-history" data-project="' + project.id + '">View billing history</button>' : "";

  return (
    '<div class="hours-widget' + collapsedClass + '" id="hours-widget" data-act="' + (UI.widgetCollapsed ? "expand-widget" : "") + '">' +
      '<div class="hw-head">' + svgClock() + '<b>' + esc(project.name) + " — hours</b>" +
      '<span class="hw-pill-num" style="color:var(--' + pillTone + ')">' + esc(pillLabel) + "</span>" +
      '<button class="hw-collapse-btn" data-act="toggle-widget" title="' + (UI.widgetCollapsed?"Expand":"Minimize") + '">' + svgChevron(UI.widgetCollapsed?"down":"up") + "</button>" +
      "</div>" +
      '<div class="hw-body">' + body +
        (addBtn || historyBtn ? '<div class="hw-actions">' + addBtn + "</div>" + historyBtn : "") +
      "</div>" +
    "</div>"
  );
}

function tplHwPool(label, consumed, bundle, remaining, tone){
  var pct = bundle > 0 ? Math.max(0, Math.min(100, (consumed / bundle) * 100)) : 0;
  return (
    '<div class="hw-pool">' +
      '<div class="hw-pool-label"><span>' + esc(label) + "</span></div>" +
      '<div class="hw-bar-track"><div class="hw-bar-fill" style="width:' + pct + "%;background:var(--" + tone + ')"></div></div>' +
      '<div class="hw-nums"><span class="rem" style="color:var(--' + tone + ')">' + fmtHours(remaining) + " left</span>" +
      '<span class="of">' + fmtPlainNum(consumed) + " / " + fmtPlainNum(bundle) + "h used</span></div>" +
    "</div>"
  );
}

/* ---------- modals ---------- */

function tplModal(){
  var m = UI.modal;
  if (!m) return "";
  var inner = "";
  if (m.type === "unlock") inner = tplModalUnlock(m);
  else if (m.type === "lock-menu") inner = tplModalLockMenu(m);
  else if (m.type === "change-pin") inner = tplModalChangePin(m);
  else if (m.type === "ticket-form") inner = tplModalTicketForm(m);
  else if (m.type === "confirm-delete") inner = tplModalConfirmDelete(m);
  else if (m.type === "add-hours") inner = tplModalAddHours(m);
  else if (m.type === "history") inner = tplModalHistory(m);
  else if (m.type === "audit-log") inner = tplModalAuditLog(m);
  else if (m.type === "backup") inner = tplModalBackup(m);
  return '<div class="modal-overlay" data-act="overlay-close">' + inner + "</div>";
}

function tplModalUnlock(m){
  return (
    '<div class="modal modal-sm" data-stop="1"><h3>Unlock edit mode</h3><p class="modal-sub">Enter the team PIN to add or change tickets and hours on this device.</p>' +
    (m.error ? '<div class="modal-err">' + esc(m.error) + "</div>" : "") +
    '<form data-act="submit-unlock">' +
      '<div class="field"><label for="pin-input">PIN</label><input id="pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="12" autofocus></div>' +
      '<div class="modal-actions"><button type="button" class="btn" data-act="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Unlock</button></div>' +
    "</form></div>"
  );
}

function tplModalLockMenu(){
  if (UI.mode === "admin"){
    return (
      '<div class="modal modal-sm" data-stop="1"><h3>Admin mode</h3><p class="modal-sub">This device can add, edit, and delete tickets, and manage service hours.</p>' +
        '<div class="modal-actions" style="justify-content:flex-start; flex-wrap:wrap; gap:8px">' +
          '<button class="btn" data-act="open-change-pin" data-target="admin">Change Admin PIN</button>' +
          '<button class="btn" data-act="open-change-pin" data-target="tracking">Change Tracking PIN</button>' +
        "</div>" +
        '<div class="modal-actions" style="justify-content:flex-start; flex-wrap:wrap; gap:8px">' +
          '<button class="btn" data-act="open-audit-log">Edit history</button>' +
          '<button class="btn" data-act="open-backup">Back up data</button>' +
        "</div>" +
        '<div class="modal-actions" style="justify-content:space-between">' +
          '<button class="btn btn-danger" data-act="lock-device">Lock this device</button>' +
          '<button type="button" class="btn btn-ghost" data-act="close-modal">Close</button>' +
        "</div>" +
      "</div>"
    );
  }
  return (
    '<div class="modal modal-sm" data-stop="1"><h3>Tracking mode</h3><p class="modal-sub">This device can log Development hours on tickets — every other field stays read-only.</p>' +
      '<div class="modal-actions" style="justify-content:space-between">' +
        '<button class="btn btn-danger" data-act="lock-device">Lock this device</button>' +
        '<button type="button" class="btn btn-ghost" data-act="close-modal">Close</button>' +
      "</div>" +
    "</div>"
  );
}

function tplModalChangePin(m){
  var target = m.target === "tracking" ? "tracking" : "admin";
  var title = target === "admin" ? "Change Admin PIN" : "Change Tracking PIN";
  var sub = target === "admin"
    ? "This replaces the Admin PIN for everyone. Other admin devices stay unlocked until they lock out; new devices will need the new PIN."
    : "This replaces the PIN developers use for Tracking mode. Devices already in Tracking mode stay unlocked until they lock out; new devices will need the new PIN.";
  var currentField = target === "admin"
    ? '<div class="field"><label>Current Admin PIN</label><input name="current" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></div>'
    : "";
  return (
    '<div class="modal modal-sm" data-stop="1"><h3>' + title + "</h3><p class=\"modal-sub\">" + sub + "</p>" +
    (m.error ? '<div class="modal-err">' + esc(m.error) + "</div>" : "") +
    '<form data-act="submit-change-pin" data-target="' + target + '">' +
      currentField +
      '<div class="field"><label>New PIN</label><input name="next1" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></div>' +
      '<div class="field"><label>Confirm new PIN</label><input name="next2" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></div>' +
      '<div class="modal-actions"><button type="button" class="btn" data-act="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save PIN</button></div>' +
    "</form></div>"
  );
}

function tplModalConfirmDelete(m){
  var t = STATE.tickets.filter(function(x){ return x.id === m.id; })[0];
  if (!t) return "";
  return (
    '<div class="modal modal-sm" data-stop="1"><h3>Delete this ticket?</h3>' +
    '<p class="modal-sub">“' + esc(t.ticket) + '” will be removed for everyone viewing this tracker. This can’t be undone.</p>' +
    '<div class="modal-actions"><button class="btn" data-act="close-modal">Cancel</button>' +
    '<button class="btn btn-danger" data-act="confirm-delete-ticket" data-id="' + t.id + '">Delete ticket</button></div></div>'
  );
}

function fieldRow(label, name, opts){
  opts = opts || {};
  var type = opts.type || "text";
  var val = opts.value !== undefined && opts.value !== null ? opts.value : "";
  return (
    '<div class="field"><label for="f-' + name + '">' + esc(label) + "</label>" +
    '<input id="f-' + name + '" name="' + name + '" type="' + type + '" value="' + escAttr(val) + '"' + (opts.step ? ' step="' + opts.step + '"' : "") + "></div>"
  );
}

function tplModalTicketForm(m){
  var editing = !!m.id;
  var t = editing ? STATE.tickets.filter(function(x){ return x.id === m.id; })[0] : {
    ticket:"", ticketLink:"", hubspotLabel:"", hubspotLink:"", assetLabel:"", assetLink:"",
    requestor:"", dateRequested: todayISO(), dateNeeded:"", status:"Task Received", assignedTo:"", dateSubmitted:"",
    timeDesign:"", timeDevelopment:"", timeAdminContent:""
  };
  var statusOpts = STATE.meta.statusList.map(function(s){
    return '<option value="' + escAttr(s) + '"' + (t.status===s?" selected":"") + ">" + esc(s) + "</option>";
  }).join("");
  var assigneeOpts = ['<option value=""' + (!t.assignedTo?" selected":"") + ">Unassigned</option>"]
    .concat((STATE.meta.assigneeList||[]).map(function(name){
      return '<option value="' + escAttr(name) + '"' + (t.assignedTo===name?" selected":"") + ">" + esc(name) + "</option>";
    })).join("");

  return (
    '<div class="modal" data-stop="1"><h3>' + (editing ? "Edit ticket" : "New ticket") + "</h3>" +
    '<p class="modal-sub">' + esc(projectById(UI.projectId).name) + "</p>" +
    (m.error ? '<div class="modal-err">' + esc(m.error) + "</div>" : "") +
    '<form data-act="submit-ticket-form" data-id="' + (editing ? m.id : "") + '">' +
      fieldRow("Project ticket", "ticket", { value: t.ticket }) +
      fieldRow("Ticket link (optional)", "ticketLink", { type:"url", value: t.ticketLink }) +
      '<div class="field-row">' + fieldRow("HubSpot email label", "hubspotLabel", { value: t.hubspotLabel }) + fieldRow("HubSpot email link", "hubspotLink", { type:"url", value: t.hubspotLink }) + "</div>" +
      '<div class="field-row">' + fieldRow("Asset label", "assetLabel", { value: t.assetLabel }) + fieldRow("Asset link (Figma / files)", "assetLink", { type:"url", value: t.assetLink }) + "</div>" +
      fieldRow("Requestor", "requestor", { value: t.requestor }) +
      '<div class="field-row">' + fieldRow("Date requested", "dateRequested", { type:"date", value: t.dateRequested }) + fieldRow("Date needed", "dateNeeded", { type:"date", value: t.dateNeeded }) + "</div>" +
      '<div class="field-row">' +
        '<div class="field"><label for="f-status">Current status</label><select id="f-status" name="status">' + statusOpts + "</select></div>" +
        '<div class="field"><label for="f-assignedTo">Assigned to</label><select id="f-assignedTo" name="assignedTo">' + assigneeOpts + "</select></div>" +
      "</div>" +
      fieldRow("Date submitted", "dateSubmitted", { type:"date", value: t.dateSubmitted }) +
      '<div class="field-row3">' +
        fieldRow("Design (hrs)", "timeDesign", { type:"number", step:"0.25", value: t.timeDesign }) +
        fieldRow("Development (hrs)", "timeDevelopment", { type:"number", step:"0.25", value: t.timeDevelopment }) +
        fieldRow("Admin & Content (hrs)", "timeAdminContent", { type:"number", step:"0.25", value: t.timeAdminContent }) +
      "</div>" +
      (editing && t.historical ? '<p class="field-hint">This is an imported record — its hours are already counted in the starting balance, so editing them here won’t change the hours widget.</p>' : "") +
      '<div class="modal-actions"><button type="button" class="btn" data-act="close-modal">Cancel</button><button type="submit" class="btn btn-primary">' + (editing?"Save changes":"Create ticket") + "</button></div>" +
    "</form></div>"
  );
}

function tplModalAddHours(m){
  var project = projectById(m.project);
  var catField = "";
  if (project.pool.mode === "split"){
    var opts = Object.keys(project.pool.categories).map(function(k){
      return '<option value="' + k + '">' + esc(CAT_LABEL[k]) + "</option>";
    }).join("");
    catField = '<div class="field"><label for="f-cat">Category</label><select id="f-cat" name="category">' + opts + "</select></div>";
  }
  return (
    '<div class="modal modal-sm" data-stop="1"><h3>Add service hours</h3><p class="modal-sub">' + esc(project.name) + " — logs a top-up once the current bundle runs low.</p>" +
    (m.error ? '<div class="modal-err">' + esc(m.error) + "</div>" : "") +
    '<form data-act="submit-add-hours" data-project="' + project.id + '">' +
      catField +
      '<div class="field-row">' +
        '<div class="field"><label for="f-hours">Hours to add</label><input id="f-hours" name="hours" type="number" step="0.25" min="0.25" value="10" required></div>' +
        '<div class="field"><label for="f-date">Date</label><input id="f-date" name="date" type="date" value="' + todayISO() + '"></div>' +
      "</div>" +
      '<div class="field"><label for="f-label">Note (optional)</label><input id="f-label" name="label" type="text" placeholder="e.g. Client purchased extra hours"></div>' +
      '<div class="modal-actions"><button type="button" class="btn" data-act="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Add hours</button></div>' +
    "</form></div>"
  );
}

function tplModalHistory(m){
  var project = projectById(m.project);
  var pools = project.legacyPools || [];
  var rows = pools.map(function(lp){
    var catKeys = Object.keys(lp.categories);
    var totalConsumed = catKeys.reduce(function(a,k){ return a + (lp.categories[k].baselineConsumed || 0); }, 0);
    var totalBundle = catKeys.reduce(function(a,k){ return a + poolBundle(lp.categories[k]); }, 0);
    var combined = '<div class="legacy-cat"><span>Service hours</span><b>' + fmtPlainNum(totalConsumed) + " / " + fmtPlainNum(totalBundle) + "h used</b></div>";
    return '<div class="legacy-pool"><h4>' + esc(lp.label) + "</h4>" + combined + "</div>";
  }).join("");

  // current pool, for completeness
  var current = "";
  if (project.pool.mode === "unified"){
    var bundle = poolBundle(project.pool);
    current = '<div class="legacy-pool"><h4>Current — ' + esc(project.pool.label) + '</h4><div class="legacy-cat"><span>Started ' + fmtDate(project.pool.initialDate) + "</span><b>" + fmtPlainNum(project.pool.baselineConsumed) + " used as of import</b></div></div>";
  }

  return (
    '<div class="modal" data-stop="1"><h3>Billing history</h3><p class="modal-sub">' + esc(project.name) + " — closed hour bands, read-only.</p>" +
    '<div class="legacy-list">' + current + rows + "</div>" +
    '<div class="modal-actions"><button class="btn btn-primary" data-act="close-modal">Close</button></div></div>'
  );
}

function tplModalAuditLog(){
  var log = STATE.auditLog || [];
  var shown = log.slice(0, 200);
  var rows = shown.map(function(e){
    var modeClass = e.mode === "admin" ? "al-admin" : (e.mode === "tracking" ? "al-tracking" : "");
    var modeLabel = e.mode === "admin" ? "Admin" : (e.mode === "tracking" ? "Tracking" : "—");
    return (
      '<div class="al-row">' +
        '<span class="al-badge ' + modeClass + '">' + modeLabel + "</span>" +
        '<div class="al-body"><div class="al-summary">' + esc(e.summary) + '</div><div class="al-ts">' + fmtDateTime(e.ts) + "</div></div>" +
      "</div>"
    );
  }).join("");
  return (
    '<div class="modal modal-lg" data-stop="1"><h3>Edit history</h3>' +
    '<p class="modal-sub">' + (log.length ? ("Showing the most recent " + shown.length + " of " + log.length + " changes, newest first.") : "No edits logged yet.") + " Kept automatically — Admin-mode and Tracking-mode changes both appear here." + "</p>" +
    '<div class="al-list">' + (rows || '<p class="field-hint" style="padding:12px">Nothing to show yet — changes made from here on will show up in this list.</p>') + "</div>" +
    '<div class="modal-actions"><button class="btn btn-primary" data-act="close-modal">Close</button></div></div>'
  );
}

function tplModalBackup(){
  var count = (STATE.tickets || []).length;
  var json = JSON.stringify(backupPayload(), null, 2);
  return (
    '<div class="modal modal-lg" data-stop="1"><h3>Back up your data</h3>' +
    '<p class="modal-sub">Every ticket and hour balance across both projects (' + count + ' tickets), as plain text. Click “Copy to clipboard” and paste it into a text file, or click into the box below, select all, and copy by hand — either way, keep the file somewhere safe. (Your real backup is Firestore itself — this is a quick point-in-time export.)</p>' +
    '<div class="modal-actions" style="justify-content:flex-start; gap:8px; margin-top:0; margin-bottom:12px">' +
      '<button class="btn btn-primary" data-act="copy-backup">Copy to clipboard</button>' +
    "</div>" +
    '<textarea id="backup-json" class="backup-textarea" readonly onclick="this.select()">' + esc(json) + "</textarea>" +
    '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-act="close-modal">Close</button></div></div>'
  );
}

/* ============================== toasts ============================== */

function toast(msg, kind){
  var wrap = document.getElementById("toast-wrap");
  if (!wrap) return;
  var el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " toast-error" : kind === "good" ? " toast-good" : "");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(function(){ el.remove(); }, 3200);
}

/* ============================== mutation helpers (Firestore writes) ============================== */

function ticketPayloadFrom(data){
  return {
    ticket: (data.ticket || "").trim() || "Untitled ticket",
    ticketLink: (data.ticketLink || "").trim() || null,
    hubspotLabel: (data.hubspotLabel || "").trim() || null,
    hubspotLink: (data.hubspotLink || "").trim() || null,
    assetLabel: (data.assetLabel || "").trim() || null,
    assetLink: (data.assetLink || "").trim() || null,
    requestor: (data.requestor || "").trim() || null,
    dateRequested: data.dateRequested || null,
    dateNeeded: data.dateNeeded || null,
    status: data.status || "Task Received",
    assignedTo: (data.assignedTo || "").trim() || null,
    dateSubmitted: data.dateSubmitted || null,
    timeDesign: data.timeDesign === "" || data.timeDesign === undefined ? null : parseFloat(data.timeDesign),
    timeAdminContent: data.timeAdminContent === "" || data.timeAdminContent === undefined ? null : parseFloat(data.timeAdminContent),
    timeDevelopment: data.timeDevelopment === "" || data.timeDevelopment === undefined ? null : parseFloat(data.timeDevelopment)
  };
}

function writeFailed(e){
  console.error("[tracker] write failed", e);
  toast("Could not save your change — check your connection and try again.", "error");
}

/* ============================== events ============================== */

function closeModal(){ UI.modal = null; render(); }

function handleScroll(){
  var shouldCollapse = window.scrollY > 80;
  if (shouldCollapse !== UI.widgetCollapsed){
    UI.widgetCollapsed = shouldCollapse;
    var w = document.getElementById("hours-widget");
    if (w) w.classList.toggle("collapsed", shouldCollapse);
  }
}

function wireEvents(root){
  root.querySelectorAll("[data-act]").forEach(function(el){
    var act = el.getAttribute("data-act");
    if (el.tagName === "FORM"){
      el.addEventListener("submit", function(ev){ ev.preventDefault(); onFormSubmit(act, el); });
      return;
    }
    if (act === "search" || act === "filter-status") return; // wired separately below
    if (act === "overlay-close"){
      el.addEventListener("mousedown", function(ev){ if (ev.target === el) closeModal(); });
      return;
    }
    el.addEventListener("click", function(ev){ onClick(act, el, ev); });
  });

  var searchEl = root.querySelector('[data-act="search"]');
  if (searchEl){
    searchEl.addEventListener("input", debounce(function(){
      UI.search = searchEl.value;
      UI.page = 1;
      render();
      var again = document.querySelector('[data-act="search"]');
      if (again){ again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    }, 220));
  }
  var filterEl = root.querySelector('[data-act="filter-status"]');
  if (filterEl){
    filterEl.addEventListener("change", function(){
      UI.statusFilter = filterEl.value; UI.page = 1; render();
    });
  }
  root.querySelectorAll('[data-act="set-status"]').forEach(function(sel){
    sel.addEventListener("change", function(){
      var t = STATE.tickets.filter(function(x){ return x.id === sel.getAttribute("data-id"); })[0];
      if (!t) return;
      var old = t.status;
      var next = sel.value;
      if (old === next) return;
      updateDoc(doc(db, "tickets", t.id), { status: next }).then(function(){
        logAudit('"' + t.ticket + '": status ' + fieldDisplay(old) + " → " + fieldDisplay(next));
      }).catch(writeFailed);
    });
  });
  root.querySelectorAll('[data-act="set-assignee"]').forEach(function(sel){
    sel.addEventListener("change", function(){
      var t = STATE.tickets.filter(function(x){ return x.id === sel.getAttribute("data-id"); })[0];
      if (!t) return;
      var old = t.assignedTo;
      var next = sel.value || null;
      if (old === next) return;
      updateDoc(doc(db, "tickets", t.id), { assignedTo: next }).then(function(){
        logAudit('"' + t.ticket + '": assigned to ' + fieldDisplay(next) + " (was " + fieldDisplay(old) + ")");
      }).catch(writeFailed);
    });
  });
  root.querySelectorAll('[data-act="set-devtime"]').forEach(function(inp){
    inp.addEventListener("change", function(){
      var t = STATE.tickets.filter(function(x){ return x.id === inp.getAttribute("data-id"); })[0];
      if (!t) return;
      var old = t.timeDevelopment;
      var v = inp.value.trim();
      var n = v === "" ? null : parseFloat(v);
      var next = (n === null || isNaN(n)) ? null : Math.max(0, n);
      if (old === next) return;
      updateDoc(doc(db, "tickets", t.id), { timeDevelopment: next }).then(function(){
        logAudit('"' + t.ticket + '": development hrs ' + fieldDisplay(old) + " → " + fieldDisplay(next));
        toast("Development time saved.", "good");
      }).catch(writeFailed);
    });
  });
  root.querySelectorAll(".modal[data-stop]").forEach(function(m){
    m.addEventListener("mousedown", function(ev){ ev.stopPropagation(); });
  });
}

var ADMIN_ONLY_ACTS = ["open-add-ticket","open-add-hours","open-edit-ticket","delete-ticket","open-change-pin","open-audit-log","open-backup","copy-backup"];

function onClick(act, el){
  if (!canManage() && ADMIN_ONLY_ACTS.indexOf(act) !== -1){
    toast("Switch to Admin mode to do this.", "error");
    return;
  }
  switch(act){
    case "switch-project":
      UI.projectId = el.getAttribute("data-id"); UI.page = 1; UI.historyOpen=false; render(); break;
    case "switch-view":
      UI.view = el.getAttribute("data-view"); UI.page = 1; render(); break;
    case "page-prev": UI.page = Math.max(1, UI.page - 1); render(); break;
    case "page-next": UI.page = UI.page + 1; render(); break;
    case "toggle-widget":
      UI.widgetCollapsed = !UI.widgetCollapsed; render(); break;
    case "expand-widget":
      if (UI.widgetCollapsed){ UI.widgetCollapsed = false; render(); } break;
    case "open-unlock": UI.modal = { type:"unlock" }; render(); break;
    case "open-lock-menu": UI.modal = { type:"lock-menu" }; render(); break;
    case "open-change-pin": UI.modal = { type:"change-pin", target: el.getAttribute("data-target") }; render(); break;
    case "lock-device":
      clearLocalSecurity(); UI.mode = "none"; UI.modal = null; render();
      toast("Locked on this device."); break;
    case "close-modal": closeModal(); break;
    case "open-add-ticket": UI.modal = { type:"ticket-form" }; render(); break;
    case "open-edit-ticket": UI.modal = { type:"ticket-form", id: el.getAttribute("data-id") }; render(); break;
    case "delete-ticket": UI.modal = { type:"confirm-delete", id: el.getAttribute("data-id") }; render(); break;
    case "confirm-delete-ticket":
      var delId = el.getAttribute("data-id");
      var delT = STATE.tickets.filter(function(x){ return x.id === delId; })[0];
      UI.modal = null; render();
      deleteDoc(doc(db, "tickets", delId)).then(function(){
        if (delT) logAudit('Deleted ticket "' + delT.ticket + '"');
        toast("Ticket deleted.");
      }).catch(writeFailed);
      break;
    case "open-add-hours": UI.modal = { type:"add-hours", project: el.getAttribute("data-project") }; render(); break;
    case "open-history": UI.modal = { type:"history", project: el.getAttribute("data-project") }; render(); break;
    case "open-audit-log": UI.modal = { type:"audit-log" }; render(); break;
    case "open-backup": UI.modal = { type:"backup" }; render(); break;
    case "copy-backup": copyBackupToClipboard(); break;
    default: break;
  }
}

function onFormSubmit(act, form){
  if (act === "submit-unlock"){
    var pin = form.querySelector("#pin-input").value.trim();
    sha256Hex(pin).then(function(hash){
      if (hash === STATE.meta.adminPinHash){
        writeLocalSecurity({ mode:"admin", version: STATE.meta.adminSecurityVersion });
        UI.mode = "admin"; UI.modal = null; render();
        toast("Admin mode unlocked on this device.", "good");
      } else if (hash === STATE.meta.trackingPinHash){
        writeLocalSecurity({ mode:"tracking", version: STATE.meta.trackingSecurityVersion });
        UI.mode = "tracking"; UI.modal = null; render();
        toast("Tracking mode unlocked on this device.", "good");
      } else {
        UI.modal = { type:"unlock", error:"That PIN doesn’t match either mode. Try again." }; render();
      }
    });
    return;
  }
  if (act === "submit-change-pin"){
    var target = form.getAttribute("data-target") === "tracking" ? "tracking" : "admin";
    var n1 = form.querySelector('[name="next1"]').value.trim();
    var n2 = form.querySelector('[name="next2"]').value.trim();
    if (target === "tracking"){
      if (!n1 || n1 !== n2){
        UI.modal = { type:"change-pin", target:"tracking", error:"New PIN entries don’t match." }; render(); return;
      }
      sha256Hex(n1).then(function(newHash){
        updateDoc(doc(db, "meta", "config"), {
          trackingPinHash: newHash,
          trackingSecurityVersion: increment(1)
        }).then(function(){
          logAudit("Tracking PIN changed");
          UI.modal = null; render();
          toast("Tracking PIN updated.", "good");
        }).catch(writeFailed);
      });
      return;
    }
    var cur = form.querySelector('[name="current"]').value.trim();
    sha256Hex(cur).then(function(hash){
      if (hash !== STATE.meta.adminPinHash){
        UI.modal = { type:"change-pin", target:"admin", error:"Current Admin PIN is incorrect." }; render(); return;
      }
      if (!n1 || n1 !== n2){
        UI.modal = { type:"change-pin", target:"admin", error:"New PIN entries don’t match." }; render(); return;
      }
      sha256Hex(n1).then(function(newHash){
        var newVersion = (STATE.meta.adminSecurityVersion || 1) + 1;
        updateDoc(doc(db, "meta", "config"), {
          adminPinHash: newHash,
          adminSecurityVersion: increment(1)
        }).then(function(){
          writeLocalSecurity({ mode:"admin", version: newVersion });
          logAudit("Admin PIN changed");
          UI.modal = null; render();
          toast("Admin PIN updated.", "good");
        }).catch(writeFailed);
      });
    });
    return;
  }
  if (act === "submit-ticket-form"){
    var fd = new FormData(form);
    var data = {}; fd.forEach(function(v,k){ data[k] = v; });
    var id = form.getAttribute("data-id") || null;
    if (!data.ticket || !data.ticket.trim()){
      UI.modal = Object.assign({}, UI.modal, { error:"Give the ticket a name." }); render(); return;
    }
    var payload = ticketPayloadFrom(data);
    if (id){
      var oldSnapshot = STATE.tickets.filter(function(x){ return x.id === id; })[0];
      updateDoc(doc(db, "tickets", id), payload).then(function(){
        var newSnap = Object.assign({}, oldSnapshot, payload);
        var changes = diffTicketFields(oldSnapshot, newSnap);
        if (changes.length){
          logAudit('Edited "' + newSnap.ticket + '": ' + changes.slice(0,4).join("; ") + (changes.length > 4 ? "; +" + (changes.length - 4) + " more field(s)" : ""));
        }
        toast("Ticket updated.", "good");
      }).catch(writeFailed);
    } else {
      var newId = uid(UI.projectId);
      var newTicket = Object.assign({ project: UI.projectId, historical:false }, payload);
      setDoc(doc(db, "tickets", newId), newTicket).then(function(){
        logAudit('Created ticket "' + newTicket.ticket + '"');
        toast("Ticket created.", "good");
      }).catch(writeFailed);
    }
    UI.modal = null; render();
    return;
  }
  if (act === "submit-add-hours"){
    var fd2 = new FormData(form);
    var hours = parseFloat(fd2.get("hours"));
    if (!hours || hours <= 0){
      UI.modal = Object.assign({}, UI.modal, { error:"Enter a positive number of hours." }); render(); return;
    }
    var projectId = form.getAttribute("data-project");
    var project = projectById(projectId);
    var entry = { date: fd2.get("date") || todayISO(), hours: hours, label: (fd2.get("label")||"").trim() || "Top up" };
    var catLabel = "";
    var updatePayload = {};
    if (project.pool.mode === "unified"){
      updatePayload["pool.topups"] = arrayUnion(entry);
    } else {
      var cat = fd2.get("category");
      catLabel = " (" + CAT_LABEL[cat] + ")";
      updatePayload["pool.categories." + cat + ".topups"] = arrayUnion(entry);
    }
    updateDoc(doc(db, "projects", projectId), updatePayload).then(function(){
      logAudit("Added " + fmtPlainNum(hours) + "h" + catLabel + " to " + project.name + ' — "' + entry.label + '"');
      toast("Hours added.", "good");
    }).catch(writeFailed);
    UI.modal = null; render();
    return;
  }
}

/* ============================== Firestore sync ============================== */

function afterSnapshot(){
  if (!booted){
    if (!(LOADED.meta && LOADED.projects && LOADED.tickets && LOADED.auditLog)) return;
    fatalError = null;
    if (!STATE.meta){
      fatalError = "No meta/config document found in Firestore yet. Run the seed script (scripts/seed.js) described in README.md, then reload this page.";
      render();
      return; // stay un-booted — a later snapshot (once seeded) re-runs this check
    }
    if (!STATE.projects.length){
      fatalError = "No documents found in the \"projects\" collection yet. Run the seed script (scripts/seed.js) described in README.md, then reload this page.";
      render();
      return;
    }
    UI.projectId = STATE.projects[0].id;
    var stored = readLocalSecurity();
    if (stored && stored.mode === "admin" && stored.version === STATE.meta.adminSecurityVersion){
      UI.mode = "admin";
    } else if (stored && stored.mode === "tracking" && stored.version === STATE.meta.trackingSecurityVersion){
      UI.mode = "tracking";
    } else {
      UI.mode = "none";
    }
    booted = true;
    render();
    return;
  }
  render();
}

function handleSnapshotError(err){
  console.error("[tracker] Firestore error", err);
  if (err && err.code === "permission-denied"){
    connError = "Firestore denied read/write access — check that firestore.rules has been deployed to your project (see README.md).";
  } else {
    connError = "Lost connection to the live database — showing the last data received. Reconnecting…";
  }
  render();
}

function startListeners(){
  onSnapshot(doc(db, "meta", "config"), function(snap){
    STATE.meta = snap.exists() ? snap.data() : null;
    LOADED.meta = true;
    connError = null;
    afterSnapshot();
  }, handleSnapshotError);

  onSnapshot(collection(db, "projects"), function(snap){
    STATE.projects = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
      .sort(function(a,b){ return (a.order||0) - (b.order||0); });
    LOADED.projects = true;
    connError = null;
    afterSnapshot();
  }, handleSnapshotError);

  onSnapshot(collection(db, "tickets"), function(snap){
    STATE.tickets = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
    LOADED.tickets = true;
    connError = null;
    afterSnapshot();
  }, handleSnapshotError);

  onSnapshot(query(collection(db, "auditLog"), orderBy("ts", "desc"), limit(AUDIT_QUERY_LIMIT)), function(snap){
    STATE.auditLog = snap.docs.map(function(d){
      var data = d.data();
      var ts = data.ts && typeof data.ts.toDate === "function" ? data.ts.toDate().toISOString() : (data.ts || null);
      return { id: d.id, mode: data.mode, summary: data.summary, ts: ts };
    });
    LOADED.auditLog = true;
    connError = null;
    afterSnapshot();
  }, handleSnapshotError);
}

/* ============================== init ============================== */

function init(){
  render(); // shows the loading (or fatal-config) screen immediately
  if (fatalError) return;

  window.addEventListener("scroll", handleScroll, { passive:true });
  startListeners();

  // Safety net: if Firestore never calls us back at all (success or error) —
  // e.g. the project ID in firebase-config.js doesn't exist, or something
  // network-level is blocking it — don't sit on "Loading tracker…" forever.
  setTimeout(function(){
    if (!booted && !fatalError && !connError){
      connError = "Still nothing back from Firestore after 10 seconds. Double-check the values in firebase-config.js match your Firebase project exactly, and that Firestore Database is enabled in that project.";
      render();
    }
  }, 10000);
}

if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

})();