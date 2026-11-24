// Functions the iOS lab runs inside the page, through the Web Inspector.
// Each is sent as its source text, so none may close over anything here.

/**
 * Installed in every document after it loads (the Inspector has no init
 * scripts): the last real pointerdown, page lifecycle, the paid moment, the
 * page's own fetches, and the finders the journeys aim with.
 */
export function PROBE() {
  if (window.__lab) return;
  const lab = {
    events: [],
    tap: undefined,
    expect: undefined,
    paidAt: undefined,
    loadedAt: Date.now(),
    answers: [],
    fetches: [],
  };
  window.__lab = lab;
  const note = (type) => lab.events.push({ type, at: Date.now(), state: document.visibilityState });

  // ---- every element, shadow roots included
  const all = () => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  };
  const norm = (s) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.01;
  };
  // biome-ignore lint/performance/useDomNodeTextContent: the rendered text, as the payer reads it
  const nameOf = (el) => norm(el.getAttribute?.("aria-label") || el.innerText || el.textContent);
  const closestDeep = (el, selector) => {
    for (let n = el; n; n = n.parentElement ?? n.getRootNode?.()?.host) {
      if (n.matches?.(selector)) return n;
    }
    return null;
  };
  lab.findEl = (q) => {
    const re = (source) => (source === undefined ? undefined : new RegExp(source, q.flags ?? ""));
    const name = re(q.name);
    const own = re(q.ownText);
    const placeholder = re(q.placeholder);
    const candidates = all().filter((el) => el.matches(q.sel ?? "*"));
    const hits = [];
    for (const el of candidates) {
      if (name && !name.test(nameOf(el))) continue;
      if (placeholder && !placeholder.test(el.getAttribute("placeholder") ?? "")) continue;
      if (own) {
        if (["SCRIPT", "STYLE", "TEMPLATE"].includes(el.tagName)) continue;
        if (!own.test(norm(el.textContent))) continue;
        // The deepest element holding the whole text, as getByText picks.
        if ([...el.children].some((child) => own.test(norm(child.textContent)))) continue;
      }
      if (q.group) {
        const group = closestDeep(el, "[role=group], fieldset");
        if (!group) continue;
        const root = group.getRootNode();
        const labelled = (group.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => (id ? root.getElementById?.(id)?.textContent : ""))
          .join(" ");
        const groupName = norm(
          group.getAttribute("aria-label") ||
            labelled ||
            group.querySelector("legend")?.textContent,
        );
        if (!groupName.includes(q.group)) continue;
      }
      if (q.visible && !visible(el)) continue;
      hits.push(el);
    }
    return hits[q.nth ?? 0];
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
      name: nameOf(el).slice(0, 60),
    };
  };
  lab.find = (q) => {
    const el = lab.findEl(q);
    return el ? rectOf(el) : undefined;
  };
  lab.aim = (q) => {
    const el = lab.findEl(q);
    if (!el) return undefined;
    const mark = `m${Date.now()}${Math.random()}`;
    el.__labMark = mark;
    lab.expect = mark;
    lab.expectEl = el;
    lab.tap = undefined;
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      top: r.top,
      scrollY,
      name: norm(
        // biome-ignore lint/performance/useDomNodeTextContent: the rendered text, as the payer reads it
        el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder"),
      ).slice(0, 80),
    };
  };
  lab.value = (q) => lab.findEl(q)?.value;
  lab.visibleText = (pattern) => {
    const hits = [];
    const visit = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!pattern.test(n.textContent)) continue;
        const el = n.parentElement;
        if (!el || !visible(el)) continue;
        hits.push(
          `${el.localName}.${String(el.className).split(" ")[0]} "${norm(n.textContent).slice(0, 50)}" at y=${Math.round(el.getBoundingClientRect().top)}`,
        );
      }
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(document.body);
    return hits;
  };
  lab.bolt11 = () => {
    for (const el of all()) {
      if (
        (el.localName === "input" || el.localName === "textarea") &&
        /^ln(bc|tb|bcrt)/i.test(el.value)
      )
        return el.value;
    }
    return null;
  };
  lab.qr = () => {
    for (const el of all()) {
      if (!["canvas", "svg", "img"].includes(el.localName)) continue;
      const r = el.getBoundingClientRect();
      const square = r.width > 40 && Math.abs(r.width - r.height) < 4;
      const dense = el.localName !== "svg" || el.innerHTML.length > 600;
      if (square && dense)
        return {
          w: r.width,
          h: r.height,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        };
    }
    return undefined;
  };
  lab.interactive = () =>
    all()
      .filter((el) =>
        el.matches("button, a[href], input:not([type=hidden]), select, textarea, [role=button]"),
      )
      .filter(visible)
      .map(rectOf);
  lab.dialogGeometry = () => {
    const el = lab.findEl({ sel: "[role=dialog], dialog[open]", visible: true });
    if (!el) return undefined;
    const r = el.getBoundingClientRect();
    const box = el.firstElementChild?.getBoundingClientRect();
    const containers = [];
    for (
      let n = el.parentElement ?? el.getRootNode().host;
      n;
      n = n.parentElement ?? n.getRootNode()?.host
    ) {
      const cs = getComputedStyle(n);
      if (
        cs.containerType !== "normal" ||
        cs.transform !== "none" ||
        (cs.contain && cs.contain !== "none")
      )
        containers.push(
          `${n.localName}.${String(n.className).split(" ")[0]} container-type:${cs.containerType}`,
        );
    }
    return {
      position: getComputedStyle(el).position,
      overlay: [Math.round(r.top), Math.round(r.bottom)],
      box: box ? [Math.round(box.top), Math.round(box.bottom)] : undefined,
      containers,
      scrollable: el.scrollHeight > el.clientHeight,
      images: [...el.querySelectorAll("img")].map((img) => ({
        alt: img.alt.slice(0, 40),
        w: Math.round(img.getBoundingClientRect().width),
        h: Math.round(img.getBoundingClientRect().height),
      })),
      vvHeight: visualViewport.height,
    };
  };

  // ---- layout stability: WebKit has no layout-shift entries, so sample
  lab.trackStart = () => {
    const seen = new Map();
    const countdown = new Set();
    lab.track = { seen, countdown };
    const sample = () => {
      for (const el of all()) {
        if (!el.matches("button, input, textarea, a[href], canvas, svg, img, h1, h2, h3")) continue;
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        const pos = `${Math.round(r.top + scrollY)},${Math.round(r.left)},${Math.round(r.height)}`;
        const entry = seen.get(el) ?? {
          name: nameOf(el).slice(0, 30) || el.localName,
          positions: [],
        };
        if (entry.positions.at(-1) !== pos) entry.positions.push(pos);
        seen.set(el, entry);
      }
      // biome-ignore lint/performance/useDomNodeTextContent: the rendered text, as the payer reads it
      const m = norm(document.body.innerText).match(/(\d+:\d\d)/);
      if (m) countdown.add(m[1]);
    };
    sample();
    lab.track.timer = setInterval(sample, 100);
    return true;
  };
  lab.trackStop = () => {
    clearInterval(lab.track.timer);
    const moved = [];
    for (const entry of lab.track.seen.values())
      if (entry.positions.length > 1) moved.push(`${entry.name}: ${entry.positions.join(" -> ")}`);
    return { moved, countdown: [...lab.track.countdown] };
  };

  // ---- the payer's touches, the page lifecycle, the paid moment
  addEventListener(
    "pointerdown",
    (event) => {
      const path = event.composedPath();
      lab.tap = {
        clientX: event.clientX,
        clientY: event.clientY,
        pointerType: event.pointerType,
        vvTop: visualViewport.offsetTop,
        vvLeft: visualViewport.offsetLeft,
        scale: visualViewport.scale,
        hit: lab.expect !== undefined && path.some((node) => node.__labMark === lab.expect),
        expectRect: lab.expectEl?.getBoundingClientRect().toJSON(),
        scrollY,
        target: (path[0]?.outerHTML ?? "").slice(0, 120),
        at: Date.now(),
      };
    },
    true,
  );
  document.addEventListener("visibilitychange", () =>
    note(`visibility:${document.visibilityState}`),
  );
  addEventListener("pagehide", (event) => note(event.persisted ? "pagehide:bfcache" : "pagehide"));
  addEventListener("pageshow", (event) => note(event.persisted ? "pageshow:bfcache" : "pageshow"));
  addEventListener("error", (event) => note(`error:${String(event.message).slice(0, 120)}`));
  addEventListener("unhandledrejection", (event) =>
    note(`unhandledrejection:${String(event.reason).slice(0, 120)}`),
  );
  const paid = () =>
    [...document.querySelectorAll(".or-shop-status-title")].some(
      (el) => el.textContent.trim() === "Payment received",
    );
  const check = () => {
    if (lab.paidAt === undefined && paid()) {
      lab.paidAt = Date.now();
      note("paid-on-screen");
    }
  };
  check();
  new MutationObserver(check).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  // ---- the page's own requests to the shop
  const realFetch = window.fetch;
  window.fetch = function fetch(...args) {
    const [input, init] = args;
    const url = new URL(
      typeof input === "string" ? input : (input.url ?? String(input)),
      location.href,
    );
    const method = String(
      init?.method ?? (typeof input === "object" && input.method) ?? "GET",
    ).toUpperCase();
    const watched = url.pathname.startsWith("/openreceive/") || url.pathname.startsWith("/api/");
    const call = { method, path: url.pathname, at: Date.now(), outcome: "pending" };
    if (watched) lab.fetches.push(call);
    return realFetch.apply(this, args).then(
      (response) => {
        call.outcome = String(response.status);
        call.ms = Date.now() - call.at;
        if (method === "POST" && /^\/openreceive\/(checkouts|swaps)$/.test(url.pathname)) {
          response
            .clone()
            .json()
            .then((json) => lab.answers.push({ path: url.pathname, status: response.status, json }))
            .catch(() => lab.answers.push({ path: url.pathname, status: response.status }));
        }
        return response;
      },
      (error) => {
        call.outcome = error?.name === "AbortError" ? "aborted" : `failed: ${error?.message}`;
        call.ms = Date.now() - call.at;
        throw error;
      },
    );
  };
}

