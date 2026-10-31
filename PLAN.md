# Protein Budget Planner – Version 0 plan

**Goal of v0:** a single web page I can open on my phone. I set a budget, calorie target and protein target, tick the foods I'm willing to eat, and get the **cheapest monthly grocery list** that meets my targets, or a clear message about how far off I am.

**Who uses it:** me and 3–5 friends. No accounts, no server, no scraping.

**Done when:** I've used it to plan one real month of shopping, and at least 3 friends have tried it and answered the feedback questions (section 9).

---

## 1. Scope

### In v0
1. **Settings:** monthly budget (kr), daily calories (kcal), daily protein minimum (g), days in the period (default 30).
2. **Food list:** about 30 Swedish foods. Tick the ones you'd eat. Optionally set a min and max amount per food.
3. **Protein quality rating (core feature, see section 4):** every food is rated Excellent, OK or Poor as a protein source. The optimizer uses the rating, so calorie-dense foods like peanut butter, oats or lentils can't fill the plan with calories instead of protein.
4. **Optimizer:** finds the cheapest combination that meets the targets and the protein quality rules.
5. **Result:** a grocery list (packages to buy, cost per item), the total cost compared with the budget, the daily kcal and protein actually reached, and a protein quality breakdown.
6. **Saved on the phone:** settings and ticks are kept in `localStorage`, so they're still there next time.

### Not in v0 (later, if feedback asks for it)
Store-by-store prices, scraping or APIs, barcode scanning, accounts or sharing, meal plans or recipes, fat/carb/fibre targets, weekly lists, tick-off shopping mode.

---

## 2. Tech choices

| Decision | Choice | Why |
|---|---|---|
| Framework | **Plain HTML, CSS and JavaScript** (no React, no build step) | One screen and a handful of inputs. Runs on an old MacBook, no tooling to learn. Move to React or Vite only if the UI grows. |
| Solver | **javascript-lp-solver**, loaded from jsDelivr with a pinned version | Small, runs in the browser, supports integer variables. |
| Data | `data/foods.json` | Easy to edit by hand, easy to swap for scraped data later. |
| Hosting | **GitHub Pages** from the repo (`main` branch, root folder) | Free, and friends just open a link. |
| Storage | `localStorage`, wrapped in try/catch | Per device only, which is fine for v0. |

### File structure
```
/index.html        – page layout
/style.css         – mobile-first styles
/app.js            – UI: render foods, read settings, show results
/optimizer.js      – builds the model, calls the solver, rounds to packages
/data/foods.json   – food data (nutrition + price)
/test.html         – runs optimizer.js on fixed test cases (see section 8)
/README.md         – what it is, how to run, how to edit foods.json
/PLAN.md           – this file
```

---

## 3. Data model – `data/foods.json`

Everything is stored **per 100 g**, so all foods can be compared. Foods sold by the piece (eggs, drinks, bars, cans) also get `pieceGrams`.

```json
{
  "id": "keso",
  "name": "Keso cottage cheese 4%",
  "category": "Dairy",
  "packGrams": 250,
  "packPrice": 22,
  "pieceGrams": null,
  "kcalPer100g": 96,
  "proteinPer100g": 12,
  "maxGramsPerDay": 300,
  "priceSource": "Estimate, Oct 2026",
  "nutritionSource": "Label / Livsmedelsverket"
}
```

Derived in code, not stored:
- `krPerGram = packPrice / packGrams`
- `krPer100gProtein = packPrice / (packGrams * proteinPer100g / 100) * 100`
- `proteinPer100kcal = proteinPer100g / kcalPer100g * 100`
- **Protein rating**, see section 4 (Excellent / OK / Poor).

`maxGramsPerDay` is a sensible default so the optimizer doesn't suggest 600 g of lentils a day. Users can override it.

### Starter food list (~30 items, prices are rough estimates to be checked once in Willys/ICA online)

