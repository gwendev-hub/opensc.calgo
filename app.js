// Everything saved in localStorage starts with "pbp.":
//   pbp.settings – the goals; pbp.myFoods – a list of food ids; pbp.tab – the last open tab;
//   pbp.theme – the appearance; pbp.limits – own limits, e.g. { "keso": { "min": 60, "max": 120 } };
//   pbp.ticks – only from old versions, moved to pbp.myFoods and then removed.
//
// Key used to store the settings in the browser's localStorage
const SETTINGS_KEY = "pbp.settings";

// The app's version, shown under About in the App section
const APP_VERSION = "0.7.0";

// The names of the settings inputs (matches the id of each <input>)
const SETTING_FIELDS = ["budget", "kcal", "proteinPct", "carbsPct", "fatPct", "tolerancePct", "days"];

// The three macros in the split, and their kcal per gram (grams = kcal × % ÷ this)
const SPLIT_MACROS = [
  { key: "protein", label: "Protein", kcalPerGram: 4 },
  { key: "carbs", label: "Carbs", kcalPerGram: 4 },
  { key: "fat", label: "Fat", kcalPerGram: 9 },
];

// The share of the rest that goes to carbs when moving old settings over (the default 45/25 split)
const OLD_SETTINGS_CARB_SHARE = 45 / 70;

// A % with at most one decimal, as a number (e.g. 21.3)
const roundPct = (value) => Math.round(value * 10) / 10;

// Moving old users over: settings saved before the macro split have a protein goal in grams.
// That goal becomes the protein %, and carbs and fat share the rest like the default split.
// E.g. 110 g at 1,700 kcal → 25.9 / 47.6 / 26.5. Newer settings come back unchanged.
function migrateSettings(saved) {
  if (typeof saved.protein !== "number" || typeof saved.proteinPct === "number") return saved;
  const { protein, ...rest } = saved;
  const kcal = saved.kcal > 0 ? saved.kcal : 1700;
  const proteinPct = Math.min(100, roundPct(((protein * 4) / kcal) * 100));
  const carbsPct = roundPct((100 - proteinPct) * OLD_SETTINGS_CARB_SHARE);
  // Fat takes what's left, so the three always add up to exactly 100
  return { ...rest, proteinPct, carbsPct, fatPct: roundPct(100 - proteinPct - carbsPct) };
}

// Read saved settings from localStorage (old ones are moved over to the macro split).
// Returns an object like { budget: 4000, ... } or null if nothing is saved.
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? migrateSettings(JSON.parse(raw)) : null;
  } catch (err) {
    // localStorage can be blocked (e.g. private browsing) or hold bad data
    return null;
  }
}

// Save the current settings object to localStorage. Returns false if saving failed.
function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (err) {
    // If saving fails the page still works; settings just won't be remembered
    return false;
  }
}

// Read the inputs on the page into a settings object of numbers
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

// Fill in the grams from the % and calories. skipId is the field being typed in, which
// keeps what the user typed. Then show the error if the split doesn't add up to 100%.
function renderMacroFields(skipId = null) {
  const settings = readSettingsFromForm();
  const goals = Optimizer.macroGoals(settings);
  for (const m of SPLIT_MACROS) {
    const id = `${m.key}Grams`;
    if (id !== skipId) document.getElementById(id).value = Math.round(goals[m.key].goal);
  }
  document.getElementById("macro-error").textContent = Optimizer.macroSplitProblem(settings) || "";
  // Highlight the preset that matches the current split, if any
  const split = `${settings.proteinPct},${settings.carbsPct},${settings.fatPct}`;
  for (const button of document.querySelectorAll("[data-preset]")) {
    button.setAttribute("aria-pressed", String(button.dataset.preset === split));
  }
}

