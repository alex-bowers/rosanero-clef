const SITE_ORIGIN = "https://forzapalermo.it";
const VIEWS = ["practice", "history", "settings"];
const MAX_DAILY_CAP = 40;

const VERDICTS = {
  fully_correct: { icon: "✓", title: "Spot on" },
  minor_issue: { icon: "≈", title: "Good, with a small slip" },
  partly_correct: { icon: "◐", title: "Partly right" },
  wrong: { icon: "✗", title: "Not quite" },
};
const VERDICT_LABELS = {
  fully_correct: "Spot on",
  minor_issue: "Small slip",
  partly_correct: "Partly right",
  wrong: "Not quite",
};

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  problem: $("problem"),
  problemText: $("problem-text"),
  retry: $("retry"),
  practice: $("practice"),
  practiceHeading: $("practice-heading"),
  italian: $("italian"),
  sourceLink: $("source-link"),
  difficultySummary: $("difficulty-summary"),
  difficultyBars: $("difficulty-bars"),
  form: $("attempt-form"),
  attempt: $("attempt"),
  attemptError: $("attempt-error"),
  submit: $("submit"),
  skip: $("skip"),
  result: $("result"),
  resultHeading: $("result-heading"),
  confidence: $("confidence"),
  fluencyText: $("fluency-text"),
  fluencyFill: $("fluency-fill"),
  verdictBars: $("verdict-bars"),
  yourAttempt: $("your-attempt"),
  reference: $("reference"),
  explain: $("explain"),
  explainButton: $("explain-button"),
  explainError: $("explain-error"),
  explanation: $("explanation"),
  explanationHeading: $("explanation-heading"),
  explanationText: $("explanation-text"),
  next: $("next"),
  history: $("history"),
  historyHeading: $("history-heading"),
  historyEmpty: $("history-empty"),
  historyList: $("history-list"),
  settings: $("settings"),
  settingsHeading: $("settings-heading"),
  settingsForm: $("settings-form"),
  targetLevel: $("target-level"),
  levelRange: $("level-range"),
  dailyCap: $("daily-cap"),
  settingsError: $("settings-error"),
  settingsStatus: $("settings-status"),
  navLinks: [...document.querySelectorAll("nav a")],
};

let currentChunk = null;
let lastAttemptId = null;
/** What the practice view is showing: a sentence to translate, a result, or nothing yet. */
let practiceState = "none";
let retryAction = () => loadNext();

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options) {
  let response;
  try {
    response = await fetch(path, { cache: "no-store", ...options });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.");
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON reply, for example a sign-in page, falls through to the generic message.
  }
  if (!response.ok) {
    throw new ApiError(response.status, body?.error ?? "Something went wrong. Please try again.");
  }
  if (body === null) throw new ApiError(response.status, "The server sent an unexpected reply.");
  return body;
}

const jsonRequest = (method, body) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const currentView = () => {
  const name = location.hash.slice(1);
  return VIEWS.includes(name) ? name : "practice";
};

