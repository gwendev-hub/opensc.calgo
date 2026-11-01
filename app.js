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

// Key used to store the ids of the foods in My foods, e.g. ["keso", "eggs"]
const MY_FOODS_KEY = "pbp.myFoods";

// The old key from before My foods: { keso: true, oil: false }, where missing foods counted as ticked.
// Read once to move existing users over, then removed.
const OLD_TICKS_KEY = "pbp.ticks";

// All foods from data/foods.json, filled in once the file has loaded
let foods = [];

// The ids of the foods in My foods. Only these go to the optimizer.
let myFoods = new Set();

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

// Read one JSON value from localStorage (null if nothing is saved, it's bad data, or storage is blocked)
function loadJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

// Save My foods to localStorage. Returns false if saving failed.
function saveMyFoods() {
  try {
    localStorage.setItem(MY_FOODS_KEY, JSON.stringify([...myFoods]));
    return true;
  } catch (err) {
    // My foods just won't be remembered; the page still works
    return false;
  }
}

// Which foods My foods starts with (a list of ids). Needs the foods to be loaded.
function startingMyFoods() {
  // 1. Saved before: use that (an empty list counts, if the user removed everything)
  const saved = loadJson(MY_FOODS_KEY);
  if (Array.isArray(saved)) return saved;

  // 2. Saved with the old ticks: every food that wasn't unticked
  const oldTicks = loadJson(OLD_TICKS_KEY);
  if (oldTicks && typeof oldTicks === "object") {
    return foods.filter((f) => oldTicks[f.id] !== false).map((f) => f.id);
  }

  // 3. First visit: the starter set marked "starter": true in foods.json
  return foods.filter((f) => f.starter).map((f) => f.id);
}

// Fill My foods when the page loads, save it, and drop the old ticks key once it's moved over
function setupMyFoods() {
  // Ignore saved ids that are no longer in foods.json
  const known = new Set(foods.map((f) => f.id));
  myFoods = new Set(startingMyFoods().filter((id) => known.has(id)));
  if (saveMyFoods()) {
    try {
      localStorage.removeItem(OLD_TICKS_KEY);
    } catch (err) {
      // Harmless: My foods is saved, so the old key is never read again
    }
  }
}

// Is this food in My foods?
function isInMyFoods(f) {
  return myFoods.has(f.id);
}

// The foods in My foods, in foods.json order. This is what the optimizer gets.
function myFoodList() {
  return foods.filter(isInMyFoods);
}

// Add a food to My foods. Returns false (and does nothing) if it's already there or unknown.
function addFood(id) {
  if (myFoods.has(id) || !foods.some((f) => f.id === id)) return false;
  myFoods.add(id);
  saveMyFoods();
  renderFoods();
  markPlansStale();
  return true;
}

// Remove a food from My foods (the untick control on each row)
function removeFood(id) {
  if (!myFoods.delete(id)) return false;
  saveMyFoods();
  renderFoods();
  // If the search list is open, its ✓ for this food has to go too
  if (!document.getElementById("food-results").hidden) renderResults();
  markPlansStale();
  return true;
}

// Sort functions for the "Sort by" dropdown
const RATING_ORDER = { excellent: 0, ok: 1, poor: 2 };
// Text shown on the rating badges
const RATING_LABELS = { excellent: "Excellent", ok: "OK", poor: "Poor" };
// Text for the fibre badges and the nutrient warnings (PLAN.md section 4.5)
const FIBER_LABELS = { high: "High fibre", source: "Fibre source", low: "Low fibre" };
const WARNING_LABELS = { satFat: "⚠ Sat. fat" };
const WARNING_TITLES = {
  satFat: "Saturated fat is more than a third of the fat",
};

