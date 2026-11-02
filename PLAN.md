# Protein Budget Planner – Version 0 plan

**Goal of v0:** a single web page I can open on my phone. I set a budget, calorie target and macro split (protein, carbs, fat), pick the foods I'm willing to eat, and get the **cheapest monthly grocery list** that meets my targets, or a clear message about how far off I am.

**Who uses it:** me and 3–5 friends. No accounts, no server, no scraping.

**Done when:** I've used it to plan one real month of shopping, and at least 3 friends have tried it and answered the feedback questions (section 9).

---

## 1. Scope

### In v0
1. **Goals:** monthly budget (kr), daily calories (kcal), macro split in % with grams (section 6), a tolerance (default ±10% of the grams), days in the period (default 30).
2. **Food list:** about 30 Swedish foods. Search and add the ones you'd eat to **My foods**. Optionally set a min and max amount per food.
3. **Protein quality rating (core feature, see section 4):** every food is rated Excellent, OK or Poor as a protein source (only Excellent is shown on the page). The optimizer uses the rating, so calorie-dense foods like peanut butter, oats or lentils can't fill the plan with calories instead of protein.
4. **Optimizer:** finds the cheapest combination that meets the targets and the protein quality rules.
5. **Result:** a grocery list (packages to buy, cost per item), the total cost compared with the budget, the daily kcal and macros actually reached, and how much of the protein comes from Excellent sources.
6. **Saved on the phone:** settings and My foods are kept in `localStorage`, so they're still there next time.

