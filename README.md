READ ME

This is a small personal web app: a protein and food budget planner. The full plan is in PLAN.md. Read it before starting any task.

How we work
Do one build step from PLAN.md section 7 at a time. Stop when that step's "Done when" check is met, and tell me how to test it.
Keep changes small. Don't add features from PLAN.md section 10 (later versions) unless I ask.
Before changing anything big, explain your plan in a few lines first.
I'm learning, so briefly explain what you did and why in plain words.
Suggest a short commit message after each step. Don't push unless I ask.
Tech rules
Plain HTML, CSS and JavaScript only. No React, no build step, no npm needed to run the site.
In all code you write, write comments explaining each logical step.
External libraries are loaded from a CDN with an exact pinned version (e.g. javascript-lp-solver).
It must work by opening index.html through GitHub Pages on a phone. Design mobile-first.
Food data lives in data/foods.json. Nutrition is per 100 g. Never hard-code foods in JavaScript.
Wrap localStorage reads and writes in try/catch.
Protein rating rule (PLAN.md section 4): protein × 10 > kcal = Excellent, ≥ kcal/2 = OK, otherwise Poor. Don't change this rule without asking.
Testing
test.html runs the optimizer test cases from PLAN.md section 8. Keep every test passing, and add a test for each new rule.
To test locally, run python3 -m http.server in the project folder and open http://localhost:8000. Pages that load JSON don't work when opened straight from the file system.

How to run
Locally: run python3 -m http.server in this folder, then open http://localhost:8000.
Online: GitHub Pages serves index.html from the main branch, root folder.
