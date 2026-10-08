const SITE_ORIGIN = "https://forzapalermo.it";
const VIEWS = ["practice", "history", "settings"];
const MAX_DAILY_CAP = 40;
/** How often to check on a fetch that is under way. */
const FETCH_POLL_MS = 4000;
const FETCH_STEPS = {
  Ingest: "Reading the latest articles",
  Rating: "Rating how hard each sentence is",
  Translation: "Writing reference translations",
  Cleanup: "Finishing up",
};

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
  fetch: $("fetch"),
  fetchText: $("fetch-text"),
  fetchButton: $("fetch-button"),
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
/** Changes whenever the sentence on screen changes, so a late reply for an old one can be ignored. */
let practiceToken = 0;
/** What the practice view is showing: a sentence to translate, a result, or nothing yet. */
let practiceState = "none";
let retryAction = () => loadNext();
/** Whether the last status seen had a fetch under way, so its end can be spotted. */
let fetchRunning = false;
let fetchTimer = null;
/** The outcome of a fetch that finished while the app was open, shown until the next press. */
let fetchOutcome = "";

class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body;
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
    throw new ApiError(response.status, body?.error ?? "Something went wrong. Please try again.", body);
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
    loadFetchStatus();
    await loadSettings();
    if (moveFocus) els.settingsHeading.focus();
  }
}

// ---- Practice ----

async function loadNext({ moveFocus = false } = {}) {
  const token = ++practiceToken;
  clearProblem();
  practiceState = "none";
  applyVisibility();
  setStatus("Finding a sentence…");
  try {
    const chunk = await api("/api/chunks/next");
    if (token !== practiceToken) return;
    currentChunk = chunk;
    renderChunk(chunk);
    setStatus("");
    practiceState = "practice";
    applyVisibility();
    if (moveFocus && currentView() === "practice") els.practiceHeading.focus();
  } catch (error) {
    if (token !== practiceToken) return;
    setStatus("");
    showProblem(
      error.status === 404
        ? "There are no sentences at your level yet. Fetch new sentences or change your target level in Settings."
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

  const token = practiceToken;
  els.submit.disabled = true;
  els.skip.disabled = true;
  els.submit.setAttribute("aria-busy", "true");
  setStatus("Checking your translation…");
  try {
    const result = await api("/api/attempt", jsonRequest("POST", { chunkId: currentChunk.id, attempt }));
    if (token !== practiceToken) return;
    renderResult(result, attempt);
    setStatus("");
    practiceState = "result";
    applyVisibility();
    if (currentView() === "practice") els.resultHeading.focus();
  } catch (error) {
    if (token !== practiceToken) return;
    setStatus("");
    els.submit.disabled = false;
    if (error.status === 400) showFieldError(error.message);
    else showProblem(error.message, () => els.form.requestSubmit());
  } finally {
    els.skip.disabled = false;
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
  const token = practiceToken;
  const attemptId = lastAttemptId;
  els.explainButton.disabled = true;
  els.next.disabled = true;
  els.explainButton.setAttribute("aria-busy", "true");
  els.explainError.hidden = true;
  setStatus("Writing an explanation…");
  try {
    const { text } = await api("/api/explain", jsonRequest("POST", { attemptId }));
    if (token !== practiceToken) return;
    els.explanationText.textContent = text;
    els.explanation.hidden = false;
    els.explain.hidden = true;
    setStatus("");
    els.explanationHeading.focus();
  } catch (error) {
    if (token !== practiceToken) return;
    setStatus("");
    els.explainError.textContent = error.message;
    els.explainError.hidden = false;
    els.explainButton.disabled = false;
  } finally {
    els.next.disabled = false;
    els.explainButton.removeAttribute("aria-busy");
  }
}

// ---- Fetching new sentences ----

const sentences = (n) => `${n} new sentence${n === 1 ? "" : "s"}`;

async function loadFetchStatus() {
  try {
    renderFetch(await api("/api/crawl"));
  } catch (error) {
    stopFetchPolling();
    els.fetch.removeAttribute("aria-busy");
    els.fetchButton.disabled = false;
    els.fetchText.textContent = `Could not check for new sentences. ${error.message}`;
  }
}

async function startFetch() {
  fetchOutcome = "";
  els.fetchButton.disabled = true;
  try {
    renderFetch(await api("/api/crawl", { method: "POST" }));
  } catch (error) {
    // A refusal still says where things stand, for example a fetch that is already going.
    if (error.body?.today) renderFetch(error.body);
    else els.fetchButton.disabled = false;
    if (error.body?.reason !== "running") els.fetchText.textContent = error.message;
  }
}

function renderFetch(status) {
  const { run, today } = status;
  const running = run?.status === "running";
  if (fetchRunning && !running) {
    fetchOutcome = outcomeText(run);
    // The practice view was empty for want of sentences, so look again now there may be some.
    if (practiceState === "none" && !els.problem.hidden) loadNext();
  }
  fetchRunning = running;

  els.fetchButton.disabled = !status.canStart;
  els.fetchButton.textContent = running ? "Fetching…" : "Fetch new sentences";
  if (running) {
    els.fetch.setAttribute("aria-busy", "true");
    const step = FETCH_STEPS[run.step] ?? "Starting";
    els.fetchText.textContent = `${step}… This takes a few minutes, and you can keep practising.`;
    scheduleFetchPoll();
    return;
  }

  els.fetch.removeAttribute("aria-busy");
  stopFetchPolling();
  els.fetchText.textContent =
    fetchOutcome ||
    (status.reason === "paused"
      ? "New sentences are paused. Set a daily number above 0 in Settings."
      : status.reason === "limit"
        ? `Today's ${sentences(today.cap)} are in. More tomorrow.`
        : `${today.added} of ${sentences(today.cap)} added today.`);
}

function outcomeText(run) {
  if (!run || run.status === "failed") return "Fetching stopped before it finished. Please try again.";
  if (!run.complete) return `Added ${sentences(run.chunksAdded)}, but a step did not finish. Fetch again to retry it.`;
  return run.chunksAdded > 0
    ? `Added ${sentences(run.chunksAdded)}.`
    : "No new articles yet. Try again later.";
}

function scheduleFetchPoll() {
  if (fetchTimer !== null || document.hidden) return;
  fetchTimer = setTimeout(() => {
    fetchTimer = null;
    loadFetchStatus();
  }, FETCH_POLL_MS);
}

function stopFetchPolling() {
  clearTimeout(fetchTimer);
  fetchTimer = null;
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
    practiceToken++; // a reply still in flight belongs to the old settings
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
els.fetchButton.addEventListener("click", startFetch);
// Phones pause timers in the background, so check again as soon as the app is back in view.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopFetchPolling();
  else if (fetchRunning) loadFetchStatus();
});
window.addEventListener("hashchange", () => route({ moveFocus: true }));

route();