// Grams were typed: work out that macro's % from them and the calories
function gramsToPct(macroKey) {
  const kcal = Number(document.getElementById("kcal").value);
  const grams = Number(document.getElementById(`${macroKey}Grams`).value);
  const macro = SPLIT_MACROS.find((m) => m.key === macroKey);
  if (kcal > 0) document.getElementById(`${macroKey}Pct`).value = roundPct(((grams * macro.kcalPerGram) / kcal) * 100);
}

// ---------- Appearance (PLAN.md section 6, App section) ----------

// Key of the saved choice: "system" (default, follows the phone), "light" or "dark"
const THEME_KEY = "pbp.theme";
const THEMES = ["system", "light", "dark"];

// The saved choice ("system" if there is none, it's unknown, or storage is blocked)
function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return THEMES.includes(saved) ? saved : "system";
  } catch (err) {
    return "system";
  }
}

// Save the choice (the page still works if this fails)
function saveTheme(choice) {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch (err) {
    // The choice just won't be remembered
  }
}

// Give the phone's browser bar the same colour as the page
function updateThemeColor() {
  const background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.getElementById("theme-color").setAttribute("content", background);
}

// A small script in the <head> of index.html sets data-theme too, before anything is drawn, so a
// dark page never flashes light. style.css has one light and one dark colour list; the dark one is
// written twice (for System and for Dark), and test.html checks that the two copies are the same.
// Use a choice: style.css reads data-theme; without it, System follows the phone.
// Also marks the chosen button in the App section.
function applyTheme(choice) {
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
  }
  updateThemeColor();
}

// ---------- Clear my data (PLAN.md section 6, App section) ----------

// All of this app's localStorage keys start with this. Other apps on the same address
// (e.g. other GitHub Pages projects on the same account) share localStorage, so
// only keys with this start may be removed; never localStorage.clear().
const STORAGE_PREFIX = "pbp.";
// Tells the page after the reload to say the data was cleared (this tab only, gone on the next visit)
const CLEARED_FLAG = "pbp.justCleared";