| id | Food | Pack | Price kr | kcal/100g | Protein/100g | Default max/day |
|---|---|---|---|---|---|---|
| eggs | Eggs (12 × 60 g) | 720 g | 45 | 135 | 12.5 | 180 g (3 eggs) |
| tuna_can | Canned tuna in water, drained | 120 g | 18 | 110 | 24 | 240 g |
| tuna_frozen | Frozen tuna steak | 250 g | 70 | 110 | 24 | 150 g |
| salmon_frozen | Frozen salmon fillets | 500 g | 100 | 205 | 20 | 150 g |
| cod_frozen | Frozen cod/saithe fillets | 600 g | 60 | 80 | 18 | 200 g |
| shrimp_frozen | Frozen shrimp, peeled | 500 g | 80 | 70 | 16 | 150 g |
| keso | Keso 4% | 250 g | 22 | 96 | 12 | 300 g |
| kvarg | Kvarg naturell | 500 g | 30 | 60 | 11 | 400 g |
| greek_0 | Greek yoghurt 0% | 1000 g | 45 | 55 | 10 | 300 g |
| drickkvarg | Lindahls drink 330 ml | 340 g | 24 | 50 | 7.6 | 680 g (2) |
| milk | Milk 1.5% | 1000 g | 15 | 47 | 3.5 | 500 g |
| prastost | Hard cheese (prästost) | 700 g | 85 | 390 | 26 | 40 g |
| tofu | Firm tofu | 400 g | 30 | 130 | 14 | 250 g |
| oumph | Oumph! | 280 g | 40 | 140 | 20 | 200 g |
| soy_mince | Soy mince, dry | 250 g | 30 | 350 | 50 | 60 g |
| lentils_red | Red lentils, dry | 500 g | 22 | 340 | 24 | 100 g |
| chickpeas_can | Chickpeas, drained | 230 g | 12 | 120 | 7.8 | 200 g |
| beans_can | Kidney/white beans, drained | 230 g | 12 | 100 | 7.4 | 200 g |
| oats | Oats | 1500 g | 25 | 370 | 13 | 100 g |
| rice | Rice, dry | 1000 g | 30 | 350 | 7 | 150 g |
| bulgur | Bulgur, dry | 1000 g | 30 | 350 | 12 | 150 g |
| pasta | Pasta, dry | 1000 g | 20 | 355 | 12 | 150 g |
| potatoes | Potatoes | 2000 g | 25 | 75 | 2 | 400 g |
| bread | Wholegrain bread | 500 g | 30 | 240 | 9 | 150 g |
| honokaka | Hönökaka | 240 g | 25 | 270 | 8 | 120 g |
| veg_frozen | Frozen vegetable mix | 1000 g | 30 | 40 | 2.5 | 400 g |
| tomatoes_can | Crushed tomatoes | 400 g | 12 | 25 | 1.2 | 200 g |
| banana | Bananas | 1000 g | 25 | 90 | 1.1 | 240 g |
| apple | Apples | 1000 g | 30 | 52 | 0.3 | 300 g |
| peanut_butter | Peanut butter | 350 g | 35 | 600 | 25 | 30 g |
| barebells | Barebells bar 55 g | 55 g | 23 | 362 | 36 | 110 g (2) |
| quest_chips | Quest protein chips 32 g | 32 g | 29 | 437 | 59 | 64 g (2) |
| oil | Rapeseed oil | 900 g | 30 | 884 | 0 | 20 g |

Nutrition values come from labels and should be checked against **Livsmedelsverket's food database**. Every price gets a `priceSource` with a date, so it's clear which numbers are stale.

---

## 4. Protein quality: telling great protein foods from poor ones (core feature)

**Why it matters:** with only "calories ≥ X and protein ≥ Y", the cheapest answer fills the plan with cheap, calorie-dense foods (oats, lentils, peanut butter, rice). They add some protein but use up most of the calorie budget. The app has to understand **protein per calorie**, not just protein per krona.

### 4.1 The rule: protein × 10 compared with calories
For every food, per 100 g:

| Rating | Rule | Same rule as protein per 100 kcal | Example |
|---|---|---|---|
| **Excellent** (green) | `protein × 10 > kcal` | more than 10 g | Cottage cheese 1.5%: 13 g → 130 > 60 kcal |
| **OK** (yellow) | `protein × 10 ≥ kcal / 2` | 5–10 g | Eggs 125 vs 135, lentils 240 vs 340 |
| **Poor** (red) | `protein × 10 < kcal / 2` | under 5 g | Peanut butter 25 g → 250 vs 600 kcal; oats, rice, bread |

```js
function proteinRating(f) {
  const score = f.proteinPer100g * 10;
  if (score > f.kcalPer100g) return "excellent";
  if (score >= f.kcalPer100g / 2) return "ok";
  return "poor";
}
```

Poor doesn't mean a bad food. Rice, vegetables and oil are fine for calories and meals. They just shouldn't count as protein sources.

### 4.2 Lifts / dilutes, and your personal target density
**Lifts / dilutes uses a fixed threshold of 10 g protein per 100 kcal** (the same as `protein × 10 > kcal`). It does not depend on the settings:
- **Lifts your plan:** more than 10 g protein per 100 kcal.
- **Dilutes your plan:** 10 g or less per 100 kcal, so calories from it have to be balanced by denser foods elsewhere.

**Personal target density (information only).** The targets set the average protein density the whole plan needs:

`targetDensity = proteinMin / kcalTarget × 100` g protein per 100 kcal

With 110 g and 1,700 kcal, that's **6.5 g per 100 kcal**. The page shows it as *"Your targets need at least 6.5 g protein per 100 kcal on average across the whole plan."* and updates it when protein or calories change. It never decides lifts/dilutes.

