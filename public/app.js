/* TAB desk UI: one app, two sources. Replay: window.__RUN__ (inlined by scripts/build-replay.ts).
   Live: /api/state + /api/stream from src/server/server.ts. Everything shown is derived from the desk's event log. */
(() => {
  "use strict";
  const RUN = window.__RUN__ || null;
  const LIVE = !RUN;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);
  const usd = (c) => (c == null ? "—" : "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
  const short = (a) => (a && a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-6) : a || "");
  const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || v;
  const EXPLORER = "https://testnet.metalntwx.com/tx/";

  let EVENTS = RUN ? RUN.events : [];
  let BUYERS = RUN ? RUN.buyers : [];
  let FAULTS = null;
  let idx = EVENTS.length - 1;
  let timer = null;
  let speed = 1100;

  // ── icons (24×24 stroke paths) ─────────────────────────────────────────
  const ICON = {
    dollar: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
    link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    card: "M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM2 10h20M6 15h4",
    stop: "M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86zM15 9l-6 6M9 9l6 6",
    spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z",
    pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
    book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5V21h16v-4",
    globe: "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
    gauge: "M12 14l4-4M3.3 19a9 9 0 1 1 17.4 0",
    cart: "M6 6h15l-1.5 9h-12zM6 6 5 3H2M9 20h.01M18 20h.01",
    minus: "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20M8 12h8",
    msg: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z",
    user: "M20 21a8 8 0 0 0-16 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
    shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
    bot: "M12 8V4H8M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM9 14h.01M15 14h.01",
    desk: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6",
    flag: "M4 22V4M4 4h13l-2 4 2 4H4",
  };
  const svgIcon = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[k] || ICON.flag}"/></svg>`;
  const TYPE_ICON = { collect: "dollar", mandate: "link", statement: "link", vic: "card", refused: "stop", collect_refused: "stop", agent: "spark", policy: "pen", books: "book", settle: "globe", decision: "gauge", order: "cart", credit: "minus", dispute: "msg", escalate: "user", proof: "shield" };
  const TYPE_LABEL = { vic: "Visa", collect_refused: "pending", settle: "Airwallex", agent: "agent", policy: "CFO policy", books: "books", collect: "collected", refused: "refused", mandate: "mandate", statement: "statement" };

  // ── scenes ─────────────────────────────────────────────────────────────
  // From "scene" events (new runs) or from the builder's log-derived tags (older runs).
  function sceneModel() {
    const list = [];
    const of = new Map();
    let cur = null;
    for (const e of EVENTS) {
      if (e.type === "scene") {
        cur = { key: e.data.key, title: e.data.title, firstSeq: e.seq };
        list.push(cur);
      } else if (e.scene) {
        if (!cur || cur.key !== e.scene) {
          const known = RUN && RUN.scenes ? RUN.scenes.find((s) => s.key === e.scene) : null;
          cur = { key: e.scene, title: known ? known.title : e.scene, firstSeq: e.seq };
          list.push(cur);
        }
      }
      if (cur) of.set(e.seq, cur.key);
    }
    return { list, of };
  }
  let SCENES = sceneModel();

  // ── state as of event i ────────────────────────────────────────────────
  function stateAt(i) {
    const buyers = Object.fromEntries(BUYERS.map((b) => [b.id, { ...b, decision: null, inputs: null, mandate: null, boundAfter: false, orders: new Map(), statements: new Map(), card: null, reached: new Set() }]));
    const k = { terms: 0, collected: 0, refusedChain: 0, pulls: 0, refusals: 0, holds: 0, captured: 0, settled: 0, sgd: 0, journals: 0, proof: null };
    const seenTx = new Set();
    for (const e of EVENTS.slice(0, i + 1)) {
      const d = e.data || {};
      const b = buyers[e.buyerId];
      if (e.type === "proof") { const c = d.checks || []; k.proof = { pass: c.filter((x) => x.ok).length, total: c.length }; }
      if (e.type === "settle" && d.conversionId) { k.settled++; const m = /→ ([\d.]+) SGD/.exec(e.summary); if (m) k.sgd += Number(m[1]); }
      if (e.type === "books" && d.journalEntryId) k.journals++;
      if (e.type === "refused" && d.tx) { k.refusedChain++; k.refusals++; }
      if (e.type === "collect" && d.tx && !seenTx.has(d.tx)) { seenTx.add(d.tx); k.collected += Number(d.amount || 0); k.pulls++; }
      if (!b) continue;
      if (e.type === "decision") {
        b.decision = d.decision; b.inputs = d.inputs; b.mandate = d.inputs && d.inputs.mandate; b.boundAfter = false;
        b.reached.add(d.decision.terms === "NET_30" ? 3 : d.decision.terms === "NET_7" ? 2 : 0);
      }
      if (e.type === "mandate") { b.mandate = { budget: d.budget, spent: 0 }; b.boundAfter = true; }
      if (e.type === "order" && d.order) {
        b.orders.set(d.order.id, { amount: d.order.amount, route: d.order.route, credited: 0, collected: false });
        if (d.order.route === "ON_TAB" || d.order.route === "CARD_AUTH") k.terms += d.order.amount;
      }
      if (e.type === "credit" && b.orders.has(d.orderId)) b.orders.get(d.orderId).credited += d.amount || 0;
      if (e.type === "collect") for (const id of d.orders || []) if (b.orders.has(id)) b.orders.get(id).collected = true;
      if (e.type === "statement") b.statements.set(d.statementId, { id: d.statementId, total: d.total, status: "accepted", refusals: 0 });
      if (e.type === "collect" && d.statementId && b.statements.has(d.statementId)) b.statements.get(d.statementId).status = "collected";
      if (e.type === "refused" && d.statementId && b.statements.has(d.statementId)) b.statements.get(d.statementId).refusals++;
      if (e.type === "vic" && d.checks && "authorised" in d.checks) { b.reached.add(1); b.card = { authorised: (d.orderIds || []).reduce((s, id) => s + (b.orders.get(id)?.amount || 0), 0), captured: null }; k.holds++; }
      if (e.type === "vic" && d.captured != null) {
        b.card = { authorised: d.authorised, captured: d.captured };
        k.captured += d.captured; k.collected += d.captured;
        for (const id of d.orderIds || []) if (b.orders.has(id)) b.orders.get(id).collected = true;
      }
    }
    return { buyers: Object.values(buyers), k };
  }

  // ── header logo ────────────────────────────────────────────────────────
  const mark = $("mark");
  if (mark && mark.setCurrentTime) {
    if (reduce) { mark.pauseAnimations(); mark.setCurrentTime(3); }
    mark.addEventListener("mouseenter", () => { if (!reduce) mark.setCurrentTime(0); });
    mark.addEventListener("click", () => { if (!reduce) mark.setCurrentTime(0); });
  }

  // ── rails map ──────────────────────────────────────────────────────────
  const NODES = {
    buyers: { x: 95, y: 150, w: 160, t: "Buyer agents", s: "Acme · Globex · Initech", c: "--info", ic: "bot" },
    claude: { x: 335, y: 46, w: 160, t: "Claude", s: "reads and proposes", c: "--claude", ic: "spark" },
    metal: { x: 335, y: 150, w: 160, t: "Metal", s: "debit mandates", c: "--metal", ic: "link" },
    visa: { x: 335, y: 254, w: 160, t: "Visa · Airi", s: "passkey card hold", c: "--visa", ic: "card" },
    desk: { x: 565, y: 150, w: 170, t: "Northwind desk", s: "code decides", c: "--accent", ic: "desk" },
    cfo: { x: 565, y: 46, w: 160, t: "CFO policy", s: "signed goals", c: "--cfo", ic: "pen" },
    t0: { x: 800, y: 96, w: 160, t: "T:0 books", s: "journal entries", c: "--t0", ic: "book" },
    awx: { x: 800, y: 214, w: 160, t: "Airwallex", s: "settle · USD → SGD", c: "--awx", ic: "globe" },
  };
  const EDGES = {
    "b-m": { d: "M175 150 L255 150" },
    "m-d": { d: "M415 150 L480 150" },
    "b-d": { d: "M120 124 C 210 88, 470 88, 545 124" },
    "b-v": { d: "M150 176 C 185 254, 220 254, 255 254" },
    "v-a": { d: "M415 254 C 560 254, 650 214, 720 214" },
    "d-a": { d: "M650 162 C 690 162, 690 214, 720 214" },
    "a-t": { d: "M800 188 L800 122" },
    "c-b": { d: "M255 46 C 160 46, 112 80, 104 124", dashed: true },
    "c-d": { d: "M415 52 C 480 58, 515 92, 530 124", dashed: true },
    "f-d": { d: "M565 72 L565 124" },
  };
  const rails = $("rails");
  let railSvg = null;
  function buildRails() {
    if (!rails) return;
    const edges = Object.entries(EDGES).map(([id, e]) => `<path id="e-${id}" class="edge${e.dashed ? " dashed" : ""}" d="${e.d}"/>`).join("");
    const nodes = Object.entries(NODES).map(([id, n]) => `
      <g class="node" id="n-${id}" style="color:var(${n.c})">
        <rect x="${n.x - n.w / 2}" y="${n.y - 26}" width="${n.w}" height="52" rx="13"/>
        <g transform="translate(${n.x - n.w / 2 + 12} ${n.y - 11}) scale(0.92)"><path class="ic" d="${ICON[n.ic]}"/></g>
        <text class="t" x="${n.x - n.w / 2 + 42}" y="${n.y - 2}">${n.t}</text>
        <text class="s" x="${n.x - n.w / 2 + 42}" y="${n.y + 14}">${n.s}</text>
      </g>`).join("");
    rails.innerHTML = `<svg id="railsvg" viewBox="0 0 900 300" role="img" aria-label="How money and decisions move between the buyer agents, Metal, Visa via Airi, Northwind's desk, the CFO's policy, Airwallex and T:0">
      <g>${edges}</g><g>${nodes}</g><g id="fx"></g></svg>`;
    railSvg = $("railsvg");
  }
  buildRails();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function flash(node, colorVar, shake) {
    const g = $("n-" + node);
    if (!g) return;
    const rect = g.querySelector("rect");
    rect.style.stroke = cssVar(colorVar);
    g.classList.add("flash");
    if (shake) { g.classList.remove("shake"); void g.getBBox(); g.classList.add("shake"); }
    setTimeout(() => { rect.style.stroke = ""; g.classList.remove("flash", "shake"); }, 700);
  }
  function stamp(node, text, colorVar) {
    const n = NODES[node];
    const fx = $("fx");
    if (!n || !fx) return;
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", n.x); t.setAttribute("y", n.y + 44); t.setAttribute("text-anchor", "middle");
    t.setAttribute("class", "stamp"); t.style.fill = cssVar(colorVar); t.textContent = text;
    fx.appendChild(t);
    t.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none", offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1600, easing: "ease-out" }).onfinish = () => t.remove();
  }
  /** Moves a packet along an edge; `back` runs it in reverse; `bounce` stops short and rebounds (a refusal). */
  function fly(edge, { color = "--accent", label = "", back = false, bounce = false, dur = 0 } = {}) {
    const p = $("e-" + edge);
    const fx = $("fx");
    if (!p || !fx || reduce) return Promise.resolve();
    const len = p.getTotalLength();
    const ns = "http://www.w3.org/2000/svg";
    const g = document.createElementNS(ns, "g");
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("r", "7"); c.setAttribute("class", "packet"); c.style.fill = cssVar(color);
    g.appendChild(c);
    let t = null;
    if (label) {
      t = document.createElementNS(ns, "text");
      t.setAttribute("class", "plabel"); t.setAttribute("text-anchor", "middle"); t.style.fill = cssVar(color); t.textContent = label;
      g.appendChild(t);
    }
    fx.appendChild(g);
    p.classList.add("hot"); p.style.stroke = cssVar(color);
    const D = dur || Math.max(380, speed * 0.62);
    const start = performance.now();
    return new Promise((resolve) => {
      // Animation frames stop in background tabs: a timer guarantees the packet finishes on time anyway.
      let done = false;
      const finish = () => { if (done) return; done = true; g.remove(); p.classList.remove("hot"); p.style.stroke = ""; resolve(); };
      setTimeout(finish, D + 250);
      const step = (now) => {
        if (done) return;
        let u = Math.min(1, (now - start) / D);
        const ease = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        let f = ease;
        if (bounce) f = u < 0.7 ? (ease / easeAt(0.7)) * 0.86 : 0.86 - (u - 0.7) * 1.2;
        const at = p.getPointAtLength(len * (back ? 1 - f : f));
        c.setAttribute("cx", at.x); c.setAttribute("cy", at.y);
        if (t) { t.setAttribute("x", at.x); t.setAttribute("y", at.y - 12); }
        if (bounce && u >= 0.7) g.style.opacity = String(Math.max(0, 1 - (u - 0.7) / 0.3));
        if (u < 1) requestAnimationFrame(step);
        else finish();
      };
      requestAnimationFrame(step);
    });
  }
  function easeAt(u) { return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; }

  /** What each event looks like on the rails. */
  async function animate(e) {
    const d = e.data || {};
    const amt = d.amount != null ? usd(Number(d.amount)) : "";
    switch (e.type) {
      case "scene": return;
      case "order":
        if (d.payNow) return fly("b-d", { color: "--info", label: "pay now" });
        return fly("b-d", { color: "--info", label: d.order ? usd(d.order.amount) : "" });
      case "agent": flash("claude", "--claude"); return fly("c-b", { color: "--claude", label: "agent" });
      case "decision": flash("desk", "--accent"); return sleep(120);
      case "policy": flash("claude", "--claude"); await fly("f-d", { color: "--cfo", label: "signed" }); flash("desk", "--cfo"); stamp("desk", "policy verified", "--cfo"); return;
      case "mandate": await fly("b-m", { color: "--metal", label: d.budget != null ? `bind ${usd(d.budget)}` : "bind" }); flash("metal", "--metal"); return;
      case "statement": await fly("b-m", { color: "--metal", label: "accept" }); flash("metal", "--metal"); stamp("metal", "statement = mandate", "--metal"); return;
      case "collect":
        if (!d.tx || /answered from the desk's record/.test(e.summary)) { flash("desk", "--accent"); stamp("desk", "nothing sent", "--muted"); return; }
        await fly("b-m", { color: "--metal", label: amt });
        flash("metal", "--metal");
        await fly("m-d", { color: "--metal", label: amt });
        flash("desk", "--metal");
        if (/reconciled from the chain/.test(e.summary)) stamp("desk", "found on chain", "--metal");
        return;
      case "refused":
        if (d.tx) { await fly("m-d", { color: "--bad", back: true, bounce: true, label: "pull" }); flash("metal", "--bad", true); stamp("metal", "refused on chain", "--bad"); return; }
        await fly("b-d", { color: "--bad", bounce: true, label: "off-menu" }); flash("desk", "--bad", true); stamp("desk", "refused", "--bad"); return;
      case "vic":
        if (d.captured != null) { await fly("v-a", { color: "--visa", label: usd(d.captured) }); flash("awx", "--visa"); stamp("visa", `captured ${usd(d.captured)}`, "--visa"); return; }
        if (d.checks && "authorised" in d.checks) { await fly("b-v", { color: "--visa", label: "hold" }); flash("visa", "--visa"); stamp("visa", "authorised, not taken", "--visa"); return; }
        await fly("v-a", { color: "--visa", label: "verified" }); flash("awx", "--visa"); return;
      case "credit": await fly("b-d", { color: "--warn", back: true, label: `−${amt}` }); return;
      case "dispute": flash("claude", "--claude"); await fly("c-d", { color: "--claude", label: "claims" }); flash("desk", "--warn"); return;
      case "escalate": flash("desk", "--bad"); stamp("desk", "to a person", "--bad"); return sleep(200);
      case "settle": await fly("d-a", { color: "--awx", label: "→ SGD" }); flash("awx", "--awx"); return;
      case "books": if (d.journalEntryId) { await fly("a-t", { color: "--t0", label: "JE" }); flash("t0", "--t0"); } return;
      case "proof": for (const n of ["buyers", "metal", "visa", "desk", "awx", "t0"]) { flash(n, "--good"); await sleep(90); } stamp("desk", "every dollar proven", "--good"); return;
      default: return;
    }
  }
  let queue = Promise.resolve();
  let qGen = 0;
  const enqueue = (e) => { const gen = qGen; queue = queue.then(() => (gen === qGen ? animate(e) : null)).catch(() => {}); return queue; };
  const clearQueue = () => { qGen++; queue = Promise.resolve(); };

  // ── headline counters ──────────────────────────────────────────────────
  const shown = {};
  function countTo(id, value, fmt) {
    const el = $(id);
    if (!el) return;
    const from = shown[id] ?? 0;
    shown[id] = value;
    const card = el.closest(".kpi");
    if (from === value) { el.textContent = fmt(value); return; }
    if (card) { card.classList.remove("bump"); void card.offsetWidth; card.classList.add("bump"); }
    if (reduce) { el.textContent = fmt(value); return; }
    const t0 = performance.now();
    const step = (now) => {
      const u = Math.min(1, (now - t0) / 650);
      el.textContent = fmt(from + (value - from) * (1 - Math.pow(1 - u, 3)));
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ── buyers ─────────────────────────────────────────────────────────────
  const REASON = {
    NET_30_EARNED: "Earned net-30", NET_7_DEFAULT: "Net-7: first rung", LIMIT_BY_TERMS_CAP: "Capped by the policy's terms",
    LIMIT_BY_MANDATE_HEADROOM: "Capped by the mandate its human signed", LIMIT_BY_ONCHAIN_BALANCE: "Capped by on-chain balance",
    LIMIT_TIGHTENED: "Limit tightened", DEMOTED_TO_PREPAY: "Demoted to prepay", COLLECT_ALL: "Collect everything now",
    COLLECT_EXCESS: "Collect the excess", ESCALATE_UNCOLLECTABLE: "Send to a person", OVERDUE_INVOICE: "Overdue in the books",
    NO_VIC_HISTORY: "No Visa-verified payment yet", NO_MANDATE: "No debit mandate", MANDATE_REVOKED: "Mandate revoked",
    MANDATE_EXPIRED: "Mandate expired", SUPPLIER_NOT_PAYEE: "Mandate doesn't name us",
  };
  const AV = { acme: "--info", globex: "--visa", initech: "--muted" };
  const RUNGS = [["Prepay", "pay now"], ["Card tab", "Visa hold"], ["Net-7", "7 days"], ["Net-30", "30 days"]];
  function ladder(b) {
    const terms = b.decision ? b.decision.terms : "PREPAY";
    const overdue = b.decision && b.decision.reasons.some((r) => r.code === "OVERDUE_INVOICE");
    const now = terms === "NET_30" ? 3 : terms === "NET_7" ? 2 : b.card ? 1 : 0; // on (or just settled) a card tab
    return `<div class="ladder" role="list" aria-label="Credit ladder">${RUNGS.map(([t, s], i) => {
      let cls = "rung";
      // ✓ only on rungs this buyer actually stood on; rungs it skipped stay plain.
      if (i === now) cls += " now";
      else if (i < now && b.reached.has(i)) cls += " past";
      else if (i > now && overdue) cls += " blocked";
      return `<div class="${cls}" role="listitem">${t}<small>${s}</small></div>`;
    }).join("")}</div>`;
  }
  function renderBuyers(st) {
    const el = $("buyers");
    if (!el) return;
    if (!st.buyers.length) { el.innerHTML = '<div class="card empty">Waiting for the desk…</div>'; return; }
    el.innerHTML = st.buyers.map((b) => {
      const dec = b.decision;
      const tab = [...b.orders.values()].filter((o) => o.route === "ON_TAB" && !o.collected);
      const owed = tab.reduce((s, o) => s + o.amount - o.credited, 0);
      const limit = dec ? dec.limit : 0;
      const used = limit > 0 ? Math.min(100, (owed / limit) * 100) : 0;
      const m = b.mandate;
      const books = b.inputs && b.inputs.booksSource;
      const terms = dec ? dec.terms : "none";
      const reasons = dec ? dec.reasons.filter((r) => !(b.boundAfter && r.code === "NO_MANDATE")) : [];
      return `<article class="card">
        <div class="row"><div class="who-av"><div class="av" style="background:var(${AV[b.id] || "--info"})">${esc(b.name.slice(0, 1))}</div><div><div class="name">${esc(b.name)}</div><div class="addr">${esc(short(b.account))}</div></div></div>
          <span class="badge ${esc(terms)}">${esc(dec ? String(terms).replace("_", "-") : "not assessed")}</span></div>
        ${ladder(b)}
        <div class="limit"><span class="big">${usd(limit)}</span><span class="lbl">credit limit</span></div>
        <div class="bar"><i style="width:${used}%"></i></div>
        <div class="legend2"><span>${usd(owed)} on the tab · ${tab.length} open</span><span>${dec ? usd(Math.max(0, limit - owed)) : "—"} available</span></div>
        <dl>
          <dt>Debit mandate</dt><dd>${m ? `${usd(m.spent)} of ${usd(m.budget)} pulled` : "none"}</dd>
          <dt>On-chain balance</dt><dd>${b.inputs && b.inputs.balance != null ? usd(b.inputs.balance) + " USDZ" : "—"}</dd>
          ${b.card ? `<dt>Visa-secured tab</dt><dd>${b.card.captured != null ? `${usd(b.card.captured)} captured of ${usd(b.card.authorised)} held` : `${usd(b.card.authorised)} held, not taken`}</dd>` : ""}
          ${[...b.statements.values()].map((s) => `<dt>Statement ${esc(s.id)}</dt><dd>${usd(s.total)} · ${esc(s.status)}${s.refusals ? ` · ${s.refusals} refused on chain` : ""}</dd>`).join("")}
          <dt>Books</dt><dd>${books === "t0" ? '<span class="tag t0">T:0</span>' : books ? '<span class="tag">stand-in</span>' : "—"}</dd>
        </dl>
        ${reasons.length ? `<ul class="why">${reasons.slice(0, 4).map((r) => `<li><b>${esc(REASON[r.code] || r.code)}</b> · ${esc(r.detail)}</li>`).join("")}</ul>` : ""}
      </article>`;
    }).join("");
  }

  // ── proof ──────────────────────────────────────────────────────────────
  const checkLi = (c) => `<li><span class="${c.ok ? "ok" : "bad"}">${c.ok ? "✔" : "✘"}</span> ${esc(c.name)}<br><small>${esc(c.detail)}</small></li>`;
  let lastProofSeq = null;
  function renderProof(i) {
    const p = EVENTS.slice(0, i + 1).filter((e) => e.type === "proof").at(-1);
    const el = $("proof");
    if (!el) return;
    if (!p) { el.innerHTML = tryPanel() ? `<div class="proof">${tryPanel()}</div>` : ""; lastProofSeq = null; return; }
    const checks = p.data.checks || [];
    const breaks = checks.filter((c) => !c.ok).length;
    const names = Object.fromEntries(BUYERS.map((b) => [b.id, b.name]));
    const groups = new Map();
    const live = [];
    for (const c of checks) {
      const m = /^([a-z0-9-]+): (.*)$/.exec(c.name);
      if (m && names[m[1]]) (groups.get(m[1]) || groups.set(m[1], []).get(m[1])).push({ ...c, name: m[2] });
      else live.push(c);
    }
    const g = [...groups.entries()].map(([id, cs]) => {
      const bad = cs.filter((c) => !c.ok).length;
      return `<details${bad ? " open" : ""}><summary><span class="${bad ? "bad" : "ok"}">${bad ? "✘" : "✔"}</span> ${esc(names[id])}'s books · ${cs.length - bad}/${cs.length}</summary><ul>${cs.map(checkLi).join("")}</ul></details>`;
    }).join("");
    const fresh = lastProofSeq !== p.seq;
    lastProofSeq = p.seq;
    el.innerHTML = `<div class="proof${fresh && !reduce ? " sweep" : ""}"><div class="head"><b>Every dollar proven</b><span class="${breaks ? "bad" : "ok"}">${checks.length - breaks}/${checks.length} checks pass</span></div>
      ${/^after "/.test(p.summary) ? `<p class="detail" style="margin:8px 0 0">${esc(p.summary)}</p>` : ""}${g}<ul>${live.map(checkLi).join("")}</ul>${tryPanel()}</div>`;
  }
  let tryResult = "";
  function tryPanel() {
    if (!FAULTS) return "";
    const buttons = Object.entries(FAULTS).map(([k, label]) => `<button class="btn" type="button" data-fault="${esc(k)}">${esc(label)}</button>`).join("");
    return `<div class="try"><b>Try to make TAB double-charge</b>${buttons}<output id="tryOut">${esc(tryResult)}</output></div>`;
  }
  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest && ev.target.closest("button[data-fault]");
    if (!btn) return;
    document.querySelectorAll("button[data-fault]").forEach((x) => (x.disabled = true));
    tryResult = "sending to Metal testnet…";
    const o = $("tryOut"); if (o) o.textContent = tryResult;
    try { tryResult = (await fetch(`/api/try/${btn.dataset.fault}`, { method: "POST" }).then((x) => x.json())).message; } catch (e) { tryResult = String(e); }
    const o2 = $("tryOut"); if (o2) o2.textContent = tryResult;
    document.querySelectorAll("button[data-fault]").forEach((x) => (x.disabled = false));
  });

  // ── event log ──────────────────────────────────────────────────────────
  function ids(d) {
    const out = [];
    const tx = d.tx || d.metalTx;
    if (tx) out.push(`<a href="${EXPLORER}${esc(tx)}" target="_blank" rel="noopener">Metal tx ${esc(short(tx))} ↗</a>`);
    if (d.mandateId) out.push(`mandate ${esc(short(d.mandateId))}`);
    if (d.paymentIntentId) out.push(`Airwallex payment ${esc(d.paymentIntentId)}`);
    if (d.airiMandateId) out.push(`Airi mandate ${esc(d.airiMandateId)}`);
    if (d.depositId) out.push(`deposit ${esc(short(d.depositId))}`);
    if (d.conversionId) out.push(`conversion ${esc(short(d.conversionId))}`);
    if (d.journalEntryId) out.push(`T:0 journal ${esc(d.journalEntryId)}`);
    if (d.model) out.push(`model ${esc(d.model)}`);
    return out.length ? `<div class="ids">${out.join("")}</div>` : "";
  }
  function detail(e) {
    const d = e.data || {};
    if (e.type === "policy") {
      const rows = [];
      if (d.goals) rows.push(`<div>CFO typed: <q>${esc(d.goals)}</q></div>`);
      for (const r of d.diff || []) rows.push(`<div>Dry run · ${esc(r.name)}: ${esc(r.before.terms)} ${usd(r.before.limit)} → ${esc(r.after.terms)} ${usd(r.after.limit)}${r.wouldCollect ? ` · would collect ${usd(r.wouldCollect)}` : ""}</div>`);
      if (d.kid) rows.push(`<div>Signed with the CFO's key (${esc(short(d.kid))}); the desk verified the signature itself before applying it.</div>`);
      return `<div class="detail">${rows.join("")}</div>`;
    }
    if (e.type === "dispute" && d.summary) return `<div class="detail"><div>Claude's reading: ${esc(d.summary)}</div></div>`;
    return "";
  }
  const names = () => Object.fromEntries(BUYERS.map((b) => [b.id, b.name]));
  function eventRow(e, now) {
    const t = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const who = e.buyerId && e.buyerId !== "desk" ? names()[e.buyerId] || e.buyerId : "Northwind desk";
    const label = TYPE_LABEL[e.type] || e.type.replace("_", " ");
    return `<li class="ev ${esc(e.type)}${now ? " now" : ""}"><span class="ico t-${esc(e.type)}">${svgIcon(TYPE_ICON[e.type])}</span><time>${t}</time>
      <div class="sum"><div class="who">${esc(who)} <span class="pill t-${esc(e.type)}">${esc(label)}</span></div><div class="text">${esc(e.summary)}</div>${detail(e)}${ids(e.data || {})}</div></li>`;
  }
  function renderTimeline(i, highlight) {
    const el = $("timeline");
    if (!el) return;
    const shownEv = EVENTS.slice(0, i + 1);
    if (!shownEv.length) { el.innerHTML = `<li class="empty">${LIVE ? "Waiting for the desk…" : "Press Play to start the run."}</li>`; return; }
    // Newest first; each scene's header sits above its newest event.
    const out = [];
    let prev;
    shownEv.slice().reverse().filter((e) => e.type !== "scene").forEach((e, k) => {
      const sk = SCENES.of.get(e.seq) ?? null;
      if (sk && sk !== prev) {
        const s = SCENES.list.find((x) => x.key === sk);
        out.push(`<li class="scene-row"><b>${esc(sk)}</b>${esc(s ? s.title : "")}</li>`);
      }
      prev = sk;
      out.push(eventRow(e, highlight && k === 0));
    });
    el.innerHTML = out.join("");
  }

  // ── render everything as of idx ────────────────────────────────────────
  function render(highlight) {
    const st = stateAt(idx);
    renderBuyers(st);
    renderProof(idx);
    renderTimeline(idx, highlight);
    countTo("k-terms", st.k.terms, (v) => usd(Math.round(v)));
    countTo("k-collected", st.k.collected, (v) => usd(Math.round(v)));
    countTo("k-refused", st.k.refusedChain, (v) => String(Math.round(v)));
    const pr = $("k-proof");
    if (pr) pr.textContent = st.k.proof ? `${st.k.proof.pass}/${st.k.proof.total}` : "—";
    const stats = $("railstats");
    if (stats) stats.innerHTML = `<span><i style="background:var(--metal)"></i>Metal: ${st.k.pulls} pull(s), ${st.k.refusals} refusal(s) recorded</span><span><i style="background:var(--visa)"></i>Visa: ${st.k.holds} hold(s), ${usd(st.k.captured)} captured</span><span><i style="background:var(--awx)"></i>Airwallex: ${st.k.settled} settled → ${st.k.sgd.toFixed(2)} SGD</span><span><i style="background:var(--t0)"></i>T:0: ${st.k.journals} journal entr${st.k.journals === 1 ? "y" : "ies"}</span>`;
    const sk = idx >= 0 ? SCENES.of.get(EVENTS[idx].seq) : null;
    const s = sk ? SCENES.list.find((x) => x.key === sk) : null;
    const cap = $("caption");
    if (cap) cap.innerHTML = s ? `<b>${esc(s.key)}</b>${esc(s.title)}` : LIVE ? "Waiting for the next scene…" : "Before the run: no buyer has credit yet.";
    const k = s ? SCENES.list.indexOf(s) : -1;
    document.querySelectorAll("#scenes button").forEach((b) => { const n = Number(b.dataset.k); b.classList.toggle("on", n === k); b.classList.toggle("done", k >= 0 && n < k); });
    const scrub = $("scrub");
    if (scrub) { scrub.max = String(EVENTS.length); scrub.value = String(idx + 1); }
    const pos = $("pos");
    if (pos) pos.textContent = `event ${idx + 1} of ${EVENTS.length}`;
    const back = $("back"); if (back) back.disabled = idx < 0;
    const fwd = $("fwd"); if (fwd) fwd.disabled = idx >= EVENTS.length - 1;
  }
  function renderScenes() {
    const el = $("scenes");
    if (el) el.innerHTML = SCENES.list.map((s, k) => `<button type="button" data-k="${k}" title="${esc(s.title)}">${esc(s.key)}</button>`).join("");
  }

  // ── player (replay) ────────────────────────────────────────────────────
  function stop() { if (timer !== null) clearTimeout(timer); timer = null; const p = $("play"); if (p) p.innerHTML = "▶ Play"; }
  async function tick() {
    if (idx >= EVENTS.length - 1) { stop(); render(false); return; }
    idx++;
    render(true);
    await enqueue(EVENTS[idx]);
    if (timer !== null) timer = setTimeout(tick, Math.max(150, speed * 0.35));
  }
  function play() {
    if (idx >= EVENTS.length - 1) idx = -1;
    clearQueue();
    const p = $("play"); if (p) p.innerHTML = "❚❚ Pause";
    timer = setTimeout(tick, 50);
  }
  function jump(to) { stop(); clearQueue(); idx = Math.max(-1, Math.min(EVENTS.length - 1, to)); render(false); }
  function wirePlayer() {
    if (LIVE) return;
    $("play").addEventListener("click", () => (timer === null ? play() : (stop(), render(false))));
    $("restart").addEventListener("click", () => jump(-1));
    $("back").addEventListener("click", () => jump(idx - 1));
    $("fwd").addEventListener("click", () => { stop(); clearQueue(); if (idx < EVENTS.length - 1) { idx++; render(true); enqueue(EVENTS[idx]); } });
    $("speed").addEventListener("change", (e) => { speed = Number(e.target.value); });
    $("scrub").addEventListener("input", (e) => jump(Number(e.target.value) - 1));
    $("scenes").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-k]");
      if (!b) return;
      const k = Number(b.dataset.k);
      const next = SCENES.list[k + 1];
      const end = next ? EVENTS.findIndex((e) => e.seq === next.firstSeq) - 1 : EVENTS.length - 1;
      jump(end);
    });
    document.addEventListener("keydown", (e) => {
      if (e.target.closest && e.target.closest("input, select, textarea")) return;
      if (e.key === " ") { e.preventDefault(); $("play").click(); }
      if (e.key === "ArrowRight") $("fwd").click();
      if (e.key === "ArrowLeft") $("back").click();
    });
  }

  // ═══ Site: views, overview receipt, guarantees, proof page, built on, tour ═══
  ICON.receipt = "M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6M9 16h4";
  document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = svgIcon(el.dataset.icon); });

  const VIEWS = ["overview", "desk", "guarantees", "proof", "built-on"];
  let view = null;
  function showView(v, opts = {}) {
    if (!VIEWS.includes(v)) v = LIVE ? "desk" : "overview";
    if (v === view && !opts.force) return;
    view = v;
    document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.dataset.view === v));
    document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.view === v));
    moveInk();
    if (location.hash.slice(1) !== v) history.replaceState(null, "", `#${v}`);
    if (v === "overview") renderReceipt();
    if (v === "guarantees") renderGuarantees();
    if (v === "proof") renderProofPage();
    if (v === "built-on") renderBuilt();
    if (!opts.keepScroll) window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }
  function moveInk() {
    const bar = $("inkbar");
    const on = document.querySelector("#tabs a.on");
    if (!bar || !on) return;
    bar.style.left = `${on.offsetLeft}px`;
    bar.style.width = `${on.offsetWidth}px`;
  }
  addEventListener("resize", moveInk);
  addEventListener("hashchange", () => showView(location.hash.slice(1)));
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest && ev.target.closest("#tabs a, a.brand");
    if (a) { ev.preventDefault(); showView(a.dataset.view || "overview"); return; }
    const act = ev.target.closest && ev.target.closest("[data-action]");
    if (!act) return;
    if (act.dataset.action === "tour") startTour();
    if (act.dataset.action === "watch") { showView("desk"); if (!LIVE) { jump(-1); play(); } }
    if (act.dataset.action === "scene") { showView("desk"); playScene(act.dataset.scene); }
  });

  /** Jump the replay to just before a scene, then play that scene with its animations. */
  async function playScene(key, opts = {}) {
    if (LIVE) return;
    const k = SCENES.list.findIndex((s) => s.key === key);
    if (k < 0) return;
    const startSeq = SCENES.list[k].firstSeq;
    const next = SCENES.list[k + 1];
    const startIdx = EVENTS.findIndex((e) => e.seq === startSeq);
    const endIdx = next ? EVENTS.findIndex((e) => e.seq === next.firstSeq) - 1 : EVENTS.length - 1;
    jump(startIdx - 1);
    const gen = ++sceneGen;
    if (opts.scroll !== false) document.querySelector(".railcard")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    await sleep(350);
    for (let i = startIdx; i <= endIdx; i++) {
      if (gen !== sceneGen) return;
      idx = i;
      render(true);
      if (tourAt >= 0) { const tg = document.querySelector(TOUR[tourAt].target); const r = tg && tg.getBoundingClientRect(); if (r && (r.top < 0 || r.bottom > innerHeight)) tg.scrollIntoView({ behavior: "auto", block: "center" }); placeTour(tg); } // the layout moved
      await animate(EVENTS[i]);
      await sleep(Math.max(120, speed * 0.25));
    }
  }
  let sceneGen = 0;

  // ── overview: Acme's tab as a printed receipt ──────────────────────────
  function renderReceipt() {
    const el = $("receipt");
    if (!el) return;
    const acmeId = BUYERS[0] ? BUYERS[0].id : "acme";
    const orders = [];
    const credits = [];
    const txs = [];
    for (const e of EVENTS) {
      if (e.buyerId !== acmeId) continue;
      const d = e.data || {};
      if (e.type === "order" && d.order && (d.order.route === "ON_TAB" || d.order.route === "CARD_AUTH")) orders.push({ text: d.order.description, amount: d.order.amount, disc: d.order.discount });
      if (e.type === "credit") credits.push(d.amount || 0);
      if (e.type === "collect" && d.tx && !txs.some((t) => t.tx === d.tx)) txs.push({ tx: d.tx, amount: Number(d.amount || 0) });
    }
    if (!orders.length) { el.innerHTML = `<div class="r-head"><b>NORTHWIND DATA</b>Waiting for the first order…</div>`; return; }
    const name = BUYERS[0] ? BUYERS[0].name.replace(/ (procurement|sourcing|buying) agent$/, "") : "Acme";
    const sub = orders.reduce((s, o) => s + o.amount, 0);
    const cr = credits.reduce((s, c) => s + c, 0);
    const paid = txs.reduce((s, t) => s + t.amount, 0);
    const lines = [];
    let delay = 0.15;
    const line = (l, r, cls = "") => { lines.push(`<div class="r-line ${cls}" style="animation-delay:${delay.toFixed(2)}s"><span>${l}</span><span>${r}</span></div>`); delay += 0.22; };
    for (const o of orders) line(esc(o.text.replace(/ · /, " × ").slice(0, 34)), usd(o.amount));
    if (orders.some((o) => o.disc)) line(`incl. ${Math.round((orders.find((o) => o.disc).disc) * 100)}% early-pay discount`, "", "muted");
    if (cr) line("credit note (stale data, QA)", `−${usd(cr)}`, "muted");
    line("ON THE TAB", usd(sub - cr), "tot");
    const links = txs.map((t) => `<a href="${EXPLORER}${esc(t.tx)}" target="_blank" rel="noopener">${esc(short(t.tx))}</a> ${usd(t.amount)}`).join(" · ");
    el.innerHTML = `<div class="r-head"><b>NORTHWIND DATA</b>${esc(name)} · tab on net terms</div>${lines.join("")}
      <div class="r-foot" style="animation-delay:${delay.toFixed(2)}s">Collected on Metal: ${links || "pending"}</div>
      ${paid ? `<div class="stamp-mark" style="animation-delay:${(delay + 0.35).toFixed(2)}s">Collected<br>on chain<small>${usd(paid)} · ${txs.length} tx</small></div>` : ""}`;
  }

  // ── guarantees ─────────────────────────────────────────────────────────
  const sceneOfFirst = (pred) => { const e = EVENTS.find(pred); return e ? SCENES.of.get(e.seq) : null; };
  const txLink = (tx, label) => `<a href="${EXPLORER}${esc(tx)}" target="_blank" rel="noopener">${esc(label || short(tx))} ↗</a>`;
  function renderGuarantees() {
    const el = $("g-grid");
    if (!el) return;
    const stRef = EVENTS.filter((e) => e.type === "refused" && e.data && e.data.statementId && e.data.tx);
    const stCol = EVENTS.find((e) => e.type === "collect" && e.data && e.data.statementId && e.data.tx);
    const hold = EVENTS.find((e) => e.type === "vic" && e.data && e.data.checks && "authorised" in e.data.checks);
    const cap = EVENTS.find((e) => e.type === "vic" && e.data && e.data.captured != null);
    const pols = EVENTS.filter((e) => e.type === "policy");
    const polRef = EVENTS.find((e) => e.type === "refused" && e.buyerId === "desk" && /policy/.test(e.summary));
    const show = (key, label = "Show me in the run") => key && !LIVE ? `<button class="btn" type="button" data-action="scene" data-scene="${esc(key)}">${label} →</button>` : "";
    const cards = [
      {
        t: "The statement is the mandate", c: "--metal",
        p: "Each statement is its own Metal mandate: the total, once, inside its due window. The buyer's human binding it is the acceptance. Collect early or twice and the chain refuses, and Northwind records the refusal on chain.",
        anim: `<svg viewBox="0 0 360 86"><rect x="150" y="18" width="110" height="34" rx="8" fill="color-mix(in srgb, var(--metal) 14%, transparent)" stroke="var(--metal)" stroke-dasharray="4 4"/><text x="205" y="12" text-anchor="middle">due window</text><line x1="10" y1="35" x2="350" y2="35" stroke="var(--line)" stroke-width="2"/><circle class="loop" cx="20" cy="35" r="8" style="animation-name:g1"/><text class="loop big" x="120" y="74" text-anchor="middle" style="animation-name:flashR1;fill:var(--bad)">early: refused</text><text class="loop big" x="205" y="74" text-anchor="middle" style="animation-name:flashG;fill:var(--good)">on time: paid</text><text class="loop big" x="300" y="74" text-anchor="middle" style="animation-name:flashR2;fill:var(--bad)">again: refused</text></svg>`,
        ids: [...stRef.map((e) => txLink(e.data.tx, `refusal ${short(e.data.tx)}`)), stCol ? txLink(stCol.data.tx, `paid ${short(stCol.data.tx)}`) : ""].join(""),
        test: "test/statements.test.ts", scene: stRef[0] ? SCENES.of.get(stRef[0].seq) : null,
      },
      {
        t: "The card hold is the guarantee", c: "--visa",
        p: "A buyer with no history pays later on a card-secured tab: a passkey-approved Visa authorisation holds the amount, and at the due date the desk captures only what is still owed after credits. That verified payment is the buyer's first rung of credit.",
        anim: `<svg viewBox="0 0 360 86"><text x="30" y="14">Visa hold ${cap ? usd(cap.data.authorised) : "$60.00"}</text><rect x="30" y="22" width="300" height="26" rx="7" fill="none" stroke="var(--visa)" stroke-width="2"/><rect class="loop bar0" x="30" y="22" width="300" height="26" rx="7" style="animation-name:holdIn;fill:color-mix(in srgb, var(--visa) 16%, transparent)"/><rect class="loop bar0" x="270" y="22" width="60" height="26" style="animation-name:credit;fill:var(--bar)"/><rect class="loop bar0" x="30" y="22" width="240" height="26" rx="7" style="animation-name:capture;fill:var(--visa)"/><text class="loop big" x="30" y="74" style="animation-name:fadeLate">captured ${cap ? usd(cap.data.captured) : "$48.00"} · credit ${cap ? usd(cap.data.authorised - cap.data.captured) : "$12.00"} never taken</text></svg>`,
        ids: [hold ? `<span>Airwallex ${esc(hold.data.paymentIntentId)}</span>` : "", hold ? `<span>Airi ${esc(hold.data.airiMandateId)}</span>` : ""].join(""),
        test: "test/card-tab.test.ts · test/card-capture.test.ts", scene: cap ? SCENES.of.get(cap.seq) : null,
      },
      {
        t: "A signed policy, verified by the desk", c: "--cfo",
        p: "The CFO types goals; Claude proposes changes to fixed fields and says what it can't express; code checks hard rails and dry-runs every buyer; the CFO's key signs the policy and its audit trail; the desk verifies the signature itself, on apply and on every load.",
        anim: `<svg viewBox="0 0 360 86">${["goals", "Claude", "rails", "signed", "desk ✓"].map((w, i) => `<g class="loop" style="animation-name:pop${Math.min(4, i)};transform-origin:${36 + i * 72}px 35px"><rect x="${8 + i * 72}" y="18" width="58" height="34" rx="9" fill="var(--panel)" stroke="${i === 4 ? "var(--good)" : i === 3 ? "var(--cfo)" : i === 1 ? "var(--claude)" : "var(--line)"}" stroke-width="2"/><text class="big" x="${37 + i * 72}" y="40" text-anchor="middle">${w}</text></g>${i < 4 ? `<path d="M${66 + i * 72} 35h6" stroke="var(--muted)" stroke-width="2"/>` : ""}`).join("")}<text x="180" y="76" text-anchor="middle">an edited copy fails the signature and is refused</text></svg>`,
        ids: `<span>${pols.length} signed polic${pols.length === 1 ? "y" : "ies"} applied</span>${polRef ? `<span>1 edited copy refused</span>` : ""}`,
        test: "test/policy.test.ts", scene: pols[0] ? SCENES.of.get(pols[0].seq) : null, scene2: pols[1] ? SCENES.of.get(pols[1].seq) : null,
      },
      {
        t: "Crash-safe collections", c: "--awx",
        p: "Before sending a pull the desk records it with the mandate's spent total. If the desk dies before hearing back, the restarted desk checks the chain: if the money moved, it records that transaction and sends nothing again. A statement can never include orders in a pull still in flight.",
        anim: `<svg viewBox="0 0 360 86"><rect x="8" y="18" width="70" height="34" rx="9" fill="var(--panel)" stroke="var(--line)" stroke-width="2"/><text class="big" x="43" y="40" text-anchor="middle">desk</text><rect x="272" y="18" width="80" height="34" rx="9" fill="var(--panel)" stroke="var(--metal)" stroke-width="2"/><text class="big" x="312" y="40" text-anchor="middle">Metal</text><circle class="loop" cx="100" cy="35" r="7" style="animation-name:pullGo;fill:var(--metal)"/><path class="loop" d="M118 8l-10 16h9l-8 16" fill="none" stroke="var(--bad)" stroke-width="3" style="animation-name:bolt"/><text class="loop big" x="180" y="76" text-anchor="middle" style="animation-name:foundIt;fill:var(--good);transform-origin:180px 70px">restarted · found on chain · pulls sent: 1</text></svg>`,
        ids: `<span>live fault on a copy of this run:</span>${txLink("0xb6a6361fa19d0f6a32e64e145526bd866d3d946b36ad9cc6779ae5e19f03a355", "the one $20.00 pull")}`,
        test: "test/faults.test.ts · test/money-guards.test.ts", scene: null,
      },
    ];
    el.innerHTML = cards.map((g) => `<article class="panel g-card lift" style="--c:var(${g.c})">
      <div class="g-anim">${g.anim}</div>
      <h3 style="color:var(${g.c})">${g.t}</h3><p>${g.p}</p>
      <div class="ev-ids">${g.ids}</div>
      <div class="row-end"><span class="tested">✓ ${esc(g.test)}</span><span>${show(g.scene)}${g.scene2 ? " " + show(g.scene2, "Mid-book") : ""}</span></div>
    </article>`).join("");
  }

  // ── proof page ─────────────────────────────────────────────────────────
  function renderProofPage() {
    const st = stateAt(EVENTS.length - 1);
    const pr = st.k.proof;
    const ring = "EVERY DOLLAR PROVEN · ON CHAIN · IN AIRWALLEX · IN T:0 · ";
    $("seal").innerHTML = `<svg viewBox="0 0 260 260" role="img" aria-label="${pr ? `${pr.pass} of ${pr.total} checks pass` : "no proof yet"}">
      <defs><path id="ringPath" d="M130 130 m-100 0 a100 100 0 1 1 200 0 a100 100 0 1 1 -200 0"/></defs>
      <circle cx="130" cy="130" r="118" fill="var(--panel)" stroke="var(--good)" stroke-width="3"/>
      <circle cx="130" cy="130" r="82" fill="none" stroke="var(--line)" stroke-width="2" stroke-dasharray="3 5"/>
      <g class="seal-ring"><text><textPath href="#ringPath">${ring}${ring}</textPath></text></g>
      <text class="seal-core" x="130" y="140" text-anchor="middle">${pr ? `${pr.pass}/${pr.total}` : "—"}</text>
      <text class="seal-sub" x="130" y="166" text-anchor="middle">checks pass</text></svg>`;
    // reuse the desk's proof renderer into the full page
    const slot = $("proof");
    const holder = document.createElement("div");
    holder.id = "proof";
    const saved = slot;
    if (saved) saved.id = "proof-desk";
    $("proof-full").innerHTML = "";
    $("proof-full").appendChild(holder);
    renderProof(EVENTS.length - 1);
    holder.removeAttribute("id");
    if (saved) saved.id = "proof";
    // every id, checkable
    const rows = [];
    const kind = (e) => ({ mandate: e.data.budget != null ? `credit line bound (${usd(e.data.budget)})` : "mandate", statement: "statement accepted (its own mandate)", collect: e.data.statementId ? "statement collected" : "credit-line collection", refused: "collection refused, recorded on chain" })[e.type] || e.type;
    for (const e of EVENTS) {
      const d = e.data || {};
      const who = names()[e.buyerId] || e.buyerId;
      if (d.tx) rows.push(`<tr><td>Metal</td><td>${esc(kind(e))}</td><td>${esc(who)}</td><td class="num">${d.amount != null ? usd(Number(d.amount)) : ""}</td><td class="mono">${txLink(d.tx)}</td></tr>`);
      if (e.type === "vic" && d.paymentIntentId) rows.push(`<tr><td>Airwallex</td><td>${d.captured != null ? `card capture ${usd(d.captured)} of ${usd(d.authorised)}` : d.checks && "authorised" in d.checks ? "card authorisation (hold)" : "earlier Visa payment, re-read"}</td><td>${esc(who)}</td><td class="num">${d.captured != null ? usd(d.captured) : ""}</td><td class="mono">${esc(d.paymentIntentId)}</td></tr>`);
      if (e.type === "settle" && d.conversionId) rows.push(`<tr><td>Airwallex</td><td>${esc(e.summary.replace(/^deposited /, "deposit "))}</td><td>${esc(who)}</td><td class="num"></td><td class="mono">${esc(short(d.conversionId))}</td></tr>`);
      if (e.type === "books" && d.journalEntryId) rows.push(`<tr><td>T:0</td><td>${esc(e.summary)}</td><td>${esc(who)}</td><td class="num"></td><td class="mono">${esc(d.journalEntryId)}</td></tr>`);
    }
    $("txs").innerHTML = `<thead><tr><th>Rail</th><th>What</th><th>Buyer</th><th>Amount</th><th>Id</th></tr></thead><tbody>${rows.join("")}</tbody>`;
  }

  // ── built on ───────────────────────────────────────────────────────────
  function renderBuilt() {
    const st = stateAt(EVENTS.length - 1);
    const count = (t, f = () => true) => EVENTS.filter((e) => e.type === t && f(e.data || {}, e)).length;
    const model = (EVENTS.find((e) => e.data && e.data.model) || { data: {} }).data.model || "Claude";
    const panels = [
      { n: "Metal", c: "--metal", ic: "link", role: "where credit lives and money moves", used: ["Supplier-issued debit mandates bound by each buyer's human: the credit line and its cap", "A statement as its own mandate: budget = total, one payment, a due window", "Supplier-held pull key; replace mandate when the human cuts the line", "Refusals recorded on chain by the supplier"], stats: [[count("mandate"), "mandates bound"], [count("statement"), "statement mandates"], [st.k.pulls, "collections"], [st.k.refusals, "refusals on chain"]], code: "src/metal/agent.ts · Desk.collectStatement" },
      { n: "Visa Intelligent Commerce · Airi", c: "--visa", ic: "card", role: "how a new buyer earns trust", used: ["Passkey-approved mandate per card statement (VIC via Airi)", "Single-use credential read once into a 0600 file, then deleted", "Pre-authorise the full statement; capture only the undisputed amount", "The verified capture counts toward terms once, for one buyer"], stats: [[st.k.holds, "card holds"], [usd(st.k.captured), "captured"], [count("vic"), "Visa events read back"]], code: "src/visa/card-statement.ts · Desk.verifyCardCapture" },
      { n: "Airwallex", c: "--awx", ic: "globe", role: "the supplier's bank", used: ["Payment Acceptance: create, confirm (pre-auth), partial capture, read back", "Every Visa payment re-read before it counts", "FX quote and conversion USD → SGD, with a refund reserve", "Global Account deposits referencing the Metal tx (sandbox simulation)"], stats: [[st.k.settled, "settlements"], [st.k.sgd.toFixed(2), "SGD converted"], [count("vic"), "payment intents read"]], code: "src/settlement/bridge.ts · src/airwallex/client.ts" },
      { n: "T:0", c: "--t0", ic: "book", role: "the books that decide and record", used: ["Payment history read over MCP decides net-30 vs net-7 vs prepay", "Every settled collection posted as a balanced journal entry tied to its Metal tx", "Idempotent posting (a repeat is answered, not doubled)"], stats: [[st.k.journals, "journal entries"], [count("books", (d) => d.source === "t0" && !d.journalEntryId), "history reads"]], code: "src/books/books.ts" },
      { n: "Claude", c: "--claude", ic: "spark", role: "reads and proposes, never decides money", used: ["Buyer agents with typed tools (catalog, account, offer, order) via the tool runner", "Structured outputs: the CFO policy compiler and the dispute reader", "Says what it can't express instead of guessing", `Model: ${model}`], stats: [[count("agent"), "agent decisions"], [count("policy"), "policies compiled"], [count("dispute"), "disputes read"]], code: "src/agents/buyer.ts · src/policy/policy.ts · src/disputes/reader.ts" },
      { n: "Northwind desk (code)", c: "--accent", ic: "desk", role: "where every dollar is decided", used: ["Credit engine in integer cents: limit = min(terms cap, mandate headroom, balance)", "Rails on policy; credits at the price charged; whole-order collections", "Crash-safe pulls reconciled from the chain", "21 proof checks after every run"], stats: [[EVENTS.length, "events logged"], [st.k.proof ? `${st.k.proof.pass}/${st.k.proof.total}` : "—", "proof checks"]], code: "src/desk/desk.ts · src/proof/checker.ts" },
    ];
    $("built").innerHTML = panels.map((p) => `<article class="panel bpanel lift" style="--c:var(${p.c})">
      <div class="bh"><div class="bico">${svgIcon(p.ic)}</div><div><h3>${esc(p.n)}</h3><div class="role">${esc(p.role)}</div></div></div>
      <div class="stats">${p.stats.map(([v, l]) => `<span class="stat"><b>${esc(String(v))}</b>${esc(l)}</span>`).join("")}</div>
      <ul class="checks">${p.used.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>
      <div class="code">${esc(p.code)}</div></article>`).join("");
  }

  // ── guided tour ────────────────────────────────────────────────────────
  const TOUR = [
    { view: "overview", target: ".hero-copy h1", title: "TAB in one line", body: "Agents can buy, but only by paying up front. TAB lets a supplier sell to AI agents on credit, and still get every dollar, provably." },
    { view: "overview", target: "#receipt", title: "A real tab from a live run", body: "Acme's Claude agent bought three things on net terms and took the 3% early-pay discount. The stamp links to the actual Metal transactions that collected it." },
    { view: "desk", target: ".railcard", scene: "1", title: "The rails", body: "Every packet you'll see is a real event: Metal mandates and collections, the Visa card hold, Airwallex settlement, T:0 journal entries. Here Acme's human binds a $400 credit line." },
    { view: "desk", target: ".railcard", scene: "1b", title: "The CFO types goals", body: "Claude turns plain English into policy changes; code checks the rails, dry-runs every buyer, and the desk verifies the CFO's signature. A copy edited after signing is refused." },
    { view: "desk", target: "#buyers .card:nth-child(2)", scene: ["3", "3b", "3c", "3d"], title: "A new buyer climbs the ladder", body: "Globex has no history. A passkey-approved Visa hold secures a 7-day tab; after a $12 credit, only $48 of $60 is captured, and that payment earns it net-7." },
    { view: "desk", target: ".railcard", scene: "5b", title: "Mid-book, the book re-prices", body: "The CFO caps any buyer at $100 with tabs open. The dry run shows the excess, and once the signed policy lands the desk collects it on chain." },
    { view: "desk", target: ".railcard", scene: "6b", title: "The statement is the mandate", body: "Acme's statement is its own Metal mandate. Watch the early collection bounce off Metal: refused on chain, and the refusal is recorded." },
    { view: "guarantees", target: "#g-grid", title: "Four guarantees", body: "Each is enforced by a rail or by code, visible in the run, and covered by a test, including a live crash in the middle of a pull." },
    { view: "proof", target: "#seal", title: "Every dollar proven", body: "After the run the desk re-reads everything: transfers on chain, card captures in Airwallex, journal entries in T:0. Every id on this page is checkable." },
    { view: "built-on", target: "#built", title: "Built on", body: "Metal, Visa via Airi, Airwallex, T:0 and Claude, each doing one job, with the numbers from this run. That's TAB." },
  ];
  let tourAt = -1;
  function startTour() { tourAt = 0; $("tour").hidden = false; tourGo(); }
  function endTour() { tourAt = -1; $("tour").hidden = true; sceneGen++; }
  async function tourGo() {
    const s = TOUR[tourAt];
    if (!s) return endTour();
    showView(s.view, { keepScroll: true });
    $("tourStep").textContent = `Step ${tourAt + 1} of ${TOUR.length}`;
    $("tourTitle").textContent = s.title;
    $("tourBody").textContent = s.body;
    $("tourDots").innerHTML = TOUR.map((_, i) => `<i class="${i === tourAt ? "on" : ""}"></i>`).join("");
    $("tourBack").disabled = tourAt === 0;
    $("tourNext").textContent = tourAt === TOUR.length - 1 ? "Finish" : "Next";
    // Instant scroll: a smooth one is cancelled when the replay re-renders the element mid-scroll.
    const target = document.querySelector(s.target);
    if (target) target.scrollIntoView({ behavior: "auto", block: "center" });
    await sleep(60);
    placeTour(document.querySelector(s.target));
    if (s.scene && !LIVE) {
      (async () => {
        for (const k of [].concat(s.scene)) { if (TOUR[tourAt] !== s) return; await playScene(k, { scroll: false }); }
        if (TOUR[tourAt] === s) placeTour(document.querySelector(s.target));
      })();
    }
  }
  function placeTour(target) {
    const spot = $("tourSpot");
    const card = $("tourCard");
    if (!target) { spot.style.cssText = "left:50%;top:50%;width:0;height:0"; card.style.left = "50%"; card.style.top = "50%"; return; }
    const r = target.getBoundingClientRect();
    const pad = 8;
    spot.style.left = `${r.left - pad}px`; spot.style.top = `${r.top - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`; spot.style.height = `${Math.min(r.height + pad * 2, innerHeight - 24)}px`;
    const cw = card.offsetWidth || 360;
    const ch = card.offsetHeight || 200;
    const fits = (t) => t >= 12 && t + ch <= innerHeight - 12;
    let top, left;
    if (fits(r.bottom + 16)) { top = r.bottom + 16; left = r.left; }          // below
    else if (fits(r.top - ch - 16)) { top = r.top - ch - 16; left = r.left; } // above
    else if (innerWidth - r.right >= cw + 32) { left = r.right + 16; top = r.top; } // beside, right
    else if (r.left >= cw + 32) { left = r.left - cw - 16; top = r.top; }          // beside, left
    else { top = innerHeight - ch - 16; left = r.left; }                           // overlay at the bottom
    top = Math.min(Math.max(12, top), innerHeight - ch - 12);
    left = Math.min(Math.max(16, left), innerWidth - cw - 16);
    card.style.top = `${top}px`; card.style.left = `${left}px`;
  }
  $("tourNext")?.addEventListener("click", () => { tourAt++; tourGo(); });
  $("tourBack")?.addEventListener("click", () => { tourAt = Math.max(0, tourAt - 1); tourGo(); });
  $("tourSkip")?.addEventListener("click", endTour);
  $("tourBtn")?.addEventListener("click", startTour);
  addEventListener("keydown", (e) => {
    if (tourAt < 0) return;
    if (e.key === "Escape") endTour();
    if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); tourAt++; tourGo(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); tourAt = Math.max(0, tourAt - 1); tourGo(); }
  }, true);
  addEventListener("resize", () => { if (tourAt >= 0) placeTour(document.querySelector(TOUR[tourAt].target)); });
  addEventListener("scroll", () => { if (tourAt >= 0) placeTour(document.querySelector(TOUR[tourAt].target)); }, { passive: true });

  // ── boot ───────────────────────────────────────────────────────────────
  async function boot() {
    document.body.classList.toggle("is-live", LIVE);
    const mode = $("mode");
    if (LIVE) {
      if (mode) { mode.classList.add("live"); mode.innerHTML = "<i></i>Live desk"; }
      const s = await fetch("/api/state").then((r) => r.json());
      EVENTS = s.events; BUYERS = s.buyers; FAULTS = s.faults;
      idx = EVENTS.length - 1;
      SCENES = sceneModel(); renderScenes(); render(false);
      const foot = $("source"); if (foot) foot.textContent = `Desk log: ${s.deskFile}.`;
      const es = new EventSource(`/api/stream?after=${EVENTS.length ? EVENTS.at(-1).seq : 0}`);
      es.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.reset) { location.reload(); return; }
        if (d.buyers) BUYERS = d.buyers;
        for (const e of d.events) {
          EVENTS.push(e);
          SCENES = sceneModel(); renderScenes();
          enqueue(e).then(() => { idx = EVENTS.indexOf(e); render(true); if (view && view !== "desk") showView(view, { force: true, keepScroll: true }); });
        }
      };
    } else {
      if (mode) mode.innerHTML = `<i></i>Replay · run ${esc(RUN.run)}`;
      const runId = $("runId"); if (runId) runId.textContent = `run ${RUN.run}`;
      const ranAt = $("ranAt"); if (ranAt) ranAt.textContent = new Date(RUN.ranAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      renderScenes(); render(false); wirePlayer();
    }
    showView(location.hash.slice(1) || (LIVE ? "desk" : "overview"), { force: true, keepScroll: true });
    requestAnimationFrame(moveInk);
    if (document.fonts) document.fonts.ready.then(moveInk);
  }
  boot();
})();