// The small fibre badge and any warning badges for one food (shown after the protein badge)
function nutrientBadgesHtml(f) {
  const fiber = Optimizer.fiberRating(f);
  const fiberBadge = `<span class="badge small fiber-${fiber}" title="${f.fiberPer100g || 0} g fibre per 100 g">${FIBER_LABELS[fiber]}</span>`;
  const warnings = Optimizer.nutrientWarnings(f)
    .map((w) => `<span class="badge small warn" title="${WARNING_TITLES[w]}">${WARNING_LABELS[w]}</span>`)
    .join("");
  return fiberBadge + warnings;
}
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

// Build the HTML for one row in My foods: a ticked checkbox (untick to remove), name, badges and numbers
function foodRowHtml(f) {
  const rating = Optimizer.proteinRating(f);
  const ratingLabel = RATING_LABELS[rating];
  const lift = liftsOrDilutes(f);
  const kr = krPer100gProtein(f);
  const krText = kr === Infinity ? "no protein" : `${Math.round(kr)} kr / 100 g protein`;

  return `
    <li>
      <label class="food">
        <input type="checkbox" data-id="${f.id}" checked>
        <span class="food-info">
          <span class="food-name">${f.name}</span><span class="badge ${rating}">${ratingLabel}</span>${nutrientBadgesHtml(f)}<br>
          <span class="food-stats">
            ${proteinPer100kcal(f).toFixed(1)} g protein / 100 kcal ·
            ${krText} ·
            <span class="${lift}">${lift}</span>
          </span>
        </span>
      </label>
    </li>`;
}