Each food card shows the badge (Excellent/OK/Poor) and "lifts" or "dilutes".

### 4.3 How the optimizer uses the rating
These become constraints in the model (section 5). Defaults are listed, and all of them can be changed under "Advanced":

1. **Most protein from Excellent sources:** at least **60%** of total protein comes from foods rated Excellent.
2. **Cap calories from Poor foods:** foods rated Poor give at most **40%** of total calories. This leaves room for rice, bread and vegetables but stops them taking over.
3. **Strict per-food caps for calorie bombs:** defaults like peanut butter ≤ 30 g/day and oil ≤ 20 g/day (`maxGramsPerDay` in foods.json).
4. **Optional filter:** "Protein sources: Excellent only / Excellent + OK / All". This hides foods from the list. It doesn't change the rules above.

### 4.4 What the user sees
- **Food list:** a coloured badge, protein per 100 kcal, and kr per 100 g protein on every food. Can be sorted by rating or price.
- **Result card, "Protein quality" section:**
  - % of protein from Excellent / OK / Poor foods (a small coloured bar)
  - % of calories from protein (`protein × 4 / kcal`)
  - a warning if any single Poor food gives more than 15% of calories, e.g. *"Peanut butter gives 18% of your calories but only 4% of your protein."*

---

## 5. The optimizer (the core of the app)

This is the classic **diet problem**, solved with linear programming.

### Model
For each ticked food *i*, the variable is **xᵢ = grams per day**.

**Minimize** total daily cost: `Σ krPerGramᵢ · xᵢ`

**Subject to:**
- Calories within a range: `Σ kcalᵢ · xᵢ/100 ≥ kcalTarget × 0.95` and `≤ kcalTarget`
- Protein minimum: `Σ proteinᵢ · xᵢ/100 ≥ proteinMin`
- Per-food limits: `minᵢ ≤ xᵢ ≤ maxᵢ` (min defaults to 0)
- **Variety:** no single food gives more than 35% of total calories (`kcalᵢ · xᵢ/100 ≤ 0.35 × kcalTarget`). Without this, the cheapest answer is boring, e.g. mostly lentils and oats.
- **Protein quality (section 4.3)**, written so it stays linear:
  - Excellent share: `Σ_{i∈Excellent} proteinᵢ·xᵢ/100 − 0.60 · Σ_all proteinᵢ·xᵢ/100 ≥ 0`
  - Poor calorie cap: `Σ_{i∈Poor} kcalᵢ·xᵢ/100 ≤ 0.40 × kcalTarget`

### After solving
1. Monthly grams = `xᵢ × days`.
2. **Packages to buy** = `ceil(monthlyGrams / packGrams)`. For piece foods, also show the piece count.
3. Shopping cost = `packages × packPrice`. Compare it with the budget.
4. Show the daily kcal and protein actually reached, and the leftover amount from rounding up (e.g. "about 200 g of rice left over").

### When there's no solution (infeasible)
Never just say "no solution". Tell the user why:
1. Check whether the protein and calorie targets are reachable at all with the ticked foods and max limits. If not, say: *"With these foods you can reach at most X g protein within Y kcal. Tick more high-protein foods or raise the max limits."*
   - If the protein quality rules are what blocks it, say so: *"You've ticked too few Excellent protein foods to get 60% of your protein from them. Tick e.g. keso, kvarg, tuna or tofu."*
2. If they're reachable but the cheapest solution is over budget, say: *"The cheapest plan costs Z kr, which is W kr over budget."* Still show that plan.
3. Optional: solve again as **"most protein within budget and calories"** and show it as an alternative.

### v0.1 improvement (only if rounding causes problems)
Switch the variables to **whole packages per month**, using integer variables in the same solver. Then the budget is exact and nothing needs rounding. Do this only after v0 works.

---

## 6. Screens (one page, mobile-first)

1. **Settings card:** budget, kcal, protein, days. Large inputs with sensible defaults (4,000 kr, 1,700 kcal, 110 g, 30 days).
2. **Foods list:** grouped by category, each food with a checkbox, its rating badge (green, yellow or red), protein per 100 kcal, "lifts/dilutes" (fixed 10 g per 100 kcal), and kr per 100 g protein. Tapping a food opens its min/max fields (advanced, hidden by default).
3. **"Make my grocery list" button**
4. **Result card:**
   - Top line: **Total 3,420 kr of 4,000 kr ✔** · **112 g protein/day** · **1,690 kcal/day**
   - Grocery table: food, rating badge, packages, amount per day, cost
   - **Protein quality** section (section 4.4)
   - A "Copy list" button that copies plain text to paste into Notes or a message
   - Warnings, such as infeasible plans or large leftovers
