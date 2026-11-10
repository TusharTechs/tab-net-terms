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
      const step = (now) => {
        let u = Math.min(1, (now - start) / D);
        const ease = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        let f = ease;
        if (bounce) f = u < 0.7 ? (ease / easeAt(0.7)) * 0.86 : 0.86 - (u - 0.7) * 1.2;
        const at = p.getPointAtLength(len * (back ? 1 - f : f));
        c.setAttribute("cx", at.x); c.setAttribute("cy", at.y);
        if (t) { t.setAttribute("x", at.x); t.setAttribute("y", at.y - 12); }
        if (bounce && u >= 0.7) g.style.opacity = String(Math.max(0, 1 - (u - 0.7) / 0.3));
        if (u < 1) requestAnimationFrame(step);
        else { g.remove(); p.classList.remove("hot"); p.style.stroke = ""; resolve(); }
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
    const now = terms === "NET_30" ? 3 : terms === "NET_7" ? 2 : b.card && b.card.captured == null ? 1 : 0;
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
          enqueue(e).then(() => { idx = EVENTS.indexOf(e); render(true); });
        }
      };
    } else {
      if (mode) mode.innerHTML = `<i></i>Replay · run ${esc(RUN.run)}`;
      const runId = $("runId"); if (runId) runId.textContent = `run ${RUN.run}`;
      const ranAt = $("ranAt"); if (ranAt) ranAt.textContent = new Date(RUN.ranAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      renderScenes(); render(false); wirePlayer();
    }
  }
  boot();
})();
