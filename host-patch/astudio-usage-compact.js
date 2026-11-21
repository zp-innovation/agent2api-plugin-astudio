/**
 * AStudio · zp 余额列改造：整块内联卡片 → 单条读数 + 点开弹窗。
 *
 * 为什么打宿主补丁，而不是在插件里改数据：
 *   面板余额格的形态由宿主 reports.mjs:11-39 的 usageReport() 决定 —— 它只透
 *   {success, windows[], user, signIn, resets, subscription, available, availableView,
 *    balanceView, warnings}。WorkBuddy 那种「单行读数 + 积分明细弹窗」靠的是
 *   totalLeft / credits / quotaSources / wallets，这些键在脚本插件这条路上全部被裁掉
 *   （它们由宿主自己的 native provider 直接产出）。所以插件无论怎么填 usage，余额列都
 *   只会落到 .usage-window-cell（分窗口卡片）这一支。
 *   面板前端（/app/ui）是磁盘上的静态文件，改它不用重编 server —— 与二维码弹窗、
 *   短信登录同一个手法。
 *
 * 这个补丁做什么：
 *   1. 找到账号表里 tr.acct-row[data-provider="astudio"] 的每一行；
 *   2. 隐藏 React 渲染出来的 .usage-window-cell（整块卡片），保留它下面可能出现的状态行；
 *   3. 在同一个 td.cell-usage 里插入一个按钮「可用 1,500 积分 ▾」；
 *   4. 点按钮在它下面弹一张卡：套餐、总积分、每个积分池的余额、更新时间；
 *   5. MutationObserver 跟着 React 重渲染走（面板每 15 秒刷新一次读数，节点会被整体替换）。
 *
 * 数据来源就是被隐藏的那张卡片本身（label/value/plan/updated 的文本），不碰接口、
 * 不需要面板 Key。卡片没渲染时（未登录、读额度中）本补丁什么都不做，面板保持原样。
 */
