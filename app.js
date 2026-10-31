// Key used to store the settings in the browser's localStorage
const SETTINGS_KEY = "pbp.settings";

// The names of the four settings inputs (matches the id of each <input>)
const SETTING_FIELDS = ["budget", "kcal", "protein", "days"];

// Read saved settings from localStorage.
// Returns an object like { budget: 4000, ... } or null if nothing is saved.
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    // localStorage can be blocked (e.g. private browsing) or hold bad data
    return null;
  }
}

// Save the current settings object to localStorage
function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    // If saving fails the page still works; settings just won't be remembered
  }
}

// Read the four inputs on the page into a settings object of numbers
function readSettingsFromForm() {
  const settings = {};
  for (const field of SETTING_FIELDS) {
    settings[field] = Number(document.getElementById(field).value);
  }
  return settings;
}

// Put saved values back into the inputs (skip anything missing or not a number)
function fillForm(settings) {
  for (const field of SETTING_FIELDS) {
    const value = settings[field];
    if (typeof value === "number" && !Number.isNaN(value)) {
      document.getElementById(field).value = value;
    }
  }
}

// ---------- Foods ----------

// Key used to store which foods are ticked, e.g. { keso: true, oil: false }
const TICKS_KEY = "pbp.ticks";

// All foods from data/foods.json, filled in once the file has loaded
let foods = [];

// Which foods are ticked. Foods not in here count as ticked (the default).
let ticks = {};

// Food-group limits from data/groups.json (used by plans 2 and 3), filled in once loaded
let groups = [];

// The protein rating rule (PLAN.md section 4.1) lives in optimizer.js as
// Optimizer.proteinRating, so the food list and the optimizer always agree.

// Grams of protein per 100 kcal for one food (0 if the food has no calories)
function proteinPer100kcal(f) {
  return f.kcalPer100g > 0 ? (f.proteinPer100g / f.kcalPer100g) * 100 : 0;
}

// Kronor you pay for 100 g of protein from this food (Infinity if it has no protein)
function krPer100gProtein(f) {
  const proteinGramsInPack = (f.packGrams * f.proteinPer100g) / 100;
  return proteinGramsInPack > 0 ? (f.packPrice / proteinGramsInPack) * 100 : Infinity;
}

// The average protein density the whole plan needs: g protein per 100 kcal.
// Shown for information only; it does NOT decide lifts/dilutes (PLAN.md section 4.2).
function targetDensity(settings) {
  return settings.kcal > 0 ? (settings.protein / settings.kcal) * 100 : 0;
}

// Fixed rule, independent of settings: more than 10 g protein per 100 kcal lifts the plan,
// 10 g or less dilutes it. Written as protein × 10 > kcal to avoid rounding errors.
function liftsOrDilutes(f) {
  return f.proteinPer100g * 10 > f.kcalPer100g ? "lifts" : "dilutes protein goal";
}

// Write the personal target density into the info line above the food list
function renderTargetDensity() {
  const density = targetDensity(readSettingsFromForm());
  document.getElementById("target-density").textContent = density.toFixed(1);
}

