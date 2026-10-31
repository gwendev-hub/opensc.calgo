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

// Protein rating rule from PLAN.md section 4.1 (don't change without asking):
// protein × 10 > kcal → Excellent, ≥ kcal / 2 → OK, otherwise Poor.
function proteinRating(f) {
  const score = f.proteinPer100g * 10;
  if (score > f.kcalPer100g) return "excellent";
  if (score >= f.kcalPer100g / 2) return "ok";
  return "poor";
}

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
const SORTERS = {
  // Best rating first; inside a rating, the most protein per calorie first
  rating: (a, b) =>
    RATING_ORDER[proteinRating(a)] - RATING_ORDER[proteinRating(b)] ||
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
  const rating = proteinRating(f);
  const ratingLabel = { excellent: "Excellent", ok: "OK", poor: "Poor" }[rating];
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

// Load data/foods.json, then draw the list. Needs a web server (not file://).
async function loadFoods() {
  try {
    const response = await fetch("data/foods.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    foods = await response.json();
    renderFoods();
  } catch (err) {
    document.getElementById("food-list").innerHTML =
      `<p class="error">Couldn't load the food list (${err.message}). ` +
      `If you opened index.html directly, run <code>python3 -m http.server</code> instead.</p>`;
  }
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
  });

  // A checkbox was ticked or unticked: remember it and fade/unfade the row
  document.getElementById("food-list").addEventListener("change", (event) => {
    const box = event.target;
    if (!box.dataset.id) return;
    ticks[box.dataset.id] = box.checked;
    saveTicks();
    box.closest(".food").classList.toggle("unticked", !box.checked);
  });

  // Sort choice changed: redraw the list in the new order
  document.getElementById("food-sort").addEventListener("change", renderFoods);

  loadFoods();
}

init();