### Not in v0 (later, if feedback asks for it)
Store-by-store prices, scraping or APIs, barcode scanning, accounts or sharing, meal plans or recipes, weekly lists, tick-off shopping mode.

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
/data/groups.json  – food-group limits for plans 2 and 3 (see section 3)
/test.html         – runs optimizer.js on fixed test cases (see section 8)
/README.md         – what it is, how to run, how to edit foods.json
/PLAN.md           – this file
```

---

## 3. Data model – `data/foods.json`

Everything is stored **per 100 g**, so all foods can be compared. Foods sold by the piece (eggs, drinks, bars, cans) also get `pieceGrams`. Foods with several pieces in a pack also get `pieceName` (e.g. `"eggs"`), so the grocery list can say *3 × 12 eggs* (without it: *3 × 12 pcs*).

```json
{
  "id": "keso",
  "name": "Keso cottage cheese 4%",
  "aliases": ["cottage cheese", "keso", "grynost"],
  "category": "Dairy",
  "starter": true,
  "packGrams": 250,
  "packPrice": 22,
  "pieceGrams": null,
  "kcalPer100g": 96,
  "proteinPer100g": 12,
  "carbsPer100g": 2.5,
  "fiberPer100g": 0,
  "fatPer100g": 4,
  "saturatedFatPer100g": 2.6,
  "sugarPer100g": 2.5,
  "maxGramsPerDay": 300,
  "priceSource": "Estimate, Oct 2026",
  "nutritionSource": "Label / Livsmedelsverket"
}
```

**Other nutrients** (all per 100 g, typical Swedish label / Livsmedelsverket values, every food's `nutritionSource` says "to check"):

| Field | Meaning |
|---|---|
| `carbsPer100g` | Available carbohydrates ("kolhydrater" on Swedish labels), **without** fibre |
| `fiberPer100g` | Dietary fibre ("fiber") |
| `fatPer100g` | Total fat |
| `saturatedFatPer100g` | Saturated fat ("varav mättat fett"), part of `fatPer100g` |
| `sugarPer100g` | Sugars ("varav sockerarter"), part of `carbsPer100g` |

Check: `kcal ≈ 4 × protein + 4 × carbs + 9 × fat + 2 × fibre` within 15% for every food (test 23). Products with sugar alcohols (e.g. Barebells) count them as carbs, which makes the estimate a bit high.

Derived in code, not stored:
- `krPerGram = packPrice / packGrams`
- `krPer100gProtein = packPrice / (packGrams * proteinPer100g / 100) * 100`
- `proteinPer100kcal = proteinPer100g / kcalPer100g * 100`
- **Protein rating**, see section 4 (Excellent / OK / Poor).

`maxGramsPerDay` is a sensible default so the optimizer doesn't suggest 600 g of lentils a day. Users can override it with their own min and max per food (section 6, Foods tab).

### Optional fields for the realistic plans (plans 2 and 3, section 5)
Only some foods have these. Plan 1 ignores them.

| Field | Meaning | Foods that have it |
|---|---|---|
| `realisticMaxGramsPerDay` | A stricter max per day for plans 2 and 3. Plan 1 keeps `maxGramsPerDay`. A user's own max always wins. | tofu 150, canned tuna 120, Oumph 150, kvarg 300 |
| `minGramsIfUsed` | The floor if the food is in plan 2 or 3 at all (0 or at least this many grams). Without it the floor is 35 g. | rapeseed oil 10, olive oil 10, peanut butter 10, mixed nuts 10 |
| `limitGroup` | The id of a food group in `data/groups.json` whose total limit this food counts towards. | dairy: keso, kvarg, Greek yoghurt, Lindahls drink, milk, prästost · dry_grains: rice, pasta, whole-grain pasta, bulgur, oats |

### Search aliases and the starter set
Every food has these two fields, used by the Foods tab (section 6). The optimizer ignores them.

| Field | Meaning |
|---|---|
| `aliases` | Other names to search by, in **Swedish and English**, e.g. keso: `["cottage cheese", "keso", "grynost"]`, canned tuna: `["tuna", "tonfisk", …]`, eggs: `["egg", "eggs", "ägg"]`. Every food has at least 2. Broad words are fine (e.g. "fruit"/"frukt" on bananas and apples, "fisk" on salmon). Write them with their normal accents; the search ignores accents and case. |
| `starter` | `true` on about 15 common foods (eggs, keso, kvarg, milk, canned tuna, cod, tofu, red lentils, oats, rice, pasta, potatoes, bread, frozen veg, bananas, olive oil; the oil gives the plans enough fat). On a first visit, **My foods** starts with exactly these. Only foods that are starters have the field. The starter set must give three valid plans with the default settings (test 30). |

**How search matches** (`foodMatches` in `app.js`): the query and the texts are lower-cased and accents are removed (å → a, ä → a, ö → o, é → e), then split into words at anything that isn't a letter or digit. A food matches if the query's words appear **at the start of a word, in a row**, in its `name` or any of its `aliases`. So "hono" finds Hönökaka, "agg" finds eggs (alias "ägg"), "cottage ch" finds keso, but "ice" doesn't find rice. An empty query matches every food.

### Food-group limits – `data/groups.json`
Limits on the **total** grams per day of several foods together, so the plan can't stack e.g. keso + kvarg + yoghurt + milk. Used by plans 2 and 3 only. The numbers are for 1,700 kcal; the optimizer multiplies them by `kcalTarget ÷ 1,700` (e.g. dry grains 200 g → 353 g at 3,000 kcal). Members are the foods whose `limitGroup` is the group's `id`.

```json
[
  { "id": "dairy", "name": "Dairy (keso, kvarg, yoghurt, drinks, milk, cheese)", "maxGramsPerDay": 700 },
  { "id": "dry_grains", "name": "Dry grains (rice, pasta, bulgur, oats)", "maxGramsPerDay": 200 }
]
```

It's a separate file so `foods.json` stays a plain list. Eggs aren't in dairy; bread and hönökaka aren't in dry grains (they're weighed ready to eat).

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
| pasta_wholegrain | Whole-grain pasta, dry | 500 g | 22 | 340 | 12 | 150 g |
| potatoes | Potatoes | 2000 g | 25 | 75 | 2 | 400 g |
| bread | Wholegrain bread | 500 g | 30 | 240 | 9 | 150 g |
| honokaka | Hönökaka | 240 g | 25 | 270 | 8 | 120 g |
| veg_frozen | Frozen vegetable mix | 1000 g | 30 | 40 | 2.5 | 400 g |
| tomatoes_can | Crushed tomatoes | 400 g | 12 | 25 | 1.2 | 200 g |
| banana | Bananas | 1000 g | 25 | 90 | 1.1 | 240 g |
| apple | Apples | 1000 g | 30 | 52 | 0.3 | 300 g |
| avocado | Avocado (2 pcs) | 300 g | 30 | 160 | 2 | 150 g |
| peanut_butter | Peanut butter | 350 g | 35 | 600 | 25 | 30 g |
| mixed_nuts | Mixed nuts | 200 g | 39 | 610 | 20 | 40 g |
| barebells | Barebells bar 55 g | 55 g | 23 | 362 | 36 | 110 g (2) |
| quest_chips | Quest protein chips 32 g | 32 g | 29 | 437 | 59 | 64 g (2) |
| oil | Rapeseed oil | 900 g | 30 | 884 | 0 | 20 g |
| olive_oil | Olive oil | 460 g (500 ml) | 89 | 884 | 0 | 30 g |

Nutrition values come from labels and should be checked against **Livsmedelsverket's food database**. Every price gets a `priceSource` with a date, so it's clear which numbers are stale.

---

## 4. Protein quality: telling great protein foods from poor ones (core feature)

**Why it matters:** the macro ranges say how much protein a plan has, not where it comes from. The app also has to understand **protein per calorie**, so most of the protein comes from foods that are really protein sources.

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

Poor doesn't mean a bad food. Rice, vegetables and oil are where the carbs and fat come from. They just shouldn't count as protein sources.

### 4.2 The rating stays internal
The page shows only the green **Excellent** badge. OK and Poor still exist inside the app: the optimizer's rules and the "Best protein first" sort use them, but no badge or text shows them. The "lifts / dilutes" labels and the "target density" info line have been removed.

### 4.3 How the optimizer uses the rating
These become constraints in the model (section 5). Defaults are listed, and all of them can be changed under "Advanced":

1. **Most protein from Excellent sources:** at least **60%** of total protein comes from foods rated Excellent.
2. **Strict per-food caps for calorie bombs:** defaults like peanut butter ≤ 30 g/day and oil ≤ 20 g/day (`maxGramsPerDay` in foods.json).
3. **Optional filter:** "Protein sources: Excellent only / Excellent + OK / All". This hides foods from the list. It doesn't change the rules above.

**The old "Poor foods ≤ 40% of calories" cap is gone.** Nearly all carbs and fat come from foods rated Poor, so it fought the macro goals: 3,000 kcal at about 21 / 54 / 25 had no plan at all, and at 1,700 kcal it held carbs at the bottom of their range. The macro ranges now stop any one kind of food taking over. For the same reason the warning about a single Poor food giving more than 15% of calories is gone too.

### 4.4 What the user sees
- **Foods tab and search results:** the green Excellent badge on Excellent foods only, no OK or Poor badges. My foods also shows protein per 100 kcal and kr per 100 g protein, and can be sorted by best protein or by price.
- **Grocery list (Plans tab):** the same Excellent-only badge in the table, and a short "Protein quality" section:
  - *"X% of your protein comes from Excellent sources."* (no Excellent/OK/Poor breakdown or bar)
  - % of calories from protein (`protein × 4 / kcal`)
- There's no warning about Poor foods.

### 4.5 Other nutrients: fibre and fat
For plans 1 and 2 fibre and saturated fat are information only; plan 3 has rules for both (section 5). The rules live in `optimizer.js` (`Optimizer.fiberRating`, `Optimizer.nutrientWarnings`) so the page and the tests use the same code.

**Per food** (small badges next to the name on the Foods tab):

| Badge | Rule (per 100 g) |
|---|---|
| **High fibre** | fibre ≥ 6 g |
| **Fibre source** | fibre ≥ 3 g |
| **Low fibre** (grey) | under 3 g |
| **⚠ Sat. fat** | saturated fat > ⅓ of fat, for foods with at least 1 g fat |

The 1 g minimum stops near fat-free foods (e.g. Greek yoghurt 0% with 0.2 g fat) being flagged. There is **no sugar warning** (it flagged milk, fruit and vegetables for their natural sugars, which wasn't useful); `sugarPer100g` stays in the data.

**Per plan** (its own **Macros** tab, section 6):
- **Plan switcher** at the top: the three plans as small buttons, so you can compare them without going back to Plans. It changes the selected plan everywhere (the card and the grocery list on the Plans tab follow).
- **Goal vs actual** table for protein, carbs and fat, always per day: goal grams with the range allowed by the tolerance under it, actual grams (✔ inside the range, ✘ outside), goal % and actual %. Actual % is that macro's share of the energy from protein + carbs + fat, without fibre, so like the goal it adds up to 100% (`quality.macroSplit`).
- **Pie chart** of protein / carbs / fat / fibre as a share of their energy, drawn with a CSS `conic-gradient`, no chart library.
- **Table** with grams, kcal and % of kcal for each macro, plus a **total kcal** row:
  - protein × 4, carbs × 4, fat × 9, fibre × 2 kcal per gram
  - % of kcal = that macro's kcal ÷ the total of the four, so they add up to 100% and match the pie
  - the total can differ a little from the label kcal on the plan cards; a hint under the table says so. It can also differ by a point or two from "% of calories from protein" in 4.4, which divides by the label kcal.
- **Daily / Monthly** toggle for the grams and kcal (monthly = per day × days in the period); the % don't change.
- **Fibre range**, green inside and yellow outside (always daily values): 25–35 g per day. Fat and carbs have no fixed ranges any more; they're compared with your own goals in the table above.
- `summarise` in the optimizer adds `carbsPerDay`, `fatPerDay`, `fiberPerDay`, `saturatedFatPerDay`, `sugarPerDay` to `totals`, and `macroKcal` (kcal per macro), `macroKcalTotal`, `macroKcalShare` and `macroSplit` to `quality`.

---

## 5. The optimizer (the core of the app)

This is the classic **diet problem**, solved with linear programming.

### Model
For each food *i* in My foods, the variable is **xᵢ = grams per day** in plan 1. Plans 2 and 3 use **whole packages** instead (see "Whole packages in plans 2 and 3" below); every rule here is the same, written for the grams per day those packages give.

**Minimize** total daily cost: `Σ krPerGramᵢ · xᵢ`

**Subject to:**
- Calories within a range: `Σ kcalᵢ · xᵢ/100 ≥ kcalTarget × 0.95` and `≤ kcalTarget`
- **Macros within goal ± tolerance:** for protein, carbs and fat, `goal × (1 − tolerance) ≤ Σ macroᵢ · xᵢ/100 ≤ goal × (1 + tolerance)`, where `goal = kcalTarget × % ÷ 4` for protein and carbs and `÷ 9` for fat (`Optimizer.macroGoals`). E.g. 1,700 kcal at 30/45/25, ±10%: protein 115–140 g, carbs 172–210 g, fat 43–52 g.
- Per-food limits: `minᵢ ≤ xᵢ ≤ maxᵢ` (min defaults to 0). The user's own min and max (`settings.limits`, from the Foods tab) always win, in all three plans: an own min above the default max raises the max to that min (e.g. kvarg min 320 g in plan 2, whose realistic max is 300 g → max 320 g), and an own max of 0 keeps the food out.
- **Variety:** no single food gives more than 35% of total calories (`kcalᵢ · xᵢ/100 − 0.35 · Σ_all kcalⱼ·xⱼ/100 ≤ 0`). Without this, the cheapest answer is boring, e.g. mostly lentils and oats.
- **Protein quality (section 4.3)**, written so it stays linear:
  - Excellent share: `Σ_{i∈Excellent} proteinᵢ·xᵢ/100 − 0.60 · Σ_all proteinᵢ·xᵢ/100 ≥ 0`
- The variety cap is measured against the plan's **actual** total calories, not the target. Total calories are never above the target, so this is never looser than `≤ 0.35 × kcalTarget`, and "35% of calories" is exactly true in the result.

### Three plans
The optimizer makes three plans from the same settings and My foods (`Optimizer.planAll(settings, foods, groups)`, where `groups` comes from `data/groups.json`), so the user can compare them. All three minimise cost.

| | Plan 1 – **Absolute cheapest** | Plan 2 – **Cheapest realistic** | Plan 3 – **Same macros, higher quality** |
|---|---|---|---|
| Calories 95–100%, variety cap (35% per food), per-food max | ✔ | ✔ | ✔ |
| Protein, carbs and fat within goal ± tolerance | ✔ | ✔ | ✔ |
| Protein from Excellent foods | ≥ 60% | ≥ 60% | **≥ 80%** |
| Fibre | – | – | **≥ 25 g/day** |
| Saturated fat | – | – | **≤ ⅓ of fat** (`Σ sat. fat − ⅓ · Σ fat ≤ 0`) |
| Floor per food | none | each food is **0 or ≥ 35 g/day** (fats: 0 or ≥ 10 g, `minGramsIfUsed`) | same as plan 2 |
| At least 10 different foods | – | ✔ | ✔ |
| Realistic max limits (`realisticMaxGramsPerDay`) | – | ✔ | ✔ |
| Food-group limits (`data/groups.json`) × `kcalTarget ÷ 1,700` | – | ✔ at 1,700 kcal: dairy ≤ 700 g, dry grains ≤ 200 g | ✔ |
| Budget | compared after solving | compared after solving | **ceiling: total cost ≤ monthly budget**, otherwise no plan |
| Variable | grams per day, rounded up to packs afterwards | **whole packages per month** | **whole packages per month** |

- **0 or ≥ 35 g** can't be written as a plain linear rule, so each food gets a yes/no (binary) variable `useᵢ`: `xᵢ − floorᵢ · useᵢ ≥ 0` and `xᵢ − maxᵢ · useᵢ ≤ 0`, where `floorᵢ` is 35 g or the food's `minGramsIfUsed`, but never more than the food's max (so an own max of 20 g still lets the food in).
- **At least 10 foods** uses the same yes/no variables: `Σ useᵢ ≥ 10`.
- **Food-group limits:** `Σ_{i∈group} xᵢ ≤ group max × kcalTarget ÷ 1,700` for each group in `data/groups.json`. Per-food max limits don't scale, so very high calories can get expensive (plan 3 at 3,000 kcal costs about 5,100 kr, because Excellent protein foods hit their max limits).
- **Plan 3 and the budget:** plan 3 is in whole packages, so its cost is exact: if the cheapest higher quality plan costs more than the budget, there is no plan 3.
- Plan 3's Excellent share (80%), fibre (25 g) and saturated fat (⅓), the 35 g floor and the 10 foods are defaults in `Optimizer.DEFAULT_RULES`, to be changeable later under "Advanced". There's no protein buffer or "goal + 20 g" any more: all three plans use the same macro ranges.
- The cost order should be **plan 1 ≤ plan 2 ≤ plan 3 ≤ budget**, because each plan has the same rules as the one before, plus more. Plan 2 ≤ plan 3 is guaranteed: if the search ever finds a cheaper plan 3, plan 2 uses that plan too (it keeps all of plan 2's rules). Plan 1 is rounded up to whole packs after solving, so in rare cases it can cost more than plan 2; test 13 checks the order.
- The cheapest way to meet "10 foods" is often to add a few foods at the smallest amount allowed (e.g. one pack of potatoes). That's expected; watch whether it looks silly in real use.
- Every plan returns: its foods with grams per day and packages, total cost, protein and kcal per day, % of protein from Excellent foods, number of foods, and a message if it isn't possible or is over budget.

### Whole packages in plans 2 and 3
- **The variable** for each food is **nᵢ = whole packages for the period** (an integer, 0, 1, 2, …). Grams per day = `nᵢ × packGrams ÷ days`, e.g. 3 packs of 1 kg rice over 30 days = 100 g a day. Plan 1 stays in grams per day.
- **All the rules apply to those grams per day:** calories 95–100%, the three macro ranges, Excellent share, plan 3's fibre and saturated fat, variety, the floor, realistic and own max limits, the food-group limits and at least 10 foods. In the model each food's numbers (kr, kcal, protein, grams for the groups) are simply per package instead of per gram.
- **Limits become whole packs:** a min rounds up and a max rounds down, e.g. own min 100 g of eggs (24 g a day per 12-pack over 30 days) → at least 5 packs (120 g); max 300 g of kvarg (16.7 g a day per pack) → at most 18 packs. If the user's own min and max fit no whole number of packs, the min wins (like an own min above the default max).
- **The floor in packs** is the fewest packs that give at least 35 g a day (or `minGramsIfUsed`), but never more packs than the max allows. So a food can be below 35 g only when one more pack would go over its max, e.g. prästost (max 40 g): 1 pack of 700 g over 30 days is 23 g a day, 2 packs would be 47 g. An own max of 20 g of tofu allows 1 pack (13 g a day), which is then its floor.
- **Foods whose single pack is more than their max per day** can't be used in plans 2 and 3, e.g. rapeseed oil (900 g lasts 45 days at 20 g a day). The "at least 10 foods" message says so when it matters. Short periods make this more common (e.g. 1.5 kg of oats is 214 g a day over 7 days, above its 100 g max).
- **No rounding afterwards:** the packages are the shopping list, and its cost is exactly the solver's cost.
- **How it's solved, quickly:** whole numbers make the solver's own branch and bound far too slow for some settings (minutes), so `solvePacks` in `optimizer.js` works in steps:
  1. **Choose the foods:** solve with `useᵢ` as real yes/no but packs allowed in between (e.g. 2.4 packs). This is quick, and nothing can be cheaper than its cost. No answer → no plan.
  2. **Whole packs for those foods:** the solver on just those ~10 foods (each used), and also step 1's answer rounded and repaired one or two packs at a time.
  3. **Cheaper, one or two packs at a time:** keep making the change of one or two foods by one pack (or to/from 0) that saves the most, while every rule still holds.
  4. **Next choice of foods:** step 1 again with "not exactly these foods" added, up to 3 choices (6 while no plan has been found, also starting from amounts rounded down and up), unless step 1 shows no other choice can save at least 1 kr.
  The answer is the cheapest plan found: usually the cheapest there is, sometimes a few percent more. With short periods (7–14 days), where one pack is a big step, and unusual splits the search can also find nothing even if a plan exists, and says so with the realistic rules message; a longer period or a wider tolerance helps. The solver's own branch and bound gets a time limit (a safety net only), and its answer is used only if it really is in whole packs. Rows that can never matter are left out of the model to keep it fast: a variety row for a food that can't reach 35% of the calorie minimum even at its max, and in plans 2 and 3 the max row of a food without an own min (its `useᵢ` row already caps it).
- **Speed:** all three plans together take about 0.3 s (up to about 1 s on the first run) for all ~33 foods on a 2015 laptop; it must stay under about 2 seconds on a phone (test 37).

### After solving
1. Monthly grams = `xᵢ × days`.
2. **Packages to buy** = `ceil(monthlyGrams / packGrams)` (plans 2 and 3 are already whole packages, so this gives back exactly those). For piece foods, also count the pieces.
3. Shopping cost = `packages × packPrice`. Compare it with the budget.
4. Show the daily kcal and protein actually reached.

### When there's no solution (infeasible)
Never just say "no solution". Tell the user **why and what to change**. Every message ends with something to do (add, raise, lower, use another plan):
- **Suggested foods** come from the full food list: `planAll(settings, foods, groups, catalog)` gets every food in `foods.json` as `catalog` and names up to 3 foods that aren't in My foods yet, with the right rating, cheapest protein first, in quotes (e.g. *“Soy mince, dry”, “Greek yoghurt 0%” or “Firm tofu”*). No food names are hard-coded. Without a catalog (or when every fitting food is already in My foods) the message falls back to raising the max limits.
- **Own limits are named:** if the user set their own max on foods in My foods, the message adds *"You set your own max for “Keso 4%” in My foods; raising it may help."* Own minimums that are too much are named in the minimums message.
1. Check whether each macro and the calories are reachable with My foods and the max limits (`macroProblems`): first with only the foods, their limits and the calories, then with all the plan's rules except that macro's own range. Name the macro, and suggest foods that get at least 40% of their calories from it, cheapest grams first: *"Carbs can't reach 172 g (at most 144 g with these foods): add “Pasta, dry”, “Oats” or “Rice, dry”, or raise the max limits."* Too much is said too: *"Fat can't stay under 51 g (at least 96 g with these foods): add foods with more protein or carbs and less fat, lower the min limits, or raise its %."* In plans 2 and 3 foods that can't be in the plan (one pack lasts longer than the period at its max) aren't suggested.
   - Plan 3's own rules: *"Fibre can't reach 25 g a day: add high-fibre foods like …"* and *"Saturated fat can't stay at or under 33% of your fat: add foods with unsaturated fat like …"*
   - If the protein quality rules are what blocks it, say so: *"My foods has too few Excellent protein foods to get 60% of your protein from them. Add more Excellent foods like …"*
   - Minimums too high: *"Your minimum amounts alone are more than 1700 kcal. Lower the min limits of “Rapeseed oil” in My foods, or raise your daily calories."*
2. If they're reachable but the cheapest solution is over budget, say: *"The cheapest plan costs Z kr, which is W kr over budget. To fit, raise the budget to at least Z kr, lower your calorie target, or try adding cheap protein foods like …"* Still show that plan. Plan 2 says the same with "cheapest realistic plan".
3. **Plans 2 and 3** first check the food count: *"This plan needs at least 10 different foods, but only N are in My foods. Add 1 more, e.g. …"* (foods with an own max of 0 don't count, and the message says so). Then, if the plan fails even without the floor, 10 foods and group limits, they run the checks in point 1 with their own rules (60% or 80% Excellent, plan 3's fibre and saturated fat, realistic max limits). Otherwise they ask whether one macro stands out once the realistic rules count (e.g. the dry grains limit keeps carbs too low). If none does, it's the realistic rules together: *"The realistic rules … can't all be met with these foods and macro goals. Add a few more foods."*
4. **Plan 3** has no plan if plan 2 has none (same reasons), if the budget is below plan 2's cost (*"Your budget of X kr is less than the cheapest realistic plan (Y kr), so no realistic plan fits. Raise the budget to at least Y kr, or use the Absolute cheapest plan."*), or if the higher quality plan costs more than the budget: *"The higher quality plan costs X kr, which is W kr over your budget of B kr. Raise the budget to at least X kr, or use the Cheapest realistic plan, which fits."*

### Whole packages in plan 1 too? (only if feedback asks for it)
Plan 1 is still solved in grams per day and rounded up afterwards, as the "absolute cheapest" reference. It could use whole packages like plans 2 and 3 later.

---

## 6. Screens (one page, mobile-first)

Still one `index.html`, split into **four tabs** (Goals, Foods, Plans, Macros) and the App settings page. Switching tabs only shows one section and hides the others (plain JavaScript, no page loads). The last open tab is remembered in `localStorage` (wrapped in try/catch), and each tab keeps its own scroll position while the page is open.

**Tab bar:** fixed to the bottom of the screen on a phone, like a phone app: four buttons with an icon and a short label, at least 44 px tall (60 px), with room for the iPhone home indicator. On a wide screen (760 px and up) it sits at the top instead, with icon and label side by side. The open tab is green and bold.

1. **Goals tab** (called Settings before; a saved last tab of `"settings"` opens Goals): budget, kcal, macro split, tolerance, days. Large inputs with sensible defaults (4,000 kr, 1,700 kcal, 30/45/25, ±10%, 30 days).
   - **Macro split:** a % and a grams field for protein, carbs and fat. Grams follow the % and calories (protein and carbs ÷ 4, fat ÷ 9). Typing grams updates that macro's % (one decimal), and the other two stay as they are.
   - **Must add up to 100%:** otherwise an error shows under the fields, and "Make my grocery list" shows it too and makes no plans (`Optimizer.macroSplitProblem`; the sum is rounded to one decimal).
   - **Presets:** Balanced 30/45/25, High protein 35/40/25, Lower carb 30/30/40. The one that matches is marked.
   - **Tolerance:** ± % of each macro's grams, 1–50, default 10.
   - **Save button** at the bottom of the form (Enter or Go on the keyboard does the same). Changes are no longer saved while typing. It checks the goals (`settingsProblem`, so the % must add up to 100); if something's wrong it shows the error under the button and saves nothing. A good save writes them to `localStorage` and the button says **Saved ✓**. If anything changes after that it says **Save changes** and plans already made are marked out of date. Before the first save it says **Save**; after a reload with saved goals, **Saved ✓**. Unsaved changes are gone after a reload.
   - **Create my grocery list →:** a big button under the form, shown after a successful save and hidden again when something changes. It opens Plans and runs the plans.
   - **Making plans with unsaved changes:** the button on the Plans tab uses what's on the Goals tab. If that's valid it's saved too, so the plans never show goals that disappear on reload; if not, it shows the error and makes nothing.
   - **Moving old users over:** saved settings with the old `protein` (grams) become a protein % at their saved calories; carbs and fat share the rest 45:25, so 110 g at 1,700 kcal becomes 25.9 / 47.6 / 26.5 (`migrateSettings` in `app.js`). They're saved in the new form and `protein` is removed.
2. **Foods tab:**
   - **Search bar** at the top ("Add a food"). Focusing it opens the **full food list in a scrollable dropdown** under it; each row shows the name, its category and the Excellent badge if the food has one, plus **+** (tap to add) or **✓** (already in My foods; tapping does nothing). If an alias matched, it's shown after the name, e.g. *Canned tuna “tonfisk”*. Typing filters the list live (matching rules in section 3). Tapping a result adds it to My foods and keeps the dropdown open, so you can add several. Arrow keys and Enter work on a computer. The dropdown closes on **Escape** or a **tap outside** the search box (which also closes the phone keyboard).
   - **Phone keyboard:** focusing the search scrolls it to the top of the screen; the dropdown's height is set to the room left above the keyboard (`window.visualViewport`) and it scrolls on its own. While it's open the bottom tab bar is hidden, so it can't cover the list. Result rows are 48 px tall, the input 44 px.
   - **My foods (N):** only the foods you've added, grouped by category and sorted with the "Sort by" choice. Each food has a ticked checkbox on the left (untick = remove it from My foods; a 44 × 44 px tap area), the green Excellent badge if it has one, small fibre and ⚠ sat. fat badges (section 4.5), protein per 100 kcal, and kr per 100 g protein. If it's empty, a hint says to search to add foods.
   - **Own min/max per food:** tapping a food (everything right of the checkbox, ≥ 44 px) opens a small editor under it with **Min g/day** and **Max g/day**. Empty = use the defaults (min 0, `maxGramsPerDay`; the hint also gives `realisticMaxGramsPerDay` if the food has one). **Save** (or Enter) checks the values (numbers ≥ 0, min ≤ max; otherwise an error and nothing is saved) and closes it; **Reset** removes the food's own limits. Tapping the food again closes the editor. Foods with own limits show a small green marker, e.g. *Own limit 60–120 g*, *≥ 100 g* or *≤ 0 g*. Saved per food id in `localStorage` under `pbp.limits` (`{ "keso": { "min": 60, "max": 120 } }`, wrapped in try/catch; unknown ids and bad values are dropped on load). Only the limits of foods in My foods go to the optimizer (`settings.limits`). Changing them marks the plans out of date.
   - **The optimizer uses only My foods.**
   - **Saved:** the ids are kept in `localStorage` under `pbp.myFoods` (a list, wrapped in try/catch). On the **first visit** (nothing saved) My foods is the starter set (`"starter": true`). **Moving old users over:** if only the old `pbp.ticks` is saved (`{ id: false }` for unticked foods, everything else counted as ticked), My foods becomes every food that wasn't unticked, and `pbp.ticks` is removed once My foods is saved. A saved empty list stays empty. Ids no longer in `foods.json` are dropped.
3. **Plans tab** (plans and the grocery list together on one page; there is no separate List tab any more):
   - The **"Make my grocery list"** button, which runs `Optimizer.planAll`. Before the first run, a short hint says what it does.
   - **Three comparison cards** (section 5, "Three plans"), side by side on a wide screen and stacked on a phone: *Absolute cheapest*, *Cheapest realistic* (selected by default), *Same macros, higher quality*. Each card shows total cost vs the budget, protein, kcal, carbs, fat and fibre per day, % of protein from Excellent foods and the number of foods, or "Not possible".
   - **Tapping a card selects it and scrolls down to its grocery list**, below the cards on the same tab.
   - **Out of date:** if settings or My foods change after plans were made, a small red dot appears on the Plans tab button and an "out of date" note appears above the cards, until the button is pressed again.
   - **Grocery list of the selected plan** (below the cards, only after the first run; no macros, they have their own tab):
     - Top line: **Total 3,420 kr of 4,000 kr ✔** · **112 g protein/day** · **1,690 kcal/day**
     - Messages, e.g. over budget, or why the plan isn't possible
     - **Grocery table** with four columns: **Food** (with the Excellent badge if it has one), **Per day** (grams), **Packs** and **Cost**, plus a total row. Packs says how many of which pack, e.g. *2 × 1 kg*, *7 × 250 g* or *3 × 12 eggs* (`packSize(food)` in `app.js`: pieces with `pieceName` for foods with several pieces per pack, otherwise kg from 1,000 g up, otherwise g). Nothing about leftovers.
     - **Protein quality** section (section 4.4)
     - **Copy list** button (full width) under the table: copies the selected plan as plain text to paste into Notes or a message, then says **Copied ✓** for 2 seconds. Uses `navigator.clipboard` (https or localhost); otherwise the old copy command; if both fail, the text is shown in a box to select by hand. The text (`copyListText(plan, days)` in `app.js`):
       ```
       Cheapest realistic – 30 days

       Eggs & dairy
       Eggs – 3 × 12 eggs – 135 kr
       Keso 4% – 7 × 250 g – 154 kr

       Total: 1,352 kr (budget 4,000 kr)
       Per day: 115 g protein · 1,615 kcal
       ```
       Grouped by category in `foods.json` order; one line per food with its name, packs in exactly the same *N × size* style as the Packs column (`packsText`), and cost. The name leaves out pack details the size already gives (`shortName`: *Eggs (12 × 60 g)* → *Eggs*, *Barebells bar 55 g* → *Barebells bar*); other brackets stay (*Hard cheese (prästost)*).
   - A last open tab saved as `"list"` (from before the merge) opens Plans.
4. **Macros tab** (for the selected plan; before the first run it says to make plans first, with a "Go to Plans" button). Pie-chart icon. See section 4.5:
   - Plan switcher with the three plans at the top (tapping one stays on Macros)
   - Goal vs actual table: goal and actual grams and % for protein, carbs and fat
   - Daily / Monthly toggle
   - Pie chart and the table: grams, kcal and % of kcal for protein (×4), carbs (×4), fat (×9) and fibre (×2), plus a total kcal row
   - The fibre range row
5. **App settings page:** opened with the **⚙️ button** in the top-right corner of every tab (44 × 44 px, in the page header). It isn't part of the tab bar. It has a **← Back** button that returns to the tab it was opened from; the tab bar stays visible and also leaves the page, with no tab marked while it's open. The ⚙️ is hidden on the page itself. A reload opens the last real tab, not this page. Using it doesn't mark plans out of date. On it:
   - **Appearance:** System / Light / Dark, default System, which follows the phone. Saved under `pbp.theme` (wrapped in try/catch; an unknown value counts as System). A small script in the `<head>` sets `data-theme` on `<html>` before anything is drawn, so a dark page never flashes light. Without `data-theme`, `style.css` follows `prefers-color-scheme`. All colours are variables in `style.css`, with one light list and one dark list (repeated once, for System and for Dark, and a test checks the copies match), so dark mode covers every tab, badge, the pie chart and the tab bar. Green buttons keep a darker fill (`--accent-fill`) than green text (`--accent`), so both are readable. The phone's browser bar follows the page background (`theme-color`).
   - **Privacy line:** *"Your data stays on this phone. Nothing is sent anywhere."*
   - **Clear my data:** the button first shows a question on the page itself (no browser popup), with **Yes, clear it** and **Cancel**. Yes removes the `localStorage` keys that start with `pbp.`, and only those (other projects on the same GitHub Pages address share `localStorage`, so never `localStorage.clear()`), then reloads the page, which gives the first-visit state: starter foods, default settings, System, no own limits, no plans. It opens on this page with a short note that the data is cleared, once.
   - **About:** app version (`APP_VERSION` in `app.js`), where the prices come from with their dates (read from each food's `priceSource` in `foods.json`), and "not medical advice".
   - The feedback link comes in step 8.

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
   *Done when:* each failure case shows a helpful message instead of an empty result, saying why and what to change (test 35).
6. **Min/max per food, Copy list and the simpler grocery list** (section 6, Foods and Plans tabs).
   *Done when:* own limits are saved and respected by all three plans, Copy list pastes a readable list, and the grocery list shows Food, Per day, Packs (*2 × 1 kg*) and Cost (tests 31–34).
6b. **Whole packages in plans 2 and 3** (section 5).
   *Done when:* plans 2 and 3 are whole packages with every rule kept, and making the plans stays under about 2 seconds on a phone (tests 36–37).
7. **Polish for the phone:** tap targets of at least 44 px, no sideways scrolling at 360 px, readable on a small screen, Appearance (System / Light / Dark), and the App settings page (section 6).
   *Done when:* every tab works at 360 px in both colour schemes, the theme choice survives a reload, and Clear my data returns to the starter state (tests 47–51).
8. **Feedback:** add a link to a short Google Form, then share the page link with friends.

---

## 8. Test cases for `test.html`

| # | Setup | Expected |
|---|---|---|
| 1 | Default settings, all foods ticked | Solution found, protein, carbs and fat within goal ± 10%, kcal between 1,615 and 1,700, cost ≤ 4,000 |
| 2 | Only rice and apples ticked | Infeasible, with "Protein can't reach 115 g" and the maximum protein reachable |
| 3 | Budget 500 kr, default foods | Over-budget message showing the cheapest cost |
| 4 | Tuna max = 0 | Tuna not in the result |
| 5 | Eggs min = 100 g/day | Eggs ≥ 100 g/day in the result |
| 6 | Check the variety cap | No single food gives more than 35% of kcal |
| 7 | Check rounding | Packages × pack size ≥ monthly grams for every food (plans 2 and 3: exactly equal) |
| 8 | Ratings | keso, kvarg, tuna, tofu = Excellent; eggs, lentils, salmon = OK; peanut butter, oats, rice = Poor; on the Foods tab exactly the Excellent foods have the badge |
| 9 | Peanut butter, rapeseed oil, oats, lentils, rice + keso and tuna ticked | ≥ 60% of protein from Excellent foods; macros within their ranges |
| 10 | Only peanut butter, oats, lentils and rice ticked | Infeasible, with the "add more Excellent protein foods" message |
| 11 | Protein labels (real `index.html`) | Foods, search results and the grocery list show only the Excellent badge; no OK or Poor badges, lifts/dilutes labels or info line; the list says "X% of your protein comes from Excellent sources." with no breakdown and no Poor-food warning; the internal ratings and the optimizer's Excellent rule are unchanged |
| 12 | Three plans, default settings | All three give valid plans: kcal 1,615–1,700; protein, carbs and fat within goal ± 10%; ≥ 60% / 60% / 80% of protein from Excellent |
| 13 | Cost order, default settings | Plan 1 ≤ plan 2 ≤ plan 3 ≤ budget |
| 14 | Floor per food | No food in plans 2 and 3 is between 0 and 35 g a day (fats with `minGramsIfUsed`: between 0 and 10 g), unless one more whole pack would go over its max (prästost: 1 pack = 23 g) |
| 15 | Realistic max | Plans 2 and 3 respect every `realisticMaxGramsPerDay` (tofu 150, canned tuna 120, Oumph 150, kvarg 300); plan 1 keeps `maxGramsPerDay` |
| 16 | Protein in plans 2 and 3 | Both within the same range, 115–140 g (no extra grams on top of the goal); plan 3 with ≥ 80% from Excellent foods |
| 17 | Budget 1,150 kr (below the cheapest realistic plan, about 1,170 kr) | Plan 2 shown with an over-budget message; plan 3 says no realistic plan fits the budget |
| 18 | Food count | Plans 2 and 3 each have at least 10 different foods |
| 19 | Food-group limits | In plans 2 and 3 at 1,700 kcal: dairy ≤ 700 g/day; dry grains ≤ 200 g dry/day; every group in `groups.json` has members |
| 20 | Budget 1,400 kr (between plan 2 and plan 3) | Plans 1 and 2 fit; plan 3 has no plan and says what it would cost and how far over budget |
| 21 | Only 9 foods ticked | Plan 1 still works; plans 2 and 3 say they need at least 10 different foods (and nothing misleading) |
| 22 | Main page with tabs (real `index.html`) | Each tab shows only its panel; tab buttons ≥ 44 px; the button on Plans shows 3 cards with Cheapest realistic selected; the selected plan's grocery list and protein quality are below the cards on the same tab (no List tab or panel); tapping a card selects it, shows its list and stays on Plans; the Plans tab has no macros; the open tab is remembered, an old saved "list" tab opens Plans and an old "settings" tab opens Goals; a change shows the dot on Plans and the "out of date" note |
| 23 | Nutrients add up | Every food has the 5 nutrient fields, saturated fat ≤ fat, sugar ≤ carbs, and kcal ≈ 4P + 4C + 9F + 2 fibre within 15% (failures are listed) |
| 24 | Fibre ratings and warnings | e.g. lentils, oats, chickpeas, Oumph, bread = High fibre; pasta, frozen veg, Quest chips = Source; rice, keso, tuna = Low; prästost, keso, Barebells, milk = ⚠ sat. fat; Greek yoghurt 0% has no sat. fat warning; no food gets a sugar warning and the page never shows "⚠ Sugar" (sugarPer100g still in the data); the Foods tab badges match |
| 25 | Macro view (real `index.html`, Macros tab) | Pie drawn with a conic gradient (4 slices); table rows protein, carbs, fat, fibre with grams matching the optimizer, kcal = grams × 4 / 4 / 9 / 2, % of kcal adding up to 100, and a total kcal row; Monthly shows grams and kcal × days with the same %; the fibre row is green or yellow as expected |
| 26 | Macros tab and plan switcher (real `index.html`) | Macros is the fourth tab, after Plans, with its own icon; the switcher shows the three plans (≥ 44 px), starts on the selected plan, and tapping a plan shows its total kcal, stays on Macros, and selects its Plans card and grocery list |
| 27 | Food search (`searchFoods` + real `index.html`) | Finds by alias (tonfisk → both tuna products, lax → salmon), without accents (hono → Hönökaka, agg → eggs, prast → prästost, jordnotssmor → peanut butter), case-insensitive, two words in a row (cottage ch → keso); "ice" and "una" find nothing; every food has ≥ 2 aliases. On the page: focus opens the list with every food, its category and the Excellent badge on exactly the Excellent foods; typing "tonfisk" filters live; Escape and a tap outside close it, a tap inside doesn't; input and rows ≥ 44 px |
| 28 | Adding and removing (real `index.html`) | Unticking keso removes it from My foods, the saved list and what the optimizer gets; searching "cottage" and tapping keso adds it back under its category, saves it and shows ✓; tapping it again changes nothing; the row (untick control) ≥ 44 px |
| 29 | The optimizer uses only My foods (real `index.html`) | With 12 foods in My foods, the button makes the same three plans (foods and totals) as `Optimizer.planAll` with only those 12, and no grocery list has any other food |
| 30 | Starter set and moving old ticks over (reloads `index.html`) | 12–18 foods have `"starter": true` and give three valid plans; first visit (nothing saved) shows and saves exactly the starter set; old `pbp.ticks` with keso and oil unticked becomes every other food, and `pbp.ticks` is removed; a saved empty list stays empty |
| 31 | Own min/max in all three plans | Limits eggs min 100, keso 60–120, tofu max 20, kvarg min 320, rice max 0: every plan finds a plan with each food inside its limits; kvarg's realistic max is raised to 320 g (whole packages: exactly 20 packs); tofu's floor is lowered to 20 g (whole packages: at most 1 pack, and 1 pack is its floor) |
| 32 | Min/max editor (real `index.html`) | Tapping keso opens its editor (empty max shows 300 as a hint); min 150 / max 100 shows an error and saves nothing; 60 / 120 is saved under `pbp.limits`, closes the editor and shows the marker on keso only; the plans keep keso between 60 and 120 g; reopening shows 60 / 120; Reset removes the limits and the marker and marks plans out of date; food button and untick area ≥ 44 px |
| 33 | Copy list | `copyListText` on a hand-made plan gives exactly the text from section 6 (categories in order, *Eggs – 3 × 12 eggs – 135 kr*, no double pack size for Barebells); on the page the button copies the selected plan (clipboard replaced by a stand-in), every line has what its Packs column shows, and it says "Copied ✓" |
| 34 | Simpler grocery list (real `index.html`) | Every plan's table has the columns Food, Per day, Packs, Cost; each Packs cell is "packages × pack size" matching the optimizer (`packSize`: eggs "12 eggs", rice "1 kg", oats "1.5 kg", keso "250 g"); no leftover notes or warnings anywhere |
| 35 | Failed plans say why and what to change | For rice + apples, Poor/OK foods only, budgets 500 / 1,150 / 1,400, 9 foods, oil min 200 g and own max 0 on keso and tuna: every message has something to do; "too few Excellent" names Excellent foods from `foods.json` that aren't in My foods; the minimums message names the oil; own max limits are pointed out |
| 36 | Whole packages in plans 2 and 3 | With default settings, the own limits of test 31, 7 days, and 14 days at 2,400 kcal / 160 g: every food in plans 2 and 3 is a whole number of packages (grams per day × days = packages × pack size) and every rule holds (kcal, macros, Excellent, plan 3's fibre and saturated fat, variety, floor, max, scaled groups, 10 foods); plan 1 is still in grams per day |
| 37 | Speed | `planAll` with every food in My foods takes under 2 seconds (default settings, 14 days at 2,400 kcal / 160 g, 7 days); open `test.html` on the phone to check the phone itself |
| 38 | 1,700 kcal, 30/45/25 | Goals 127.5 / 191.25 / 47.2 g; in all three plans all macros within ±10% and kcal 95–100% |
| 39 | 3,000 kcal with 160 g protein (21.3/53.7/25) | All three plans: protein within 144–176 g, not 235 g; carbs and fat in range; every rule holds; dry grains limit scaled to 353 g. Budget 6,000 kr, because plan 3 costs about 5,100 kr here |
| 40 | The % must add up to 100 | 30/45/25 and 21.3/53.7/25 are fine; 30/45/30, 30/45/20 and a missing % aren't. The page shows the error and the button makes no plans; fixing the split removes it |
| 41 | Plan 3 | Named "Same macros, higher quality"; ≥ 80% Excellent, fibre ≥ 25 g, saturated fat ≤ ⅓ of fat; no extra-protein rules left |
| 42 | Presets and tolerance | All three presets give three plans inside the ranges; ±5% gives a narrower range that is kept too |
| 43 | Impossible plans name the macro | No carb foods: "Carbs can't reach 172 g" with carb foods from `foods.json`; the same for fat; only fatty foods: "Fat can't stay under …"; low-fibre foods: plan 2 works, plan 3 says "Fibre can't reach 25 g"; over 7 days the 900 g oil isn't suggested |
| 44 | New foods | Mixed nuts, olive oil, whole-grain pasta and avocado have a pack, price and nutrition "to check"; only one potatoes food |
| 45 | Settings form and moving old settings (real `index.html`, reloads) | Defaults 1,700 kcal, 30/45/25, ±10%; grams 128/191/47, and 225/338/83 at 3,000 kcal; typing 160 g gives 21.3%; presets fill in and mark the %; old 110 g at 1,700 kcal becomes 25.9/47.6/26.5, saved without `protein` |
| 46 | Macros tab: goal vs actual (real `index.html`) | Protein, carbs and fat show goal grams with range, actual grams, goal % and actual %, matching the optimizer and marked in range; only fibre is left in the range rows |
| 47 | Appearance (reloads `index.html`) | System by default; Dark and Light set the page's theme and survive a reload, and really change the colours; System removes the override; an unknown saved value counts as System; the System and Dark colour lists are identical; no fixed colours outside the lists |
| 48 | Readable on every tab (real page, 360 px) | In Dark and Light, on Goals (also with errors, Save changes and Saved ✓ with the Create button), App settings (also with the Clear question), Foods (also with an editor and the search open), Plans and Macros (each plan, incl. over budget and "not possible"): all text and input text at least 4.5:1 against what's behind it, counting opacity. In Dark the pie, swatches and dot at least 3:1 against the card |
| 49 | 360 px wide (real page) | In the same states: no sideways scrolling, nothing past the screen edges, and every button, link, input, select, food row and checkbox area at least 44 × 44 px |
| 50 | Clear my data (reloads `index.html`) | The first tap only asks, on the page; Cancel changes nothing; no browser popup; Yes leaves only what a first visit saves, keeps another app's key, and gives the starter foods, default settings, System, no plans and no own limits; the note shows once, on the App settings page, and the next reload opens Goals |
| 51 | App settings page (real `index.html`) | ⚙️ on every tab, not in the tab bar, labelled for screen readers; it opens only this page from every tab and Back returns to that tab; no tab marked and ⚙️ hidden while open; the tab bar also leaves it; a reload opens the last real tab; Goals holds none of it; the data line word for word, version, every price source from `foods.json`, "Not medical advice", System/Light/Dark, Clear my data |
| 52 | Goals tab: Save (real `index.html`, reloads) | Tab and heading say Goals; first visit says Save with no Create button; typing saves nothing; a split of 105% shows the error and saves nothing; a good save says Saved ✓, stores the goals (also values like 3,333 kr that don't fit the fields' step) and shows "Create my grocery list →"; Enter or Go saves without reloading; after a reload Saved ✓ with no Create button; a change or preset says Save changes and hides it, and the saved goals stay until Save; unsaved changes are gone after a reload; Create opens Plans and makes 3 plans; a later change marks them out of date; the Plans button uses and saves valid unsaved changes, and shows the error for a bad split |

"Tuna" in tests 4, 8 and 9 means both tuna products (canned and frozen). Test 4 also uses a food set where tuna is normally picked, and test 6 adds a stress case (quality rules off, every max × 10) so the variety cap actually has to do something. A browser test can't switch the phone's own dark setting, so test 47 checks System through the colour lists; check it by hand once on the phone. `test.html` also shows the three default plans side by side. The page tests start with every food in My foods and no own min/max, and the user's own saved data (`pbp.*` in `localStorage`) is put back after the run.

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
- Weekly lists, tick-off shopping mode, "already have it", and meal suggestions.
- Accounts and sharing, which needs a backend. Not before people actually use the app.

---

## 11. Risks to keep in mind

- **Bad prices or nutrition data give bad advice.** Show sources and dates, and make editing `foods.json` easy.
- **The optimizer picks odd combinations** or fills calories with cheap, low-protein foods. That's why the protein quality rules, max limits and variety cap exist. Expect to tune them after the first real month.
- **Health:** this plans calories and macros only. It isn't a complete diet plan or medical advice. Say so under About on the App settings page.
- **Scope creep:** nothing from section 10 goes in before steps 1–8 are done and at least 3 friends have tried it.