// Draw My foods: one group per category, sorted with the chosen sorter
function renderFoods() {
  const list = document.getElementById("food-list");
  const sorter = SORTERS[document.getElementById("food-sort").value];
  const mine = myFoodList();
  document.getElementById("my-food-count").textContent = `(${mine.length})`;

  // Nothing added yet: point to the search box
  if (mine.length === 0) {
    list.innerHTML = `<p class="hint empty-foods">No foods yet. Search above to add the foods you'd eat.</p>`;
    return;
  }

  // Group foods by category, keeping the category order from foods.json
  const groups = new Map();
  for (const f of mine) {
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

// ---------- Food search (PLAN.md section 6) ----------

// Lower case without accents, so "Hönökaka" becomes "honokaka" and "ÄGG" becomes "agg".
// "NFD" splits å/ä/ö into a plain letter plus an accent mark, and the replace removes the marks.
function normalizeText(text) {
  return String(text).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Normalised words of a text: anything that isn't a letter or a digit separates words
function wordsOf(text) {
  return normalizeText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// Does the query match the start of a word in this text? Several query words must follow
// each other, so "cottage ch" finds "cottage cheese", but "ice" doesn't find "rice".
function textMatches(text, query) {
  const queryWords = wordsOf(query);
  if (queryWords.length === 0) return true;
  return (" " + wordsOf(text).join(" ")).includes(" " + queryWords.join(" "));
}

// The name or alias of a food that matches the query (the name first), or null if none does
function matchingText(f, query) {
  return [f.name, ...(f.aliases || [])].find((text) => textMatches(text, query)) || null;
}

// Does this food match the search query? (An empty query matches every food.)
function foodMatches(f, query) {
  return matchingText(f, query) !== null;
}

// All foods that match the query, in foods.json order
function searchFoods(query) {
  return foods.filter((f) => foodMatches(f, query));
}

// Index of the result highlighted with the arrow keys (-1 = none)
let activeResult = -1;

// Build one result row: name, category, protein badge, and ✓ if it's already in My foods (+ if not)
function resultRowHtml(f, query) {
  const added = isInMyFoods(f);
  const rating = Optimizer.proteinRating(f);
  // When an alias matched (e.g. "tonfisk"), show it, so it's clear why the food is listed
  const match = matchingText(f, query);
  const alias = query.trim() && match !== f.name ? ` <span class="result-alias">“${esc(match)}”</span>` : "";
  return `
    <li id="food-result-${f.id}" class="food-result${added ? " added" : ""}" role="option"
      data-id="${f.id}" aria-selected="false" aria-disabled="${added}">
      <span class="result-info">
        <span class="food-name">${esc(f.name)}</span>${alias}<br>
        <span class="result-category">${esc(f.category)}</span>
      </span>
      <span class="badge ${rating}">${RATING_LABELS[rating]}</span>
      <span class="result-mark" aria-hidden="true">${added ? "✓" : "+"}</span>
      ${added ? '<span class="visually-hidden">(in My foods)</span>' : ""}
    </li>`;
}

// Draw the results for what's typed in the search box right now
function renderResults() {
  const input = document.getElementById("food-search-input");
  const list = document.getElementById("food-results");
  const matches = searchFoods(input.value);
  list.innerHTML = matches.length
    ? matches.map((f) => resultRowHtml(f, input.value)).join("")
    : `<li class="no-results" role="presentation">No food matches “${esc(input.value.trim())}”.</li>`;
  // A new list: nothing highlighted, and start at the top
  setActiveResult(-1);
  list.scrollTop = 0;
}

// The result rows that can be highlighted
function resultRows() {
  return [...document.querySelectorAll("#food-results .food-result")];
}

// Highlight one result (arrow keys), and tell screen readers which one it is
function setActiveResult(index) {
  const input = document.getElementById("food-search-input");
  const rows = resultRows();
  activeResult = index;
  rows.forEach((row, i) => row.setAttribute("aria-selected", String(i === index)));
  if (rows[index]) {
    input.setAttribute("aria-activedescendant", rows[index].id);
    rows[index].scrollIntoView({ block: "nearest" });
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}

// Keep the dropdown inside the part of the screen you can see. With the phone keyboard open
// the visible part (window.visualViewport) is much shorter than the window, so the list must be too.
function sizeResults() {
  const list = document.getElementById("food-results");
  if (list.hidden) return;
  const view = window.visualViewport;
  const visibleBottom = view ? view.offsetTop + view.height : window.innerHeight;
  const space = visibleBottom - list.getBoundingClientRect().top - 8;
  // Never smaller than about three rows
  list.style.maxHeight = `${Math.max(Math.round(space), 150)}px`;
}

// Phone layout (tab bar at the bottom), where the search box is scrolled to the top when focused
const phoneLayout = window.matchMedia("(max-width: 759px)");

// Open the dropdown with the results for the current text
function openResults() {
  const input = document.getElementById("food-search-input");
  const list = document.getElementById("food-results");
  if (input.disabled) return;
  renderResults();
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  // "searching" hides the bottom tab bar on a phone, so it doesn't cover the list above the keyboard
  document.body.classList.add("searching");
  sizeResults();
}

// Close the dropdown (blur: also close the phone keyboard)
function closeResults({ blur = false } = {}) {
  const input = document.getElementById("food-search-input");
  const list = document.getElementById("food-results");
  if (!list.hidden) {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    document.body.classList.remove("searching");
    setActiveResult(-1);
  }
  if (blur) input.blur();
}

// Add a tapped (or Enter-ed) result to My foods and show ✓ on its row. Already added: do nothing.
function pickResult(row) {
  const id = row.dataset.id;
  if (!addFood(id)) return;
  // Update just this row, so the list doesn't jump back to the top
  row.classList.add("added");
  row.setAttribute("aria-disabled", "true");
  row.querySelector(".result-mark").textContent = "✓";
  row.insertAdjacentHTML("beforeend", '<span class="visually-hidden">(in My foods)</span>');
}

// Wire up the search box: open on focus, filter while typing, keys, taps, and closing
function setupSearch() {
  const box = document.getElementById("food-search");
  const input = document.getElementById("food-search-input");
  const list = document.getElementById("food-results");

  // Focus opens the full list. On a phone, scroll the search box to the top of the screen
  // once the keyboard has slid up (about 300 ms), so the list gets as much room as possible.
  input.addEventListener("focus", () => {
    openResults();
    if (phoneLayout.matches) {
      setTimeout(() => {
        box.scrollIntoView({ block: "start", behavior: "smooth" });
        sizeResults();
      }, 300);
    }
  });

  // Tapping the box again after Escape opens the list again
  input.addEventListener("click", () => {
    if (list.hidden) openResults();
  });

  // Typing filters the list straight away
  input.addEventListener("input", () => {
    if (list.hidden) openResults();
    else renderResults();
  });

  // Keys: arrows move the highlight, Enter adds, Escape closes, Tab leaves
  input.addEventListener("keydown", (event) => {
    const rows = resultRows();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) openResults();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const count = resultRows().length;
      if (count) setActiveResult((activeResult + step + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // The highlighted result, or the only one if the search narrowed it down to one
      const row = rows[activeResult] || (rows.length === 1 ? rows[0] : null);
      if (row && !list.hidden) pickResult(row);
    } else if (event.key === "Escape") {
      // preventDefault: some browsers would also clear the text
      event.preventDefault();
      closeResults();
    } else if (event.key === "Tab") {
      closeResults();
    }
  });

  // Pressing on the list mustn't take the focus from the input, or the phone keyboard would close
  list.addEventListener("mousedown", (event) => event.preventDefault());

  // A result was tapped
  list.addEventListener("click", (event) => {
    const row = event.target.closest(".food-result");
    if (row) pickResult(row);
  });

  // Tapping anywhere outside the search box closes the list and the keyboard
  document.addEventListener("pointerdown", (event) => {
    if (!box.contains(event.target)) closeResults({ blur: document.activeElement === input });
  });

  // The keyboard opening or closing, or scrolling, changes the room for the list
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", sizeResults);
    window.visualViewport.addEventListener("scroll", sizeResults);
  }
  window.addEventListener("scroll", sizeResults, { passive: true });
  window.addEventListener("resize", sizeResults);
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
    // My foods needs the food list (for the starter set and moving old ticks over)
    setupMyFoods();
    renderFoods();
    // The search box and the button only work once the data is here
    document.getElementById("food-search-input").disabled = false;
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

// Show grams per day or per month in the macro section ("day" or "month")
let macroPeriod = "day";

// Ranges shown under the pie (PLAN.md section 4.5): green inside, yellow outside.
// Fibre is in grams per day; fat and carbs are shares of energy.
const MACRO_RANGES = {
  fiber: { min: 25, max: 35 },
  fat: { min: 0.25, max: 0.4 },
  carbs: { min: 0.45, max: 0.6 },
};

// One range row: name, value, the range, and a green ✔ or a yellow "below"/"above"
function rangeRowHtml(label, value, range, text, rangeText) {
  const inside = value >= range.min && value <= range.max;
  const verdict = inside ? "✔ in range" : value < range.min ? "below range" : "above range";
  return `
    <li class="range-row ${inside ? "in-range" : "out-of-range"}">
      <span class="range-name">${label}</span>
      <span class="range-value">${text}</span>
      <span class="range-target">${rangeText} · ${verdict}</span>
    </li>`;
}

// The four macros on the Macros tab: key (matches the optimizer's names), label and kcal per gram
const MACROS = [
  { key: "protein", label: "Protein", kcalPerGram: 4 },
  { key: "carbs", label: "Carbs", kcalPerGram: 4 },
  { key: "fat", label: "Fat", kcalPerGram: 9 },
  { key: "fiber", label: "Fibre", kcalPerGram: 2 },
];

// Small switcher at the top of the Macros tab: one button per plan, the selected one filled
function planSwitchHtml() {
  const buttons = PLAN_ORDER.map((key) =>
    `<button type="button" data-macro-plan="${key}" aria-pressed="${key === selectedPlan}">${esc(plans[key].title)}</button>`)
    .join("");
  return `<div class="plan-switch" role="group" aria-label="Plan">${buttons}</div>`;
}

// Build the Macros tab for one plan: plan switcher, Daily/Monthly toggle, pie, table and ranges
function macroHtml(plan) {
  const switcher = planSwitchHtml();

  // No plan: the switcher stays so you can pick another one, plus the reasons
  if (plan.status !== "optimal") {
    return `
      <h2>Macros</h2>
      ${switcher}
      <p class="warning">${esc(plan.title)}: not possible.</p>
      <ul class="messages">${plan.messages.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`;
  }

  const t = plan.totals;
  const kcal = plan.quality.macroKcal;
  const share = plan.quality.macroKcalShare;
  const days = readSettingsFromForm().days;

  // Daily or monthly amounts (grams and kcal); the % don't change
  const factor = macroPeriod === "month" ? days : 1;
  const period = macroPeriod === "month" ? `for ${num(days)} days` : "per day";
  const gramsPerDay = { protein: t.proteinPerDay, carbs: t.carbsPerDay, fat: t.fatPerDay, fiber: t.fiberPerDay };

  // Pie chart: a CSS conic gradient with one slice per macro (no chart library).
  // Each slice runs from where the previous one ended to that point plus its share.
  let from = 0;
  const slices = MACROS.map((m) => {
    const to = from + share[m.key] * 100;
    const slice = `var(--macro-${m.key}) ${from.toFixed(1)}% ${to.toFixed(1)}%`;
    from = to;
    return slice;
  });
  const pie = `
    <div class="macro-pie" role="img"
      aria-label="${MACROS.map((m) => `${m.label} ${pct(share[m.key])}`).join(", ")} of the energy"
      style="background: conic-gradient(${slices.join(", ")})"></div>`;

  // Table: one row per macro with grams, kcal (grams × kcal per gram) and % of the kcal, then the total
  const rows = MACROS.map((m) => `
      <tr data-macro="${m.key}">
        <th scope="row"><span class="swatch ${m.key}"></span>${m.label} <span class="muted">×${m.kcalPerGram}</span></th>
        <td class="num macro-grams">${num(gramsPerDay[m.key] * factor)} g</td>
        <td class="num macro-kcal">${num(kcal[m.key] * factor)}</td>
        <td class="num macro-pct">${pct(share[m.key])}</td>
      </tr>`).join("");
  const table = `
    <table class="macro-table">
      <thead>
        <tr><th scope="col">Macro</th><th scope="col" class="num">Grams</th><th scope="col" class="num">kcal</th><th scope="col" class="num">% kcal</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><th scope="row">Total</th><td></td><td class="num macro-total">${num(plan.quality.macroKcalTotal * factor)}</td><td class="num">100%</td></tr>
      </tfoot>
    </table>`;

  // Daily / monthly toggle (two buttons; the pressed one is highlighted)
  const toggleButton = (value, label) =>
    `<button type="button" data-macro-period="${value}" aria-pressed="${macroPeriod === value}">${label}</button>`;
  const toggle = `
    <div class="toggle" role="group" aria-label="Show amounts">
      ${toggleButton("day", "Daily")}${toggleButton("month", "Monthly")}
    </div>`;

  // The ranges always use daily values and shares
  const ranges = `
    <ul class="ranges">
      ${rangeRowHtml("Fibre", t.fiberPerDay, MACRO_RANGES.fiber, `${num(t.fiberPerDay)} g/day`, "25–35 g")}
      ${rangeRowHtml("Fat", share.fat, MACRO_RANGES.fat, pct(share.fat), "25–40%")}
      ${rangeRowHtml("Carbs", share.carbs, MACRO_RANGES.carbs, pct(share.carbs), "45–60%")}
    </ul>`;

  return `
    <h2>Macros</h2>
    ${switcher}
    <p class="hint">${esc(plan.title)}: grams and kcal ${period}. kcal = grams × 4 for protein and carbs, × 9 for fat, × 2 for fibre.</p>
    ${toggle}
    <div class="macro-row">${pie}${table}</div>
    <p class="hint">The plan card's ${num(t.kcalPerDay)} kcal/day comes from the food labels, so it can differ a little from this total.</p>
    ${ranges}`;
}

// Draw the Macros tab for the selected plan
function renderMacros() {
  document.getElementById("macro-section").innerHTML = macroHtml(plans[selectedPlan]);
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

// Draw the three cards and the selected plan's list (Plans tab), and its macros (Macros tab)
function renderPlans() {
  document.getElementById("plan-cards").innerHTML = PLAN_ORDER.map((key) => planCardHtml(plans[key])).join("");
  renderPlanDetail();
  renderMacros();
  // Swap the "nothing yet" texts for the real content
  document.getElementById("plans-empty").hidden = true;
  document.getElementById("plans").hidden = false;
  document.getElementById("plan-detail").hidden = false;
  document.getElementById("macros-empty").hidden = true;
  document.getElementById("macro-section").hidden = false;
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

// "Make my grocery list": run all three plans with the current settings and My foods
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
    // Only the foods in My foods go to the optimizer
    plans = Optimizer.planAll(settings, myFoodList(), groups);
    renderPlans();
  } catch (err) {
    // E.g. the solver couldn't be downloaded (no internet)
    error.textContent = `Couldn't make the list: ${err.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "Make my grocery list";
  }
}

// Select a plan (from a card or the Macros tab switcher) and redraw its grocery list and macros
function selectPlan(key) {
  selectedPlan = key;
  // Update the highlighted card without redrawing everything
  for (const card of document.querySelectorAll(".plan-card")) {
    const isSelected = card.dataset.key === key;
    card.classList.toggle("selected", isSelected);
    card.setAttribute("aria-pressed", String(isSelected));
  }
  renderPlanDetail();
  renderMacros();
}

// Settings or My foods changed after a list was made: show the "out of date"
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
const TABS = ["settings", "foods", "plans", "macros"];

// Where each tab was scrolled to, so coming back to e.g. Foods keeps your place
const tabScroll = {};

// The tab that's open right now
let currentTab = null;

// Read the last open tab from localStorage ("settings" if none, or storage is blocked)
function loadTab() {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    // The old List tab is now part of Plans
    if (saved === "list") return "plans";
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

// Restore saved settings, load the foods (and My foods), and react to changes
function init() {
  const saved = loadSettings();
  if (saved) {
    fillForm(saved);
  }

  // Show the personal target density straight away
  renderTargetDensity();

  // Settings changed: save them and update the info line (food labels don't depend on settings)
  const form = document.getElementById("settings-form");
  form.addEventListener("input", () => {
    saveSettings(readSettingsFromForm());
    renderTargetDensity();
    markPlansStale();
  });

  // A food in My foods was unticked: remove it from My foods
  document.getElementById("food-list").addEventListener("change", (event) => {
    const box = event.target;
    if (!box.dataset.id || box.checked) return;
    removeFood(box.dataset.id);
  });

  // The search box above My foods
  setupSearch();

  // Sort choice changed: redraw the list in the new order
  document.getElementById("food-sort").addEventListener("change", renderFoods);

  // "Make my grocery list" runs the optimizer
  document.getElementById("make-list").addEventListener("click", makeGroceryList);

  // A plan card was tapped (one listener for all three cards): select it and scroll down to its
  // grocery list under the cards (scroll-margin-top in style.css keeps it clear of the top tab bar)
  document.getElementById("plan-cards").addEventListener("click", (event) => {
    const card = event.target.closest(".plan-card");
    if (!card) return;
    selectPlan(card.dataset.key);
    document.getElementById("plan-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // Macros tab: the plan switcher selects another plan (and stays on Macros);
  // the Daily / Monthly toggle redraws the section with the new period
  document.getElementById("macro-section").addEventListener("click", (event) => {
    const planButton = event.target.closest("[data-macro-plan]");
    if (planButton) {
      selectPlan(planButton.dataset.macroPlan);
      return;
    }
    const periodButton = event.target.closest("[data-macro-period]");
    if (!periodButton) return;
    macroPeriod = periodButton.dataset.macroPeriod;
    renderMacros();
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