/** What a phone exposes: overflow, small tap targets, truncated text, fixed boxes (tests/android). */
export function MEASURE(minTap) {
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const width = document.documentElement.clientWidth;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const name = (el) =>
    (
      el.getAttribute("aria-label") ||
      el.textContent ||
      el.getAttribute("placeholder") ||
      el.localName
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
  const over = [];
  const small = [];
  const cut = [];
  const fixed = [];
  for (const el of all) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if ((r.right > width + 1 || r.left < -1) && !el.closest?.("[aria-hidden=true]"))
      over.push(
        `${el.localName}.${String(el.className).split(" ")[0]} ${Math.round(r.left)}..${Math.round(r.right)}`,
      );
    const interactive = el.matches(
      "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=radio], [role=tab], label[for]",
    );
    if (interactive && (r.height < minTap || r.width < minTap))
      small.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (
      el.children.length === 0 &&
      el.textContent.trim() &&
      s.textOverflow === "ellipsis" &&
      el.scrollWidth > el.clientWidth + 1
    )
      cut.push(`${name(el)} (${el.scrollWidth}>${el.clientWidth})`);
    if (
      s.overflowX === "hidden" &&
      s.whiteSpace === "nowrap" &&
      s.textOverflow !== "ellipsis" &&
      el.scrollWidth > el.clientWidth + 1 &&
      el.textContent.trim()
    )
      cut.push(`${name(el)} clipped (${el.scrollWidth}>${el.clientWidth})`);
    if ((s.position === "fixed" || s.position === "sticky") && r.height > 0)
      fixed.push(
        `${s.position} ${el.localName}.${String(el.className).split(" ")[0]} ${Math.round(r.top)}..${Math.round(r.bottom)}`,
      );
  }
  return {
    width,
    scrollWidth: document.documentElement.scrollWidth,
    innerHeight,
    vvHeight: visualViewport.height,
    bodyFont: getComputedStyle(document.body).fontSize,
    over: [...new Set(over)].slice(0, 12),
    overCount: over.length,
    small: [...new Set(small)],
    cut: [...new Set(cut)],
    fixed: [...new Set(fixed)],
  };
}

/** Text under 3:1 against what is behind it (tests/android, shadow roots included). */
export function CONTRAST() {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bg = (el) => {
    for (let n = el; n; n = n.parentElement ?? n.getRootNode()?.host) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0.5) return c;
    }
    return rgba(getComputedStyle(document.documentElement).backgroundColor || "#fff");
  };
  const out = [];
  const visit = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const text = t.textContent.trim();
      if (!text) continue;
      const el = t.parentElement;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const [l1, l2] = [lum(rgba(getComputedStyle(el).color)), lum(bg(el))].sort((x, y) => y - x);
      const ratio = (l1 + 0.05) / (l2 + 0.05);
      if (ratio < 3) out.push(`"${text.slice(0, 40)}" ${ratio.toFixed(2)}:1`);
    }
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
  };
  visit(document.body);
  return [...new Set(out)].slice(0, 15);
}