(() => {
  if (window.__a2aAstudioUsage) return;
  window.__a2aAstudioUsage = true;

  const PROVIDER = "astudio";
  const ROW = 'tr.acct-row[data-provider="' + PROVIDER + '"]';
  const POP_ID = "a2a-usage-pop";

  const STYLE = `
#@POP@ {
  position: fixed;
  z-index: 2147483000;
  min-width: 248px;
  max-width: min(320px, calc(100vw - 24px));
  padding: 10px 14px 12px;
  border: 1px solid var(--ui-hairline, #e6e6e6);
  border-radius: var(--r-md, 10px);
  background: var(--ui-surface, #fff);
  color: var(--ui-text-1, #1f1f1f);
  box-shadow: var(--ui-shadow-3, 0 12px 32px rgba(0, 0, 0, .16));
  font-size: 12.5px;
  line-height: 1.45;
}
#@POP@[hidden] { display: none; }
#@POP@ .a2a-usage-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--ui-text-3, #8a8a8a);
  font-size: 11.5px;
}
#@POP@ .a2a-usage-head b {
  color: var(--ui-text-1, #1f1f1f);
  font-size: 12.5px;
  font-weight: 600;
}
#@POP@ .a2a-usage-head .a2a-usage-status {
  margin-left: auto;
  color: var(--ui-success, #12a150);
}
#@POP@ .a2a-usage-total {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 11px;
  border-radius: var(--r-xs, 6px);
  background: var(--ui-surface-inset, #f1f1f2);
}
#@POP@ .a2a-usage-total .k { font-size: 11.5px; color: var(--ui-text-3, #8a8a8a); }
#@POP@ .a2a-usage-total .v {
  margin-left: auto;
  color: var(--ui-success, #12a150);
  font-size: 13.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
#@POP@ .a2a-usage-group {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  color: var(--ui-text-3, #8a8a8a);
  font-size: 11px;
}
#@POP@ .a2a-usage-group::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--ui-hairline, #e6e6e6);
}
#@POP@ .a2a-usage-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 0;
}
#@POP@ .a2a-usage-row + .a2a-usage-row { border-top: 1px dashed var(--ui-hairline, #e6e6e6); }
#@POP@ .a2a-usage-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-2, #4a4a4a);
}
#@POP@ .a2a-usage-view {
  margin-left: auto;
  flex: none;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
#@POP@ .a2a-usage-view.muted { color: var(--ui-text-3, #8a8a8a); font-weight: 500; }
#@POP@ .a2a-usage-foot {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--ui-hairline, #e6e6e6);
  color: var(--ui-text-3, #8a8a8a);
  font-size: 10.5px;
}

.a2a-usage-line {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  margin: 0;
  padding: 2px 6px;
  border: 0;
  border-radius: var(--r-xs, 6px);
  background: transparent;
  color: var(--ui-text-1, #1f1f1f);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}
.a2a-usage-line:hover { background: var(--ui-row-hover, rgba(0, 0, 0, .05)); }
.a2a-usage-line:focus-visible { outline: 2px solid var(--ui-focus-ring, #4a8cff); outline-offset: 1px; }
.a2a-usage-line .a2a-usage-label { flex: none; color: var(--ui-text-3, #8a8a8a); font-size: 11.5px; }
.a2a-usage-line .a2a-usage-value {
  flex: none;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.a2a-usage-line .a2a-usage-value.is-zero { color: var(--ui-text-3, #8a8a8a); font-weight: 500; }
.a2a-usage-line .a2a-usage-caret {
  flex: none;
  margin-left: 1px;
  color: var(--ui-text-3, #8a8a8a);
  font-size: 11px;
  line-height: 1;
  transition: transform .15s ease;
}
.a2a-usage-line[aria-expanded="true"] .a2a-usage-caret { transform: rotate(180deg); }
`.split("@POP@").join(POP_ID);

  const style = document.createElement("style");
  style.id = "a2a-usage-style";
  style.textContent = STYLE;
  document.head.appendChild(style);

  /** 把卡片里的文本抠成数据；卡片不存在就返回 null。 */
  function readCell(cell) {
    const plan = (cell.querySelector(".usage-window-plan")?.textContent || "").trim();
    const status = (cell.querySelector(".usage-window-status")?.textContent || "").trim();
    const updatedNode = cell.querySelector(".usage-window-updated");
    let updated = "";
    if (updatedNode) {
      const clone = updatedNode.cloneNode(true);
      for (const caption of clone.querySelectorAll(".usage-window-caption")) caption.remove();
      updated = (clone.textContent || "").trim();
    }
    const rows = [];
    for (const item of cell.querySelectorAll(".usage-window-item")) {
      const name = (item.querySelector(".usage-window-label")?.textContent || "").trim();
      const valueNode = item.querySelector(".usage-window-value");
      const view = ((valueNode && valueNode.getAttribute("title")) || valueNode?.textContent || "").trim();
      if (name && view) rows.push({ name, view });
    }
    if (!rows.length) return null;
    return { plan, status, updated, rows };
  }

  /** 「剩 1,500 积分」→ 1500；抠不出数字就 null（不把 0 当成缺省）。 */
  function amountOf(view) {
    const match = /-?\d[\d,]*(?:\.\d+)?/.exec(view || "");
    if (!match) return null;
    const value = Number(match[0].replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
  }

  function totalOf(rows) {
    let sum = 0;
    let seen = false;
    for (const row of rows) {
      const value = amountOf(row.view);
      if (value === null) continue;
      sum += value;
      seen = true;
    }
    return seen ? sum : null;
  }

  function formatNumber(value) {
    return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
  }

  // ── 弹窗 ────────────────────────────────────────────────────────────────
  let pop = null;
  let owner = null;

  function ensurePop() {
    if (pop && pop.isConnected) return pop;
    pop = document.getElementById(POP_ID);
    if (!pop) {
      pop = document.createElement("div");
      pop.id = POP_ID;
      pop.setAttribute("role", "dialog");
      pop.hidden = true;
      document.body.appendChild(pop);
    }
    return pop;
  }

  function buildPop(data) {
    const node = ensurePop();
    node.textContent = "";

    const head = document.createElement("div");
    head.className = "a2a-usage-head";
    const planLabel = document.createElement("span");
    planLabel.textContent = "套餐";
    const planValue = document.createElement("b");
    planValue.textContent = data.plan || "—";
    head.append(planLabel, planValue);
    if (data.status) {
      const status = document.createElement("span");
      status.className = "a2a-usage-status";
      status.textContent = data.status;
      head.appendChild(status);
    }
    node.appendChild(head);

    const total = totalOf(data.rows);
    if (total !== null) {
      const box = document.createElement("div");
      box.className = "a2a-usage-total";
      const key = document.createElement("span");
      key.className = "k";
      key.textContent = "总积分";
      const value = document.createElement("span");
      value.className = "v";
      value.textContent = formatNumber(total) + " 积分";
      box.append(key, value);
      node.appendChild(box);
    }

    const group = document.createElement("div");
    group.className = "a2a-usage-group";
    group.textContent = "积分明细";
    node.appendChild(group);

    for (const row of data.rows) {
      const line = document.createElement("div");
      line.className = "a2a-usage-row";
      const name = document.createElement("span");
      name.className = "a2a-usage-name";
      name.textContent = row.name;
      const view = document.createElement("span");
      const amount = amountOf(row.view);
      view.className = "a2a-usage-view" + (amount === 0 ? " muted" : "");
      view.textContent = row.view;
      line.append(name, view);
      node.appendChild(line);
    }

    if (data.updated) {
      const foot = document.createElement("div");
      foot.className = "a2a-usage-foot";
      foot.textContent = data.updated;
      node.appendChild(foot);
    }
    return node;
  }

  function place(anchor) {
    const node = ensurePop();
    const rect = anchor.getBoundingClientRect();
    node.hidden = false;
    const box = node.getBoundingClientRect();
    const margin = 6;
    let left = rect.left;
    if (left + box.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - box.width);
    let top = rect.bottom + margin;
    if (top + box.height > window.innerHeight - 8) {
      const above = rect.top - margin - box.height;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - box.height);
    }
    node.style.left = Math.round(left) + "px";
    node.style.top = Math.round(top) + "px";
  }

  function close() {
    if (pop) pop.hidden = true;
    if (owner) owner.setAttribute("aria-expanded", "false");
    owner = null;
  }

  function toggle(anchor, data) {
    if (owner === anchor && pop && !pop.hidden) {
      close();
      return;
    }
    if (owner) owner.setAttribute("aria-expanded", "false");
    buildPop(data);
    owner = anchor;
    anchor.setAttribute("aria-expanded", "true");
    place(anchor);
  }

  // ── 行改造 ──────────────────────────────────────────────────────────────
  function decorate(row) {
    const td = row.querySelector("td.cell-usage");
    if (!td) return;
    const cell = td.querySelector(".usage-window-cell");
    const mine = td.querySelector(".a2a-usage-line");
    const data = cell ? readCell(cell) : null;

    if (!data) {
      // 卡片没渲染（读额度中/失败）：恢复原样，别留下一个空按钮
      if (mine) mine.remove();
      if (cell) cell.style.removeProperty("display");
      return;
    }

    const total = totalOf(data.rows);
    const value = total === null ? "—" : formatNumber(total) + " 积分";

    let button = mine;
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "a2a-usage-line";
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-haspopup", "dialog");
      const labelNode = document.createElement("span");
      labelNode.className = "a2a-usage-label";
      labelNode.textContent = "可用";
      const valueNode = document.createElement("span");
      valueNode.className = "a2a-usage-value";
      const caret = document.createElement("span");
      caret.className = "a2a-usage-caret";
      caret.textContent = "⌄";
      button.append(labelNode, valueNode, caret);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const fresh = cell && cell.isConnected ? readCell(cell) : null;
        if (!fresh) return;
        toggle(button, fresh);
      });
      td.appendChild(button);
    }

    const valueNode = button.querySelector(".a2a-usage-value");
    valueNode.textContent = value;
    valueNode.classList.toggle("is-zero", total === 0);

    // 隐藏原生卡片，但保留它 —— 弹窗的数据就是从这里读的
    cell.style.display = "none";
  }

  function scan() {
    for (const row of document.querySelectorAll(ROW)) decorate(row);
    if (owner && !owner.isConnected) close();
  }

  // ── 事件 ────────────────────────────────────────────────────────────────
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!owner) return;
      if (pop && pop.contains(event.target)) return;
      if (owner.contains(event.target)) return;
      close();
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && owner) {
        close();
        event.stopPropagation();
      }
    },
    true,
  );

  const follow = () => {
    if (owner && owner.isConnected) place(owner);
  };
  window.addEventListener("scroll", follow, true);
  window.addEventListener("resize", follow);

  // React 每次刷新读数都会整体替换单元格：跟着重扫（合并到一帧内）
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  });

  const start = () => {
    if (!document.body) return;
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