// Remove this app's keys. Returns false if storage is blocked.
function clearMyData() {
  try {
    // List the keys first: removing while looping would shift the positions
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    for (const key of keys) {
      if (key.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
    }
    return true;
  } catch (err) {
    return false;
  }
}

// "Yes, clear it": remove the data and reload, which is exactly what a first visit does
function confirmClearData() {
  clearMyData();
  try {
    sessionStorage.setItem(CLEARED_FLAG, "1");
  } catch (err) {
    // Only the "cleared" note is lost
  }
  window.location.reload();
}

// Show or hide the confirmation step, and move the focus sensibly for keyboards and screen readers
function showClearConfirm(show) {
  document.getElementById("clear-confirm").hidden = !show;
  document.getElementById("clear-data").hidden = show;
  document.getElementById(show ? "clear-no" : "clear-data").focus();
}

// After the reload: say the data was cleared, once, on the page the button was on
function showClearedNote() {
  try {
    if (sessionStorage.getItem(CLEARED_FLAG) === null) return;
    sessionStorage.removeItem(CLEARED_FLAG);
    document.getElementById("clear-done").hidden = false;
    showTab(APP_PAGE, { toTop: true });
  } catch (err) {
    // No note then
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

// Key used to store the user's own min/max per food, e.g. { "keso": { "min": 50, "max": 200 } }
const LIMITS_KEY = "pbp.limits";

// The user's own min/max grams per day, by food id. A missing min or max means "use the default".
let foodLimits = {};

// The food whose min/max editor is open in My foods (null = none)
let editingFood = null;

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

// The starter set must give three valid plans with the default goals (test.html checks this).
// Olive oil is in it because the other starter foods can't reach the fat goal in plan 3.
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

// ---------- Own min/max per food (PLAN.md section 6, step 6) ----------

// Only the limits of foods in My foods go to the optimizer, and changing them marks plans out of date.
// Load the saved limits when the page starts. Keeps only known foods and real numbers ≥ 0.
function setupLimits() {
  const saved = loadJson(LIMITS_KEY);
  const known = new Set(foods.map((f) => f.id));
  foodLimits = {};
  if (!saved || typeof saved !== "object") return;
  for (const [id, limit] of Object.entries(saved)) {
    if (!known.has(id) || !limit) continue;
    const clean = {};
    for (const key of ["min", "max"]) {
      if (typeof limit[key] === "number" && limit[key] >= 0) clean[key] = limit[key];
    }
    if (Object.keys(clean).length) foodLimits[id] = clean;
  }
}

// Save the limits to localStorage (the page still works if this fails)
function saveLimits() {
  try {
    localStorage.setItem(LIMITS_KEY, JSON.stringify(foodLimits));
  } catch (err) {
    // The limits just won't be remembered next time
  }
}

// The user's own limits for one food, e.g. { min: 50 } ({} if none)
function foodLimitFor(id) {
  return foodLimits[id] || {};
}

// Set one food's own limits ({ min?, max? }); an empty object removes them. Saves and marks plans stale.
function setFoodLimit(id, limit) {
  if (Object.keys(limit).length) foodLimits[id] = limit;
  else delete foodLimits[id];
  saveLimits();
  markPlansStale();
}

// The limits the optimizer gets: only those for foods in My foods
function limitsForMyFoods() {
  const limits = {};
  for (const id of myFoods) if (foodLimits[id]) limits[id] = { ...foodLimits[id] };
  return limits;
}

// Short text for the marker on a food with own limits, e.g. "50–200 g", "≥ 50 g", "≤ 200 g"
function limitText(limit) {
  const hasMin = typeof limit.min === "number";
  const hasMax = typeof limit.max === "number";
  if (hasMin && hasMax) return `${limit.min}–${limit.max} g`;
  if (hasMin) return `≥ ${limit.min} g`;
  return `≤ ${limit.max} g`;
}

// Read the two editor fields. Empty = use the default.
// Returns { limit } if the values are fine, or { error } with a message to show.
function readLimitFields(minText, maxText) {
  const limit = {};
  for (const [key, text] of [["min", minText], ["max", maxText]]) {
    if (String(text).trim() === "") continue;
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) return { error: "Use grams of 0 or more, or leave it empty." };
    limit[key] = value;
  }
  if (typeof limit.min === "number" && typeof limit.max === "number" && limit.min > limit.max) {
    return { error: "Min can't be more than max." };
  }
  return { limit };
}

// The small editor under a food in My foods: min and max grams per day, Save and Reset
function limitEditorHtml(f) {
  const limit = foodLimitFor(f.id);
  // Tell the user what "empty" means for this food
  const realistic = typeof f.realisticMaxGramsPerDay === "number"
    ? ` (Cheapest realistic and Same macros, higher quality: ${f.realisticMaxGramsPerDay} g)`
    : "";
  const value = (key) => (typeof limit[key] === "number" ? limit[key] : "");
  return `
    <div class="limit-editor" id="limit-editor-${f.id}">
      <p class="hint">Grams per day. Leave empty to use the defaults: min 0 g, max ${f.maxGramsPerDay} g${realistic}.</p>
      <div class="limit-fields">
        <label>Min g/day
          <input type="number" inputmode="numeric" min="0" step="5" data-limit="min" value="${value("min")}" placeholder="0">
        </label>
        <label>Max g/day
          <input type="number" inputmode="numeric" min="0" step="5" data-limit="max" value="${value("max")}" placeholder="${f.maxGramsPerDay}">
        </label>
      </div>
      <p class="error limit-error" role="alert"></p>
      <div class="limit-actions">
        <button type="button" class="secondary" data-limit-save="${f.id}">Save</button>
        <button type="button" class="secondary" data-limit-reset="${f.id}">Reset</button>
      </div>
    </div>`;
}

// Open (or close, if it's already open) a food's min/max editor
function toggleLimitEditor(id) {
  editingFood = editingFood === id ? null : id;
  renderFoods();
}

// Save the open editor's values for one food. Returns false (and shows why) if they aren't valid.
function saveLimitEditor(id) {
  const editor = document.getElementById("limit-editor-" + id);
  const field = (key) => editor.querySelector(`[data-limit="${key}"]`).value;
  const { limit, error } = readLimitFields(field("min"), field("max"));
  if (error) {
    editor.querySelector(".limit-error").textContent = error;
    return false;
  }
  setFoodLimit(id, limit);
  editingFood = null;
  renderFoods();
  return true;
}

// Reset one food to the default limits
function resetLimit(id) {
  setFoodLimit(id, {});
  editingFood = null;
  renderFoods();
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
// Only Excellent foods get a protein badge. OK and Poor stay internal: the optimizer
// and the "Best protein first" sort still use them, but the page doesn't show them.
function proteinBadgeHtml(rating) {
  return rating === "excellent" ? '<span class="badge excellent">Excellent</span>' : "";
}
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

// Build the HTML for one row in My foods: a ticked checkbox (untick to remove), then the food itself
// as a button (tap to open its min/max editor) with name, badges, own-limit marker and numbers
function foodRowHtml(f) {
  const rating = Optimizer.proteinRating(f);
  const kr = krPer100gProtein(f);
  const krText = kr === Infinity ? "no protein" : `${Math.round(kr)} kr / 100 g protein`;
  const editing = editingFood === f.id;
  // Small marker on foods with their own min/max
  const limit = foodLimitFor(f.id);
  const marker = Object.keys(limit).length
    ? `<span class="limit-mark" title="Your own min/max per day">Own limit ${limitText(limit)}</span>`
    : "";

  return `
    <li class="${editing ? "editing" : ""}">
      <div class="food">
        <label class="food-tick">
          <input type="checkbox" data-id="${f.id}" checked>
          <span class="visually-hidden">Keep ${esc(f.name)} in My foods (untick to remove)</span>
        </label>
        <button type="button" class="food-info" data-edit="${f.id}" aria-expanded="${editing}" aria-controls="limit-editor-${f.id}">
          <span class="food-name">${esc(f.name)}</span>${proteinBadgeHtml(rating)}${nutrientBadgesHtml(f)}${marker}<br>
          <span class="food-stats">
            ${proteinPer100kcal(f).toFixed(1)} g protein / 100 kcal ·
            ${krText}
          </span>
        </button>
      </div>
      ${editing ? limitEditorHtml(f) : ""}
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
      ${proteinBadgeHtml(rating)}
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

// How the list behaves: focusing opens every food; tapping a result adds it and keeps the list open,
// so you can add several; Escape or a tap outside closes it (which also closes the phone keyboard).
// On a phone the box scrolls to the top of the screen and the tab bar hides, so it can't cover the list.
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
    setupLimits();
    renderFoods();
    document.getElementById("price-source").textContent = priceSourceText(foods);
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

// The three plans from the last button press, the settings they were made with, and which card is selected
let plans = null;
let planSettings = null;
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
      <span class="plan-stat">${num(t.carbsPerDay)} g carbs · ${num(t.fatPerDay)} g fat · ${num(t.fiberPerDay)} g fibre/day</span>
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
  return `
    <h3>Protein quality</h3>
    <p class="protein-share">${pct(plan.quality.proteinShare.excellent)} of your protein comes from Excellent sources.</p>
    <p>${pct(plan.quality.proteinKcalShare)} of your calories come from protein.</p>`;
}

// Show grams per day or per month in the macro section ("day" or "month")
let macroPeriod = "day";

// Range shown under the pie (PLAN.md section 4.5): green inside, yellow outside.
// Protein, carbs and fat are compared with your own goals in the table above it instead.
const MACRO_RANGES = {
  fiber: { min: 25, max: 35 },
};

// Goal vs actual for protein, carbs and fat: grams per day and % of their energy.
// A macro is green with ✔ when its grams are inside goal ± tolerance.
function macroGoalHtml(plan, settings) {
  const goals = Optimizer.macroGoals(settings);
  const t = plan.totals;
  const actual = { protein: t.proteinPerDay, carbs: t.carbsPerDay, fat: t.fatPerDay };
  const rows = SPLIT_MACROS.map((m) => {
    const goal = goals[m.key];
    const inside = actual[m.key] >= goal.min - 1e-6 && actual[m.key] <= goal.max + 1e-6;
    return `
      <tr data-goal-macro="${m.key}" class="${inside ? "goal-in" : "goal-out"}">
        <th scope="row"><span class="swatch ${m.key}"></span>${m.label}</th>
        <td class="num goal-grams">${num(goal.goal)} g<br><span class="muted goal-range">${num(goal.min)}–${num(goal.max)}</span></td>
        <td class="num actual-grams">${num(actual[m.key])} g ${inside ? "✔" : "✘"}</td>
        <td class="num goal-pct">${roundPct(goal.pct)}%</td>
        <td class="num actual-pct">${pct(plan.quality.macroSplit[m.key])}</td>
      </tr>`;
  }).join("");
  return `
    <h3>Goal vs actual, per day</h3>
    <table class="macro-table macro-goals">
      <thead>
        <tr><th scope="col">Macro</th><th scope="col" class="num">Goal</th><th scope="col" class="num">Actual</th><th scope="col" class="num">Goal %</th><th scope="col" class="num">Actual %</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">Under each goal is the range allowed by your ±${num(settings.tolerancePct)}% tolerance. Actual % is the share of the energy from protein, carbs and fat, so it adds up to 100%. The table below also counts fibre.</p>`;
}

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

// The pie and the kcal table are shares of protein × 4 + carbs × 4 + fat × 9 + fibre × 2, so they add
// up to 100%. That total can differ a little from the label kcal on the plan cards, and the protein %
// by a point or two from "% of calories from protein", which divides by the label kcal.
// Monthly = per day × days and leaves the % alone; the goal table and the fibre range stay daily.
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
  const days = planSettings.days;

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
    </ul>`;

  return `
    <h2>Macros</h2>
    ${switcher}
    ${macroGoalHtml(plan, planSettings)}
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

// One pack's size: "12 eggs" for foods with several pieces per pack (pieceName from
// foods.json, otherwise "pcs"), else its weight: "1 kg", "1.5 kg" or "250 g"
function packSize(f) {
  if (f.pieceGrams && f.pieceGrams < f.packGrams) {
    return `${Math.round(f.packGrams / f.pieceGrams)} ${f.pieceName || "pcs"}`;
  }
  if (f.packGrams >= 1000) return `${(f.packGrams / 1000).toLocaleString("en-GB")} kg`;
  return `${num(f.packGrams)} g`;
}

// Packages to buy, e.g. "2 × 1 kg" or "3 × 12 eggs"
const packsText = (item, f) => `${item.packages} × ${packSize(f)}`;

// Deliberately nothing about leftovers from rounding up to whole packs: that was taken off the list.
// Build the grocery table for one plan: food (with its badge), grams per day, packs, cost
function groceryTableHtml(plan) {
  const rows = plan.items
    .map((i) => {
      const f = foods.find((x) => x.id === i.id);
      return `
        <tr data-id="${i.id}">
          <td>${esc(i.name)}${proteinBadgeHtml(i.rating)}</td>
          <td class="num">${num(i.gramsPerDay)} g</td>
          <td class="num packs">${packsText(i, f)}</td>
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
        <tr><th scope="row" colspan="3">Total for ${num(planSettings.days)} days</th><td class="num">${num(plan.totals.shoppingCost)} kr</td></tr>
      </tfoot>
    </table>`;
}

// A food's name without the pack details the "N × size" part already gives:
// "Eggs (12 × 60 g)" → "Eggs", "Barebells bar 55 g" → "Barebells bar".
// Other brackets stay, e.g. "Hard cheese (prästost)".
function shortName(f) {
  return f.name.replace(/\s*\([^)]*\d[^)]*\)$/, "").replace(new RegExp(`\\s${f.packGrams} g$`), "");
}

// The selected plan as plain text for Notes or a message, grouped by category, e.g.
//   Cheapest realistic – 30 days
//
//   Eggs & dairy
//   Eggs – 3 × 12 eggs – 135 kr
//   Keso 4% – 7 × 250 g – 154 kr
//
//   Total: 1,352 kr (budget 4,000 kr)
//   Per day: 115 g protein · 1,690 kcal
function copyListText(plan, days) {
  const lines = [`${plan.title} – ${num(days)} days`];

  // Group the items by category, in the category order of foods.json
  const byCategory = new Map();
  for (const f of foods) {
    const item = plan.items.find((i) => i.id === f.id);
    if (!item) continue;
    if (!byCategory.has(f.category)) byCategory.set(f.category, []);
    byCategory.get(f.category).push({ f, item });
  }

  // One line per food: name, packs in the same style as the Packs column, cost
  for (const [category, rows] of byCategory) {
    lines.push("", category);
    for (const { f, item } of rows) {
      lines.push(`${shortName(f)} – ${packsText(item, f)} – ${num(item.cost)} kr`);
    }
  }

  // Totals at the bottom
  const t = plan.totals;
  lines.push("", `Total: ${num(t.shoppingCost)} kr (budget ${num(t.budget)} kr)`);
  lines.push(`Per day: ${num(t.proteinPerDay)} g protein · ${num(t.kcalPerDay)} kcal`);
  return lines.join("\n");
}

// Copy text to the clipboard. Returns true if it worked.
async function copyText(text) {
  // The modern way; only works on https or localhost
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // Fall through to the old way below
  }
  // The old way, e.g. on a phone opening the page over plain http on the home Wi-Fi:
  // select the text in a hidden text box and run the browser's copy command
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (err) {
    ok = false;
  }
  area.remove();
  return ok;
}

// "Copy list" was tapped: copy the selected plan and say "Copied ✓" for a moment.
// If copying isn't possible, show the text so it can be selected by hand.
async function copyList(button) {
  const text = copyListText(plans[selectedPlan], planSettings.days);
  const fallback = document.getElementById("copy-fallback");
  if (await copyText(text)) {
    button.textContent = "Copied ✓";
    fallback.hidden = true;
  } else {
    button.textContent = "Couldn't copy – select the text below";
    fallback.value = text;
    fallback.hidden = false;
  }
  // Back to the normal label after 2 seconds (if the list hasn't been redrawn meanwhile)
  setTimeout(() => {
    if (button.isConnected) button.textContent = "Copy list";
  }, 2000);
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
    <button type="button" class="secondary copy-list" data-copy-list>Copy list</button>
    <textarea id="copy-fallback" class="copy-fallback" readonly rows="8" hidden></textarea>
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
  const splitProblem = Optimizer.macroSplitProblem(settings);
  if (splitProblem) return splitProblem;
  if (!(settings.tolerancePct >= 1 && settings.tolerancePct <= 50)) return "Enter a tolerance between 1% and 50%.";
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

  // The plans use what's on the Goals tab, so keep those goals: otherwise the plans
  // would show goals that are gone after a reload
  if (saveSettings(settings)) setSaveState("saved");

  // Show that something is happening; solving can take a second on an old phone
  button.disabled = true;
  button.textContent = "Working…";
  // Give the browser a moment to draw "Working…" before the solver blocks the page
  await new Promise((resolve) => setTimeout(resolve, 30));

  try {
    // Only the foods in My foods go to the optimizer, with their own min/max.
    // The full food list is passed too, so messages can suggest foods to add.
    settings.limits = limitsForMyFoods();
    plans = Optimizer.planAll(settings, myFoodList(), groups, foods);
    planSettings = settings;
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
const TABS = ["goals", "foods", "plans", "macros"];

// The App settings page: shown like a tab, but not in the tab bar and not remembered
const APP_PAGE = "app";

// Where each tab was scrolled to, so coming back to e.g. Foods keeps your place
const tabScroll = {};

// The tab that's open right now
let currentTab = null;
// The tab the App settings page was opened from, for its back button
let tabBeforeApp = "goals";

// An old saved "settings" tab isn't in TABS any more, so it opens Goals, the tab it was renamed to.
// Read the last open tab from localStorage ("goals" if none, or storage is blocked)
function loadTab() {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    // The old List tab is now part of Plans
    if (saved === "list") return "plans";
    return TABS.includes(saved) ? saved : "goals";
  } catch (err) {
    return "goals";
  }
}

// Remember the open tab for next time
function saveTab(name) {
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch (err) {
    // The page still works; it just opens on Goals next time
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

  // The App settings page has no button in the tab bar, and needs no ⚙️ while it's open
  document.getElementById("panel-app").hidden = name !== APP_PAGE;
  document.getElementById("open-app").hidden = name === APP_PAGE;

  // Remember where to go back to. Reloading opens the last real tab, not this page.
  if (name === APP_PAGE) tabBeforeApp = TABS.includes(currentTab) ? currentTab : tabBeforeApp;
  else saveTab(name);
  currentTab = name;
  window.scrollTo(0, toTop ? 0 : tabScroll[name] || 0);
}

// ---------- Saving the goals ----------

// The Save button's three states: never saved, saved, and changed since the last save
const SAVE_LABELS = { new: "Save", saved: "Saved ✓", changed: "Save changes" };
let saveState = "new";

// Show a state on the Save button
function setSaveState(state) {
  saveState = state;
  const button = document.getElementById("save-goals");
  button.textContent = SAVE_LABELS[state];
  button.classList.toggle("is-saved", state === "saved");
}

// Changes aren't saved while typing, so unsaved changes are gone after a reload.
// The Save button: check the goals, save them, and offer to make the plans.
// Nothing is saved while something's wrong.
function saveGoals() {
  const settings = readSettingsFromForm();
  const error = document.getElementById("save-error");
  const createButton = document.getElementById("create-list");
  const problem = settingsProblem(settings);
  if (problem) {
    error.textContent = problem;
    createButton.hidden = true;
    return;
  }
  // The goals still work if storage is blocked; they just won't be there next time
  if (saveSettings(settings)) {
    error.textContent = "";
    setSaveState("saved");
  } else {
    error.textContent = "Couldn't save on this device, so your goals will be gone when you close the page.";
  }
  createButton.hidden = false;
}

// A goal changed: it isn't saved yet, so don't offer to make plans from it
function goalsChanged() {
  document.getElementById("save-error").textContent = "";
  document.getElementById("create-list").hidden = true;
  if (saveState === "saved") setSaveState("changed");
  markPlansStale();
}

// "Create my grocery list →": open Plans and make the plans
async function createList() {
  showTab("plans", { toTop: true });
  await makeGroceryList();
}

// ---------- App settings page ----------

// Where the prices come from, from foods.json: each source with how many foods use it,
// e.g. "Estimate, Oct 2026 (33 foods) and Estimate, Nov 2026 (4 foods)"
function priceSourceText(list) {
  const counts = new Map();
  for (const f of list) counts.set(f.priceSource, (counts.get(f.priceSource) || 0) + 1);
  return [...counts].map(([source, n]) => `${source} (${n} ${n === 1 ? "food" : "foods"})`).join(" and ");
}

// Connect the App settings page's buttons and fill in the version
function setupAppPage() {
  document.getElementById("app-version").textContent = APP_VERSION;

  // Appearance: use the choice and remember it
  document.querySelector(".theme-choice").addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme-choice]");
    if (!button) return;
    saveTheme(button.dataset.themeChoice);
    applyTheme(button.dataset.themeChoice);
  });
  applyTheme(loadTheme());
  // System: the phone can switch to dark in the evening while the page is open
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeColor);
  }

  // Clear my data: first the built-in question, then only "Yes" clears anything
  document.getElementById("clear-data").addEventListener("click", () => showClearConfirm(true));
  document.getElementById("clear-no").addEventListener("click", () => showClearConfirm(false));
  document.getElementById("clear-yes").addEventListener("click", confirmClearData);

  // The ⚙️ button opens the page, and Back returns to the tab it was opened from
  document.getElementById("open-app").addEventListener("click", () => {
    showTab(APP_PAGE, { toTop: true });
    document.getElementById("app-back").focus();
  });
  document.getElementById("app-back").addEventListener("click", () => {
    showTab(tabBeforeApp);
    document.getElementById("open-app").focus();
  });
}