5. **Footer:** where the prices come from and their date, a "not medical advice" note, and a feedback link.

---

## 7. Build steps (in order, each one testable)

Each step is one small commit. Ask Claude in VS Code to do one step at a time.

1. **Skeleton:** create `index.html`, `style.css`, `app.js` and `README.md`. The page shows a title and the settings card. Turn on GitHub Pages and confirm the page opens on the phone.
   *Done when:* the GitHub Pages link loads on the phone.
2. **Food data and protein rating:** create `data/foods.json` with the starter list. Write `proteinRating()`, the fixed "lifts/dilutes" label and the target-density info line (section 4). `app.js` renders the grouped checkbox list with badge, protein per 100 kcal and kr per 100 g protein, sortable by rating.
   *Done when:* all foods show with the right badge (keso Excellent, eggs OK, peanut butter Poor), and ticks survive a reload.
3. **Optimizer core:** write `optimizer.js` with `buildModel(settings, foods)` and `solve(model)`, using javascript-lp-solver, including the protein quality constraints. No UI yet. Create `test.html` with the test cases from section 8.
   *Done when:* all the tests pass in `test.html`.
4. **Wire it up:** the button runs the optimizer, rounds up to packages and renders the result card, including the protein quality section.
   *Done when:* a real plan is shown with cost, kcal, protein and the Excellent/OK/Poor breakdown.
5. **Infeasible and over-budget messages,** as described in section 5.
   *Done when:* each failure case shows a helpful message instead of an empty result.
6. **Min/max per food, and Copy list.**
7. **Polish for the phone:** tap targets of at least 44 px, readable on a small screen, and a dark mode that follows the phone setting.
8. **Feedback:** add a link to a short Google Form, then share the page link with friends.

---

## 8. Test cases for `test.html`

| # | Setup | Expected |
|---|---|---|
| 1 | Default settings, all foods ticked | Solution found, protein ≥ 110, kcal between 1,615 and 1,700, cost ≤ 4,000 |
| 2 | Only rice and apples ticked, protein 110 | Infeasible, with a message giving the maximum protein reachable |
| 3 | Budget 500 kr, default foods | Over-budget message showing the cheapest cost |
| 4 | Tuna max = 0 | Tuna not in the result |
| 5 | Eggs min = 100 g/day | Eggs ≥ 100 g/day in the result |
| 6 | Check the variety cap | No single food gives more than 35% of kcal |
| 7 | Check rounding | Packages × pack size ≥ monthly grams for every food |
| 8 | Ratings | keso, kvarg, tuna, tofu = Excellent; eggs, lentils, salmon = OK; peanut butter, oats, rice = Poor |
| 9 | Peanut butter, oats, lentils, rice + keso and tuna ticked | ≥ 60% of protein from Excellent foods; Poor foods ≤ 40% of kcal |
| 10 | Only peanut butter, oats, lentils and rice ticked | Infeasible, with the "tick more Excellent protein foods" message |
| 11 | Lifts/dilutes and target density | Lifts/dilutes uses the fixed 10 g per 100 kcal: keso and tuna "lift"; eggs, lentils, chickpeas and oats "dilute". Target density 110 g / 1,700 kcal → 6.5 g per 100 kcal (info only); changing protein to 150 changes only the info line, no food's label |

---

## 9. Feedback questions for friends

1. Did the grocery list look like something you'd actually buy? What felt wrong?
2. Which foods were missing?
3. Were the prices roughly right for where you shop?
4. What would make you use this every month?
5. Would you rather have a weekly list, a monthly list, or meal suggestions?

---

## 10. Later versions (let the feedback decide the order)

- **Prices per store and price ranges.** Read each store's terms of use and `robots.txt` before scraping. Some forbid it, and scraping breaks whenever a site changes. Look for official or open sources first. Matpriskollen shows it's possible, but also how much upkeep it takes.
- **Barcode scanning** with Open Food Facts (free API) for nutrition, plus the price typed in by the user.
- **Personal calorie target** calculator (age, weight, height, activity).
- Fat, carb and fibre targets so plans are more balanced.
- Weekly lists, tick-off shopping mode, "already have it", and meal suggestions.
- Accounts and sharing, which needs a backend. Not before people actually use the app.

---

## 11. Risks to keep in mind

- **Bad prices or nutrition data give bad advice.** Show sources and dates, and make editing `foods.json` easy.
- **The optimizer picks odd combinations** or fills calories with cheap, low-protein foods. That's why the protein quality rules, max limits and variety cap exist. Expect to tune them after the first real month.
- **Health:** this plans calories and protein only. It isn't a complete diet plan or medical advice. Say so in the footer.
- **Scope creep:** nothing from section 10 goes in before steps 1–8 are done and at least 3 friends have tried it.
