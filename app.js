// Commonplace — local-first reading-retention app.
// All data lives in localStorage on this device only. No accounts, no server.

(() => {
  "use strict";

  const STORAGE_KEY = "commonplace_data_v1";
  const STOPWORDS = new Set("a an the and or but of to in on at for with is are was were be been being this that these those i you he she it we they my your his her its our their as not no so if than then just very much more most one two first last also into about over under again out up down".split(" "));

  // ---------- utils ----------
  function uid(prefix) { return prefix + Math.random().toString(36).slice(2, 9); }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function formatDate(d) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function tokenize(text) {
    return new Set(
      String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter(w => w.length > 2 && !STOPWORDS.has(w))
    );
  }
  function jaccard(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }
  function pairKey(aEntryId, bEntryId) {
    return [aEntryId, bEntryId].sort().join("::");
  }

  // ---------- storage ----------
  function emptyData() { return { books: [], links: [] }; }
  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { console.warn("Could not read local data, starting fresh.", e); }
    const fresh = emptyData();
    saveData(fresh);
    return fresh;
  }
  function saveData(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  // ---------- images (IndexedDB — localStorage is too small for photos) ----------
  const IMG_DB_NAME = "commonplace_images", IMG_STORE = "images";
  function openImgDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IMG_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(IMG_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function saveImageBlob(id, blob) {
    const db = await openImgDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMG_STORE, "readwrite");
      tx.objectStore(IMG_STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function loadImageBlob(id) {
    const db = await openImgDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(IMG_STORE, "readonly").objectStore(IMG_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function deleteImageBlob(id) {
    if (!id) return;
    const db = await openImgDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMG_STORE, "readwrite");
      tx.objectStore(IMG_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  // Resize client-side so a phone photo doesn't blow past a sane per-image size.
  function resizeImageFile(file, maxDim = 1000, quality = 0.72) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => { URL.revokeObjectURL(url); blob ? resolve(blob) : reject(new Error("resize failed")); }, "image/jpeg", quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not read image")); };
      img.src = url;
    });
  }

  let data = loadData();
  const ui = { view: "home", bookId: null, connTab: "map", pickerOpen: false, resurfaceDismissed: false, quickAddOpen: false, search: "", tagType: "theme", resurfaceKey: null };

  // ---------- data helpers ----------
  function findBook(id) { return data.books.find(b => b.id === id); }
  function allEntries() {
    const out = [];
    for (const book of data.books) for (const entry of book.entries) out.push({ book, entry });
    return out;
  }

  // ---------- suggestions / connections ----------
  function decidedPairs() {
    const m = new Map();
    for (const link of data.links) m.set(pairKey(link.aEntryId, link.bEntryId), link);
    return m;
  }
  function computeSuggestions() {
    const entries = allEntries();
    const decided = decidedPairs();
    const scored = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const A = entries[i], B = entries[j];
        if (A.entry.id === B.entry.id && A.book.id === B.book.id) continue;
        if (decided.has(pairKey(A.entry.id, B.entry.id))) continue;
        const sim = jaccard(tokenize(A.entry.keep + " " + A.entry.connection), tokenize(B.entry.keep + " " + B.entry.connection));
        if (sim >= 0.12) scored.push({ a: A, b: B, similarity: sim });
      }
    }
    scored.sort((x, y) => y.similarity - x.similarity);
    return scored.slice(0, 8).map(s => ({
      id: pairKey(s.a.entry.id, s.b.entry.id),
      aBookId: s.a.book.id, aEntryId: s.a.entry.id, aBook: s.a.book.title, aExcerpt: s.a.entry.keep,
      bBookId: s.b.book.id, bEntryId: s.b.entry.id, bBook: s.b.book.title, bExcerpt: s.b.entry.keep,
      similarity: s.similarity
    }));
  }
  function confirmedLinks() {
    return data.links.filter(l => l.status === "confirmed").map(l => {
      const A = findBook(l.aBookId), B = findBook(l.bBookId);
      const ea = A?.entries.find(e => e.id === l.aEntryId), eb = B?.entries.find(e => e.id === l.bEntryId);
      if (!A || !B || !ea || !eb) return null;
      return { id: l.id, aBookId: A.id, aEntryId: ea.id, aBook: A.title, aExcerpt: ea.keep, bBookId: B.id, bEntryId: eb.id, bBook: B.title, bExcerpt: eb.keep };
    }).filter(Boolean);
  }
  function decideLink(aEntryId, bEntryId, aBookId, bBookId, status) {
    data.links.push({ id: uid("l"), aBookId, aEntryId, bBookId, bEntryId, status });
    saveData(data);
  }
  function neighborsOf(entryId) {
    return confirmedLinks().filter(l => l.aEntryId === entryId || l.bEntryId === entryId)
      .map(l => l.aEntryId === entryId ? { book: l.bBook, excerpt: l.bExcerpt } : { book: l.aBook, excerpt: l.aExcerpt });
  }

  // ---------- graph layout (for the Map view) ----------
  function buildGraph() {
    const pending = computeSuggestions();
    const confirmed = confirmedLinks();
    const active = [...confirmed.map(c => ({ ...c, status: "confirmed" })), ...pending.map(p => ({ ...p, status: "pending" }))];
    if (active.length === 0) return { nodes: [], edges: [] };
    const nodeMap = new Map();
    const key = (bookId, entryId) => bookId + "::" + entryId;
    function ensure(bookId, entryId, book, excerpt) {
      const k = key(bookId, entryId);
      if (!nodeMap.has(k)) nodeMap.set(k, { key: k, book, excerpt, degree: 0 });
      return nodeMap.get(k);
    }
    active.forEach(s => { ensure(s.aBookId, s.aEntryId, s.aBook, s.aExcerpt).degree++; ensure(s.bBookId, s.bEntryId, s.bBook, s.bExcerpt).degree++; });
    const nodes = Array.from(nodeMap.values());
    const n = nodes.length, cx = 190, cy = 160, R = n <= 1 ? 0 : 110;
    nodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i / n) - Math.PI / 2;
      node.x = cx + R * Math.cos(angle); node.y = cy + R * Math.sin(angle);
    });
    const edges = active.map((s, i) => {
      const a = nodeMap.get(key(s.aBookId, s.aEntryId)), b = nodeMap.get(key(s.bBookId, s.bEntryId));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len, ny = dx / len, bend = 20;
      const qx = mx + nx * bend, qy = my + ny * bend;
      const confirmedEdge = s.status === "confirmed";
      return { d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`, stroke: confirmedEdge ? "var(--color-accent-2-600)" : "var(--color-accent-600)", dash: confirmedEdge ? "0" : "5 6" };
    });
    const graphNodes = nodes.map(node => {
      const r = Math.min(6 + node.degree * 1.5, 12);
      const label = node.excerpt.length > 26 ? node.excerpt.slice(0, 26) + "…" : node.excerpt;
      return { x: node.x, y: node.y, r, label, book: node.book, leftPct: (node.x / 380 * 100).toFixed(1), labelTopPct: ((node.y - r - 6) / 300 * 100).toFixed(1), bookTopPct: ((node.y + r + 4) / 300 * 100).toFixed(1), fill: node.degree > 1 ? "var(--color-accent-2-100)" : "var(--color-bg)", stroke: node.degree > 1 ? "var(--color-accent-2-700)" : "var(--color-neutral-800)" };
    });
    return { nodes: graphNodes, edges };
  }

  // ---------- resurfacing ----------
  function pickResurfaceEntry() {
    const entries = allEntries();
    if (entries.length < 2) return null;
    if (ui.resurfaceKey) {
      const found = entries.find(e => e.entry.id === ui.resurfaceKey);
      if (found) return found;
    }
    const candidates = entries.slice(0, -1); // exclude the most recently added
    const pick = candidates[Math.floor(Math.random() * candidates.length)] || entries[0];
    ui.resurfaceKey = pick.entry.id;
    return pick;
  }

  // ---------- rendering ----------
  const app = document.getElementById("app");
  function render() {
    let html = "";
    if (ui.view === "home") html = viewHome();
    else if (ui.view === "startBook") html = viewStartBook();
    else if (ui.view === "bookDetail") html = viewBookDetail();
    else if (ui.view === "capture") html = viewCapture();
    else if (ui.view === "closeBook") html = viewCloseBook();
    else if (ui.view === "connections") html = viewConnections();
    html += viewTabbar();
    if (ui.pickerOpen) html += viewPicker();
    app.innerHTML = html;
    bind();
    hydrateImages();
  }

  // Fill in <img data-image-id> placeholders from IndexedDB after the DOM is in place.
  function hydrateImages() {
    app.querySelectorAll("img[data-image-id]").forEach(async img => {
      const id = img.dataset.imageId;
      try {
        const blob = await loadImageBlob(id);
        if (blob) img.src = URL.createObjectURL(blob);
      } catch (e) { console.warn("Could not load image", id, e); }
    });
  }

  function go(view, extra = {}) { Object.assign(ui, { view, pickerOpen: false }, extra); render(); }

  function viewTabbar() {
    if (ui.view === "startBook" || ui.view === "capture" || ui.view === "closeBook") return "";
    return `<div class="tabbar">
      <button data-action="go-home" class="${ui.view === "home" ? "active" : ""}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1V10.5z"/></svg>
        <span>Library</span>
      </button>
      <button data-action="go-connections" class="${ui.view === "connections" ? "active" : ""}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8 7l7-.6M7.3 8.2L11 16M17 8l-4 8"/></svg>
        <span>Connections</span>
      </button>
      <button data-action="open-picker">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>
        <span>New entry</span>
      </button>
    </div>`;
  }

  function viewPicker() {
    const rows = data.books.map(b => `<button type="button" class="btn btn-secondary btn-block" style="justify-content:flex-start" data-action="pick-book" data-book="${b.id}">${escapeHtml(b.title)}</button>`).join("");
    return `<div class="dialog-backdrop" data-action="close-picker">
      <div class="dialog" onclick="event.stopPropagation()">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="font-family:var(--font-heading);font-weight:600;font-size:20px">New entry — which book?</div>
          <button type="button" class="btn btn-ghost btn-icon" data-action="close-picker">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div style="display:flex;flex-direction:column;gap:var(--space-2)">${rows || '<p style="opacity:0.6;font-size:13px">No books yet — start one first.</p>'}</div>
      </div>
    </div>`;
  }

  function viewHome() {
    const totalNotes = data.books.reduce((n, b) => n + b.entries.length, 0);
    const resurface = (!ui.resurfaceDismissed) ? pickResurfaceEntry() : null;
    const neighbors = resurface ? neighborsOf(resurface.entry.id) : [];
    const filtered = data.books.filter(b =>
      !ui.search || b.title.toLowerCase().includes(ui.search.toLowerCase()) || b.author.toLowerCase().includes(ui.search.toLowerCase())
    );

    return `
      <div style="padding:var(--space-4) var(--space-4) 0">
        <div style="display:flex;align-items:flex-start;justify-content:space-between">
          <div>
            <h1 style="margin:0;font-size:38px;line-height:1">Commonplace</h1>
            <p class="hand" style="margin:6px 0 0;font-size:16px;color:var(--color-accent-2-700);transform:rotate(-1deg);display:inline-block">a book of what's worth keeping</p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" data-action="go-connections" style="margin-top:4px">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8 7l7-.6M7.3 8.2L11 16M17 8l-4 8"/></svg>
          </button>
        </div>
        <div style="height:3px;background:var(--color-text);margin-top:var(--space-2)"></div>
        <div style="height:1px;background:var(--color-text);margin-top:2px"></div>
        <div style="display:flex;justify-content:space-between;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.55;padding:5px 0 var(--space-2)">
          <span>${formatDate(new Date()).toUpperCase()}</span>
          <span>${data.books.length} BOOKS · ${totalNotes} NOTES</span>
        </div>
      </div>

      ${resurface ? `
      <div style="margin:var(--space-3) var(--space-4) var(--space-4);padding:var(--space-3);background:var(--color-surface);border-radius:var(--radius-md)">
        <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--color-accent-700);margin-bottom:var(--space-2)">From ${escapeHtml(formatDate(new Date(resurface.entry.date)))} · ${escapeHtml(resurface.book.title)}</div>
        <p style="margin:0 0 var(--space-2);font-size:15px;line-height:1.5;background:linear-gradient(transparent 62%, var(--color-accent-100) 62%);display:inline">${escapeHtml(resurface.entry.keep)}</p>
        ${resurface.entry.connection ? `<p style="margin:0 0 var(--space-3);padding-left:var(--space-3);font-style:italic;font-size:13px;opacity:0.72;color:var(--color-accent-2-800)">${escapeHtml(resurface.entry.connection)}</p>` : ""}
        ${neighbors[0] ? `<div style="display:flex;gap:8px;align-items:baseline;margin:0 0 var(--space-3);font-size:12px;opacity:0.75">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none;margin-top:2px"><path d="M9 15l6-6M8 13l-2 2a3 3 0 004 4l3-3M16 11l2-2a3 3 0 00-4-4l-3 3"/></svg>
          <span>linked — <em>${escapeHtml(neighbors[0].book)}</em>: ${escapeHtml(neighbors[0].excerpt)}</span>
        </div>` : ""}
        <p class="hand" style="margin:0 0 var(--space-3);font-size:17px;color:var(--color-accent-700);transform:rotate(-1deg);opacity:0.9">Still true? Anything to add?</p>
        <div style="display:flex;gap:var(--space-3)">
          <button type="button" class="btn btn-ghost" style="padding-inline:0" data-action="capture-for" data-book="${resurface.book.id}">Add a note</button>
          <button type="button" class="btn btn-ghost" style="padding-inline:0;color:var(--color-text);opacity:0.55" data-action="dismiss-resurface">Skip for now</button>
        </div>
      </div>` : ""}

      <div style="padding:0 var(--space-4)">
        <h6 class="hand" style="font-weight:400;font-size:18px;color:var(--color-accent-700);opacity:0.9;margin-bottom:var(--space-3);transform:rotate(-0.6deg);text-transform:none;letter-spacing:0">Library</h6>
        <div class="field" style="margin-bottom:var(--space-4)">
          <div style="position:relative">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);opacity:0.5"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/></svg>
            <input class="input" style="padding-left:32px" placeholder="Search books" id="search-input" value="${escapeHtml(ui.search)}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--space-3);margin-bottom:var(--space-4)">
          ${filtered.map(book => {
            const latest = book.entries[book.entries.length - 1];
            return `<div class="card" style="cursor:pointer" data-action="open-book" data-book="${book.id}">
              <div style="display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-2)">
                <span class="card-kicker">${book.status === "reading" ? "READING" : "CLOSED"}</span>
                <span style="font-size:11px;opacity:0.55">${book.entries.length} note${book.entries.length === 1 ? "" : "s"}</span>
              </div>
              <div class="card-title">${escapeHtml(book.title)}</div>
              <p style="margin:0;font-size:13px;opacity:0.65">${escapeHtml(book.author)}</p>
              ${latest ? `<p style="margin:4px 0 0;font-style:italic;font-size:12px;color:var(--color-accent-2-800);background:var(--color-accent-2-100);display:inline-block;max-width:100%;padding:2px 6px;border-radius:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">"${escapeHtml(latest.keep)}"</p>` : ""}
            </div>`;
          }).join("")}
        </div>
        ${filtered.length === 0 && data.books.length > 0 ? `<p style="opacity:0.5;font-size:13px;font-style:italic;margin:0 0 var(--space-4)">No books match "${escapeHtml(ui.search)}".</p>` : ""}
        ${data.books.length === 0 ? `<p style="opacity:0.6;font-size:14px;font-style:italic;margin:0 0 var(--space-4)">Nothing here yet. Start your first book below — capture what you want to keep from it as you go.</p>` : ""}
        <button type="button" class="btn btn-secondary btn-block" data-action="go-start">Start a new book</button>
      </div>
    `;
  }

  function viewStartBook() {
    return `<div>
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-4) var(--space-4) var(--space-2)">
        <button type="button" class="btn btn-ghost btn-icon" data-action="go-home"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <h4 style="margin:0">New book</h4>
      </div>
      <div style="padding:var(--space-2) var(--space-4) var(--space-8);display:flex;flex-direction:column;gap:var(--space-4)">
        <div class="field"><label>Title</label><input class="input" id="f-title" placeholder="Book title"></div>
        <div class="field"><label>Author</label><input class="input" id="f-author" placeholder="Author"></div>
        <div class="field"><label>What do you think this book is about?</label><textarea class="input" rows="3" id="f-about"></textarea></div>
        <div class="field"><label>What do you want to get out of it?</label><textarea class="input" rows="3" id="f-want"></textarea></div>
        <div class="field"><label>What have you already read or lived that this might connect to?</label><textarea class="input" rows="3" id="f-connect"></textarea></div>
        <button type="button" class="btn btn-primary btn-block" data-action="submit-start">Begin reading</button>
      </div>
    </div>`;
  }

  function viewBookDetail() {
    const book = findBook(ui.bookId);
    if (!book) { go("home"); return ""; }
    const closed = book.status === "closed";
    return `<div>
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-4) var(--space-4) var(--space-1)">
        <button type="button" class="btn btn-ghost btn-icon" data-action="go-home"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <h4 style="margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(book.title)}</h4>
      </div>
      <div style="padding:0 var(--space-4) var(--space-3)">
        <p style="margin:0 0 var(--space-2);opacity:0.65;font-size:14px">${escapeHtml(book.author)}</p>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="tag ${closed ? "tag-neutral" : "tag-accent"}">${closed ? "Closed" : "Reading"}</span>
          <span style="font-size:12px;opacity:0.5">${closed ? "Closed " + formatDate(new Date(book.closedAt)) : "Started " + formatDate(new Date(book.startedAt))}</span>
        </div>
      </div>

      ${closed ? `<div style="padding:0 var(--space-4);margin-bottom:var(--space-6);display:flex;flex-direction:column;gap:var(--space-3)">
        <div>
          <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;opacity:0.5;margin-bottom:6px">Then — your prediction</div>
          <p style="margin:0;font-size:13px;font-style:italic;opacity:0.75">${escapeHtml(book.start.about)}</p>
        </div>
        <div>
          <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--color-accent-700);margin-bottom:6px">Now — what surprised you</div>
          <p style="margin:0 0 var(--space-2);font-size:14px">${escapeHtml(book.close.surprised)}</p>
          <p style="margin:0 0 var(--space-2);font-size:14px"><strong>Next time:</strong> ${escapeHtml(book.close.differently)}</p>
          <p style="margin:0;font-size:14px;font-style:italic">"${escapeHtml(book.close.rating)}"</p>
        </div>
      </div>` : `<div style="padding:0 var(--space-4);margin-bottom:var(--space-6)">
        <p style="margin:0;font-size:13px;font-style:italic;opacity:0.6">Started thinking: "${escapeHtml(book.start.about)}"</p>
      </div>`}

      <div style="padding:0 var(--space-4);display:flex;flex-direction:column;gap:var(--space-6);margin-bottom:var(--space-6)">
        ${book.entries.map(entry => `<div>
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-2);margin-bottom:6px">
            <span style="font-size:13px;opacity:0.6">${escapeHtml(formatDate(new Date(entry.date)))}</span>
            <span style="display:flex;gap:4px">
              <button type="button" class="btn btn-ghost btn-icon" style="width:28px;height:28px" aria-label="Edit" data-action="edit-entry" data-book="${book.id}" data-entry="${entry.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
              <button type="button" class="btn btn-ghost btn-icon" style="width:28px;height:28px;color:var(--color-accent-2-700)" aria-label="Delete" data-action="delete-entry" data-book="${book.id}" data-entry="${entry.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0v13a1 1 0 01-1 1H8a1 1 0 01-1-1V7h10z"/></svg></button>
            </span>
          </div>
          ${entry.imageId ? `<img data-image-id="${entry.imageId}" style="width:100%;max-height:220px;object-fit:cover;border-radius:var(--radius-md);margin-bottom:8px;background:var(--color-divider)">` : ""}
          <p style="margin:0 0 8px;font-size:16px;line-height:1.55">${escapeHtml(entry.keep)}</p>
          ${entry.connection ? `<p style="margin:0 0 8px;padding-left:var(--space-3);font-style:italic;font-size:13px;opacity:0.72;color:var(--color-accent-2-800)">↳ ${escapeHtml(entry.connection)}</p>` : ""}
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${entry.tags.map(t => `<span class="tag ${t.type === "theme" ? "tag-outline" : t.type === "person" ? "tag-accent" : "tag-neutral"}">${escapeHtml(t.value)}</span>`).join("")}
          </div>
        </div>`).join("") || `<p style="opacity:0.5;font-size:13px;font-style:italic">No entries yet.</p>`}
      </div>

      <div style="padding:0 var(--space-4);display:flex;flex-direction:column;gap:var(--space-2)">
        <button type="button" class="btn btn-primary btn-block" data-action="capture-for" data-book="${book.id}">New entry</button>
        ${!closed ? `<button type="button" class="btn btn-ghost" data-action="go-close" data-book="${book.id}">Close this book</button>` : ""}
        <button type="button" class="btn btn-ghost" style="color:var(--color-accent-2-700)" data-action="delete-book" data-book="${book.id}">Delete this book</button>
      </div>
    </div>`;
  }

  let captureTags = [];
  let editingEntryId = null;      // set when the capture view is editing an existing entry
  let pendingImageFile = null;    // a newly-picked File awaiting save
  let pendingImagePreviewUrl = null;
  let existingImageId = null;     // image already attached to the entry being edited
  let imageRemoved = false;       // user asked to remove the existing image

  function resetCaptureDraft() {
    captureTags = []; editingEntryId = null; pendingImageFile = null;
    pendingImagePreviewUrl = null; existingImageId = null; imageRemoved = false;
  }

  function imagePickerHtml() {
    const showRemove = (existingImageId && !imageRemoved) || pendingImagePreviewUrl;
    return `<div class="field">
      <label>Photo (optional)</label>
      <input type="file" accept="image/*" id="f-image" class="input" style="padding:6px">
      <div id="image-preview" style="margin-top:8px;display:flex;align-items:center;gap:10px">
        ${pendingImagePreviewUrl ? `<img src="${pendingImagePreviewUrl}" style="width:64px;height:64px;object-fit:cover;border-radius:var(--radius-md)">`
          : (existingImageId && !imageRemoved ? `<img data-image-id="${existingImageId}" style="width:64px;height:64px;object-fit:cover;border-radius:var(--radius-md);background:var(--color-divider)">` : "")}
        ${showRemove ? `<button type="button" class="btn btn-ghost" style="padding-inline:0" data-action="remove-image">Remove photo</button>` : ""}
      </div>
    </div>`;
  }

  function viewCapture() {
    const book = findBook(ui.bookId);
    if (!book) { go("home"); return ""; }
    const editing = !!editingEntryId;
    const entry = editing ? book.entries.find(e => e.id === editingEntryId) : null;
    return `<div>
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-4) var(--space-4) var(--space-1)">
        <button type="button" class="btn btn-ghost btn-icon" data-action="go-book" data-book="${book.id}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div><h4 style="margin:0">${editing ? "Edit entry" : "New entry"}</h4><p style="margin:2px 0 0;font-size:12px;opacity:0.55">${escapeHtml(book.title)}</p></div>
      </div>
      <div style="padding:var(--space-3) var(--space-4) var(--space-8);display:flex;flex-direction:column;gap:var(--space-4)">
        <div class="field">
          <label style="font-size:14px;opacity:0.9">What do you want to keep from this?</label>
          <textarea class="input" rows="5" style="font-size:16px" id="f-keep" placeholder="The idea, line, or scene worth keeping…" autofocus>${escapeHtml(entry?.keep ?? "")}</textarea>
        </div>
        <div style="padding-left:var(--space-3)">
          <label style="display:block;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:var(--color-accent-2-700);margin-bottom:6px">Personal connection</label>
          <textarea class="input" rows="3" style="font-style:italic;font-size:13px;background:transparent;border-color:var(--color-divider)" id="f-connection" placeholder="Where does this touch something you already know or have lived?">${escapeHtml(entry?.connection ?? "")}</textarea>
        </div>
        <div class="field">
          <label>Tags</label>
          <div class="seg" style="margin-bottom:var(--space-2)">
            <span class="seg-opt ${ui.tagType === "theme" ? "active" : ""}" data-action="set-tag-type" data-type="theme">Theme</span>
            <span class="seg-opt ${ui.tagType === "person" ? "active" : ""}" data-action="set-tag-type" data-type="person">Person</span>
            <span class="seg-opt ${ui.tagType === "place" ? "active" : ""}" data-action="set-tag-type" data-type="place">Place</span>
          </div>
          <div style="display:flex;gap:var(--space-2)">
            <input class="input" id="f-tag" placeholder="Add a tag">
            <button type="button" class="btn btn-secondary" data-action="add-tag">Add</button>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:var(--space-2)">
            ${captureTags.map((t, i) => `<span class="tag ${t.type === "theme" ? "tag-outline" : t.type === "person" ? "tag-accent" : "tag-neutral"}" style="display:inline-flex;align-items:center;gap:6px">${escapeHtml(t.value)}<button type="button" data-action="remove-tag" data-index="${i}" style="background:none;border:none;padding:0;cursor:pointer;color:inherit;opacity:0.6;display:flex"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>`).join("")}
          </div>
        </div>
        ${imagePickerHtml()}
        <button type="button" class="btn btn-primary btn-block" id="save-capture-btn" data-action="save-capture">${editing ? "Save changes" : "Save entry"}</button>
      </div>
    </div>`;
  }

  function viewCloseBook() {
    const book = findBook(ui.bookId);
    if (!book) { go("home"); return ""; }
    return `<div>
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-4) var(--space-4) var(--space-1)">
        <button type="button" class="btn btn-ghost btn-icon" data-action="go-book" data-book="${book.id}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div><h4 style="margin:0">Close book</h4><p style="margin:2px 0 0;font-size:12px;opacity:0.55">${escapeHtml(book.title)}</p></div>
      </div>
      <div style="padding:var(--space-2) var(--space-4) 0">
        <p style="font-size:13px;font-style:italic;opacity:0.6;margin:0 0 var(--space-4)">Your prediction, from ${escapeHtml(formatDate(new Date(book.startedAt)))}: "${escapeHtml(book.start.about)}"</p>
      </div>
      <div style="padding:0 var(--space-4) var(--space-8);display:flex;flex-direction:column;gap:var(--space-4)">
        <div class="field"><label>What surprised you?</label><textarea class="input" rows="3" id="f-surprised"></textarea></div>
        <div class="field"><label>What will you do differently?</label><textarea class="input" rows="3" id="f-differently"></textarea></div>
        <div class="field"><label>One line — how was it?</label><input class="input" id="f-rating" placeholder="e.g. Slower than I expected, in a good way"></div>
        <button type="button" class="btn btn-primary btn-block" data-action="save-close">Close book</button>
      </div>
    </div>`;
  }

  function viewConnections() {
    const graph = buildGraph();
    const pending = computeSuggestions();
    const confirmed = confirmedLinks();
    return `<div>
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-4) var(--space-4) var(--space-1)">
        <button type="button" class="btn btn-ghost btn-icon" data-action="go-home"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <h4 style="margin:0">Connections</h4>
      </div>
      <p style="padding:0 var(--space-4);font-size:13px;opacity:0.6;margin:0 0 var(--space-3)">Suggested by similarity between notes. Nothing links until you confirm it.</p>
      <div style="padding:0 var(--space-4);margin-bottom:var(--space-4)">
        <div class="seg">
          <span class="seg-opt ${ui.connTab === "map" ? "active" : ""}" data-action="set-conn-tab" data-tab="map">Map</span>
          <span class="seg-opt ${ui.connTab === "pending" ? "active" : ""}" data-action="set-conn-tab" data-tab="pending">Pending</span>
          <span class="seg-opt ${ui.connTab === "confirmed" ? "active" : ""}" data-action="set-conn-tab" data-tab="confirmed">Confirmed</span>
        </div>
      </div>

      ${ui.connTab === "map" ? `
      <div style="padding:0 var(--space-4);margin-bottom:var(--space-6)">
        ${graph.nodes.length === 0 ? `<p style="opacity:0.5;font-size:13px;font-style:italic">No connections yet — link some notes to see the map.</p>` : `
        <div style="position:relative;background-image:radial-gradient(var(--color-neutral-300, #d7d3d3) 1px, transparent 1px);background-size:15px 15px;padding:var(--space-3) 2px;border-radius:var(--radius-md)">
          <svg viewBox="0 0 380 300" width="100%" style="display:block;overflow:visible">
            ${graph.edges.map(e => `<path d="${e.d}" fill="none" stroke="${e.stroke}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${e.dash}"/>`).join("")}
            <g font-family="var(--font-heading)">
              ${graph.nodes.map(n => `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${n.fill}" stroke="${n.stroke}" stroke-width="1.6"/>`).join("")}
            </g>
          </svg>
          ${graph.nodes.map(n => `
            <div style="position:absolute;left:${n.leftPct}%;top:${n.labelTopPct}%;transform:translate(-50%,-100%);width:110px;margin-left:-55px;text-align:center;font-family:var(--font-heading);font-size:11px;pointer-events:none">${escapeHtml(n.label)}</div>
            <div style="position:absolute;left:${n.leftPct}%;top:${n.bookTopPct}%;transform:translate(-50%,0);white-space:nowrap;text-align:center;font-size:9px;opacity:0.55;font-style:italic;pointer-events:none">${escapeHtml(n.book)}</div>
          `).join("")}
        </div>
        <p class="hand" style="font-size:12px;color:var(--color-accent-2-700);margin:var(--space-2) 0 0">solid thread — confirmed · dashed — still guessing</p>
        <div style="height:60px" aria-hidden="true"></div>
        `}
      </div>` : ""}

      ${ui.connTab === "pending" ? `
      <div style="padding:0 var(--space-4);margin-bottom:var(--space-6)">
        <div style="display:flex;flex-direction:column;gap:var(--space-3)">
          ${pending.map(s => `<div class="card">
            <div style="font-size:11px;opacity:0.55">${Math.round(s.similarity * 100)}% similar</div>
            <p style="margin:0;font-size:14px"><strong>${escapeHtml(s.aBook)}</strong> — ${escapeHtml(s.aExcerpt)}</p>
            <p style="margin:0;font-size:14px"><strong>${escapeHtml(s.bBook)}</strong> — ${escapeHtml(s.bExcerpt)}</p>
            <div style="display:flex;gap:var(--space-2);margin-top:var(--space-1)">
              <button type="button" class="btn btn-secondary" data-action="confirm-link" data-a="${s.aEntryId}" data-b="${s.bEntryId}" data-abook="${s.aBookId}" data-bbook="${s.bBookId}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 13l4 4L19 7"/></svg>Confirm
              </button>
              <button type="button" class="btn btn-ghost" style="color:var(--color-text);opacity:0.6" data-action="reject-link" data-a="${s.aEntryId}" data-b="${s.bEntryId}" data-abook="${s.aBookId}" data-bbook="${s.bBookId}">Not related</button>
            </div>
          </div>`).join("") || `<p style="opacity:0.5;font-size:13px;font-style:italic">No pending suggestions right now.</p>`}
        </div>
      </div>` : ""}

      ${ui.connTab === "confirmed" ? `
      <div style="padding:0 var(--space-4)">
        <div style="display:flex;flex-direction:column;gap:var(--space-3)">
          ${confirmed.map(s => `<div style="font-size:13px">
            <div style="display:flex;gap:6px;align-items:center;opacity:0.6;margin-bottom:4px">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 15l6-6M8 13l-2 2a3 3 0 004 4l3-3M16 11l2-2a3 3 0 00-4-4l-3 3"/></svg>
              ${escapeHtml(s.aBook)} ↔ ${escapeHtml(s.bBook)}
            </div>
            <p style="margin:0">${escapeHtml(s.aExcerpt)} — <em>${escapeHtml(s.bExcerpt)}</em></p>
          </div>`).join("") || `<p style="opacity:0.5;font-size:13px;font-style:italic">Nothing confirmed yet.</p>`}
        </div>
      </div>` : ""}
    </div>`;
  }

  // ---------- event binding ----------
  function bind() {
    app.querySelectorAll("[data-action]").forEach(el => {
      el.addEventListener("click", onAction);
    });
    const searchInput = document.getElementById("search-input");
    if (searchInput) {
      searchInput.addEventListener("input", () => { ui.search = searchInput.value; renderHomeListOnly(); });
      searchInput.focus();
      searchInput.selectionStart = searchInput.selectionEnd = searchInput.value.length;
    }
    const imageInput = document.getElementById("f-image");
    if (imageInput) {
      imageInput.addEventListener("change", () => {
        const file = imageInput.files && imageInput.files[0];
        if (!file) return;
        pendingImageFile = file;
        imageRemoved = false;
        if (pendingImagePreviewUrl) URL.revokeObjectURL(pendingImagePreviewUrl);
        pendingImagePreviewUrl = URL.createObjectURL(file);
        renderCapturePreserving();
      });
    }
  }

  // Re-render only the search results without losing focus, by re-rendering fully
  // but restoring focus/caret to the search box afterward.
  function renderHomeListOnly() {
    const caret = document.getElementById("search-input")?.selectionStart ?? null;
    render();
    const el = document.getElementById("search-input");
    if (el && caret !== null) { el.focus(); el.selectionStart = el.selectionEnd = caret; }
  }

  function onAction(e) {
    const el = e.currentTarget;
    const action = el.dataset.action;

    if (action === "go-home") return go("home");
    if (action === "go-connections") return go("connections");
    if (action === "go-start") return go("startBook");
    if (action === "open-book") return go("bookDetail", { bookId: el.dataset.book });
    if (action === "go-book") return go("bookDetail", { bookId: el.dataset.book });
    if (action === "go-close") return go("closeBook", { bookId: el.dataset.book });
    if (action === "dismiss-resurface") { ui.resurfaceDismissed = true; return render(); }

    if (action === "open-picker") { ui.pickerOpen = true; return render(); }
    if (action === "close-picker") { ui.pickerOpen = false; return render(); }
    if (action === "pick-book") { resetCaptureDraft(); return go("capture", { bookId: el.dataset.book }); }
    if (action === "capture-for") { resetCaptureDraft(); return go("capture", { bookId: el.dataset.book }); }

    if (action === "edit-entry") {
      resetCaptureDraft();
      const book = findBook(el.dataset.book);
      const entry = book?.entries.find(x => x.id === el.dataset.entry);
      if (!entry) return;
      editingEntryId = entry.id;
      captureTags = entry.tags.map(t => ({ ...t }));
      existingImageId = entry.imageId || null;
      return go("capture", { bookId: book.id });
    }
    if (action === "delete-entry") {
      const book = findBook(el.dataset.book);
      const entry = book?.entries.find(x => x.id === el.dataset.entry);
      if (!entry) return;
      if (!confirm("Delete this entry? This can't be undone.")) return;
      book.entries = book.entries.filter(x => x.id !== entry.id);
      data.links = data.links.filter(l => l.aEntryId !== entry.id && l.bEntryId !== entry.id);
      saveData(data);
      if (entry.imageId) deleteImageBlob(entry.imageId);
      return render();
    }
    if (action === "delete-book") {
      const book = findBook(el.dataset.book);
      if (!book) return;
      if (!confirm(`Delete "${book.title}" and all ${book.entries.length} of its notes? This can't be undone.`)) return;
      const entryIds = new Set(book.entries.map(x => x.id));
      data.books = data.books.filter(b => b.id !== book.id);
      data.links = data.links.filter(l => !entryIds.has(l.aEntryId) && !entryIds.has(l.bEntryId));
      saveData(data);
      book.entries.forEach(e => { if (e.imageId) deleteImageBlob(e.imageId); });
      return go("home");
    }
    if (action === "remove-image") {
      if (pendingImagePreviewUrl) { URL.revokeObjectURL(pendingImagePreviewUrl); pendingImagePreviewUrl = null; }
      pendingImageFile = null;
      imageRemoved = true;
      return renderCapturePreserving();
    }

    if (action === "set-tag-type") { ui.tagType = el.dataset.type; return renderCapturePreserving(); }
    if (action === "add-tag") {
      const input = document.getElementById("f-tag");
      const val = input.value.trim();
      if (val) captureTags.push({ type: ui.tagType, value: val });
      return renderCapturePreserving({ tag: "" });
    }
    if (action === "remove-tag") { captureTags.splice(Number(el.dataset.index), 1); return renderCapturePreserving(); }

    if (action === "save-capture") {
      const book = findBook(ui.bookId);
      const keep = document.getElementById("f-keep").value.trim();
      const connection = document.getElementById("f-connection").value.trim();
      if (!keep || !connection) {
        alert("Both “what to keep” and “personal connection” are required — that's the whole point of this app.");
        return;
      }
      const btn = document.getElementById("save-capture-btn");
      btn.disabled = true; btn.textContent = "Saving…";
      saveCaptureAsync(book, keep, connection).catch(err => {
        console.error(err);
        alert("Couldn't save the photo — the note itself is safe, try re-adding the photo.");
      });
      return;
    }

    if (action === "submit-start") {
      const title = document.getElementById("f-title").value.trim();
      const author = document.getElementById("f-author").value.trim();
      const about = document.getElementById("f-about").value.trim();
      const want = document.getElementById("f-want").value.trim();
      const connect = document.getElementById("f-connect").value.trim();
      if (!title) { alert("Give the book a title first."); return; }
      const book = { id: uid("b"), title, author, status: "reading", startedAt: new Date().toISOString().slice(0, 10), start: { about, want, connect }, close: null, entries: [] };
      data.books.push(book);
      saveData(data);
      return go("bookDetail", { bookId: book.id });
    }

    if (action === "save-close") {
      const book = findBook(ui.bookId);
      book.status = "closed";
      book.closedAt = new Date().toISOString().slice(0, 10);
      book.close = {
        surprised: document.getElementById("f-surprised").value.trim(),
        differently: document.getElementById("f-differently").value.trim(),
        rating: document.getElementById("f-rating").value.trim()
      };
      saveData(data);
      return go("bookDetail", { bookId: book.id });
    }

    if (action === "set-conn-tab") { ui.connTab = el.dataset.tab; return render(); }
    if (action === "confirm-link") { decideLink(el.dataset.a, el.dataset.b, el.dataset.abook, el.dataset.bbook, "confirmed"); return render(); }
    if (action === "reject-link") { decideLink(el.dataset.a, el.dataset.b, el.dataset.abook, el.dataset.bbook, "rejected"); return render(); }
  }

  async function saveCaptureAsync(book, keep, connection) {
    let imageId = (existingImageId && !imageRemoved) ? existingImageId : null;
    if (pendingImageFile) {
      const resized = await resizeImageFile(pendingImageFile);
      const newId = uid("img");
      await saveImageBlob(newId, resized);
      if (existingImageId) await deleteImageBlob(existingImageId); // replacing an existing photo
      imageId = newId;
    } else if (imageRemoved && existingImageId) {
      await deleteImageBlob(existingImageId);
      imageId = null;
    }

    if (editingEntryId) {
      const entry = book.entries.find(e => e.id === editingEntryId);
      entry.keep = keep; entry.connection = connection; entry.tags = captureTags.slice(); entry.imageId = imageId;
    } else {
      book.entries.push({ id: uid("e"), date: new Date().toISOString().slice(0, 10), keep, connection, tags: captureTags.slice(), imageId });
    }
    saveData(data);
    if (pendingImagePreviewUrl) URL.revokeObjectURL(pendingImagePreviewUrl);
    resetCaptureDraft();
    ui.resurfaceDismissed = false;
    go("bookDetail", { bookId: book.id });
  }

  // Re-render the capture view while preserving whatever the user has typed so far.
  function renderCapturePreserving(overrides = {}) {
    const keep = document.getElementById("f-keep")?.value ?? "";
    const connection = document.getElementById("f-connection")?.value ?? "";
    const tag = overrides.tag ?? (document.getElementById("f-tag")?.value ?? "");
    render();
    const k = document.getElementById("f-keep"); if (k) k.value = keep;
    const c = document.getElementById("f-connection"); if (c) c.value = connection;
    const t = document.getElementById("f-tag"); if (t) t.value = tag;
  }

  render();
})();
