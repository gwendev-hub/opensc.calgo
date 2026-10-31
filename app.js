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

// Start-up: restore saved settings, then save again whenever an input changes
function init() {
  const saved = loadSettings();
  if (saved) {
    fillForm(saved);
  }

  const form = document.getElementById("settings-form");
  form.addEventListener("input", () => {
    saveSettings(readSettingsFromForm());
  });
}

init();