// Read saved ticks from localStorage ({} if nothing is saved or storage is blocked)
function loadTicks() {
  try {
    const raw = localStorage.getItem(TICKS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}

// Save the ticks object to localStorage
function saveTicks() {
  try {
    localStorage.setItem(TICKS_KEY, JSON.stringify(ticks));
  } catch (err) {
    // Ticks just won't be remembered; the page still works
  }
}

// A food is ticked unless the user has unticked it
function isTicked(f) {
  return ticks[f.id] !== false;
}

// Sort functions for the "Sort by" dropdown
const RATING_ORDER = { excellent: 0, ok: 1, poor: 2 };
// Text shown on the rating badges
const RATING_LABELS = { excellent: "Excellent", ok: "OK", poor: "Poor" };
const SORTERS = {
  // Best rating first; inside a rating, the most protein per calorie first
  rating: (a, b) =>
    RATING_ORDER[Optimizer.proteinRating(a)] - RATING_ORDER[Optimizer.proteinRating(b)] ||
    proteinPer100kcal(b) - proteinPer100kcal(a),
  // Cheapest protein first; foods with no protein (Infinity) end up last
  price: (a, b) => {
    const pa = krPer100gProtein(a);
    const pb = krPer100gProtein(b);
    if (pa === pb) return 0;
    if (pa === Infinity) return 1;
    if (pb === Infinity) return -1;
    return pa - pb;
  },
};

// Build the HTML for one food row: checkbox, name, badge and numbers
function foodRowHtml(f) {
  const rating = Optimizer.proteinRating(f);
  const ratingLabel = RATING_LABELS[rating];
  const lift = liftsOrDilutes(f);
  const kr = krPer100gProtein(f);
  const krText = kr === Infinity ? "no protein" : `${Math.round(kr)} kr / 100 g protein`;
  const ticked = isTicked(f);

  return `
    <li>
      <label class="food${ticked ? "" : " unticked"}">
        <input type="checkbox" data-id="${f.id}"${ticked ? " checked" : ""}>
        <span class="food-info">
          <span class="food-name">${f.name}</span><span class="badge ${rating}">${ratingLabel}</span><br>
          <span class="food-stats">
            ${proteinPer100kcal(f).toFixed(1)} g protein / 100 kcal ·
            ${krText} ·
            <span class="${lift}">${lift}</span>
          </span>
        </span>
      </label>
    </li>`;
}

// Draw the whole food list: one group per category, sorted with the chosen sorter
function renderFoods() {
  const list = document.getElementById("food-list");
  const sorter = SORTERS[document.getElementById("food-sort").value];

  // Group foods by category, keeping the category order from foods.json
  const groups = new Map();
  for (const f of foods) {
    if (!groups.has(f.category)) groups.set(f.category, []);
    groups.get(f.category).push(f);
  }

  // Turn each group into a heading plus a sorted list of rows
  let html = "";
  for (const [category, items] of groups) {
    const rows = [...items].sort(sorter).map((f) => foodRowHtml(f)).join("");
    html += `<div class="food-group"><h3>${category}</h3><ul>${rows}</ul></div>`;
  }
  list.innerHTML = html;
}

// Fetch one JSON file from the data folder (throws if it's missing)
async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

// Load data/foods.json and data/groups.json, then draw the list. Needs a web server (not file://).
async function loadFoods() {
  try {
    [foods, groups] = await Promise.all([fetchJson("data/foods.json"), fetchJson("data/groups.json")]);
    renderFoods();
    // The button only works once the data is here
    document.getElementById("make-list").disabled = false;
  } catch (err) {
    document.getElementById("food-list").innerHTML =
      `<p class="error">Couldn't load the food list (${err.message}). ` +
      `If you opened index.html directly, run <code>python3 -m http.server</code> instead.</p>`;
  }
}

// ---------- Plans (PLAN.md sections 5 and 6) ----------

// The three plans from the last button press, and which card is selected
let plans = null;
let selectedPlan = "realistic"; // "Cheapest realistic" is selected by default

// Card order on the page
const PLAN_ORDER = ["cheapest", "realistic", "highQuality"];

// Escape text before putting it into HTML (messages, food names)
function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Whole numbers with thousands separators, e.g. 3,420
const num = (n) => Math.round(n).toLocaleString("en-GB");
// A share (0–1) as a whole percentage, e.g. 60%
const pct = (share) => `${Math.round(share * 100)}%`;

// "1,352 kr of 4,000 kr ✔" (or ✘ and how much over)
function costLine(plan) {
  const t = plan.totals;
  const verdict = t.overBudget
    ? `<span class="over">✘ ${num(t.overBy)} kr over</span>`
    : `<span class="within">✔</span>`;
  return `${num(t.shoppingCost)} kr <span class="muted">of ${num(t.budget)} kr</span> ${verdict}`;
}

// Build the HTML for one comparison card
function planCardHtml(plan) {
  const selected = plan.key === selectedPlan;
  let body;
  if (plan.status === "optimal") {
    const t = plan.totals;
    // Cost with ✔/✘ on one line, the budget under it, then the numbers on two short lines
    const budgetLine = t.overBudget
      ? `<span class="plan-stat over">${num(t.overBy)} kr over the ${num(t.budget)} kr budget</span>`
      : `<span class="plan-stat muted">of ${num(t.budget)} kr budget</span>`;
    body = `
      <span class="plan-cost">${num(t.shoppingCost)} kr ${t.overBudget ? '<span class="over">✘</span>' : '<span class="within">✔</span>'}</span>
      ${budgetLine}
      <span class="plan-stat">${num(t.proteinPerDay)} g protein/day · ${num(t.kcalPerDay)} kcal/day</span>
      <span class="plan-stat">${pct(plan.quality.proteinShare.excellent)} protein from Excellent · ${t.foodCount} foods</span>`;
  } else {
    // No plan: say so on the card; the reasons are shown below when it's selected
    body = `<span class="plan-cost over">Not possible</span>
      <span class="plan-stat">Tap to see why</span>`;
  }
  // A real <button>, so it's easy to tap and works with screen readers
  return `
    <button type="button" class="plan-card${selected ? " selected" : ""}" data-key="${plan.key}" aria-pressed="${selected}">
      <span class="plan-title">${esc(plan.title)}</span>
      ${body}
    </button>`;
}

// Build the protein quality section (PLAN.md section 4.4) for one plan
function proteinQualityHtml(plan) {
  const share = plan.quality.proteinShare;
  const t = plan.totals;

  // Coloured bar: % of protein from Excellent / OK / Poor foods
  const parts = ["excellent", "ok", "poor"].filter((r) => share[r] > 0);
  const bar = parts
    .map((r) => `<span class="bar-part ${r}" style="width:${(share[r] * 100).toFixed(1)}%"></span>`)
    .join("");
  const legend = ["excellent", "ok", "poor"]
    .map((r) => `<span class="badge ${r}">${RATING_LABELS[r]} ${pct(share[r])}</span>`)
    .join(" ");

  // Warning for any single Poor food that gives more than 15% of the calories
  const warnings = plan.items
    .filter((i) => i.rating === "poor" && i.kcalPerDay / t.kcalPerDay > 0.15)
    .map((i) =>
      `<p class="warning">${esc(i.name)} gives ${pct(i.kcalPerDay / t.kcalPerDay)} of your calories ` +
      `but only ${pct(i.proteinPerDay / t.proteinPerDay)} of your protein.</p>`)
    .join("");

  return `
    <h3>Protein quality</h3>
    <p class="hint">Where your protein comes from:</p>
    <div class="quality-bar" role="img" aria-label="Protein from Excellent ${pct(share.excellent)}, OK ${pct(share.ok)}, Poor ${pct(share.poor)}">${bar}</div>
    <p class="legend">${legend}</p>
    <p>${pct(plan.quality.proteinKcalShare)} of your calories come from protein.</p>
    ${warnings}`;
}

// Build the grocery table for one plan: food, badge, grams per day, packages, cost
function groceryTableHtml(plan) {
  const rows = plan.items
    .map((i) => {
      const f = foods.find((x) => x.id === i.id);
      // Foods with several pieces per pack (e.g. eggs) also show how many pieces
      const pieces = f.pieceGrams && f.pieceGrams < f.packGrams ? `<br><span class="muted">${i.piecesToBuy} pcs</span>` : "";
      return `
        <tr>
          <td>${esc(i.name)}<span class="badge ${i.rating}">${RATING_LABELS[i.rating]}</span></td>
          <td class="num">${num(i.gramsPerDay)} g</td>
          <td class="num">${i.packages}${pieces}</td>
          <td class="num">${num(i.cost)} kr</td>
        </tr>`;
    })
    .join("");
  return `
    <table class="grocery">
      <thead>
        <tr><th scope="col">Food</th><th scope="col" class="num">Per day</th><th scope="col" class="num">Packs</th><th scope="col" class="num">Cost</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><th scope="row" colspan="3">Total for ${num(readSettingsFromForm().days)} days</th><td class="num">${num(plan.totals.shoppingCost)} kr</td></tr>
      </tfoot>
    </table>`;
}

// Draw the selected plan below the cards: top line, messages, grocery list, protein quality
function renderPlanDetail() {
  const plan = plans[selectedPlan];
  const detail = document.getElementById("plan-detail");

  // Any messages (over budget, or why the plan isn't possible)
  const messages = plan.messages.length
    ? `<ul class="messages">${plan.messages.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`
    : "";

  if (plan.status !== "optimal") {
    detail.innerHTML = `<h2>${esc(plan.title)}: not possible</h2>${messages}`;
    return;
  }

  const t = plan.totals;
  detail.innerHTML = `
    <h2>${esc(plan.title)}</h2>
    <p class="top-line"><strong>Total ${costLine(plan)}</strong> · <strong>${num(t.proteinPerDay)} g protein/day</strong> · <strong>${num(t.kcalPerDay)} kcal/day</strong></p>
    ${messages}
    ${groceryTableHtml(plan)}
    ${proteinQualityHtml(plan)}`;
}

// Draw the three cards (Plans tab) and the selected plan (List tab)
function renderPlans() {
  document.getElementById("plan-cards").innerHTML = PLAN_ORDER.map((key) => planCardHtml(plans[key])).join("");
  renderPlanDetail();
  // Swap the "nothing yet" texts for the real content
  document.getElementById("plans-empty").hidden = true;
  document.getElementById("plans").hidden = false;
  document.getElementById("list-empty").hidden = true;
  document.getElementById("plan-detail").hidden = false;
  // The plans are fresh again: no "out of date" note or dot
  document.getElementById("plans-stale").hidden = true;
  document.getElementById("plans-dot").hidden = true;
}

// Check the settings before running the optimizer. Returns an error text, or null if fine.
function settingsProblem(settings) {
  if (!(settings.kcal > 0)) return "Enter your daily calories first.";
  if (!(settings.protein > 0)) return "Enter your daily protein minimum first.";
  if (!(settings.days >= 1)) return "Enter how many days the list should cover.";
  if (!(settings.budget >= 0)) return "Enter your monthly budget first.";
  return null;
}

// "Make my grocery list": run all three plans with the current settings and ticked foods
async function makeGroceryList() {
  const button = document.getElementById("make-list");
  const error = document.getElementById("plan-error");
  const settings = readSettingsFromForm();
  error.textContent = "";

  const problem = settingsProblem(settings);
  if (problem) {
    error.textContent = problem;
    return;
  }

  // Show that something is happening; solving can take a second on an old phone
  button.disabled = true;
  button.textContent = "Working…";
  // Give the browser a moment to draw "Working…" before the solver blocks the page
  await new Promise((resolve) => setTimeout(resolve, 30));

  try {
    plans = Optimizer.planAll(settings, foods.filter(isTicked), groups);
    renderPlans();
  } catch (err) {
    // E.g. the solver couldn't be downloaded (no internet)
    error.textContent = `Couldn't make the list: ${err.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "Make my grocery list";
  }
}

// A card was tapped: select it and open its grocery list on the List tab
function selectPlan(key) {
  selectedPlan = key;
  // Update the highlighted card without redrawing everything
  for (const card of document.querySelectorAll(".plan-card")) {
    const isSelected = card.dataset.key === key;
    card.classList.toggle("selected", isSelected);
    card.setAttribute("aria-pressed", String(isSelected));
  }
  renderPlanDetail();
  showTab("list", { toTop: true });
}

// Settings or ticks changed after a list was made: show the "out of date"
// note on the Plans tab and a dot on the Plans tab button
function markPlansStale() {
  if (!plans) return;
  document.getElementById("plans-stale").hidden = false;
  document.getElementById("plans-dot").hidden = false;
}

// ---------- Tabs ----------

// Key used to remember the last open tab
const TAB_KEY = "pbp.tab";

// The four tabs, in the order of the tab bar
const TABS = ["settings", "foods", "plans", "list"];

// Where each tab was scrolled to, so coming back to e.g. Foods keeps your place
const tabScroll = {};

// The tab that's open right now
let currentTab = null;

// Read the last open tab from localStorage ("settings" if none, or storage is blocked)
function loadTab() {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return TABS.includes(saved) ? saved : "settings";
  } catch (err) {
    return "settings";
  }
}

// Remember the open tab for next time
function saveTab(name) {
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch (err) {
    // The page still works; it just opens on Settings next time
  }
}

// Show one tab's panel and hide the others.
// toTop: start at the top of the tab instead of where it was last scrolled to.
function showTab(name, { toTop = false } = {}) {
  // Remember how far the old tab was scrolled
  if (currentTab) tabScroll[currentTab] = window.scrollY;

  for (const tab of TABS) {
    const isOpen = tab === name;
    document.getElementById("panel-" + tab).hidden = !isOpen;
    const button = document.getElementById("tab-" + tab);
    button.setAttribute("aria-selected", String(isOpen));
    button.classList.toggle("active", isOpen);
  }

  currentTab = name;
  saveTab(name);
  window.scrollTo(0, toTop ? 0 : tabScroll[name] || 0);
}

// ---------- Start-up ----------

// Restore saved settings and ticks, load the foods, and react to changes
function init() {
  const saved = loadSettings();
  if (saved) {
    fillForm(saved);
  }
  ticks = loadTicks();

  // Show the personal target density straight away
  renderTargetDensity();

  // Settings changed: save them and update the info line (food labels don't depend on settings)
  const form = document.getElementById("settings-form");
  form.addEventListener("input", () => {
    saveSettings(readSettingsFromForm());
    renderTargetDensity();
    markPlansStale();
  });

  // A checkbox was ticked or unticked: remember it and fade/unfade the row
  document.getElementById("food-list").addEventListener("change", (event) => {
    const box = event.target;
    if (!box.dataset.id) return;
    ticks[box.dataset.id] = box.checked;
    saveTicks();
    box.closest(".food").classList.toggle("unticked", !box.checked);
    markPlansStale();
  });

  // Sort choice changed: redraw the list in the new order
  document.getElementById("food-sort").addEventListener("change", renderFoods);

  // "Make my grocery list" runs the optimizer
  document.getElementById("make-list").addEventListener("click", makeGroceryList);

  // A plan card was tapped (one listener for all three cards)
  document.getElementById("plan-cards").addEventListener("click", (event) => {
    const card = event.target.closest(".plan-card");
    if (card) selectPlan(card.dataset.key);
  });

  // A tab in the tab bar was tapped
  document.querySelector(".tab-bar").addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (tab) showTab(tab.dataset.tab);
  });

  // Buttons like "Go to Plans" that jump to another tab
  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-go-tab]");
    if (link) showTab(link.dataset.goTab, { toTop: true });
  });

  // Open the tab that was open last time
  showTab(loadTab());

  loadFoods();
}

init();
