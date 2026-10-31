// optimizer.js – builds the diet model (PLAN.md section 5), solves it with
// javascript-lp-solver and turns the answer into packages to buy.
// It never touches the page. It expects the solver to be loaded first, which
// gives a global called `solver`:
//   <script src="https://cdn.jsdelivr.net/npm/javascript-lp-solver@0.4.24/prod/solver.js"></script>
//
// Everything is wrapped in one object, `Optimizer`, so none of the names here
// clash with the ones in app.js.
const Optimizer = (() => {
  // Default rules. All of them can be overridden through settings.rules
  // (PLAN.md section 4.3 says they'll be editable under "Advanced" later).
  const DEFAULT_RULES = {
    kcalLowFactor: 0.95, // calories must land between 95% and 100% of the target
    excellentProteinShare: 0.6, // at least 60% of protein from Excellent foods
    poorKcalShare: 0.4, // Poor foods give at most 40% of calories
    varietyKcalShare: 0.35, // no single food gives more than 35% of calories
    // Realistic rules, used by plans 2 and 3 only (PLAN.md section 5, "Three plans")
    minGramsIfUsed: 35, // a food is either not in the plan or at least 35 g a day (foods.json can lower it, e.g. fats)
    minFoods: 10, // at least this many different foods
    proteinBuffer: 5, // plan 2 aims this many grams above the protein minimum
    // Plan 3 "High quality"
    highQualityProteinExtra: 20, // protein at least minimum + 20 g
    highQualityExcellentShare: 0.8, // at least 80% of protein from Excellent foods
  };

  // Amounts below this many grams per day are treated as zero.
  // The solver can return tiny leftovers like 0.0000001 g, and we don't want
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

  // Nutrient warnings per food (PLAN.md section 4.5). Returns a list, e.g. ["satFat", "sugar"]:
  //   "satFat" – saturated fat is more than ⅓ of the fat
  //   "sugar"  – sugar is more than ⅓ of the carbs
  function nutrientWarnings(f) {
    const warnings = [];
    const fat = f.fatPer100g || 0;
    const carbs = f.carbsPer100g || 0;
    if (fat >= WARNING_MIN_GRAMS && (f.saturatedFatPer100g || 0) > fat / 3) warnings.push("satFat");
    if (carbs >= WARNING_MIN_GRAMS && (f.sugarPer100g || 0) > carbs / 3) warnings.push("sugar");
    return warnings;
  }

  // The solver keeps its own fields (feasible, result, bounded) next to the
  // variable values in its answer, so food variables get a prefix that can't
  // collide with those names.
  const varName = (f) => "food_" + f.id;

  // Merge the user's rules over the defaults
  function rulesFrom(settings) {
    return { ...DEFAULT_RULES, ...(settings.rules || {}) };
  }

  // Per-food min and max in grams per day.
  // Max is the user's override if there is one. Otherwise it's maxGramsPerDay
  // from foods.json, or the stricter realisticMaxGramsPerDay (if the food has one)
  // when building a realistic plan.
  function limitsFor(f, settings, realistic = false) {
    const override = (settings.limits && settings.limits[f.id]) || {};
    const dataMax =
      realistic && typeof f.realisticMaxGramsPerDay === "number" ? f.realisticMaxGramsPerDay : f.maxGramsPerDay;
    const min = typeof override.min === "number" ? override.min : 0;
    const max = typeof override.max === "number" ? override.max : dataMax;
    return { min, max };
  }

  // Build the javascript-lp-solver model.
  // settings: { kcal, protein, budget, days, limits?, rules? }
  // foods:    only the foods the user ticked
  // options changes the goal, adds rules or drops rules:
  //   optimize/opType     – what to maximise or minimise (default: minimise cost)
  //   skip                – names of rules to leave out ("kcalMin", "protein",
  //                         "excellent", "poor", "variety")
  //   realistic           – plans 2 and 3: 35 g floor per food, realistic max
  //                         limits, at least 10 foods and the group limits
  //   groups              – food-group limits from data/groups.json (realistic only)
  //   proteinMin          – protein minimum to use instead of settings.protein
  //   costMax             – most kr per day the plan may cost (plan 3)
  // Rule shares (Excellent share etc.) come from settings.rules.
  function buildModel(settings, foods, options = {}) {
    const rules = rulesFrom(settings);
    const skip = new Set(options.skip || []);
    const kcalTarget = settings.kcal;
    const realistic = Boolean(options.realistic);

    // Constraints are named limits on sums of variable attributes
    const constraints = {};

    // Calories within a range: 95–100% of the target
    constraints.kcal = skip.has("kcalMin")
      ? { max: kcalTarget }
      : { min: kcalTarget * rules.kcalLowFactor, max: kcalTarget };

    // Protein minimum (plans 2 and 3 pass a higher one)
    const proteinMin = typeof options.proteinMin === "number" ? options.proteinMin : settings.protein;
    if (!skip.has("protein")) constraints.protein = { min: proteinMin };

    // Budget: most kr per day
    if (typeof options.costMax === "number") constraints.cost = { max: options.costMax };

    // At least 10 different foods: every food's yes/no variable counts 1 (see the floor below)
    if (realistic) constraints.foodCount = { min: rules.minFoods };

    // Food-group limits, e.g. dairy ≤ 700 g a day: each food in the group counts 1 per gram
    const groupMax = {};
    if (realistic) {
      for (const g of options.groups || []) {
        constraints["group_" + g.id] = { max: g.maxGramsPerDay };
        groupMax[g.id] = g.maxGramsPerDay;
      }
    }

    // Excellent share, written so it stays linear (PLAN.md section 5):
    // Σ_excellent protein − 0.60 · Σ_all protein ≥ 0
    if (!skip.has("excellent")) constraints.excellentShare = { min: 0 };

    // Poor calorie cap, compared with the plan's actual total calories:
    // Σ_poor kcal − 0.40 · Σ_all kcal ≤ 0.
    // Total kcal is never above the target, so this is never looser than
    // "≤ 0.40 × kcalTarget" from section 5, and "40% of calories" is exactly true.
    if (!skip.has("poor")) constraints.poorKcal = { max: 0 };

    // One entry per food: its attributes, plus its own limit constraints
    const variables = {};
    // Yes/no variables for the 35 g floor (realistic plans only)
    const binaries = {};
    for (const f of foods) {
      const name = varName(f);
      const kcal = f.kcalPer100g / 100; // kcal per gram
      const protein = f.proteinPer100g / 100; // protein grams per gram
      const rating = proteinRating(f);

      const v = {
        cost: f.packPrice / f.packGrams, // krPerGram
        kcal,
        protein,
        // 1 − 0.60 for Excellent foods, −0.60 for the rest (see excellentShare above)
        excellentShare: protein * ((rating === "excellent" ? 1 : 0) - rules.excellentProteinShare),
        // 1 − 0.40 for Poor foods, −0.40 for the rest (see poorKcal above)
        poorKcal: kcal * ((rating === "poor" ? 1 : 0) - rules.poorKcalShare),
      };

      // Per-food limits: min ≤ grams per day ≤ max.
      // The solver has no variable bounds, so each food gets a constraint
      // that only it contributes to (1 per gram).
      const { min, max } = limitsFor(f, settings, realistic);
      v["limit_" + f.id] = 1;
      constraints["limit_" + f.id] = { min, max };

      // The floor: grams is either 0 or at least 35 (or the food's own
      // minGramsIfUsed from foods.json, e.g. 10 g for fats). A linear model can't
      // say "either/or" directly, so each food gets a yes/no variable `use`:
      //   grams − floor · use ≥ 0  (if use = 1, at least the floor)
      //   grams − max · use ≤ 0    (if use = 0, nothing at all)
      // `use` also counts 1 towards the "at least 10 foods" rule.
      // Foods with max 0 can't be used anyway, so they don't need one.
      if (realistic && max > 0) {
        const use = "use_" + f.id;
        const floor = typeof f.minGramsIfUsed === "number" ? f.minGramsIfUsed : rules.minGramsIfUsed;
        v["floor_" + f.id] = 1;
        v["ceiling_" + f.id] = 1;
        variables[use] = { ["floor_" + f.id]: -floor, ["ceiling_" + f.id]: -max, foodCount: 1 };
        constraints["floor_" + f.id] = { min: 0 };
        constraints["ceiling_" + f.id] = { max: 0 };
        binaries[use] = 1;
      }

      // This food's grams count towards its group's limit (if the group has one)
      if (realistic && f.limitGroup && f.limitGroup in groupMax) v["group_" + f.limitGroup] = 1;

      // Variety: this food's kcal − 0.35 · total kcal ≤ 0.
      // Like the Poor cap, it's measured against the actual total, so no
      // food ever gives more than 35% of the plan's calories.
      if (!skip.has("variety")) {
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
        for (const other of foods) {
          if (other.id === f.id) continue;
          variables[varName(other)]["variety_" + f.id] =
            -(other.kcalPer100g / 100) * rules.varietyKcalShare;
        }
      }
    }

    return {
      optimize: options.optimize || "cost",
      opType: options.opType || "min",
      constraints,
      variables,
      binaries,
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

  // Read grams per day for each food out of a solver answer (tiny values → 0)
  function gramsFrom(answer, foods) {
    const grams = {};
    for (const f of foods) {
      const x = answer[varName(f)] || 0;
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
        // What's left at the end of the period because we rounded up
        leftoverGrams: packages * f.packGrams - monthlyGrams,
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

    // Macro shares of energy for the pie chart: protein and carbs 4 kcal/g, fat 9 kcal/g.
    // They're shares of the energy from these three, so they always add up to 100%.
    const macroKcal = { protein: proteinPerDay * 4, carbs: nutrients.carbs * 4, fat: nutrients.fat * 9 };
    const macroTotal = macroKcal.protein + macroKcal.carbs + macroKcal.fat;
    const macroKcalShare = {};
    for (const m of Object.keys(macroKcal)) macroKcalShare[m] = macroTotal > 0 ? macroKcal[m] / macroTotal : 0;

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
        // Protein / carbs / fat as shares of their combined energy (for the macro pie)
        macroKcalShare,
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

  // The plan has no solution: work out why, in words (PLAN.md section 5).
  // Returns a list of { code, message, ... }, most useful first.
  function diagnose(settings, foods) {
    const rules = rulesFrom(settings);
    const kcalTarget = settings.kcal;
    const kcalMin = kcalTarget * rules.kcalLowFactor;
    const problems = [];
    const pct = (share) => Math.round(share * 100);

    // Only the foods and their limits, no protein-quality or variety rules
    const basicSkip = ["kcalMin", "protein", "excellent", "poor", "variety"];

    // 1. Excellent share: even using every Excellent food up to its max,
    //    is there enough Excellent protein for 60% of the protein target?
    const excellentFoods = foods.filter((f) => proteinRating(f) === "excellent");
    const maxExcellentProtein = excellentFoods.length
      ? bestValue(settings, excellentFoods, { optimize: "protein", opType: "max", skip: basicSkip }) || 0
      : 0;
    if (
      maxExcellentProtein < rules.excellentProteinShare * settings.protein ||
      feasibleWithout(settings, foods, "excellent")
    ) {
      problems.push({
        code: "excellent",
        message:
          `You've ticked too few Excellent protein foods to get ${pct(rules.excellentProteinShare)}% ` +
          `of your protein from them. Tick e.g. keso, kvarg, tuna or tofu.`,
      });
    }

    // 2. Poor calorie cap: can the non-Poor foods cover the other 60% of the calories?
    const nonPoorFoods = foods.filter((f) => proteinRating(f) !== "poor");
    const maxNonPoorKcal = nonPoorFoods.length
      ? bestValue(settings, nonPoorFoods, { optimize: "kcal", opType: "max", skip: basicSkip }) || 0
      : 0;
    if (
      maxNonPoorKcal < (1 - rules.poorKcalShare) * kcalMin ||
      feasibleWithout(settings, foods, "poor")
    ) {
      problems.push({
        code: "poor",
        message:
          `Too many of your calories would have to come from Poor protein foods ` +
          `(at most ${pct(rules.poorKcalShare)}% is allowed). Tick more Excellent or OK foods, ` +
          `or raise their max limits.`,
      });
    }

    // 3. Protein: the most protein the ticked foods can give within the calorie target
    const maxProtein = bestValue(settings, foods, { optimize: "protein", opType: "max", skip: basicSkip });
    if (maxProtein === null) {
      // Even the minimum amounts the user set are over the calorie target
      problems.push({
        code: "minimums",
        message: `Your minimum amounts alone are more than ${kcalTarget} kcal. Lower some of the min limits.`,
      });
    } else if (maxProtein < settings.protein) {
      problems.push({
        code: "protein",
        maxProtein,
        message:
          `With these foods you can reach at most ${Math.floor(maxProtein)} g protein within ` +
          `${kcalTarget} kcal. Tick more high-protein foods or raise the max limits.`,
      });
    }

    // 4. Calories: the most kcal the ticked foods can give at their max limits
    // (still capped at the target, which is fine: we only care if it's below the minimum)
    const maxKcal = bestValue(settings, foods, { optimize: "kcal", opType: "max", skip: basicSkip });
    if (maxKcal !== null && maxKcal < kcalMin) {
      problems.push({
        code: "kcal",
        maxKcal,
        message:
          `With these foods and max limits you can reach at most ${Math.floor(maxKcal)} kcal a day, ` +
          `but you need at least ${Math.ceil(kcalMin)}. Tick more foods or raise the max limits.`,
      });
    }

    // 5. Variety: is the 35% per-food cap the thing that blocks it?
    if (problems.length === 0 && feasibleWithout(settings, foods, "variety")) {
      problems.push({
        code: "variety",
        message:
          `No single food may give more than ${pct(rules.varietyKcalShare)}% of your calories. ` +
          `Tick a few more foods so the calories can be spread out.`,
      });
    }

    // 6. Nothing above explains it on its own: it's the rules together
    if (problems.length === 0) {
      problems.push({
        code: "combined",
        message:
          "Each target is reachable on its own, but not all of them at once with these foods. " +
          "Tick more foods or raise some max limits.",
      });
    }

    return problems;
  }

  // The whole job: cheapest plan for these settings and ticked foods.
  // Returns either
  //   { status: "optimal", items, totals, quality, messages }
  // or
  //   { status: "infeasible", problems, messages }
  function plan(settings, foods) {
    const answer = solve(buildModel(settings, foods));

    // No solution: explain why instead of just saying "no solution"
    if (!answer.feasible) {
      const problems = diagnose(settings, foods);
      return { status: "infeasible", problems, messages: problems.map((p) => p.message) };
    }

    // Solution found: build the grocery list
    const result = summarise(settings, foods, gramsFrom(answer, foods));
    result.status = "optimal";
    result.messages = [];

    // Over budget: still show the plan, but say by how much
    if (result.totals.overBudget) {
      result.messages.push(
        `The cheapest plan costs ${Math.round(result.totals.shoppingCost)} kr, ` +
          `which is ${Math.round(result.totals.overBy)} kr over budget.`
      );
    }
    return result;
  }

  // ---------- Three plans (PLAN.md section 5, "Three plans") ----------

  // Names shown on the plans, keyed the same way planAll returns them
  const PLAN_TITLES = {
    cheapest: "Absolute cheapest",
    realistic: "Cheapest realistic",
    highQuality: "High quality",
  };

  // A "no plan" answer with one or more { code, message } problems
  const noPlan = (problems) => ({ status: "infeasible", problems, messages: problems.map((p) => p.message) });

  // Settings and solver options for plan 2 ("realistic") or plan 3 ("highQuality").
  // Both use the realistic rules and the group limits. They differ in the protein
  // minimum (+5 g or +20 g) and, for plan 3, an 80% Excellent share instead of 60%.
  function realisticSetup(settings, groups, which) {
    const rules = rulesFrom(settings);
    if (which === "highQuality") {
      return {
        settings: { ...settings, rules: { ...(settings.rules || {}), excellentProteinShare: rules.highQualityExcellentShare } },
        options: { realistic: true, groups, proteinMin: settings.protein + rules.highQualityProteinExtra },
      };
    }
    return { settings, options: { realistic: true, groups, proteinMin: settings.protein + rules.proteinBuffer } };
  }

  // Plan 2 or 3 has no solution: explain why.
  // Runs the usual checks with that plan's targets (higher protein, realistic max
  // limits, its Excellent share). If none of them is the cause, it's the realistic
  // rules together (floor, 10 foods, group limits).
  function diagnoseRealistic(setup, foods) {
    const rules = rulesFrom(setup.settings);
    const problems = [];

    // Too few foods ticked for the "at least 10 foods" rule
    const usable = foods.filter((f) => limitsFor(f, setup.settings, true).max > 0).length;
    if (usable < rules.minFoods) {
      problems.push({
        code: "minFoods",
        message: `This plan needs at least ${rules.minFoods} different foods, but only ${usable} are ticked. Tick more foods.`,
      });
    }

    // The usual checks, with this plan's protein target and realistic max limits
    const limits = {};
    for (const f of foods) limits[f.id] = limitsFor(f, setup.settings, true);
    const checkSettings = { ...setup.settings, protein: setup.options.proteinMin, limits };
    // Those checks assume the plan fails even without the floor, 10 foods and group
    // limits, so only run them when it does. "variety" and "combined" are guesses
    // made without the realistic rules, so leave them out.
    if (!solve(buildModel(checkSettings, foods)).feasible) {
      problems.push(...diagnose(checkSettings, foods).filter((p) => p.code !== "variety" && p.code !== "combined"));
    }

    if (problems.length === 0) {
      problems.push({
        code: "realistic",
        message:
          `The realistic rules (at least ${rules.minFoods} different foods, at least ${rules.minGramsIfUsed} g ` +
          `of each food you eat, realistic max amounts and food-group limits) can't all be met with these ` +
          `foods at ${Math.round(setup.options.proteinMin)} g protein. Tick a few more foods.`,
      });
    }
    return problems;
  }

  // Plan 2: lowest cost with the realistic rules and the protein buffer
  function planRealistic(settings, foods, groups) {
    const setup = realisticSetup(settings, groups, "realistic");
    const answer = solve(buildModel(setup.settings, foods, setup.options));
    if (!answer.feasible) return noPlan(diagnoseRealistic(setup, foods));

    const result = summarise(settings, foods, gramsFrom(answer, foods));
    result.status = "optimal";
    result.messages = [];
    if (result.totals.overBudget) {
      result.messages.push(
        `The cheapest realistic plan costs ${Math.round(result.totals.shoppingCost)} kr, ` +
          `which is ${Math.round(result.totals.overBy)} kr over budget.`
      );
    }
    return result;
  }

  // Plan 3 "High quality": the cheapest plan with protein ≥ minimum + 20 g and at
  // least 80% of it from Excellent foods, with the realistic rules. The budget is
  // a ceiling: if the plan costs more, there is no plan (but we say what it would cost).
  // Needs plan 2's answer: if even the cheapest realistic plan doesn't fit, nothing does.
  function planHighQuality(settings, foods, groups, realistic) {
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
            `Raise the budget or tick cheaper foods.`,
        },
      ]);
    }

    const setup = realisticSetup(settings, groups, "highQuality");

    // Without the budget ceiling first: does a high quality plan exist at all?
    const unlimited = solve(buildModel(setup.settings, foods, setup.options));
    if (!unlimited.feasible) return noPlan(diagnoseRealistic(setup, foods));

    // The solver works per day, so the monthly budget becomes kr per day
    let costMax = settings.budget / settings.days;
    let result = null;

    // Rounding up to whole packs makes the shopping cost a bit higher than the
    // solver's cost. If that goes over budget, lower the cap and solve again.
    for (let attempt = 0; attempt < 8; attempt++) {
      const answer = solve(buildModel(setup.settings, foods, { ...setup.options, costMax }));
      if (!answer.feasible) break;
      result = summarise(settings, foods, gramsFrom(answer, foods));
      if (!result.totals.overBudget) break;

      // Lower the daily cap by how much the rounding went over, and try again
      costMax -= result.totals.overBy / settings.days;
    }

    // Over budget (or only over after rounding): no plan, but say what it would cost
    if (!result || result.totals.overBudget) {
      const cost = (result || summarise(settings, foods, gramsFrom(unlimited, foods))).totals.shoppingCost;
      return noPlan([
        {
          code: "budget",
          cost,
          message:
            `The high quality plan costs ${Math.round(cost)} kr, which is ` +
            `${Math.round(cost - settings.budget)} kr over your budget of ${Math.round(settings.budget)} kr.`,
        },
      ]);
    }

    result.status = "optimal";
    result.messages = [];
    return result;
  }

  // All three plans for the same settings and ticked foods:
  //   { cheapest, realistic, highQuality }
  // groups are the food-group limits from data/groups.json (used by plans 2 and 3).
  // Each one is a plan() style answer (items, totals incl. foodCount, quality,
  // messages – or status "infeasible" with problems), plus its key and title.
  function planAll(settings, foods, groups = []) {
    const cheapest = plan(settings, foods);
    const realistic = planRealistic(settings, foods, groups);
    const highQuality = planHighQuality(settings, foods, groups, realistic);

    const plans = { cheapest, realistic, highQuality };
    for (const key of Object.keys(plans)) {
      plans[key].key = key;
      plans[key].title = PLAN_TITLES[key];
    }
    return plans;
  }

  // What other files can use
  return {
    DEFAULT_RULES, PLAN_TITLES, proteinRating, fiberRating, nutrientWarnings, buildModel, solve, plan, planAll,
  };
})();