/** Shows the section that matches the current view and state, and hides the rest. */
function applyVisibility() {
  const view = currentView();
  els.practice.hidden = !(view === "practice" && practiceState === "practice");
  els.result.hidden = !(view === "practice" && practiceState === "result");
  els.history.hidden = view !== "history";
  els.settings.hidden = view !== "settings";
  for (const link of els.navLinks) {
    if (link.hash === `#${view}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function setStatus(text) {
  els.status.textContent = text;
}

function showProblem(message, action) {
  retryAction = action;
  els.problemText.textContent = message;
  els.problem.hidden = false;
}

function clearProblem() {
  els.problem.hidden = true;
  els.problemText.textContent = "";
}

const percent = (probability) => `${Math.round(probability * 100)}%`;

function renderBars(list, items) {
  list.replaceChildren(
    ...items.map(({ label, probability }) => {
      const fill = document.createElement("span");
      fill.style.width = percent(probability);
      const track = document.createElement("span");
      track.className = "track";
      track.setAttribute("aria-hidden", "true");
      track.append(fill);

      const name = document.createElement("span");
      name.textContent = label;
      const value = document.createElement("span");
      value.className = "pct";
      value.textContent = percent(probability);

      const item = document.createElement("li");
      item.append(name, track, value);
      return item;
    }),
  );
}

/** The verdict heading text, with the symbol hidden from screen readers. */
function verdictHeading(top, heading) {
  const verdict = VERDICTS[top] ?? { icon: "", title: top };
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = `${verdict.icon} `;
  heading.replaceChildren(icon, document.createTextNode(verdict.title));
}

// ---- Routing ----

async function route({ moveFocus = false } = {}) {
  const view = currentView();
  clearProblem();
  setStatus("");
  applyVisibility();

  if (view === "practice") {
    if (practiceState === "none") await loadNext({ moveFocus });
    else if (moveFocus) (practiceState === "result" ? els.resultHeading : els.practiceHeading).focus();
  } else if (view === "history") {
    await loadHistory();
    if (moveFocus) els.historyHeading.focus();
  } else {
    await loadSettings();
    if (moveFocus) els.settingsHeading.focus();
  }
}

// ---- Practice ----

async function loadNext({ moveFocus = false } = {}) {
  clearProblem();
  practiceState = "none";
  applyVisibility();
  setStatus("Finding a sentence…");
  try {
    const chunk = await api("/api/chunks/next");
    currentChunk = chunk;
    renderChunk(chunk);
    setStatus("");
    practiceState = "practice";
    applyVisibility();
    if (moveFocus && currentView() === "practice") els.practiceHeading.focus();
  } catch (error) {
    setStatus("");
    showProblem(
      error.status === 404
        ? "There are no sentences at your level yet. Change your target level in Settings, or check back after the next daily update."
        : error.message,
      loadNext,
    );
  }
}

function renderChunk(chunk) {
  els.italian.textContent = chunk.italian;

  els.sourceLink.textContent = chunk.source.title;
  try {
    const url = new URL(chunk.source.url);
    if (url.origin === SITE_ORIGIN) els.sourceLink.href = url.href;
    else els.sourceLink.removeAttribute("href");
  } catch {
    els.sourceLink.removeAttribute("href");
  }

  const { top, confidence, runnerUp, distribution } = chunk.cefr;
  els.difficultySummary.textContent =
    `Looks like ${top} (${percent(confidence)} sure)` + (runnerUp ? `, could be ${runnerUp}` : "");
  renderBars(els.difficultyBars, distribution);

  els.attempt.value = "";
  clearFieldError();
  els.submit.disabled = false;
}

function showFieldError(message) {
  els.attemptError.textContent = message;
  els.attemptError.hidden = false;
  els.attempt.setAttribute("aria-invalid", "true");
  els.attempt.focus();
}

function clearFieldError() {
  els.attemptError.hidden = true;
  els.attemptError.textContent = "";
  els.attempt.removeAttribute("aria-invalid");
}

async function submitAttempt(event) {
  event.preventDefault();
  const attempt = els.attempt.value.trim();
  if (attempt === "") {
    showFieldError("Type your translation before checking it.");
    return;
  }
  clearFieldError();
  clearProblem();

  els.submit.disabled = true;
  els.submit.setAttribute("aria-busy", "true");
  setStatus("Checking your translation…");
  try {
    const result = await api("/api/attempt", jsonRequest("POST", { chunkId: currentChunk.id, attempt }));
    renderResult(result, attempt);
    setStatus("");
    practiceState = "result";
    applyVisibility();
    if (currentView() === "practice") els.resultHeading.focus();
  } catch (error) {
    setStatus("");
    els.submit.disabled = false;
    if (error.status === 400) showFieldError(error.message);
    else showProblem(error.message, () => els.form.requestSubmit());
  } finally {
    els.submit.removeAttribute("aria-busy");
  }
}

function renderResult(result, attempt) {
  lastAttemptId = result.attemptId;
  verdictHeading(result.verdict.top, els.resultHeading);
  els.confidence.textContent = `The scorer is ${percent(result.verdict.confidence)} sure of this verdict.`;

  els.fluencyText.textContent = `${result.fluency.score.toFixed(1)} out of ${result.fluency.outOf}`;
  els.fluencyFill.style.width = percent(result.fluency.score / result.fluency.outOf);

  renderBars(
    els.verdictBars,
    result.verdict.distribution.map((entry) => ({
      label: VERDICT_LABELS[entry.label] ?? entry.label,
      probability: entry.probability,
    })),
  );

  els.yourAttempt.textContent = attempt;
  els.reference.textContent = result.reference;

  els.explanation.hidden = true;
  els.explanationText.textContent = "";
  els.explainError.hidden = true;
  els.explainButton.disabled = false;
  els.explain.hidden = !result.needsExplanation;
}

async function explainAttempt() {
  els.explainButton.disabled = true;
  els.explainButton.setAttribute("aria-busy", "true");
  els.explainError.hidden = true;
  setStatus("Writing an explanation…");
  try {
    const { text } = await api("/api/explain", jsonRequest("POST", { attemptId: lastAttemptId }));
    els.explanationText.textContent = text;
    els.explanation.hidden = false;
    els.explain.hidden = true;
    setStatus("");
    els.explanationHeading.focus();
  } catch (error) {
    setStatus("");
    els.explainError.textContent = error.message;
    els.explainError.hidden = false;
    els.explainButton.disabled = false;
  } finally {
    els.explainButton.removeAttribute("aria-busy");
  }
}

// ---- History ----

async function loadHistory() {
  setStatus("Loading your history…");
  try {
    const { attempts } = await api("/api/history?limit=30");
    els.historyEmpty.hidden = attempts.length > 0;
    els.historyList.replaceChildren(...attempts.map(renderHistoryEntry));
    setStatus("");
  } catch (error) {
    setStatus("");
    showProblem(error.message, loadHistory);
  }
}

function textElement(tag, text, className, lang) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  if (lang) element.lang = lang;
  return element;
}

function renderHistoryEntry(entry) {
  const heading = document.createElement("h3");
  heading.id = `entry-${entry.id}-heading`;
  const verdictTitle = document.createElement("span");
  verdictHeading(entry.verdictTop, verdictTitle);
  const when = document.createElement("time");
  when.dateTime = entry.createdAt;
  when.textContent = new Date(entry.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  heading.append(verdictTitle, " ", when);

  const attempt = textElement("p", entry.attempt, "english", "en");
  const attemptLabel = textElement("span", "Your translation: ", "visually-hidden");
  attempt.prepend(attemptLabel);

  const details = document.createElement("details");
  details.append(
    textElement("summary", "Reference and explanation"),
    textElement("p", entry.reference, "english", "en"),
    entry.explanation
      ? textElement("p", entry.explanation, "explanation", "en")
      : textElement("p", "No explanation was requested for this attempt.", "hint"),
  );

  const article = document.createElement("article");
  article.className = "entry";
  article.setAttribute("aria-labelledby", heading.id);
  article.append(heading, textElement("p", entry.italian, "italian compact", "it"), attempt, details);
  return article;
}

// ---- Settings ----

async function loadSettings() {
  els.settingsError.hidden = true;
  els.settingsStatus.textContent = "";
  try {
    const settings = await api("/api/settings");
    els.targetLevel.value = settings.targetLevel;
    els.levelRange.value = String(settings.levelRange);
    els.dailyCap.value = String(settings.dailyChunkCap);
  } catch (error) {
    showProblem(error.message, loadSettings);
  }
}

function showSettingsError(message) {
  els.settingsError.textContent = message;
  els.settingsError.hidden = false;
  els.dailyCap.setAttribute("aria-invalid", "true");
  els.dailyCap.focus();
}

async function saveSettings(event) {
  event.preventDefault();
  els.settingsError.hidden = true;
  els.dailyCap.removeAttribute("aria-invalid");
  els.settingsStatus.textContent = "";

  const dailyChunkCap = Number(els.dailyCap.value);
  if (els.dailyCap.value.trim() === "" || !Number.isInteger(dailyChunkCap) || dailyChunkCap < 0 || dailyChunkCap > MAX_DAILY_CAP) {
    showSettingsError(`Enter a whole number from 0 to ${MAX_DAILY_CAP} for new sentences per day.`);
    return;
  }

  try {
    await api(
      "/api/settings",
      jsonRequest("PUT", {
        targetLevel: els.targetLevel.value,
        levelRange: Number(els.levelRange.value),
        dailyChunkCap,
      }),
    );
    practiceState = "none"; // the next visit to Practice picks a sentence for the new settings
    els.settingsStatus.textContent = "Settings saved.";
  } catch (error) {
    showSettingsError(error.message);
  }
}

// ---- Wiring ----

els.form.addEventListener("submit", submitAttempt);
els.attempt.addEventListener("input", clearFieldError);
els.skip.addEventListener("click", () => loadNext({ moveFocus: true }));
els.next.addEventListener("click", () => loadNext({ moveFocus: true }));
els.explainButton.addEventListener("click", explainAttempt);
els.retry.addEventListener("click", () => retryAction({ moveFocus: true }));
els.settingsForm.addEventListener("submit", saveSettings);
window.addEventListener("hashchange", () => route({ moveFocus: true }));

route();
