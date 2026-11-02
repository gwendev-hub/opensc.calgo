// optimizer.js – builds the diet model (PLAN.md section 5), solves it with
// javascript-lp-solver and turns the answer into packages to buy.
// It never touches the page. It expects the solver to be loaded first, which
// gives a global called `solver`:
//   <script src="https://cdn.jsdelivr.net/npm/javascript-lp-solver@0.4.24/prod/solver.js"></script>
//
// Everything is wrapped in one object, `Optimizer`, so none of the names here
// clash with the ones in app.js.
// What the numbers in data/foods.json mean (all per 100 g):
//   carbsPer100g – available carbohydrates ("kolhydrater" on Swedish labels), without fibre
//   saturatedFatPer100g – part of fatPer100g; sugarPer100g – part of carbsPer100g
//   Check: kcal ≈ 4 × protein + 4 × carbs + 9 × fat + 2 × fibre, within 15%. Products with sugar
//   alcohols (e.g. Barebells) count them as carbs, which makes the estimate a bit high.
//
const Optimizer = (() => {
  // Default rules. All of them can be overridden through settings.rules
  // (PLAN.md section 4.3 says they'll be editable under "Advanced" later).
  const DEFAULT_RULES = {
    kcalLowFactor: 0.95, // calories must land between 95% and 100% of the target
    excellentProteinShare: 0.6, // at least 60% of protein from Excellent foods
    varietyKcalShare: 0.35, // no single food gives more than 35% of calories
    // Realistic rules, used by plans 2 and 3 only (PLAN.md section 5, "Three plans")
    minGramsIfUsed: 35, // a food is either not in the plan or at least 35 g a day (foods.json can lower it, e.g. fats)
    minFoods: 10, // at least this many different foods
    groupBaseKcal: 1700, // groups.json limits are for this many kcal; they scale with kcalTarget ÷ this
    // Extra rules, only switched on by plan 3 (the defaults here never block anything)
    minFiberPerDay: 0, // fibre at least this many grams a day
    maxSaturatedFatShare: 1, // saturated fat at most this share of the fat
    // Plan 3 "Same macros, higher quality"
    highQualityExcellentShare: 0.8, // at least 80% of protein from Excellent foods
    highQualityMinFiber: 25, // fibre at least 25 g a day
    highQualitySaturatedFatShare: 1 / 3, // saturated fat at most ⅓ of the fat
  };

  // kcal per gram of the three macros in the plan (fibre isn't part of the split)
  const MACRO_KCAL = { protein: 4, carbs: 4, fat: 9 };
  // Names for messages
  const MACRO_LABELS = { protein: "Protein", carbs: "Carbs", fat: "Fat" };
  // Default tolerance: each macro may be this many % of its grams above or below its goal
  const DEFAULT_TOLERANCE_PCT = 10;

  // Each macro's goal in grams per day, and the range the plans must stay in.
  // settings: { kcal, proteinPct, carbsPct, fatPct, tolerancePct }
  // E.g. 1,700 kcal with 45% carbs: 1700 × 0.45 ÷ 4 = 191 g, ±10% = 172–210 g.
  // Returns { protein: { pct, goal, min, max }, carbs: …, fat: … }
  function macroGoals(settings) {
    const tolerance =
      (typeof settings.tolerancePct === "number" ? settings.tolerancePct : DEFAULT_TOLERANCE_PCT) / 100;
    const goals = {};
    for (const m of Object.keys(MACRO_KCAL)) {
      const pct = settings[m + "Pct"];
      const goal = (settings.kcal * pct) / 100 / MACRO_KCAL[m];
      goals[m] = { pct, goal, min: goal * (1 - tolerance), max: goal * (1 + tolerance) };
    }
    return goals;
  }

  // The split must add up to 100% (rounded to one decimal, because typing grams gives
  // values like 21.3%). Returns an error text, or null if the split is fine.
  function macroSplitProblem(settings) {
    const pcts = Object.keys(MACRO_KCAL).map((m) => settings[m + "Pct"]);
    if (pcts.some((pct) => typeof pct !== "number" || Number.isNaN(pct) || pct < 0)) {
      return "Enter a % of 0 or more for protein, carbs and fat.";
    }
    const sum = Math.round(pcts.reduce((total, pct) => total + pct, 0) * 10) / 10;
    return sum === 100 ? null : `Protein, carbs and fat must add up to 100%. Now they add up to ${sum}%.`;
  }

  // There's deliberately no "Poor foods ≤ 40% of calories" rule any more. Nearly all carbs and fat
  // come from foods rated Poor, so it fought the macro goals: 3,000 kcal at about 21 / 54 / 25 had no
  // plan at all, and at 1,700 kcal it held carbs at the bottom of their range. The macro ranges now
  // stop one kind of food taking over. OK and Poor don't appear in any rule of the model; they only
  // give the plan's protein and kcal shares and decide which foods a message suggests.
  //
  // Why the variety rule exists: without it the cheapest answer is boring, e.g. mostly lentils and oats.
  //
  // Amounts below this many grams per day are treated as zero.
  // The solver can return tiny amounts like 0.0000001 g, and we don't want
  // to tell anyone to buy a whole pack of something because of that.
  const MIN_GRAMS_PER_DAY = 0.5;

  // Protein rating rule from PLAN.md section 4.1 (same rule as in app.js,
  // don't change without asking): protein × 10 > kcal → Excellent,
  // ≥ kcal / 2 → OK, otherwise Poor.
  function proteinRating(f) {
    const score = f.proteinPer100g * 10;
    if (score > f.kcalPer100g) return "excellent";
    if (score >= f.kcalPer100g / 2) return "ok";
    return "poor";
  }

  // Fibre rating per 100 g (PLAN.md section 4.5): ≥ 6 g → High, ≥ 3 g → Source, otherwise Low
  function fiberRating(f) {
    const fiber = f.fiberPer100g || 0;
    if (fiber >= 6) return "high";
    if (fiber >= 3) return "source";
    return "low";
  }

  // Foods with less than this much fat (or carbs) per 100 g get no warning about it,
  // so e.g. 0.2 g fat in Greek yoghurt 0% isn't flagged for saturated fat
  const WARNING_MIN_GRAMS = 1;

  // Nutrient warnings per food (PLAN.md section 4.5). Returns a list, e.g. ["satFat"]:
  //   "satFat" – saturated fat is more than ⅓ of the fat
  // (sugarPer100g stays in the data, but there's no sugar warning any more)
  function nutrientWarnings(f) {
    const warnings = [];
    const fat = f.fatPer100g || 0;
    if (fat >= WARNING_MIN_GRAMS && (f.saturatedFatPer100g || 0) > fat / 3) warnings.push("satFat");
    return warnings;
  }

  // The solver keeps its own fields (feasible, result, bounded) next to the
  // variable values in its answer, so food variables get a prefix that can't
  // collide with those names.
  const varName = (f) => "food_" + f.id;

  // Same name for the yes/no variable that says whether a food is used (realistic plans)
  const useName = (f) => "use_" + f.id;

  // Merge the user's rules over the defaults
  function rulesFrom(settings) {
    return { ...DEFAULT_RULES, ...(settings.rules || {}) };
  }

  // maxGramsPerDay is a sensible default, so the plan can't say e.g. 600 g of lentils a day.
  // Plan 1 ignores realisticMaxGramsPerDay, minGramsIfUsed and limitGroup.
  // Per-food min and max in grams per day.
  // Max is the user's override if there is one. Otherwise it's maxGramsPerDay
  // from foods.json, or the stricter realisticMaxGramsPerDay (if the food has one)
  // when building a realistic plan.
  // The user's own limits always win: a min above the default max raises the max
  // to that min (e.g. tofu min 200 g with plan 2's 150 g default max → max 200 g).
  function limitsFor(f, settings, realistic = false) {
    const override = (settings.limits && settings.limits[f.id]) || {};
    const dataMax =
      realistic && typeof f.realisticMaxGramsPerDay === "number" ? f.realisticMaxGramsPerDay : f.maxGramsPerDay;
    const min = typeof override.min === "number" ? override.min : 0;
    const max = typeof override.max === "number" ? override.max : Math.max(dataMax, min);
    return { min, max };
  }

  // Limits in the unit of the food's variable (PLAN.md section 5):
  //   grams per day (plan 1), or
  //   whole packages per month (plans 2 and 3, packs = true).
  // Returns { unit, min, max, floor }:
  //   unit  – grams per day that one unit of the variable stands for
  //           (1, or packGrams ÷ days, e.g. a 1 kg pack over 30 days = 33.3 g a day)
  //   min / max – the per-food limits in that unit
  //   floor – the smallest amount if the food is used (realistic plans only), in that unit
  function unitLimits(f, settings, realistic = false, packs = false) {
    const rules = rulesFrom(settings);
    const { min, max } = limitsFor(f, settings, realistic);
    const floorGrams = typeof f.minGramsIfUsed === "number" ? f.minGramsIfUsed : rules.minGramsIfUsed;
    if (!packs) {
      // Grams: the floor is never above the max, so a user max of e.g. 20 g still lets the food in
      return { unit: 1, min, max, floor: Math.min(max, floorGrams) };
    }
    // With whole packs a food can be below its floor only when one more pack would go over its max,
    // e.g. prästost (max 40 g): 1 pack of 700 g over 30 days is 23 g a day, 2 packs would be 47 g.
    // A food whose single pack is more than its max per day can't be used at all, e.g. rapeseed oil
    // (900 g lasts 45 days at 20 g a day). Short periods make this more common (1.5 kg of oats is
    // 214 g a day over 7 days, above its 100 g max).
    const unit = f.packGrams / settings.days;
    // Min rounds up to whole packs and max rounds down (the small 1e-9 stops
    // 99.99999 / 33.33333 becoming 2 instead of 3). If the user's own min and max
    // fit no whole number of packs, their min wins, like an own min above the default max.
    const minPacks = Math.ceil(min / unit - 1e-9);
    const maxPacks = Math.max(minPacks, Math.floor(max / unit + 1e-9));
    // At least 1 pack if used, and enough packs for the floor, but never more than the max
    const floorPacks = Math.min(maxPacks, Math.max(1, Math.ceil(floorGrams / unit - 1e-9)));
    return { unit, min: minPacks, max: maxPacks, floor: floorPacks };
  }

  // The user's own limits ({ id: { min?, max? } }) on foods in this list, as names,
  // e.g. "Firm tofu and Oats" (only the foods that have a "min" or "max", whichever `which` says)
  function ownLimitNames(userLimits, foods, which) {
    const names = foods.filter((f) => userLimits && userLimits[f.id] && typeof userLimits[f.id][which] === "number")
      .map((f) => f.name);
    return joinNames(names, "and");
  }

  // “A”, “A” and “B”, “A”, “B” and “C”, or “A”, “B”, “C” and 2 more (word is "and" or "or").
  // The quotes keep names with commas readable, e.g. “Soy mince, dry”.
  function joinNames(names, word) {
    const quoted = names.map((name) => `“${name}”`);
    if (quoted.length <= 1) return quoted.join("");
    if (quoted.length > 3) return `${quoted.slice(0, 3).join(", ")} and ${quoted.length - 3} more`;
    return `${quoted.slice(0, -1).join(", ")} ${word} ${quoted[quoted.length - 1]}`;
  }

  // Up to 3 foods from the full food list (catalog) that aren't in My foods yet and
  // pass the test, cheapest protein first, e.g. "Keso 4%, Kvarg naturell or Firm tofu".
  // "" if there are none (or no catalog was passed in).
  function suggestFoods(catalog, foods, test, nutrient = "proteinPer100g") {
    const mine = new Set(foods.map((f) => f.id));
    // kr per gram of the nutrient (protein unless told otherwise), so the cheapest sources come first
    const krPerGram = (f) => (f[nutrient] > 0 ? f.packPrice / f.packGrams / f[nutrient] : Infinity);
    const names = (catalog || [])
      .filter((f) => !mine.has(f.id) && test(f))
      .sort((a, b) => krPerGram(a) - krPerGram(b))
      .slice(0, 3)
      .map((f) => f.name);
    return joinNames(names, "or");
  }

  // Foods to suggest for a macro that can't be reached: those that get at least 40% of
  // their calories from it, cheapest grams first (e.g. rice, pasta and potatoes for carbs)
  // usable (optional) leaves out foods that can't help the plan being explained.
  function suggestForMacro(catalog, foods, macro, usable = () => true) {
    const isSource = (f) =>
      f.kcalPer100g > 0 && (f[macro + "Per100g"] * MACRO_KCAL[macro]) / f.kcalPer100g >= 0.4 && usable(f);
    return suggestFoods(catalog, foods, isSource, macro + "Per100g");
  }

  // " You set your own max for X and Y in My foods; raising them may help." ("" if there are none)
  function ownMaxHint(userLimits, foods) {
    const names = ownLimitNames(userLimits, foods, "max");
    if (!names) return "";
    // One food: "it"; several: "them"
    const pronoun = names.includes("” and “") || names.includes("”, “") ? "them" : "it";
    return ` You set your own max for ${names} in My foods; raising ${pronoun} may help.`;
  }

  // Build the javascript-lp-solver model.
  // settings: { kcal, proteinPct, carbsPct, fatPct, tolerancePct, budget, days, limits?, rules? }
  // foods:    only the foods in My foods
  // options changes the goal, adds rules or drops rules:
  //   optimize/opType     – what to maximise or minimise (default: minimise cost)
  //   skip                – names of rules to leave out ("kcalMin", "protein", "carbs",
  //                         "fat", "excellent", "variety", "fiber", "satFat")
  //   realistic           – plans 2 and 3: 35 g floor per food, realistic max
  //                         limits, at least 10 foods and the group limits
  //   packs               – plans 2 and 3: each food's variable is the number of whole
  //                         packages per month (an integer) instead of grams per day
  //   groups              – food-group limits from data/groups.json (realistic only)
  // Rule shares (Excellent share etc.) come from settings.rules.
  function buildModel(settings, foods, options = {}) {
    const rules = rulesFrom(settings);
    const skip = new Set(options.skip || []);
    const kcalTarget = settings.kcal;
    const realistic = Boolean(options.realistic);
    const packs = Boolean(options.packs);

    // Constraints are named limits on sums of variable attributes
    const constraints = {};

    // Calories within a range: 95–100% of the target
    constraints.kcal = skip.has("kcalMin")
      ? { max: kcalTarget }
      : { min: kcalTarget * rules.kcalLowFactor, max: kcalTarget };

    // Protein, carbs and fat: each within its goal ± the tolerance
    const goals = macroGoals(settings);
    for (const m of Object.keys(goals)) {
      if (!skip.has(m)) constraints[m] = { min: goals[m].min, max: goals[m].max };
    }

    // Plan 3 only: enough fibre, and saturated fat at most a share of the fat, written
    // so it stays linear: Σ saturated fat − ⅓ · Σ fat ≤ 0
    if (rules.minFiberPerDay > 0 && !skip.has("fiber")) constraints.fiber = { min: rules.minFiberPerDay };
    if (rules.maxSaturatedFatShare < 1 && !skip.has("satFat")) constraints.satFat = { max: 0 };

    // At least 10 different foods: every food's yes/no variable counts 1 (see the floor below)
    if (realistic) constraints.foodCount = { min: rules.minFoods };

    // Groups stop a plan stacking similar foods, e.g. keso + kvarg + yoghurt + milk. Eggs aren't in
    // dairy; bread and hönökaka aren't in dry grains (they're weighed ready to eat, the grains dry).
    // Food-group limits, e.g. dairy ≤ 700 g a day at 1,700 kcal: each food in the group
    // counts 1 per gram. The limits grow and shrink with the calories (kcalTarget ÷ 1,700).
    const groupMax = {};
    if (realistic) {
      for (const g of options.groups || []) {
        const max = (g.maxGramsPerDay * kcalTarget) / rules.groupBaseKcal;
        constraints["group_" + g.id] = { max };
        groupMax[g.id] = max;
      }
    }

    // Excellent share, written so it stays linear (PLAN.md section 5):
    // Σ_excellent protein − 0.60 · Σ_all protein ≥ 0
    if (!skip.has("excellent")) constraints.excellentShare = { min: 0 };

    // Does a food that gives at most maxKcal a day need a variety constraint?
    // Not if that's within 35% of the calorie minimum (only known when that minimum is used).
    const varietyNeeded = (maxKcal) =>
      !skip.has("variety") && (skip.has("kcalMin") || maxKcal > rules.varietyKcalShare * constraints.kcal.min);

    // One entry per food: its attributes, plus its own limit constraints
    const variables = {};
    // Yes/no variables for the 35 g floor (realistic plans only)
    const binaries = {};
    // Whole-number variables: the packages per month (plans 2 and 3)
    const ints = {};
    for (const f of foods) {
      const name = varName(f);
      // Limits in the variable's unit, and how many grams per day one unit is
      const { unit, min, max, floor } = unitLimits(f, settings, realistic, packs);
      // Everything below is per unit of the variable: per gram (unit = 1), or
      // per package per month, which is packGrams ÷ days grams a day
      const kcal = (f.kcalPer100g / 100) * unit; // kcal per day
      const protein = (f.proteinPer100g / 100) * unit; // protein grams per day
      const rating = proteinRating(f);

      const v = {
        cost: (f.packPrice / f.packGrams) * unit, // kr per day
        kcal,
        protein,
        carbs: (f.carbsPer100g / 100) * unit, // carb grams per day
        fat: (f.fatPer100g / 100) * unit, // fat grams per day
        fiber: (f.fiberPer100g / 100) * unit, // fibre grams per day
        // Saturated fat minus ⅓ of the fat (see satFat above)
        satFat: ((f.saturatedFatPer100g - rules.maxSaturatedFatShare * f.fatPer100g) / 100) * unit,
        // 1 − 0.60 for Excellent foods, −0.60 for the rest (see excellentShare above)
        excellentShare: protein * ((rating === "excellent" ? 1 : 0) - rules.excellentProteinShare),
      };

      // Per-food limits: min ≤ amount ≤ max (grams per day, or packages).
      // The solver has no variable bounds, so each food gets a constraint
      // that only it contributes to (1 per unit).
      // In realistic plans a food with min 0 doesn't need it: its "ceiling" below
      // (amount ≤ max · use) already keeps it under the max. Fewer constraints = faster.
      const ceilingIsEnough = realistic && max > 0 && min === 0;
      if (!ceilingIsEnough) {
        v["limit_" + f.id] = 1;
        constraints["limit_" + f.id] = { min, max };
      }

      // Packages can only be bought whole
      if (packs) ints[name] = 1;

      // The cheapest way to reach "10 foods" is often a few foods at the smallest amount allowed
      // (e.g. one pack of potatoes). That's expected; watch whether it looks silly in real use.
      // The floor: the amount is either 0 or at least 35 g (or the food's own
      // minGramsIfUsed from foods.json, e.g. 10 g for fats; with packages, the
      // fewest packs that give that much). A linear model can't
      // say "either/or" directly, so each food gets a yes/no variable `use`:
      //   amount − floor · use ≥ 0  (if use = 1, at least the floor)
      //   amount − max · use ≤ 0    (if use = 0, nothing at all)
      // `use` also counts 1 towards the "at least 10 foods" rule.
      // Foods with max 0 can't be used anyway, so they don't need one
      // (with packages that includes foods where one pack is more than their max).
      // The floor is never above the max, so a user max of e.g. 20 g still lets the food in.
      if (realistic && max > 0) {
        const use = useName(f);
        v["floor_" + f.id] = 1;
        v["ceiling_" + f.id] = 1;
        variables[use] = { ["floor_" + f.id]: -floor, ["ceiling_" + f.id]: -max, foodCount: 1 };
        constraints["floor_" + f.id] = { min: 0 };
        constraints["ceiling_" + f.id] = { max: 0 };
        binaries[use] = 1;
      }

      // This food's grams per day count towards its group's limit (if the group has one)
      if (realistic && f.limitGroup && f.limitGroup in groupMax) v["group_" + f.limitGroup] = unit;

      // Variety: this food's kcal − 0.35 · total kcal ≤ 0.
      // It's measured against the actual total, so no
      // food ever gives more than 35% of the plan's calories.
      // A food that gives at most 35% of the calorie minimum even at its max can
      // never break it (the total is at least that minimum), so it gets no
      // constraint. That's most foods, and it makes the solver a lot faster.
      if (varietyNeeded(kcal * max)) {
        const key = "variety_" + f.id;
        constraints[key] = { max: 0 };
        // This food counts once in full and once inside the total
        v[key] = kcal * (1 - rules.varietyKcalShare);
      }

      variables[name] = v;
    }

    // Second pass: every other food only counts inside the total, so it gets
    // "−0.35 × kcal" in this food's variety constraint (needs all variables to exist first)
    if (!skip.has("variety")) {
      for (const f of foods) {
        if (!(("variety_" + f.id) in constraints)) continue;
        for (const other of foods) {
          if (other.id === f.id) continue;
          variables[varName(other)]["variety_" + f.id] = -variables[varName(other)].kcal * rules.varietyKcalShare;
        }
      }
    }

    return {
      optimize: options.optimize || "cost",
      opType: options.opType || "min",
      constraints,
      variables,
      binaries,
      ints,
      // Solver options, e.g. a time limit (only set when explaining a failed plan)
      ...(options.options ? { options: options.options } : {}),
    };
  }

  // Run the solver. Returns its raw answer:
  // { feasible: true/false, result: <value of the goal>, food_<id>: grams, ... }
  function solve(model) {
    if (typeof solver === "undefined") {
      throw new Error("javascript-lp-solver isn't loaded (global `solver` missing)");
    }
    return solver.Solve(model);
  }

  // Read grams per day for each food out of a solver answer (tiny values → 0).
  // days is given for answers in whole packages per month (plans 2 and 3):
  // grams per day = packages × pack size ÷ days.
  function gramsFrom(answer, foods, days) {
    const grams = {};
    for (const f of foods) {
      const value = answer[varName(f)] || 0;
      // Packages: round away the solver's tiny errors (2.9999999 → 3)
      const x = days ? (Math.round(value) * f.packGrams) / days : value;
      grams[f.id] = x >= MIN_GRAMS_PER_DAY ? x : 0;
    }
    return grams;
  }

  // Turn grams per day into a grocery list, totals and the protein quality breakdown
  function summarise(settings, foods, grams) {
    const days = settings.days;
    const items = [];
    let shoppingCost = 0;
    let kcalPerDay = 0;
    let proteinPerDay = 0;
    // Other nutrients per day, in grams (PLAN.md section 4.5)
    const nutrients = { carbs: 0, fat: 0, fiber: 0, saturatedFat: 0, sugar: 0 };
    // kcal and protein per day, split by rating
    const byRating = {
      excellent: { kcal: 0, protein: 0 },
      ok: { kcal: 0, protein: 0 },
      poor: { kcal: 0, protein: 0 },
    };

    for (const f of foods) {
      const gramsPerDay = grams[f.id];
      if (!gramsPerDay) continue; // not in the plan

      // Monthly grams, then packages: always round up so you never run short.
      // The small −1e-9 stops 3000.0000001 g / 1000 g packs becoming 4 packs.
      // (Plans 2 and 3 are already in whole packages, so this gives back exactly those.)
      const monthlyGrams = gramsPerDay * days;
      const packages = Math.ceil(monthlyGrams / f.packGrams - 1e-9);
      const cost = packages * f.packPrice;
      const rating = proteinRating(f);
      const kcal = (f.kcalPer100g * gramsPerDay) / 100;
      const protein = (f.proteinPer100g * gramsPerDay) / 100;

      items.push({
        id: f.id,
        name: f.name,
        rating,
        gramsPerDay,
        monthlyGrams,
        packages,
        cost,
        packGrams: f.packGrams,
        // Piece foods (eggs, cans, bars): also give the piece count
        piecesPerDay: f.pieceGrams ? gramsPerDay / f.pieceGrams : null,
        piecesToBuy: f.pieceGrams ? Math.round((packages * f.packGrams) / f.pieceGrams) : null,
        kcalPerDay: kcal,
        proteinPerDay: protein,
      });

      // Add up the totals
      shoppingCost += cost;
      kcalPerDay += kcal;
      proteinPerDay += protein;
      byRating[rating].kcal += kcal;
      byRating[rating].protein += protein;
      for (const name of Object.keys(nutrients)) {
        nutrients[name] += ((f[name + "Per100g"] || 0) * gramsPerDay) / 100;
      }
    }

    // Energy per day from each macro for the Macros tab: protein and carbs 4 kcal/g,
    // fat 9 kcal/g, fibre 2 kcal/g. The shares are of the total of these four, so they add up to 100%.
    const macroKcal = {
      protein: proteinPerDay * 4,
      carbs: nutrients.carbs * 4,
      fat: nutrients.fat * 9,
      fiber: nutrients.fiber * 2,
    };
    const macroKcalTotal = Object.values(macroKcal).reduce((sum, k) => sum + k, 0);
    const macroKcalShare = {};
    for (const m of Object.keys(macroKcal)) macroKcalShare[m] = macroKcalTotal > 0 ? macroKcal[m] / macroKcalTotal : 0;

    // The split to compare with the goal: each macro's share of protein + carbs + fat
    // (without fibre, like the goal), so these three add up to 100%
    const splitTotal = macroKcal.protein + macroKcal.carbs + macroKcal.fat;
    const macroSplit = {};
    for (const m of Object.keys(MACRO_KCAL)) macroSplit[m] = splitTotal > 0 ? macroKcal[m] / splitTotal : 0;

    // Shares as fractions (0–1) of total protein and total kcal
    const proteinShare = {};
    const kcalShare = {};
    for (const r of ["excellent", "ok", "poor"]) {
      proteinShare[r] = proteinPerDay > 0 ? byRating[r].protein / proteinPerDay : 0;
      kcalShare[r] = kcalPerDay > 0 ? byRating[r].kcal / kcalPerDay : 0;
    }

    // Budget check, done on the rounded shopping cost (what you actually pay)
    const overBy = shoppingCost - settings.budget;

    return {
      items,
      totals: {
        shoppingCost,
        budget: settings.budget,
        overBudget: overBy > 0,
        overBy: Math.max(0, overBy),
        kcalPerDay,
        proteinPerDay,
        carbsPerDay: nutrients.carbs,
        fatPerDay: nutrients.fat,
        fiberPerDay: nutrients.fiber,
        saturatedFatPerDay: nutrients.saturatedFat,
        sugarPerDay: nutrients.sugar,
        foodCount: items.length,
      },
      quality: {
        proteinShare,
        kcalShare,
        // % of calories that come from protein (4 kcal per gram)
        proteinKcalShare: kcalPerDay > 0 ? (proteinPerDay * 4) / kcalPerDay : 0,
        // kcal per day from protein / carbs / fat / fibre, their total, and each one's share (Macros tab)
        macroKcal,
        macroKcalTotal,
        macroKcalShare,
        macroSplit,
      },
    };
  }

  // Solve a variant of the model and return the value of its goal (or null if infeasible)
  function bestValue(settings, foods, options) {
    const answer = solve(buildModel(settings, foods, options));
    return answer.feasible ? answer.result : null;
  }

  // Is the full cost model feasible without one of the rules?
  function feasibleWithout(settings, foods, rule) {
    return solve(buildModel(settings, foods, { skip: [rule] })).feasible;
  }

  // Which macro can't be met? Returns one problem per macro, e.g.
  //   { code: "carbs", macro: "carbs", side: "min", message: "Carbs can't reach 172 g (…): add …" }.
  // Two passes, each with its own rules:
  //   1. Only the foods, their limits and the calorie target: can the macro get there at all?
  //   2. If every macro passes, all the plan's rules except this macro's own range: if
  //      leaving out just this range makes a plan possible, this macro is what blocks it.
  // options are the model options of the plan being explained (e.g. realistic and groups).
  function macroProblems(settings, foods, help, options = {}) {
    const goals = macroGoals(settings);
    const macros = Object.keys(goals);
    const foodsOnly = ["kcalMin", "protein", "carbs", "fat", "excellent", "variety", "fiber", "satFat"];
    const userLimits = "userLimits" in help ? help.userLimits : settings.limits;
    const maxHint = ownMaxHint(userLimits, foods);

    // The highest or lowest this macro can be; null if the rules can't be kept at all
    const reach = (macro, opType, skip) => bestValue(settings, foods, { ...options, optimize: macro, opType, skip });

    // A message for a macro that's outside its range; what to do depends on the side
    const problemFor = (macro, side, value) => {
      const label = MACRO_LABELS[macro];
      const fix = "raise the max limits";
      if (side === "min") {
        const ideas = suggestForMacro(help.catalog, foods, macro, help.usable);
        const target = Math.round(goals[macro].min);
        return {
          code: macro,
          macro,
          side,
          value,
          message:
            `${label} can't reach ${target} g (at most ${Math.floor(value)} g with these foods): ` +
            (ideas ? `add ${ideas}, or ${fix}.` : `${fix}, or lower its %.`) + maxHint,
        };
      }
      const others = macros.filter((m) => m !== macro).map((m) => MACRO_LABELS[m].toLowerCase()).join(" or ");
      return {
        code: macro,
        macro,
        side,
        value,
        message:
          `${label} can't stay under ${Math.floor(goals[macro].max)} g (at least ${Math.ceil(value)} g with these foods): ` +
          `add foods with more ${others} and less ${label.toLowerCase()}, lower the min limits, or raise its %.`,
      };
    };

    // Pass 1: the highest within the calorie target, the lowest at the calorie minimum
    const problems = [];
    for (const macro of macros) {
      const highest = reach(macro, "max", foodsOnly);
      if (highest !== null && highest < goals[macro].min) {
        problems.push(problemFor(macro, "min", highest));
        continue;
      }
      const lowest = reach(macro, "min", foodsOnly.filter((rule) => rule !== "kcalMin"));
      if (lowest !== null && lowest > goals[macro].max) problems.push(problemFor(macro, "max", lowest));
    }
    if (problems.length > 0) return problems;

    // Pass 2: all the plan's rules except this macro's range
    for (const macro of macros) {
      const highest = reach(macro, "max", [macro]);
      if (highest === null) continue; // still impossible, so this macro isn't the only cause
      if (highest < goals[macro].min) {
        problems.push(problemFor(macro, "min", highest));
        continue;
      }
      const lowest = reach(macro, "min", [macro]);
      if (lowest !== null && lowest > goals[macro].max) problems.push(problemFor(macro, "max", lowest));
    }
    return problems;
  }

  // Message rules: never just "no solution". Every message ends with something to do (add, raise,
  // lower, use another plan). Suggested foods come from foods.json, never from names written in the
  // code, and only ones not yet in My foods. If none fit, the message falls back to raising max limits.
  // The user's own max and min limits are named, because they may be what's in the way.
  // The plan has no solution: work out why, in words (PLAN.md section 5).
  // Every message says what to change. help (optional):
  //   catalog    – every food in foods.json, to suggest foods that aren't in My foods yet
  //   userLimits – the user's own min/max ({ id: { min?, max? } }), to point at them
  //   usable     – leaves out foods that can't help this plan from the macro suggestions
  // Returns a list of { code, message, ... }, most useful first.
  function diagnose(settings, foods, help = {}) {
    const rules = rulesFrom(settings);
    const kcalTarget = settings.kcal;
    const kcalMin = kcalTarget * rules.kcalLowFactor;
    const goals = macroGoals(settings);
    const problems = [];
    const pct = (share) => Math.round(share * 100);
    const userLimits = "userLimits" in help ? help.userLimits : settings.limits;
    const maxHint = ownMaxHint(userLimits, foods);
    // Foods to suggest, by rating
    const excellentIdeas = suggestFoods(help.catalog, foods, (f) => proteinRating(f) === "excellent");
    const notPoorIdeas = suggestFoods(help.catalog, foods, (f) => proteinRating(f) !== "poor");

    // Only the foods and their limits, no macro, quality or variety rules
    const basicSkip = ["kcalMin", "protein", "carbs", "fat", "excellent", "variety", "fiber", "satFat"];

    // 1. Excellent share: even using every Excellent food up to its max,
    //    is there enough Excellent protein for 60% of the lowest protein allowed?
    const excellentFoods = foods.filter((f) => proteinRating(f) === "excellent");
    const maxExcellentProtein = excellentFoods.length
      ? bestValue(settings, excellentFoods, { optimize: "protein", opType: "max", skip: basicSkip }) || 0
      : 0;
    if (
      maxExcellentProtein < rules.excellentProteinShare * goals.protein.min ||
      feasibleWithout(settings, foods, "excellent")
    ) {
      problems.push({
        code: "excellent",
        message:
          `My foods has too few Excellent protein foods to get ${pct(rules.excellentProteinShare)}% ` +
          `of your protein from them. ` +
          (excellentIdeas
            ? `Add more Excellent foods like ${excellentIdeas}.`
            : `Raise the max limits of your Excellent foods.`) +
          maxHint,
      });
    }

    // 2. Plan 3's fibre rule: can these foods reach it within the calorie target?
    if (rules.minFiberPerDay > 0) {
      const maxFiber = bestValue(settings, foods, { optimize: "fiber", opType: "max", skip: basicSkip });
      if ((maxFiber !== null && maxFiber < rules.minFiberPerDay) || feasibleWithout(settings, foods, "fiber")) {
        const isFibreSource = (f) => fiberRating(f) === "high";
        const ideas = suggestFoods(help.catalog, foods, isFibreSource, "fiberPer100g");
        problems.push({
          code: "fiber",
          message:
            `Fibre can't reach ${rules.minFiberPerDay} g a day: ` +
            (ideas ? `add high-fibre foods like ${ideas}, or raise the max limits.` : "raise the max limits of your high-fibre foods.") +
            maxHint,
        });
      }
    }

    // 3. Plan 3's saturated fat rule: is it what blocks the plan?
    if (rules.maxSaturatedFatShare < 1 && feasibleWithout(settings, foods, "satFat")) {
      const isLowSat = (f) => f.fatPer100g >= 10 && f.saturatedFatPer100g <= f.fatPer100g * rules.maxSaturatedFatShare;
      const ideas = suggestFoods(help.catalog, foods, isLowSat, "fatPer100g");
      problems.push({
        code: "satFat",
        message:
          `Saturated fat can't stay at or under ${pct(rules.maxSaturatedFatShare)}% of your fat: ` +
          (ideas ? `add foods with unsaturated fat like ${ideas}, ` : "") +
          `or use less of your foods marked ⚠ Sat. fat.`,
      });
    }

    // 4. Macros: which of protein, carbs and fat can't be met (and which foods would help)
    problems.push(...macroProblems(settings, foods, { ...help, userLimits }));

    // 5. Even the minimum amounts the user set are over the calorie target
    // (This asks for the most protein: the solver ignores the kcal limit when asked for the most kcal)
    if (bestValue(settings, foods, { optimize: "protein", opType: "max", skip: basicSkip }) === null) {
      const minNames = ownLimitNames(userLimits, foods, "min");
      problems.push({
        code: "minimums",
        message:
          `Your minimum amounts alone are more than ${kcalTarget} kcal. ` +
          `Lower the min limits${minNames ? ` of ${minNames}` : ""} in My foods, or raise your daily calories.`,
      });
    }

    // 6. Calories: the most kcal the ticked foods can give at their max limits
    // (it can come out above the target, which is fine: we only care if it's below the minimum)
    const maxKcal = bestValue(settings, foods, { optimize: "kcal", opType: "max", skip: basicSkip });
    if (maxKcal !== null && maxKcal < kcalMin) {
      problems.push({
        code: "kcal",
        maxKcal,
        message:
          `With these foods and max limits you can reach at most ${Math.floor(maxKcal)} kcal a day, ` +
          `but you need at least ${Math.ceil(kcalMin)}. Add more foods or raise the max limits.` + maxHint,
      });
    }

    // 7. Variety: is the 35% per-food cap the thing that blocks it?
    if (problems.length === 0 && feasibleWithout(settings, foods, "variety")) {
      problems.push({
        code: "variety",
        message:
          `No single food may give more than ${pct(rules.varietyKcalShare)}% of your calories. ` +
          `Add a few more foods so the calories can be spread out` +
          (notPoorIdeas ? `, e.g. ${notPoorIdeas}.` : ".") +
          maxHint,
      });
    }

    // 8. Nothing above explains it on its own: it's the rules together
    if (problems.length === 0) {
      problems.push({
        code: "combined",
        message:
          "Each target is reachable on its own, but not all of them at once with these foods. " +
          (excellentIdeas ? `Add more foods (e.g. ${excellentIdeas}) or raise some max limits.` : "Raise some max limits.") +
          maxHint,
      });
    }

    return problems;
  }

  // What to change when a plan that was found costs more than the budget:
  // " To fit, raise the budget to at least 1520 kr, lower your protein or calorie target, or try adding … like …"
  function overBudgetHint(result, foods, catalog) {
    const ideas = suggestFoods(catalog, foods, (f) => proteinRating(f) === "excellent");
    const budget = `raise the budget to at least ${Math.round(result.totals.shoppingCost)} kr`;
    return ideas
      ? ` To fit, ${budget}, lower your calorie target, or try adding cheap protein foods like ${ideas}.`
      : ` To fit, ${budget}, or lower your calorie target.`;
  }

  // The whole job: cheapest plan for these settings and ticked foods.
  // catalog (optional) is every food in foods.json, used to suggest foods in the messages.
  // Returns either
  //   { status: "optimal", items, totals, quality, messages }
  // or
  //   { status: "infeasible", problems, messages }
  function plan(settings, foods, catalog = []) {
    const answer = solve(buildModel(settings, foods));

    // No solution: explain why instead of just saying "no solution"
    if (!answer.feasible) {
      const problems = diagnose(settings, foods, { catalog });
      return { status: "infeasible", problems, messages: problems.map((p) => p.message) };
    }

    // Solution found: build the grocery list
    const result = summarise(settings, foods, gramsFrom(answer, foods));
    result.status = "optimal";
    result.messages = [];

    // Over budget: still show the plan, but say by how much and what to change
    if (result.totals.overBudget) {
      result.messages.push(
        `The cheapest plan costs ${Math.round(result.totals.shoppingCost)} kr, ` +
          `which is ${Math.round(result.totals.overBy)} kr over budget.` +
          overBudgetHint(result, foods, catalog)
      );
    }
    return result;
  }

  // ---------- Whole packages (plans 2 and 3, PLAN.md section 5) ----------
  //
  // With whole packages the solver's own branch and bound can take minutes for some
  // settings, which is far too slow on a phone. So plans 2 and 3 are found in steps
  // that each stay small (see solvePacks):
  //   1. Choose the foods: solve with "used" as real yes/no but packs allowed in
  //      between (e.g. 2.4 packs). That's quick, and no plan can be cheaper than it.
  //   2. Whole packs for exactly those foods: the solver on just those ~10 foods, and
  //      also that answer rounded and repaired, one or two packs at a time.
  //   3. Lower the cost further one or two packs at a time (this can swap foods too).
  //   4. Try the next-best choice of foods, up to 3 in all, unless step 1 already
  //      shows that no other choice can be cheaper.
  // The answer is the cheapest plan found: usually the cheapest there is, sometimes a
  // few percent more.

  // Speed: all three plans together take about 0.3 s (up to about 1 s on the first run) on a 2015
  // laptop, and must stay under about 2 seconds on a phone (open test.html on the phone to check).
  // Limit: with short periods (7–14 days), where one pack is a big step, and unusual splits, the
  // search can find nothing even if a plan exists. A longer period or a wider tolerance helps.
  //
  // How much a rule may be broken and still count as kept (rounding errors)
  const RULE_TOLERANCE = 1e-6;
  // Most repair or improve moves per starting point (a safety limit; normally far fewer)
  const MAX_MOVES = 300;

  // Turn a buildModel() model with packs into lists the search can work with quickly:
  //   rules – every constraint: { min, max, scale }
  //   foods – per food: its variable name, the packs allowed and its coefficients
  //           (for the packs variable and for its yes/no "used" variable)
  function packProblem(model, settings, foods) {
    const ruleNames = Object.keys(model.constraints);
    const index = {};
    const rules = ruleNames.map((name, i) => {
      index[name] = i;
      const c = model.constraints[name];
      return {
        min: typeof c.min === "number" ? c.min : -Infinity,
        max: typeof c.max === "number" ? c.max : Infinity,
        scale: 0, // the largest coefficient in this rule, filled in below
      };
    });
    // A variable's coefficients as [rule index, coefficient] pairs (the cost isn't a rule)
    const entriesOf = (variable) =>
      Object.keys(variable || {})
        .filter((key) => key in index)
        .map((key) => [index[key], variable[key]]);

    const items = foods.map((f) => {
      // Packs allowed, the same as in buildModel
      const limit = unitLimits(f, settings, true, true);
      return {
        name: varName(f),
        cost: model.variables[varName(f)].cost,
        min: limit.min,
        max: limit.max,
        // The fewest packs if the food is used: its own min, or the floor
        lowestUsed: Math.max(limit.min, limit.max > 0 ? limit.floor : 0),
        entries: entriesOf(model.variables[varName(f)]),
        useEntries: entriesOf(model.variables[useName(f)]),
      };
    });

    // Scale each rule by its largest coefficient, so a broken kcal rule and a broken
    // protein rule weigh about the same (both "about one pack too much or too little")
    for (const item of items) {
      for (const [r, coef] of [...item.entries, ...item.useEntries]) {
        rules[r].scale = Math.max(rules[r].scale, Math.abs(coef));
      }
    }
    for (const rule of rules) rule.scale = rule.scale || 1;
    return { rules, items };
  }

  // A search state: packs per food, every rule's current sum, how much the rules are broken and the cost
  function packState(problem, packs) {
    const state = { packs: packs.slice(), sums: new Float64Array(problem.rules.length), broken: 0, cost: 0 };
    problem.items.forEach((item, i) => {
      const n = state.packs[i];
      state.cost += item.cost * n;
      for (const [r, coef] of item.entries) state.sums[r] += coef * n;
      if (n > 0) for (const [r, coef] of item.useEntries) state.sums[r] += coef;
    });
    problem.rules.forEach((rule, r) => (state.broken += brokenBy(rule, state.sums[r])));
    return state;
  }

  // How far a rule's sum is outside its min and max, in "packs" (0 when it's kept)
  function brokenBy(rule, sum) {
    const amount = Math.max(0, rule.min - sum, sum - rule.max) / rule.scale;
    return amount > RULE_TOLERANCE ? amount : 0;
  }

  // Change one food to n packs, updating the sums, the broken amount and the cost
  function setPacks(problem, state, i, n) {
    const item = problem.items[i];
    const old = state.packs[i];
    if (n === old) return;
    // Its yes/no "used" variable changes when it goes from 0 to some packs or back
    const useChange = (n > 0 ? 1 : 0) - (old > 0 ? 1 : 0);
    const change = (r, by) => {
      state.broken -= brokenBy(problem.rules[r], state.sums[r]);
      state.sums[r] += by;
      state.broken += brokenBy(problem.rules[r], state.sums[r]);
    };
    for (const [r, coef] of item.entries) change(r, coef * (n - old));
    if (useChange) for (const [r, coef] of item.useEntries) change(r, coef * useChange);
    state.packs[i] = n;
    state.cost += item.cost * (n - old);
  }

  // The amounts a food can move to from n packs: one more and one fewer.
  // Below the fewest packs if used, the only other choice is 0 (if its min allows that).
  function nextPacks(item, n) {
    const options = [];
    const up = n === 0 ? item.lowestUsed : n + 1;
    if (up <= item.max && up > n) options.push(up);
    const down = n <= item.lowestUsed ? 0 : n - 1;
    if (down < n && down >= item.min) options.push(down);
    return options;
  }

  // Every move of one food, or of two foods at once: [[i, n], ...]
  function allMoves(problem, state) {
    const singles = [];
    problem.items.forEach((item, i) => {
      for (const n of nextPacks(item, state.packs[i])) singles.push([i, n]);
    });
    const moves = singles.map((move) => [move]);
    for (let a = 0; a < singles.length; a++) {
      for (let b = a + 1; b < singles.length; b++) {
        if (singles[a][0] !== singles[b][0]) moves.push([singles[a], singles[b]]);
      }
    }
    return moves;
  }

  // Try a move, read the broken amount and cost it gives, then undo it
  function tryMove(problem, state, move) {
    const before = move.map(([i]) => [i, state.packs[i]]);
    for (const [i, n] of move) setPacks(problem, state, i, n);
    const result = { broken: state.broken, cost: state.cost };
    for (const [i, n] of before.reverse()) setPacks(problem, state, i, n);
    return result;
  }

  // From a starting point, repair until every rule is kept, then lower the cost.
  // Returns the state, or null if it couldn't be repaired.
  function packSearch(problem, start) {
    const state = packState(problem, start);
    for (let step = 0; step < MAX_MOVES; step++) {
      const repairing = state.broken > RULE_TOLERANCE;
      let best = null;
      let bestScore = null;
      for (const move of allMoves(problem, state)) {
        const after = tryMove(problem, state, move);
        if (repairing) {
          // Repair: break the rules less; at the same amount, the cheaper move
          if (after.broken < state.broken - RULE_TOLERANCE &&
              (!best || after.broken < bestScore.broken - RULE_TOLERANCE ||
                (Math.abs(after.broken - bestScore.broken) <= RULE_TOLERANCE && after.cost < bestScore.cost))) {
            best = move;
            bestScore = after;
          }
        } else if (after.broken <= RULE_TOLERANCE && after.cost < state.cost - RULE_TOLERANCE && (!best || after.cost < bestScore.cost)) {
          // Improve: keep every rule and save the most money
          best = move;
          bestScore = after;
        }
      }
      if (!best) break; // no move helps any more
      for (const [i, n] of best) setPacks(problem, state, i, n);
    }
    // (Adding and subtracting leaves tiny rounding errors, so "kept" means within the tolerance)
    return state.broken <= RULE_TOLERANCE ? state : null;
  }

  // A starting point in whole packs from amounts in packs (e.g. 2.6 → 3), kept
  // inside each food's limits. Below the fewest packs if used, it's that number or 0, whichever is nearer.
  function roundPacks(problem, amounts) {
    return problem.items.map((item, i) => {
      let n = Math.round(amounts[i]);
      if (n > 0 && n < item.lowestUsed) n = amounts[i] >= item.lowestUsed / 2 ? item.lowestUsed : 0;
      return Math.min(item.max, Math.max(item.min, n));
    });
  }

  // How many choices of foods solvePacks tries at most (step 4). With tight macro ranges a
  // choice can have no whole-pack answer, so it keeps looking for longer while nothing is found.
  const MAX_FOOD_CHOICES = 3;
  const MAX_FOOD_CHOICES_IF_NONE_FOUND = 6;
  // Time limits for the solver's own branch and bound, in ms. Only a safety net:
  // normally each run takes a few to a few dozen ms.
  const CHOOSE_TIMEOUT = 1500;
  const FIXED_FOODS_TIMEOUT = 300;
  const DIAGNOSE_TIMEOUT = 300;

  // Plans 2 and 3: the plan in whole packages per month (see the steps above).
  // Returns an answer like solve() does: { feasible, result, food_<id>: packages, ... }
  function solvePacks(settings, foods, options) {
    const model = buildModel(settings, foods, options);
    const problem = packProblem(model, settings, foods);
    // With whole-kr prices, a different plan only counts as cheaper if it saves at
    // least 1 kr a month (in kr per day, like the model). Otherwise any amount counts.
    const saving = foods.every((f) => Number.isInteger(f.packPrice)) ? 1 / settings.days : RULE_TOLERANCE;

    // The cheapest plan found so far (a search state from packSearch)
    let best = null;
    const consider = (packs) => {
      const found = packs && packSearch(problem, packs);
      if (found && (!best || found.cost < best.cost)) best = found;
    };

    // Step 1 with "not exactly these foods" rules added for the choices already tried
    const choose = { ...model, ints: {}, constraints: { ...model.constraints }, variables: { ...model.variables },
      options: { timeout: CHOOSE_TIMEOUT } };

    for (let choice = 0; choice < (best ? MAX_FOOD_CHOICES : MAX_FOOD_CHOICES_IF_NONE_FOUND); choice++) {
      // 1. Choose the foods. No answer: no (other) choice of foods works.
      const chosen = solve(choose);
      if (!chosen.feasible) break;
      // Not even packs in between can save money: the plan found is the cheapest
      if (best && chosen.result > best.cost - saving) break;
      const used = foods.filter((f) => (chosen[useName(f)] || 0) > 0.5);

      // 2a. The solver on just those foods, each of them used, in whole packs
      const fixed = buildModel(settings, used, options);
      for (const f of used) {
        fixed.constraints["used_" + f.id] = { min: 1 };
        fixed.variables[useName(f)] = { ...fixed.variables[useName(f)], ["used_" + f.id]: 1 };
      }
      const answer = solve({ ...fixed, options: { timeout: FIXED_FOODS_TIMEOUT } });
      // Use it only if it's really in whole packs (a timed-out answer may not be)
      if (answer.feasible) {
        const amounts = foods.map((f) => answer[varName(f)] || 0);
        if (amounts.every((x) => Math.abs(x - Math.round(x)) < 1e-6)) consider(amounts.map(Math.round));
      }
      // 2b. Step 1's answer rounded to whole packs, then repaired. 3. Both get cheaper in packSearch.
      consider(roundPacks(problem, problem.items.map((item) => chosen[item.name] || 0)));
      // Nothing found yet: also try starting with every amount rounded down, and rounded up
      if (!best) {
        const amounts = problem.items.map((item) => chosen[item.name] || 0);
        consider(roundPacks(problem, amounts.map(Math.floor)));
        consider(roundPacks(problem, amounts.map(Math.ceil)));
      }

      // 4. Next time, not exactly these foods: Σ used (these) − Σ used (others) ≤ count − 1
      const rule = "notChoice_" + choice;
      choose.constraints[rule] = { max: used.length - 1 };
      for (const f of foods) {
        if (!choose.variables[useName(f)]) continue;
        choose.variables[useName(f)] = { ...choose.variables[useName(f)], [rule]: used.includes(f) ? 1 : -1 };
      }
    }
    if (!best) return { feasible: false };

    // Back to the solver's answer format
    const answer = { feasible: true, result: best.cost };
    problem.items.forEach((item, i) => (answer[item.name] = best.packs[i]));
    return answer;
  }

  // ---------- Three plans (PLAN.md section 5, "Three plans") ----------

  // Names shown on the plans, keyed the same way planAll returns them
  const PLAN_TITLES = {
    cheapest: "Absolute cheapest",
    realistic: "Cheapest realistic",
    highQuality: "Same macros, higher quality",
  };

  // A "no plan" answer with one or more { code, message } problems
  const noPlan = (problems) => ({ status: "infeasible", problems, messages: problems.map((p) => p.message) });

  // Settings and solver options for plan 2 ("realistic") or plan 3 ("highQuality").
  // Both use the realistic rules and the group limits, and the same macro ranges.
  // Plan 3 adds its quality rules: 80% Excellent, enough fibre, limited saturated fat.
  function realisticSetup(settings, groups, which) {
    const rules = rulesFrom(settings);
    const options = { realistic: true, packs: true, groups };
    if (which !== "highQuality") return { settings, options };
    return {
      settings: {
        ...settings,
        rules: {
          ...(settings.rules || {}),
          excellentProteinShare: rules.highQualityExcellentShare,
          minFiberPerDay: rules.highQualityMinFiber,
          maxSaturatedFatShare: rules.highQualitySaturatedFatShare,
        },
      },
      options,
    };
  }

  // Plan 2 or 3 has no solution: explain why.
  // Runs the usual checks with that plan's rules (realistic max limits, its Excellent
  // share, plan 3's fibre and saturated fat). Then asks whether one macro is what the
  // realistic rules block (e.g. the dry grains limit keeps carbs too low). If nothing
  // stands out, it's the realistic rules together (floor, 10 foods, whole packs).
  function diagnoseRealistic(setup, foods, catalog = []) {
    const rules = rulesFrom(setup.settings);
    const problems = [];
    const userLimits = setup.settings.limits;
    // Any food can help with the food count; cheapest protein first
    const anyIdeas = suggestFoods(catalog, foods, () => true);

    // Too few foods ticked for the "at least 10 foods" rule. Foods with max 0 don't
    // count, and neither do foods where one pack for the whole period is more than their max per day.
    const usable = foods.filter((f) => unitLimits(f, setup.settings, true, true).max > 0).length;
    if (usable < rules.minFoods) {
      const tooBig = foods.filter((f) => limitsFor(f, setup.settings, true).max > 0 && unitLimits(f, setup.settings, true, true).max === 0);
      const zeroMax =
        (foods.some((f) => limitsFor(f, setup.settings, true).max === 0) ? " Foods you set to max 0 g don't count." : "") +
        (tooBig.length
          ? ` ${joinNames(tooBig.map((f) => f.name), "and")} can't be used either: one pack lasts longer than ${setup.settings.days} days at its max per day.`
          : "");
      problems.push({
        code: "minFoods",
        message:
          `This plan needs at least ${rules.minFoods} different foods, but only ${usable} are in My foods. ` +
          `Add ${rules.minFoods - usable} more` + (anyIdeas ? `, e.g. ${anyIdeas}.` : ".") + zeroMax,
      });
    }

    // Only suggest foods that can be in this plan: a food whose one pack lasts longer
    // than the period at its max per day can't be (e.g. a big bottle of oil over 7 days)
    const fitsInPacks = (f) => unitLimits(f, setup.settings, true, true).max > 0;

    // The usual checks, with this plan's realistic max limits
    const limits = {};
    for (const f of foods) limits[f.id] = limitsFor(f, setup.settings, true);
    const checkSettings = { ...setup.settings, limits };
    // Those checks assume the plan fails even without the floor, 10 foods and group
    // limits, so only run them when it does. "variety" and "combined" are guesses
    // made without the realistic rules, so leave them out.
    if (!solve(buildModel(checkSettings, foods)).feasible) {
      // checkSettings.limits holds every food's realistic limits, so pass the user's own ones separately
      const found = diagnose(checkSettings, foods, { catalog, userLimits, usable: fitsInPacks });
      problems.push(...found.filter((p) => p.code !== "variety" && p.code !== "combined"));
    }

    // Does one macro stand out once the realistic rules count (in grams, not packs yet)?
    if (problems.length === 0) {
      const inGrams = { realistic: true, groups: setup.options.groups, options: { timeout: DIAGNOSE_TIMEOUT } };
      problems.push(...macroProblems(checkSettings, foods, { catalog, userLimits, usable: fitsInPacks }, inGrams));
    }

    if (problems.length === 0) {
      problems.push({
        code: "realistic",
        message:
          `The realistic rules (at least ${rules.minFoods} different foods, at least ${rules.minGramsIfUsed} g ` +
          `of each food you eat, whole packages, realistic max amounts and food-group limits) can't all be met with these ` +
          `foods and macro goals. ` +
          `Add a few more foods` + (anyIdeas ? `, e.g. ${anyIdeas}.` : ".") +
          ownMaxHint(userLimits, foods),
      });
    }
    return problems;
  }

  // Plan 2: lowest cost with the realistic rules and the protein buffer
  function planRealistic(settings, foods, groups, catalog = []) {
    const setup = realisticSetup(settings, groups, "realistic");
    const answer = solvePacks(setup.settings, foods, setup.options);
    if (!answer.feasible) return noPlan(diagnoseRealistic(setup, foods, catalog));
    return realisticPlan(settings, foods, gramsFrom(answer, foods, settings.days), catalog);
  }

  // Plan 2's grocery list from grams per day, with the over-budget message if needed
  function realisticPlan(settings, foods, grams, catalog = []) {
    const result = summarise(settings, foods, grams);
    result.status = "optimal";
    result.messages = [];
    if (result.totals.overBudget) {
      result.messages.push(
        `The cheapest realistic plan costs ${Math.round(result.totals.shoppingCost)} kr, ` +
          `which is ${Math.round(result.totals.overBy)} kr over budget.` +
          overBudgetHint(result, foods, catalog)
      );
    }
    return result;
  }

  // Plan 3 "Same macros, higher quality": the cheapest plan with the same macro ranges
  // and realistic rules, at least 80% of the protein from Excellent foods, enough fibre
  // and limited saturated fat. The budget is a ceiling: if the plan costs more, there
  // is no plan (but we say what it would cost).
  // Needs plan 2's answer: if even the cheapest realistic plan doesn't fit, nothing does.
  function planHighQuality(settings, foods, groups, realistic, catalog = []) {
    // Plan 2 had no solution: plan 3 can't have one either (same rules, stricter targets)
    if (realistic.status !== "optimal") return noPlan(realistic.problems);

    // The cheapest realistic plan is already over budget, and plan 3 can't be cheaper
    if (realistic.totals.overBudget) {
      return noPlan([
        {
          code: "budget",
          message:
            `Your budget of ${Math.round(settings.budget)} kr is less than the cheapest realistic plan ` +
            `(${Math.round(realistic.totals.shoppingCost)} kr), so no realistic plan fits. ` +
            `Raise the budget to at least ${Math.round(realistic.totals.shoppingCost)} kr, or use the ` +
            `Absolute cheapest plan.`,
        },
      ]);
    }

    const setup = realisticSetup(settings, groups, "highQuality");

    // Does a higher quality plan exist at all?
    const answer = solvePacks(setup.settings, foods, setup.options);
    if (!answer.feasible) return noPlan(diagnoseRealistic(setup, foods, catalog));

    // Whole packages cost exactly what the solver says, and this is the cheapest
    // higher quality plan, so the budget ceiling is simply: does this one fit?
    const result = summarise(settings, foods, gramsFrom(answer, foods, settings.days));

    // Over budget: no plan, but say what it would cost
    if (result.totals.overBudget) {
      const cost = result.totals.shoppingCost;
      return noPlan([
        {
          code: "budget",
          cost,
          message:
            `The higher quality plan costs ${Math.round(cost)} kr, which is ` +
            `${Math.round(cost - settings.budget)} kr over your budget of ${Math.round(settings.budget)} kr. ` +
            `Raise the budget to at least ${Math.round(cost)} kr, or use the Cheapest realistic plan, which fits.`,
        },
      ]);
    }

    result.status = "optimal";
    result.messages = [];
    return result;
  }

  // The cost order should be plan 1 ≤ plan 2 ≤ plan 3 ≤ budget, because each plan has the rules of
  // the one before, plus more. Plan 1 is solved in grams and rounded up to packs afterwards, so in
  // rare cases it costs more than plan 2. It could use whole packs too, if feedback asks for it.
  // All three plans for the same settings and ticked foods:
  //   { cheapest, realistic, highQuality }
  // groups are the food-group limits from data/groups.json (used by plans 2 and 3).
  // Each one is a plan() style answer (items, totals incl. foodCount, quality,
  // messages – or status "infeasible" with problems), plus its key and title.
  // catalog (optional) is every food in foods.json, so messages can suggest foods to add.
  function planAll(settings, foods, groups = [], catalog = []) {
    const cheapest = plan(settings, foods, catalog);
    let realistic = planRealistic(settings, foods, groups, catalog);
    const highQuality = planHighQuality(settings, foods, groups, realistic, catalog);

    // The whole-package search finds a very cheap plan, not always the cheapest one.
    // A higher quality plan also keeps every rule of plan 2, so if it came out cheaper,
    // it's plan 2's answer too (and the cost order plan 2 ≤ plan 3 holds).
    if (highQuality.status === "optimal" && highQuality.totals.shoppingCost < realistic.totals.shoppingCost) {
      const grams = {};
      for (const item of highQuality.items) grams[item.id] = item.gramsPerDay;
      realistic = realisticPlan(settings, foods, grams, catalog);
    }

    const plans = { cheapest, realistic, highQuality };
    for (const key of Object.keys(plans)) {
      plans[key].key = key;
      plans[key].title = PLAN_TITLES[key];
    }
    return plans;
  }

  // What other files can use
  return {
    DEFAULT_RULES, PLAN_TITLES, proteinRating, fiberRating, nutrientWarnings, macroGoals, macroSplitProblem,
    buildModel, solve, plan, planAll,
  };
})();
