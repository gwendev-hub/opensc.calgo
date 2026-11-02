# Protein Budget Planner – plan

**What it is:** a phone web page. You set calories, macro goals and a budget, pick the foods you'd eat, and get the **cheapest monthly grocery list** that hits your macros, or a clear message saying what to change.

**Who uses it (v0):** me and 3–5 friends. No accounts, no server, no scraping.

**v0 is done when:** I've planned one real month with it, and at least 3 friends have tried it and answered the feedback questions (section 7).

**Source of truth:** foods, prices and nutrition live only in `data/foods.json` and `data/groups.json`. Detailed rules and edge cases live as comments in `optimizer.js` and as test descriptions in `test.html`. This file says **what** the app does and **why**, not every detail.

---

## 1. Tech
- **Plain HTML, CSS and JavaScript**, no build step. One `index.html`, tabs shown and hidden with JS.
- **Solver:** javascript-lp-solver 0.4.24 from jsDelivr (pinned).
- **Hosting:** GitHub Pages (`main`, root). **Storage:** `localStorage`, always wrapped in try/catch, keys start with `pbp.`.
- **Files:** `index.html`, `style.css`, `app.js` (UI), `optimizer.js` (model and solver), `data/foods.json`, `data/groups.json`, `test.html`, `README.md`, `CLAUDE.md`, `PLAN.md`.

## 2. Data – `data/foods.json`
All nutrition is **per 100 g**. Fields: `id` (stable, never reused), `name`, `aliases` (Swedish and English search words), `category`, `storage`, `starter`, `packGrams`, `packPrice`, `pieceGrams` / `pieceName` (for eggs, bars, cans), `kcal`, `protein`, `carbs` (without fibre, as on Swedish labels), `fiber`, `fat`, `saturatedFat`, `sugar` (stored, not shown), `maxGramsPerDay`, optional `realisticMaxGramsPerDay`, `minGramsIfUsed`, `limitGroup`, plus `priceSource` / `nutritionSource` with a date.
- **Check:** kcal ≈ 4 × protein + 4 × carbs + 9 × fat + 2 × fibre, within 15% (a test catches typos).
- **`groups.json`:** limits on the total of several foods together (e.g. dairy, dry grains). They scale with the calorie target.
- **`storage`:** `"pantry"` (dry, canned, frozen, oil) or `"fresh"`. It only decides when the weekly list buys a food; the optimizer ignores it.
- **Starter set:** about 15 foods with `starter: true` fill **My foods** on a first visit.

## 3. Protein quality (core idea)
Cheap calorie-dense foods (oats, peanut butter, rice) must not fill the plan instead of real protein foods.
- **Rule:** a food is **Excellent** when `protein × 10 > kcal` (more than 10 g protein per 100 kcal). Example: cottage cheese 13 g → 130 > 60 kcal. Peanut butter 25 g → 250 vs 600 kcal is not.
- **Shown to the user:** only a green **Excellent** badge. Other foods get no protein badge; they can still be good for carbs, fat or fibre.
- **Used internally** (unchanged): foods are also rated OK (`protein × 10 ≥ kcal/2`) or Poor (below that). No optimizer rule depends on these two; only Excellent is a rule (section 4). They feed the plan's protein and calorie shares, the "Best protein first" sort, and which foods a message suggests.
- **Other badges:** fibre **High** (≥ 6 g/100 g) or **Source** (≥ 3 g); **⚠ Sat. fat** when saturated fat is more than ⅓ of fat (foods with at least 1 g fat). No sugar warning.

## 4. The optimizer
The classic **diet problem**, solved with linear programming: the cheapest set of foods that meets the rules.

**Goals (set on the Goals tab):** daily calories and a **macro split in %** (protein / carbs / fat, adding up to 100). Grams are calculated: protein and carbs = kcal × % ÷ 4, fat = kcal × % ÷ 9. Example: 1,700 kcal at 30/45/25 ≈ 128 g protein, 191 g carbs, 47 g fat.

**Rules in every plan**
- Calories 95–100% of the goal.
- Protein, carbs and fat each within **goal ± tolerance** (default ±10% of grams).
- At least **60% of protein from Excellent** foods. There's no cap on Poor foods: nearly all carbs and fat come from them, so the macro ranges do that job.
- Variety: no single food gives more than 35% of calories.
- Per-food max (`maxGramsPerDay`), and the user's own min/max per food, which always win.

**Three plans**, all minimising cost, shown side by side:

| | 1 – Absolute cheapest | 2 – Cheapest realistic | 3 – Same macros, higher quality |
|---|---|---|---|
| Rules above | ✔ | ✔ | ✔ |
| Amounts | grams per day, rounded up to packs | **whole packs**, each food 0 or ≥ 35 g/day (fats ≥ 10 g) | same as plan 2 |
| Realistic limits | – | ≥ 10 foods, `realisticMaxGramsPerDay`, group limits | same as plan 2 |
| Extra quality | – | – | ≥ 80% protein from Excellent, fibre ≥ 25 g/day, sat. fat ≤ ⅓ of fat |
| Budget | compared after | compared after | must fit, otherwise no plan |