// ---------- Start-up ----------

// Restore saved settings, load the foods (and My foods), and react to changes
function init() {
  const saved = loadSettings();
  if (saved) {
    fillForm(saved);
    // Keep old settings in their new form (saved again unchanged if they already were)
    saveSettings(readSettingsFromForm());
    setSaveState("saved");
  }

  // Appearance, Clear my data and About
  setupAppPage();

  // Show the macro grams straight away
  renderMacroFields();

  // Something in the goals changed: redraw the grams and mark it as not saved yet
  const settingsChanged = (skipId) => {
    renderMacroFields(skipId);
    goalsChanged();
  };

  // Grams update their % first; the field being typed in keeps what the user typed.
  const form = document.getElementById("settings-form");
  form.addEventListener("input", (event) => {
    const typedGrams = SPLIT_MACROS.find((m) => event.target.id === `${m.key}Grams`);
    if (typedGrams) gramsToPct(typedGrams.key);
    settingsChanged(event.target.id);
  });

  // A preset button fills in all three %
  form.addEventListener("click", (event) => {
    const preset = event.target.closest("[data-preset]");
    if (!preset) return;
    const pcts = preset.dataset.preset.split(",");
    SPLIT_MACROS.forEach((m, i) => (document.getElementById(`${m.key}Pct`).value = pcts[i]));
    settingsChanged();
  });

  // Save: the button, or Enter or Go on the keyboard. preventDefault stops the page reloading.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveGoals();
  });

  // "Create my grocery list →" after a save
  document.getElementById("create-list").addEventListener("click", createList);

  // A food in My foods was unticked: remove it from My foods
  document.getElementById("food-list").addEventListener("change", (event) => {
    const box = event.target;
    if (!box.dataset.id || box.checked) return;
    removeFood(box.dataset.id);
  });

  // My foods: tapping a food opens its min/max editor; Save and Reset work inside the editor
  document.getElementById("food-list").addEventListener("click", (event) => {
    const save = event.target.closest("[data-limit-save]");
    const reset = event.target.closest("[data-limit-reset]");
    const food = event.target.closest("[data-edit]");
    if (save) saveLimitEditor(save.dataset.limitSave);
    else if (reset) resetLimit(reset.dataset.limitReset);
    else if (food) toggleLimitEditor(food.dataset.edit);
  });

  // Enter in a min/max field saves, like tapping Save
  document.getElementById("food-list").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.dataset.limit) return;
    event.preventDefault();
    saveLimitEditor(event.target.closest(".limit-editor").id.replace("limit-editor-", ""));
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

  // "Copy list" under the grocery list
  document.getElementById("plan-detail").addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-list]");
    if (button) copyList(button);
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

  // Open the tab that was open last time, or the App settings page right after clearing data
  showTab(loadTab());
  showClearedNote();

  loadFoods();
}

init();