- Whole packs use a fast step-by-step search on top of the solver (details in `optimizer.js`). All three plans must take **under 2 seconds on a phone**.
- **Failed plans never just say "no solution".** They say why and what to change, and name foods from `foods.json` to add, e.g. *"Carbs can't reach 172 g: add rice, pasta or potatoes"*, or *"The cheapest plan costs X kr, Y kr over budget."*

## 5. Screens
A bottom tab bar on phones (moves to the top on wide screens), ≥ 44 px tap targets, the last open tab remembered.

1. **Goals:** calories, macro % (or grams), tolerance, presets (Balanced 30/45/25, High protein 35/40/25, Lower carb 30/30/40), budget, days. A **Save** button checks the input and shows **"Saved ✓"** (it says "Save changes" when something is unsaved). After saving, a **"Create my grocery list →"** button opens My List and runs them.
2. **My foods:** a **search bar** (tap to see every food, type to filter, ignores case and å/ä/ö, matches aliases) and your foods, grouped by category, with badges and kr per 100 g protein. Untick to remove. Tap a food to set your own min/max. The optimizer uses only these foods. A **"Make my grocery list"** button at the bottom opens My List and runs them, so the flow is Goals → My foods → My List.
3. **My List:** at the top, a **Week / Month** switch for the grocery list (saved straight away; it only changes the display). Then three plan cards (cost vs budget, protein, kcal, % Excellent, number of foods). Tap one to see its **grocery list**: Food, Per day, Packs (*2 × 1 kg*, *3 × 12 eggs*), Cost, plus "X% of your protein comes from Excellent sources" and a **Copy list** button. **Per week:** plans are always optimized for the whole period, which keeps whole packs sensible, and the list then shows shopping weeks (days ÷ 7, rounded, so 30 days is 4). Pantry foods are bought in week 1, and fresh foods are split evenly in whole packs. Copy list follows the view. A red dot and an "out of date" note appear when the goals or foods change.
4. **Macros:** a plan switcher, a pie chart, and a table with grams, kcal and % for protein, carbs, fat and fibre against the goals; a Daily / Weekly / Monthly toggle; a fibre range (fat and carbs are compared with your goals). Below the range, a tip names high-fibre foods from `foods.json` to add, with a button to My foods.
5. **⚙️ App** (icon in the top corner, not a tab): appearance (System / Light / Dark), **Clear my data** (asks first, removes only `pbp.*`), "Your data stays with you, I haven't started selling it yet :)", and About (version, price date, not medical advice, feedback link).

## 6. Status
Done: skeleton, food data, optimizer, three plans, whole packs, tabs, search, min/max, Copy list, nutrients and Macros tab, full macro goals, dark mode and App page, Goals tab with Save, Excellent-only badge, My foods button, weekly view.
**Now:** step 8 (feedback link, share with friends).
**Then:** the next versions in section 8.

Tests live in `test.html` (each test describes itself); every change keeps them all passing and adds a test for each new rule.

## 7. Feedback questions for friends
1. Did the grocery list look like something you'd actually buy? What felt wrong?
2. Which foods were missing?
3. Were the prices roughly right for where you shop?
4. What would make you use this every month?
5. Weekly list, monthly list, or meal suggestions?
6. Which plan did you pick, and why?

## 8. Later

### Next versions (not built yet)
**Meal planner**
- **3a – Split into meals:** meal tags in `foods.json`, and a rule-based split of the plan into 3 meals + snacks for 7 days.
- **3b – Day view:** ticks and daily macro progress, saved per date.
- **3c – Week view.**

**Scraping track (prices per store)**
- `products` (EAN barcodes) and `prices` (store, price, date) linked to `foods.id`. A price range per food, "my stores", a list split by store, and deal alerts from a weekly GitHub Actions job (Python). Check each store's terms and `robots.txt` first.

### After that (let the feedback decide)
- **Protein price ranking tab:** all foods ranked by kr per gram of protein, with a **protein type** column: Complete (fish, eggs, dairy, soy), Incomplete (legumes, grains; "combine with grains"), Mostly complete (bars with collagen). Filters: complete only, Excellent only, My foods only.
- **Barcode scanning** with Open Food Facts, with the price typed in.
- **AI meal ideas** from the grocery list (free Gemini or Groq tier behind a Cloudflare Worker; never put an API key in the site).
- Personal calorie calculator, a shopping tick-off mode, export/import of data, accounts (needs a backend; only once people use the app).

## 9. Risks
- **Bad prices or nutrition give bad advice:** show sources and dates; keep `foods.json` easy to edit.
- **Odd combinations** (filler foods at 35 g, too much of one thing): tune limits after real use.
- **Health:** plans macros and cost only; not medical advice.
- **Scope creep:** nothing from section 8 before v0 is done and friends have tried it.
