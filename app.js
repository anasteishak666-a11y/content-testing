"use strict";

const ENCYCLOPEDIA_URL = "https://anasteishak666-a11y.github.io/Encyclopedia/";

// Базовый тест использует серверные вопросы и сохранение ответов; экран результатов пока не подключён.
const screens = ["login", "dashboard", "basic-attempt", "basic-result", "quiz", "admin"];
const questions = [
  {
    type: "Текстовый вопрос",
    title: "Какую тему вы хотели бы разобрать перед следующей съёмкой?",
    hint: "Учебный пример: здесь нет правильного или неправильного варианта.",
    options: ["Подбор вещей", "Подготовка раскладки", "Планирование публикации"]
  },
  {
    type: "Вопрос с фотографиями",
    title: "Какой снимок вы выбрали бы для обсуждения на занятии?",
    hint: "Фотографии служат примером формата вопроса. Ответ не оценивается.",
    photos: [
      { src: `${ENCYCLOPEDIA_URL}Стандарты/Фото на фотофоне/cHV7vxE1qVI.jpg`, caption: "Снимок А" },
      { src: `${ENCYCLOPEDIA_URL}Стандарты/Фото на фотофоне/G80iHiXHPCk.jpg`, caption: "Снимок Б" }
    ],
    options: ["Снимок А", "Снимок Б"]
  }
];
const topics = [
  ["Стандарты работы с контентом", "89%"],
  ["Актуальность вещей", "89%"],
  ["Гармоничные образы", "83%"],
  ["Раскладки", "83%"],
  ["Цвет", "75%"],
  ["Анонс", "86%"],
  ["Продавец с вещами", "100%"],
  ["Фото на фотофоне", "100%"],
  ["Фото обуви", "67%"]
];

let questionIndex = 0;
let selectedOption = -1;
let demoDeadline = 0;
let timerInterval = null;
let toastTimeout = null;
let authClient = null;
let authenticatedUser = null;
let currentProfile = null;
let currentRole = null;
let authCheckSerial = 0;
let availabilityCheckSerial = 0;
let basicActionSerial = 0;
let basicActionInFlight = false;
let basicAvailability = null;
let basicQuestion = null;
let basicSelectedOptions = new Set();
let basicPendingAnswer = null;
let basicAnswerInFlight = false;
let basicResultSerial = 0;
let basicHistorySerial = 0;
let basicHistoryCursor = null;
let basicResultAttemptId = null;
let basicCountdownInterval = null;
let activeTestKind = "basic";
let fullAvailability = null;
let resultKind = "basic";
const testName = kind => kind === "full" ? "Полная аттестация" : "Базовый тест";

function showFullAvailability(test = null, errorMessage = null, attestation = null) {
  fullAvailability = test;
  const chip = document.getElementById("full-availability-chip");
  const message = document.getElementById("full-availability-message");
  const action = document.getElementById("full-availability-action");
  const note = document.getElementById("full-launch-note");
  action.hidden = true;
  action.disabled = true;
  note.hidden = true;
  let label = "Проверяем", detail = "Проверяем доступность аттестации…", tone = "muted";
  if (errorMessage) { label = "Ошибка проверки"; detail = errorMessage; tone = "warning"; }
  else if (test?.state === "in_progress" && basicAttemptIdPattern.test(test.active_attempt_id)) {
    label = "Не завершена"; detail = "У вас есть незавершённая попытка."; tone = "warning";
    action.textContent = "Продолжить аттестацию"; action.hidden = false; action.disabled = basicActionInFlight; note.hidden = false;
  } else if (test?.state === "available" && test.can_start === true) {
    label = "Доступна"; detail = "Можно начать итоговую аттестацию."; tone = "success";
    action.textContent = "Начать аттестацию"; action.hidden = false; action.disabled = basicActionInFlight; note.hidden = false;
  } else if (test?.state === "prerequisite_required") {
    label = "Закрыта"; detail = "Сначала сдайте базовый тест.";
  } else if (test?.state === "cooldown") {
    label = "Пересдача позже"; detail = test.next_allowed_moscow
      ? `Пересдача доступна с ${test.next_allowed_moscow}.` : "Пересдача доступна через 7 дней после завершения попытки.";
    tone = "warning";
  } else if (["passed", "valid_until_due"].includes(test?.state)) {
    label = "Пройдена"; detail = attestation?.valid_until_moscow
      ? `Действует до ${attestation.valid_until_moscow}.` : "Срок действия аттестации рассчитан сервером.";
    tone = "success";
  } else if (test?.state === "bank_unavailable") {
    label = "Пока недоступна"; detail = "Банк вопросов пока не готов."; tone = "warning";
  } else if (test) { label = "Недоступна"; detail = "Обновите страницу, чтобы уточнить статус."; tone = "warning"; }
  chip.className = `chip chip--${tone}`;
  chip.textContent = label;
  message.textContent = detail;
}
let currentScreen = "login";
let loginInProgress = false;

function setAuthMessage(message, isError = false) {
  const element = document.getElementById("auth-message");
  element.textContent = message;
  element.classList.toggle("auth-message--error", isError);
}

function setLoginBusy(busy) {
  const button = document.getElementById("login-button");
  button.disabled = busy || !authClient;
  button.textContent = busy ? "Проверяем вход…" : "Войти в кабинет";
}

function showBasicAvailability(test = null, errorMessage = null) {
  basicAvailability = test;
  const chip = document.getElementById("basic-availability-chip");
  const message = document.getElementById("basic-availability-message");
  const action = document.getElementById("basic-availability-action");
  const note = document.getElementById("basic-launch-note");
  let label = "Проверяем";
  let detail = "Проверяем доступность теста…";
  let tone = "muted";
  action.hidden = true;
  action.disabled = true;
  note.hidden = true;

  if (errorMessage) {
    label = "Ошибка проверки";
    detail = errorMessage;
    tone = "warning";
  } else if (test?.state === "available" && test.can_start === true) {
    label = "Доступен";
    detail = "Базовый тест можно пройти.";
    tone = "success";
    action.textContent = "Начать тест";
    action.hidden = false;
    action.disabled = basicActionInFlight;
    note.hidden = false;
  } else if (test?.state === "in_progress" && basicAttemptIdPattern.test(test.active_attempt_id)) {
    label = "Не завершён";
    detail = "У вас есть незавершённая попытка.";
    tone = "warning";
    action.textContent = "Продолжить тест";
    action.hidden = false;
    action.disabled = basicActionInFlight;
    note.hidden = false;
  } else if (test?.state === "cooldown") {
    label = "Пересдача позже";
    detail = test.next_allowed_moscow
      ? `Пересдача доступна с ${test.next_allowed_moscow}.`
      : "Срок пересдачи ещё не наступил.";
    tone = "warning";
  } else if (test?.state === "passed") {
    label = "Пройден";
    detail = "Базовый тест уже пройден. Повторное прохождение закрыто.";
    tone = "success";
  } else if (test?.state === "bank_unavailable") {
    label = "Пока недоступен";
    detail = "Банк вопросов пока не готов. Попробуйте позже.";
    tone = "warning";
  } else if (test) {
    label = "Недоступен";
    detail = "Не удалось определить срок допуска к тесту. Попробуйте позже.";
    tone = "warning";
  }
  chip.className = `chip chip--${tone}`;
  chip.textContent = label;
  message.textContent = detail;
}

const basicAttemptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function testingRequest(path, method = "GET", body = null) {
  const { data, error } = await authClient.auth.getSession();
  if (error || !data.session) throw new Error("Сеанс входа истёк. Войдите снова.");
  const response = await fetch(
    new URL(`/functions/v1/testing${path}`, window.TESTING_SUPABASE_CONFIG.url),
    {
      method,
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        apikey: window.TESTING_SUPABASE_CONFIG.publishableKey,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code;
    if (code === "attempt_expired" || code === "attempt_finished") {
      const issue = new Error("Время попытки истекло или тест уже завершён. Обновите кабинет.");
      issue.apiCode = code;
      throw issue;
    }
    if (response.status === 401 || response.status === 403) {
      const issue = new Error("Доступ закрыт. Войдите снова или обратитесь к администратору.");
      issue.apiCode = code;
      issue.httpStatus = response.status;
      throw issue;
    }
    if (code === "cooldown_active" || code === "already_passed") {
      throw new Error("Запуск сейчас недоступен. Обновите кабинет, чтобы увидеть причину.");
    }
    if (code === "answer_locked" || code === "question_out_of_order") {
      const issue = new Error("Ответ уже сохранён или текущий вопрос изменился. Вернитесь в кабинет и продолжите попытку.");
      issue.apiCode = code;
      throw issue;
    }
    if (code === "request_id_conflict" && path === "/admin/retake-overrides") {
      const issue = new Error("Параметры запроса пересдачи изменились. Повторите действие с новой причиной.");
      issue.apiCode = code;
      throw issue;
    }
    if (code === "invalid_options" || code === "request_id_conflict") {
      throw new Error("Сервер отклонил сохранённый ответ. Не меняйте его и обратитесь к администратору.");
    }
    const issue = new Error("Не удалось связаться с сервером тестирования. Обновите кабинет и попробуйте снова.");
    issue.apiCode = code;
    issue.httpStatus = response.status;
    throw issue;
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Сервер вернул неполный ответ. Обновите кабинет и попробуйте снова.");
  }
  Object.defineProperty(payload, "receivedAt", { value: performance.now() });
  return payload;
}

function renderBasicResult(payload, attemptId) {
  if (payload.attempt_id !== attemptId || payload.kind !== "basic" ||
      !["completed", "timed_out"].includes(payload.state) ||
      !Number.isInteger(payload.correct_count) || payload.question_count !== 20 ||
      payload.correct_count < 0 || payload.correct_count > 20 ||
      typeof payload.percentage !== "number" || typeof payload.passed !== "boolean" ||
      !Array.isArray(payload.review) || payload.review.length !== 20) {
    throw new Error("Сервер вернул неполный результат. Повторите загрузку позже.");
  }
  const fragment = document.createDocumentFragment();
  payload.review.forEach((item, index) => {
    if (item?.position !== index + 1 || typeof item.prompt !== "string" ||
        typeof item.answered !== "boolean" || !Array.isArray(item.options) ||
        !Array.isArray(item.selected_option_ids) || !Array.isArray(item.correct_option_ids) ||
        !item.correct_option_ids.length) {
      throw new Error("Сервер вернул неполный разбор. Повторите загрузку позже.");
    }
    const labels = new Map();
    item.options.forEach(option => {
      if (!basicAttemptIdPattern.test(option?.id) || typeof option.label !== "string") {
        throw new Error("Сервер вернул неполный разбор. Повторите загрузку позже.");
      }
      labels.set(option.id, option.label);
    });
    if (labels.size !== item.options.length ||
        [...item.selected_option_ids, ...item.correct_option_ids].some(id => !labels.has(id)) ||
        (item.answered === false && item.selected_option_ids.length !== 0)) {
      throw new Error("Сервер вернул неполный разбор. Повторите загрузку позже.");
    }
    const card = document.createElement("article");
    card.className = "card basic-review__item";
    const number = document.createElement("span");
    number.className = "section-label";
    number.textContent = `Вопрос ${item.position}`;
    const title = document.createElement("h2");
    title.textContent = item.prompt;
    card.append(number);
    if (!item.answered) {
      const missed = document.createElement("span");
      missed.className = "chip chip--warning basic-review__missed";
      missed.textContent = "Без ответа";
      card.append(missed);
    }
    card.append(title);
    const line = (heading, value) => {
      const paragraph = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = `${heading}: `;
      paragraph.append(strong, document.createTextNode(value));
      card.append(paragraph);
    };
    line("Ваш ответ", item.answered
      ? item.options.filter(option => item.selected_option_ids.includes(option.id))
        .map(option => option.label).join(", ") : "Без ответа");
    line("Правильный ответ", item.options.filter(option => item.correct_option_ids.includes(option.id))
      .map(option => option.label).join(", "));
    line("Объяснение", typeof item.explanation_text === "string" && item.explanation_text.trim()
      ? item.explanation_text : "Объяснение пока не добавлено.");
    fragment.append(card);
  });
  document.getElementById("basic-result-review").replaceChildren(fragment);
  const chip = document.getElementById("basic-result-status");
  chip.className = `chip chip--${payload.passed ? "success" : "warning"}`;
  chip.textContent = payload.passed ? "Сдан" : "Не сдан";
  document.getElementById("basic-result-score").textContent =
    `${payload.correct_count} из 20 · ${payload.percentage}%`;
  document.getElementById("basic-result-message").textContent = payload.state === "timed_out"
    ? "Время истекло. В разборе отмечены вопросы без ответа."
    : "Тест завершён. Ниже показаны ваши ответы и объяснения.";
}

function renderFullResult(payload, attemptId) {
  if (payload.attempt_id !== attemptId || payload.kind !== "full" ||
      !["completed", "timed_out"].includes(payload.state) ||
      !Number.isInteger(payload.correct_count) || payload.question_count !== 50 ||
      payload.correct_count < 0 || payload.correct_count > 50 ||
      typeof payload.percentage !== "number" || typeof payload.passed !== "boolean" ||
      !Array.isArray(payload.topics) || !Array.isArray(payload.recommendations)) {
    throw new Error("Сервер вернул неполный результат. Повторите загрузку позже.");
  }
  const fragment = document.createDocumentFragment();
  const heading = document.createElement("h2");
  heading.textContent = "Результаты по темам";
  fragment.append(heading);
  const grid = document.createElement("div");
  grid.className = "result-grid";
  payload.topics.forEach(topic => {
    if (typeof topic?.topic !== "string" || !Number.isInteger(topic.correct_count) ||
        !Number.isInteger(topic.question_count) || typeof topic.percentage !== "number") {
      throw new Error("Сервер вернул неполные результаты по темам.");
    }
    const row = document.createElement("div");
    row.className = "result-topic";
    const label = document.createElement("span");
    label.textContent = topic.topic;
    const value = document.createElement("strong");
    value.textContent = `${topic.correct_count} из ${topic.question_count} · ${topic.percentage}%`;
    row.append(label, value);
    grid.append(row);
  });
  fragment.append(grid);
  if (payload.recommendations.length) {
    const title = document.createElement("h2");
    title.textContent = "Рекомендуем повторить";
    fragment.append(title);
    const list = document.createElement("ul");
    payload.recommendations.forEach(item => {
      if (typeof item?.topic !== "string" || typeof item.encyclopedia_href !== "string") return;
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.textContent = item.topic;
      const anchor = /^\.\.\/index\.html#([a-zA-Z0-9_-]+)$/.exec(item.encyclopedia_href);
      if (anchor) link.href = `${ENCYCLOPEDIA_URL}#${anchor[1]}`;
      row.append(link.href ? link : document.createTextNode(item.topic));
      list.append(row);
    });
    fragment.append(list);
  }
  document.getElementById("basic-result-review").replaceChildren(fragment);
  const chip = document.getElementById("basic-result-status");
  chip.className = `chip chip--${payload.passed ? "success" : "warning"}`;
  chip.textContent = payload.passed ? "Сдана" : "Не сдана";
  document.getElementById("basic-result-score").textContent =
    `${payload.correct_count} из 50 · ${payload.percentage}%`;
  const term = payload.passed ? payload.valid_until_moscow : payload.retry_available_moscow;
  document.getElementById("basic-result-message").textContent =
    `${payload.state === "timed_out" ? "Время истекло. " : ""}${payload.passed ? "Аттестация пройдена." : "Аттестация не сдана."}${term ? ` ${payload.passed ? "Действует до" : "Пересдача с"} ${term}.` : ""}`;
}

async function loadBasicResult(attemptId, kind = activeTestKind) {
  if (currentRole !== "employee" || !authenticatedUser || !basicAttemptIdPattern.test(attemptId)) return;
  const check = ++basicResultSerial;
  const userId = authenticatedUser.id;
  basicResultAttemptId = attemptId;
  resultKind = kind;
  document.getElementById("basic-result-title").textContent = kind === "full" ? "Результат аттестации" : "Результат базового теста";
  document.getElementById("result-intro").textContent = kind === "full"
    ? "Результаты по темам и рекомендации." : "Разбор доступен только после завершения вашей попытки.";
  document.getElementById("basic-result-review").replaceChildren();
  document.getElementById("basic-result-score").textContent = "";
  document.getElementById("basic-result-status").textContent = "Загружаем";
  document.getElementById("basic-result-status").className = "chip chip--muted";
  document.getElementById("basic-result-message").textContent = "Загружаем результат с сервера…";
  document.getElementById("basic-result-retry").hidden = true;
  showScreen("basic-result");
  try {
    const payload = await testingRequest(`/attempts/${attemptId}/result`);
    if (check !== basicResultSerial || currentRole !== "employee" || authenticatedUser?.id !== userId) return;
    if (kind === "full") renderFullResult(payload, attemptId);
    else renderBasicResult(payload, attemptId);
    try { localStorage.removeItem(pendingAnswerKey(attemptId, kind)); } catch { /* Результат уже подтверждён сервером. */ }
    void loadBasicHistory();
  } catch {
    if (check !== basicResultSerial || currentRole !== "employee" || authenticatedUser?.id !== userId) return;
    document.getElementById("basic-result-message").textContent =
      "Результат пока не удалось загрузить. Попробуйте ещё раз.";
    document.getElementById("basic-result-status").textContent = "Недоступен";
    document.getElementById("basic-result-status").className = "chip chip--warning";
    document.getElementById("basic-result-retry").hidden = false;
  }
}

async function loadBasicHistory(cursor = null) {
  if (currentRole !== "employee" || !authenticatedUser) return;
  const check = ++basicHistorySerial;
  const userId = authenticatedUser.id;
  const status = document.getElementById("basic-history-status");
  const list = document.getElementById("basic-history-list");
  status.textContent = cursor ? "Загружаем более ранние попытки…" : "Загружаем историю…";
  if (!cursor) {
    list.replaceChildren();
    basicHistoryCursor = null;
  }
  document.getElementById("basic-history-retry").hidden = true;
  document.getElementById("basic-history-more").hidden = true;
  try {
    const payload = await testingRequest(`/attempts/history?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (check !== basicHistorySerial || currentRole !== "employee" || authenticatedUser?.id !== userId) return;
    if (!Array.isArray(payload.items)) throw new Error("История недоступна.");
    const attempts = payload.items.filter(item => ["basic", "full"].includes(item?.kind) &&
      ["completed", "timed_out"].includes(item.state) && basicAttemptIdPattern.test(item.attempt_id));
    if (!cursor) for (const kind of ["basic", "full"]) {
      const latest = payload.latest?.[kind];
      if (basicAttemptIdPattern.test(latest?.attempt_id) &&
          !attempts.some(item => item.attempt_id === latest.attempt_id)) attempts.unshift({ ...latest, kind });
    }
    status.textContent = attempts.length || list.childElementCount ? "Откройте результат завершённой попытки." :
      "Завершённых попыток пока нет.";
    attempts.forEach(item => {
      if ([...list.children].some(row => row.dataset.attemptId === item.attempt_id)) return;
      const row = document.createElement("div");
      row.className = "basic-history__item";
      row.dataset.attemptId = item.attempt_id;
      const label = document.createElement("span");
      const date = new Date(item.finished_at);
      label.textContent = `${Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" }).format(date)
        : "Завершённая попытка"} · ${testName(item.kind)} · ${typeof item.percentage === "number" ? `${item.percentage}%` : "Результат"}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = "Посмотреть результат →";
      button.addEventListener("click", () => { void loadBasicResult(item.attempt_id, item.kind); });
      row.append(label, button);
      list.append(row);
    });
    basicHistoryCursor = typeof payload.next_cursor === "string" ? payload.next_cursor : null;
    document.getElementById("basic-history-more").hidden = !basicHistoryCursor;
  } catch {
    if (check !== basicHistorySerial || currentRole !== "employee" || authenticatedUser?.id !== userId) return;
    status.textContent = "Не удалось загрузить историю. Попробуйте ещё раз.";
    if (cursor) {
      basicHistoryCursor = cursor;
      document.getElementById("basic-history-more").hidden = false;
    } else {
      document.getElementById("basic-history-retry").hidden = false;
    }
  }
}

function pendingAnswerKey(attemptId, kind = activeTestKind) {
  return `testing:${kind}:pending:${authenticatedUser.id}:${attemptId}`;
}

function readPendingAnswer(attemptId, questionId, optionIds) {
  let raw;
  try { raw = localStorage.getItem(pendingAnswerKey(attemptId)); }
  catch { throw new Error("Браузер не разрешает сохранить ответ. Проверьте настройки хранения данных."); }
  if (!raw) return null;
  let pending;
  try { pending = JSON.parse(raw); } catch { throw new Error("Не удалось восстановить неподтверждённый ответ. Обратитесь к администратору."); }
  if (!pending || typeof pending !== "object") {
    throw new Error("Сохранённый запрос ответа повреждён. Обратитесь к администратору.");
  }
  if (pending.employee_id !== authenticatedUser.id || pending.attempt_id !== attemptId ||
      !basicAttemptIdPattern.test(pending.request_id) ||
      !basicAttemptIdPattern.test(pending.attempt_question_id) ||
      !Array.isArray(pending.selected_option_ids) || !pending.selected_option_ids.length ||
      new Set(pending.selected_option_ids).size !== pending.selected_option_ids.length ||
      pending.selected_option_ids.some(id => !basicAttemptIdPattern.test(id))) {
    throw new Error("Сохранённый запрос ответа повреждён. Обратитесь к администратору.");
  }
  if (pending.attempt_question_id !== questionId) {
    try { localStorage.removeItem(pendingAnswerKey(attemptId)); }
    catch { throw new Error("Не удалось очистить уже подтверждённый ответ в браузере."); }
    return null;
  }
  if (pending.selected_option_ids.some(id => !optionIds.has(id))) {
    throw new Error("Сохранённый запрос ответа повреждён. Обратитесь к администратору.");
  }
  return pending;
}

function updateBasicAnswerButton() {
  const button = document.getElementById("basic-submit-answer");
  button.disabled = !basicQuestion || basicAnswerInFlight ||
    (!basicPendingAnswer && basicSelectedOptions.size === 0);
  button.textContent = basicAnswerInFlight ? "Сохраняем…" :
    basicPendingAnswer ? "Повторить подтверждение" : "Подтвердить ответ";
}

function resetBasicQuestion() {
  clearInterval(basicCountdownInterval);
  basicCountdownInterval = null;
  basicQuestion = null;
  basicSelectedOptions = new Set();
  basicPendingAnswer = null;
  basicAnswerInFlight = false;
  updateBasicAnswerButton();
}

function startBasicCountdown(payload) {
  clearInterval(basicCountdownInterval);
  basicCountdownInterval = null;
  const serverNow = Date.parse(payload.server_now);
  const deadline = Date.parse(payload.deadline_at);
  if (!Number.isFinite(serverNow) || !Number.isFinite(deadline) ||
      !Number.isInteger(payload.remaining_seconds) || payload.remaining_seconds < 0 ||
      !Number.isFinite(payload.receivedAt)) {
    throw new Error("Сервер не указал время попытки. Вернитесь в кабинет и попробуйте снова.");
  }
  const secondsAtReceipt = Math.max(0, Math.min(payload.remaining_seconds,
    (deadline - serverNow) / 1000));
  const clock = document.getElementById("basic-question-deadline");
  clock.title = `Срок завершения: ${new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(deadline)} МСК`;
  let checked = false;
  const update = () => {
    const left = Math.max(0, secondsAtReceipt - (performance.now() - payload.receivedAt) / 1000);
    const seconds = Math.ceil(left);
    clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    if (seconds === 0 && !checked && currentScreen === "basic-attempt" &&
        currentRole === "employee" && basicQuestion?.attemptId === payload.attempt_id) {
      checked = true;
      clearInterval(basicCountdownInterval);
      basicCountdownInterval = null;
       void loadBasicResult(payload.attempt_id, activeTestKind);
    }
  };
  update();
  basicCountdownInterval = setInterval(update, 1000);
}

function renderBasicQuestion(payload) {
  const question = payload.question;
  const multi = ["multiple", "scenario_multiple", "photo_multiple"].includes(question?.type);
  const single = ["single", "scenario_single", "photo_single"].includes(question?.type);
  if (!basicAttemptIdPattern.test(payload.attempt_id) ||
      !basicAttemptIdPattern.test(question?.attempt_question_id) ||
      !Number.isInteger(payload.position) || !Number.isInteger(payload.question_count) ||
      payload.position < 1 || payload.position > payload.question_count ||
      (!single && !multi) ||
      typeof question?.prompt !== "string" || !Array.isArray(question.options) ||
      question.options.length < 2 || question.options.some(option =>
        !basicAttemptIdPattern.test(option?.id) || typeof option?.label !== "string") ||
      new Set(question.options.map(option => option.id)).size !== question.options.length) {
    throw new Error("Не удалось отобразить вопрос. Вернитесь в кабинет и попробуйте снова.");
  }
  const optionIds = new Set(question.options.map(option => option.id));
  const pending = readPendingAnswer(payload.attempt_id, question.attempt_question_id, optionIds);
  if (pending && single && pending.selected_option_ids.length !== 1) {
    throw new Error("Сохранённый запрос ответа повреждён. Обратитесь к администратору.");
  }
  if (payload.question_count !== (activeTestKind === "full" ? 50 : 20)) {
    throw new Error("Сервер вернул неверное число вопросов.");
  }
  basicQuestion = { attemptId: payload.attempt_id, id: question.attempt_question_id,
    multi, questionCount: payload.question_count, optionIds: question.options.map(option => option.id) };
  basicPendingAnswer = pending;
  basicSelectedOptions = new Set(pending?.selected_option_ids ?? []);
  basicAnswerInFlight = false;
  document.getElementById("basic-question-number").textContent =
    `Вопрос ${payload.position} из ${payload.question_count}`;
  document.getElementById("basic-question-progress").style.width =
    `${Math.min(100, payload.position / payload.question_count * 100)}%`;
  document.getElementById("basic-question-topic").textContent = question.topic || testName(activeTestKind);
  document.getElementById("basic-question-title").textContent = question.prompt;
  const photos = document.getElementById("basic-question-photos");
  photos.replaceChildren();
  const imageItems = Array.isArray(question.photos) ? question.photos : [];
  photos.hidden = imageItems.length === 0;
  imageItems.forEach(photo => {
    if (typeof photo?.url !== "string") return;
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.src = photo.url;
    image.alt = typeof photo.caption === "string" ? photo.caption : "Фотография к вопросу";
    figure.append(image);
    if (typeof photo.caption === "string") {
      const caption = document.createElement("figcaption");
      caption.textContent = photo.caption;
      figure.append(caption);
    }
    photos.append(figure);
  });
  const options = document.getElementById("basic-question-options");
  options.replaceChildren();
  question.options.forEach((option, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "option";
    item.setAttribute("aria-pressed", String(basicSelectedOptions.has(option.id)));
    item.classList.toggle("is-selected", basicSelectedOptions.has(option.id));
    item.disabled = Boolean(basicPendingAnswer);
    const mark = document.createElement("span");
    mark.className = "option-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = String.fromCharCode(1040 + index);
    const label = document.createElement("span");
    label.textContent = option.label;
    item.append(mark, label);
    item.addEventListener("click", () => {
      if (basicAnswerInFlight || basicPendingAnswer) return;
      if (!multi) basicSelectedOptions.clear();
      if (multi && basicSelectedOptions.has(option.id)) basicSelectedOptions.delete(option.id);
      else basicSelectedOptions.add(option.id);
      options.querySelectorAll("button").forEach((button, optionIndex) => {
        const selected = basicSelectedOptions.has(question.options[optionIndex].id);
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      });
      updateBasicAnswerButton();
    });
    options.append(item);
  });
  document.getElementById("basic-answer-status").textContent = pending
    ? "Подтверждение не получено. Повторите тот же ответ. Выбор изменить нельзя."
    : multi ? "Выберите один или несколько вариантов. После подтверждения ответ изменить нельзя."
      : "Выберите один вариант. После подтверждения ответ изменить нельзя.";
  updateBasicAnswerButton();
  startBasicCountdown(payload);
}

async function openBasicQuestion(attemptId, actionSerial, userId) {
  if (!basicAttemptIdPattern.test(attemptId)) {
    throw new Error("Не удалось восстановить попытку. Обновите кабинет.");
  }
  const payload = await testingRequest(`/attempts/${attemptId}/current-question`);
  if (actionSerial !== basicActionSerial || currentRole !== "employee" || authenticatedUser?.id !== userId) return;
  if (payload.attempt_id !== attemptId) throw new Error("Сервер вернул другой идентификатор попытки.");
  renderBasicQuestion(payload);
  showScreen("basic-attempt");
}

async function submitBasicAnswer() {
  if (basicAnswerInFlight || !basicQuestion || currentRole !== "employee" || !authenticatedUser) return;
  if (!basicPendingAnswer && basicSelectedOptions.size === 0) return;
  const question = basicQuestion;
  const serial = basicActionSerial;
  const userId = authenticatedUser.id;
  try {
    if (!basicPendingAnswer) {
      const existing = readPendingAnswer(question.attemptId, question.id, new Set(question.optionIds));
      if (existing) {
        basicPendingAnswer = existing;
        basicSelectedOptions = new Set(existing.selected_option_ids);
        document.getElementById("basic-question-options").querySelectorAll("button").forEach((button, index) => {
          const selected = basicSelectedOptions.has(question.optionIds[index]);
          button.classList.toggle("is-selected", selected);
          button.setAttribute("aria-pressed", String(selected));
          button.disabled = true;
        });
        document.getElementById("basic-answer-status").textContent =
          "Найден неподтверждённый ответ. Проверьте выбор и повторите подтверждение.";
        updateBasicAnswerButton();
        return;
      }
      const selected = Array.from(document.getElementById("basic-question-options").querySelectorAll("button"))
        .map((button, index) => ({ button, index }))
        .filter(({ button }) => button.getAttribute("aria-pressed") === "true")
        .map(({ index }) => question.optionIds[index]);
      if (!selected.length || (!question.multi && selected.length !== 1)) return;
      const prepared = {
        employee_id: userId,
        attempt_id: question.attemptId,
        request_id: crypto.randomUUID(),
        attempt_question_id: question.id,
        selected_option_ids: selected
      };
      try { localStorage.setItem(pendingAnswerKey(question.attemptId), JSON.stringify(prepared)); }
      catch { throw new Error("Браузер не разрешает сохранить ответ. Проверьте настройки хранения данных."); }
      basicPendingAnswer = prepared;
    }
    basicAnswerInFlight = true;
    document.getElementById("basic-question-options").querySelectorAll("button").forEach(button => { button.disabled = true; });
    document.getElementById("basic-answer-status").textContent = "Сохраняем ответ на сервере…";
    updateBasicAnswerButton();
    const pending = basicPendingAnswer;
    const result = await testingRequest(`/attempts/${question.attemptId}/answers`, "POST", {
      request_id: pending.request_id,
      attempt_question_id: pending.attempt_question_id,
      selected_option_ids: pending.selected_option_ids
    });
    if (serial !== basicActionSerial || currentRole !== "employee" || authenticatedUser?.id !== userId) return;
    if (result.saved !== true || result.request_id !== pending.request_id ||
        result.attempt_question_id !== question.id || !Number.isInteger(result.answered_count)) {
      throw new Error("Не удалось подтвердить сохранение ответа. Повторите запрос с тем же ответом.");
    }
    localStorage.removeItem(pendingAnswerKey(question.attemptId));
    basicPendingAnswer = null;
    basicQuestion = null;
    document.getElementById("basic-question-progress").style.width =
      `${Math.min(100, result.answered_count / question.questionCount * 100)}%`;
    if (result.attempt_state === "completed") {
      document.getElementById("basic-answer-status").textContent = "Все ответы сохранены. Загружаем результат…";
      if (activeTestKind === "full") showFullAvailability(null); else showBasicAvailability(null);
       await loadBasicResult(question.attemptId, activeTestKind);
      return;
    }
    if (result.attempt_state !== "in_progress") {
      throw new Error("Ответ сохранён. Обновите кабинет, чтобы проверить состояние попытки.");
    }
    document.getElementById("basic-answer-status").textContent = "Ответ сохранён. Загружаем следующий вопрос…";
    try {
      await openBasicQuestion(question.attemptId, serial, userId);
    } catch {
      document.getElementById("basic-answer-status").textContent =
        "Ответ сохранён, но следующий вопрос не загрузился. Вернитесь в кабинет и продолжите тест.";
    }
  } catch (error) {
    if (serial !== basicActionSerial || currentRole !== "employee" || authenticatedUser?.id !== userId) return;
    if (["attempt_expired", "attempt_finished", "answer_locked", "question_out_of_order"].includes(error?.apiCode)) {
      try { localStorage.removeItem(pendingAnswerKey(question.attemptId)); } catch { /* Сервер подтвердил окончательный отказ. */ }
      resetBasicQuestion();
      if (["attempt_expired", "attempt_finished"].includes(error.apiCode)) {
         void loadBasicResult(question.attemptId, activeTestKind);
      } else {
        showScreen("dashboard");
        void refreshBasicAvailability();
      }
    } else {
      document.getElementById("basic-answer-status").textContent = basicPendingAnswer
        ? "Подтверждение не получено. Повторите тот же ответ; выбор изменить нельзя."
        : "Не удалось сохранить запрос ответа в браузере. Повторите попытку.";
    }
    showToast(error instanceof TypeError ? "Нет соединения. Повторите подтверждение того же ответа."
      : error instanceof Error ? error.message : "Не удалось подтвердить ответ.");
  } finally {
    if (serial === basicActionSerial) {
      basicAnswerInFlight = false;
      updateBasicAnswerButton();
    }
  }
}

async function handleBasicAction(kind = "basic") {
  if (basicActionInFlight || currentRole !== "employee" || !authenticatedUser) return;
  const test = kind === "full" ? fullAvailability : basicAvailability;
  const canStart = test?.state === "available" && test.can_start === true;
  const canResume = test?.state === "in_progress" && basicAttemptIdPattern.test(test.active_attempt_id);
  if (!canStart && !canResume) return;
  if (canStart && !window.confirm(kind === "full"
    ? "Начать итоговую аттестацию? 50 вопросов, 75 минут. Таймер начнётся сразу после подтверждения и не остановится при закрытии страницы.\n\nПодтверждённый ответ нельзя изменить. При неудаче пересдача обычно доступна через 7 дней."
    : "Начать базовый тест? 20 вопросов, 25 минут. Таймер запустится сразу и не остановится при закрытии страницы.\n\nПодтверждённый ответ нельзя изменить. Неудачная попытка может потребовать ожидания 24 часа перед пересдачей.")) return;

  activeTestKind = kind;
  const actionSerial = ++basicActionSerial;
  ++availabilityCheckSerial;
  const userId = authenticatedUser.id;
  basicActionInFlight = true;
  if (kind === "full") showFullAvailability(test); else showBasicAvailability(test);
  let attemptId = test.active_attempt_id;
  try {
    if (canStart) {
      const started = await testingRequest("/attempts/start-or-resume", "POST", { kind });
      attemptId = started.attempt?.id;
      if (actionSerial !== basicActionSerial || currentRole !== "employee" || authenticatedUser?.id !== userId) return;
      if (!basicAttemptIdPattern.test(attemptId)) {
        throw new Error("Попытка могла начаться, но ответ сервера неполный. Обновите кабинет.");
      }
      if (kind === "full") showFullAvailability({ state: "in_progress", active_attempt_id: attemptId });
      else showBasicAvailability({ state: "in_progress", active_attempt_id: attemptId });
    }
    await openBasicQuestion(attemptId, actionSerial, userId);
  } catch (error) {
    if (actionSerial === basicActionSerial && currentRole === "employee" && authenticatedUser?.id === userId) {
      if (["attempt_expired", "attempt_finished"].includes(error?.apiCode) &&
          basicAttemptIdPattern.test(attemptId)) {
         void loadBasicResult(attemptId, kind);
        return;
      }
      showScreen("dashboard");
      showToast(error instanceof TypeError
        ? "Нет соединения с сервером. Обновите страницу и проверьте статус попытки."
        : error instanceof Error ? error.message : "Не удалось открыть тест. Обновите страницу.");
      const message = "Не удалось открыть тест. Обновите страницу, чтобы проверить статус попытки.";
      if (kind === "full") showFullAvailability(null, message); else showBasicAvailability(null, message);
    }
  } finally {
    if (actionSerial === basicActionSerial) {
      basicActionInFlight = false;
      if (kind === "full" && fullAvailability) showFullAvailability(fullAvailability);
      else if (kind === "basic" && basicAvailability) showBasicAvailability(basicAvailability);
    }
  }
}

async function refreshBasicAvailability() {
  const check = ++availabilityCheckSerial;
  const userId = authenticatedUser?.id;
  showBasicAvailability();
  showFullAvailability();
  try {
    const { data, error } = await authClient.auth.getSession();
    if (error || !data.session) throw new Error("Сеанс входа истёк. Войдите снова.");
    const response = await fetch(
      new URL("/functions/v1/testing/tests/availability", window.TESTING_SUPABASE_CONFIG.url),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${data.session.access_token}`,
          apikey: window.TESTING_SUPABASE_CONFIG.publishableKey
        },
        cache: "no-store"
      }
    );
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403
        ? "Доступ к проверке закрыт. Войдите снова или обратитесь к администратору."
        : "Не удалось проверить доступность теста. Обновите страницу и попробуйте снова.");
    }
    const payload = await response.json();
    const basic = Array.isArray(payload?.tests)
      ? payload.tests.find(test => test?.kind === "basic") : null;
    const full = Array.isArray(payload?.tests)
      ? payload.tests.find(test => test?.kind === "full") : null;
    if (!basic || !full) throw new Error("Не удалось получить статус тестов. Попробуйте позже.");
    if (check === availabilityCheckSerial && currentRole === "employee" && authenticatedUser?.id === userId) {
      showBasicAvailability(basic);
      showFullAvailability(full, null, payload.attestation);
    }
  } catch (error) {
    if (check === availabilityCheckSerial && currentRole === "employee" && authenticatedUser?.id === userId) {
      const knownMessages = [
        "Сеанс входа истёк. Войдите снова.",
        "Доступ к проверке закрыт. Войдите снова или обратитесь к администратору.",
        "Не удалось проверить доступность теста. Обновите страницу и попробуйте снова.",
        "Не удалось получить статус базового теста. Попробуйте позже."
      ];
      showBasicAvailability(null, knownMessages.includes(error?.message)
        ? error.message : "Не удалось проверить доступность теста. Обновите страницу и попробуйте снова.");
      showFullAvailability(null, "Не удалось проверить доступность аттестации. Обновите страницу.");
    }
  }
}

async function loadUserAccess(user) {
  const { data: profile, error: profileError } = await authClient.from("profiles")
    .select("user_id, email, first_name, last_name, access_status")
    .eq("user_id", user.id).maybeSingle();
  if (profileError) throw new Error("Не удалось проверить статус доступа. Попробуйте позже.");
  if (!profile || profile.user_id !== user.id || profile.access_status !== "active") {
    throw new Error("Доступ к кабинету не разрешён. Обратитесь к администратору.");
  }

  const { data: role, error: roleError } = await authClient.from("user_roles")
    .select("user_id, role").eq("user_id", user.id).maybeSingle();
  if (roleError || !role || role.user_id !== user.id || !["admin", "employee"].includes(role.role)) {
    throw new Error("Не удалось проверить роль пользователя. Попробуйте позже.");
  }
  return { profile, role: role.role };
}

function applyAuthenticatedUser(user, access = null) {
  ++availabilityCheckSerial;
  ++basicActionSerial;
  ++basicResultSerial;
  ++basicHistorySerial;
  basicActionInFlight = false;
  basicAvailability = null;
  fullAvailability = null;
  activeTestKind = "basic";
  basicResultAttemptId = null;
  basicHistoryCursor = null;
  resetBasicQuestion();
  document.getElementById("basic-question-photos").replaceChildren();
  document.getElementById("basic-result-review").replaceChildren();
  document.getElementById("basic-history-list").replaceChildren();
  authenticatedUser = user;
  currentProfile = access?.profile || null;
  currentRole = access?.role || null;
  window.resetAdminPanel?.();
  document.querySelectorAll("[data-auth-only]").forEach(button => { button.hidden = !user; });
  document.querySelectorAll("[data-demo-only]").forEach(element => {
    element.hidden = true;
  });
  document.querySelectorAll("[data-employee-only]").forEach(element => {
    element.hidden = currentRole !== "employee";
  });
  document.querySelector('.nav-button[data-go="admin"]').hidden = currentRole !== "admin";
  document.getElementById("logout-button").hidden = !user;
  document.querySelector('.nav-button[data-go="login"]').hidden = Boolean(user);
  if (currentRole !== "employee") {
    document.getElementById("basic-question-title").textContent = "";
    document.getElementById("basic-question-options").replaceChildren();
  }
  document.getElementById("data-status-label").textContent = currentRole === "admin"
    ? "Кабинет администратора" : "Доступность из Supabase";
  if (user) {
    document.getElementById("account-email").textContent = currentRole === "employee"
      ? "Доступность тестов проверяется на сервере."
      : `${user.email || "Администратор"} · управление сотрудниками.`;
    document.getElementById("result-panel").hidden = true;
    if (currentRole === "employee") {
      void refreshBasicAvailability();
      void loadBasicHistory();
    }
    if ((currentScreen === "quiz" && currentRole === "employee") ||
        currentScreen === "basic-attempt" || currentScreen === "basic-result") showScreen("dashboard");
    if (currentScreen === "login") showScreen(currentRole === "admin" ? "admin" : "dashboard");
    else if (currentScreen === "admin" && currentRole === "admin") window.loadAdminPanel?.();
  } else {
    document.getElementById("password").value = "";
    document.getElementById("result-panel").hidden = true;
    document.getElementById("employee-detail").hidden = true;
    showScreen("login");
  }
}

async function verifyCurrentSession() {
  const check = ++authCheckSerial;
  try {
    // getSession восстанавливает сохранённый сеанс; getUser подтверждает его на сервере.
    const { data: sessionData, error: sessionError } = await authClient.auth.getSession();
    if (sessionError) throw sessionError;
    if (!sessionData.session) {
      if (check === authCheckSerial) {
        applyAuthenticatedUser(null);
        setAuthMessage("Введите email и пароль приглашённого сотрудника.");
      }
      return;
    }
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData.user) throw userError || new Error("Нет подтверждённого пользователя");
    if (check === authCheckSerial) {
      const access = await loadUserAccess(userData.user);
      if (check !== authCheckSerial) return;
      applyAuthenticatedUser(userData.user, access);
      setAuthMessage("");
    }
  } catch (error) {
    if (check === authCheckSerial) {
      applyAuthenticatedUser(null);
      setAuthMessage(error.message || "Не удалось проверить доступ. Проверьте интернет и обновите страницу.", true);
    }
  }
}

async function initializeAuth() {
  applyAuthenticatedUser(null);
  try {
    authClient = await window.createTestingSupabaseClient();
    setLoginBusy(false);
  } catch (error) {
    setAuthMessage(error.message || "Авторизация пока недоступна.", true);
    return;
  }
  await verifyCurrentSession();
  authClient.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") {
      ++authCheckSerial;
      applyAuthenticatedUser(null);
      setAuthMessage("Вы вышли из аккаунта.");
    } else if (
      (event === "SIGNED_IN" && !loginInProgress) ||
      event === "TOKEN_REFRESHED" ||
      event === "USER_UPDATED"
    ) {
      // Запрос к Auth запускается после завершения обработчика события.
      setTimeout(() => { void verifyCurrentSession(); }, 0);
    }
  });
}

function showScreen(name) {
  if (!screens.includes(name)) return;
  if (name === "quiz" && currentRole === "employee") return;
  if ((name === "basic-attempt" || name === "basic-result") && currentRole !== "employee") return;
  if (name === "admin" && currentRole !== "admin") {
    showToast("Раздел доступен только администратору.");
    return;
  }
  if (name !== "login" && !authenticatedUser) {
    name = "login";
    setAuthMessage("Сначала войдите в аккаунт.", true);
  }
  if (name !== "basic-attempt") {
    clearInterval(basicCountdownInterval);
    basicCountdownInterval = null;
  }
  currentScreen = name;
  if (name === "basic-attempt") document.getElementById("basic-attempt-title").textContent = testName(activeTestKind);
  for (const screen of screens) {
    document.getElementById(`screen-${screen}`).hidden = screen !== name;
  }
  document.querySelectorAll(".nav-button").forEach(button => {
    const active = button.dataset.go === name;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (name !== "quiz") stopTimer();
  if (name === "admin") window.loadAdminPanel?.();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 4200);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

function updateTimer() {
  const seconds = Math.max(0, Math.ceil((demoDeadline - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  document.getElementById("question-timer").textContent = `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  if (seconds === 0) {
    stopTimer();
    showToast("Время демотеста истекло. Показан пример результата.");
    showResult("full");
  }
}

function startQuiz() {
  if (!authenticatedUser) {
    showScreen("login");
    return;
  }
  if (currentRole === "employee") return;
  questionIndex = 0;
  selectedOption = -1;
  demoDeadline = Date.now() + 75 * 60 * 1000;
  showScreen("quiz");
  renderQuestion();
  updateTimer();
  stopTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

function renderQuestion() {
  const question = questions[questionIndex];
  selectedOption = -1;
  document.getElementById("question-number").textContent = `Вопрос ${questionIndex + 1} из ${questions.length}`;
  document.getElementById("question-progress").style.width = `${(questionIndex + 1) / questions.length * 100}%`;
  document.getElementById("question-type").textContent = question.type;
  document.getElementById("question-title").textContent = question.title;
  document.getElementById("question-hint").textContent = question.hint;
  document.getElementById("question-status").textContent = "Выберите вариант ответа.";
  const next = document.getElementById("next-question");
  next.disabled = true;
  next.textContent = questionIndex === questions.length - 1 ? "Завершить демотест →" : "Продолжить →";

  const photoBox = document.getElementById("question-photos");
  photoBox.replaceChildren();
  photoBox.hidden = !question.photos;
  if (question.photos) {
    question.photos.forEach(photo => {
      const figure = document.createElement("figure");
      const image = document.createElement("img");
      const caption = document.createElement("figcaption");
      image.src = photo.src;
      image.alt = photo.caption + " — фотография из энциклопедии";
      caption.textContent = photo.caption;
      figure.append(image, caption);
      photoBox.append(figure);
    });
  }

  const options = document.getElementById("question-options");
  options.replaceChildren();
  question.options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option";
    button.setAttribute("aria-pressed", "false");
    const mark = document.createElement("span");
    mark.className = "option-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = String.fromCharCode(1040 + index);
    const label = document.createElement("span");
    label.textContent = option;
    button.append(mark, label);
    button.addEventListener("click", () => {
      selectedOption = index;
      options.querySelectorAll(".option").forEach((item, itemIndex) => {
        const active = itemIndex === index;
        item.classList.toggle("is-selected", active);
        item.setAttribute("aria-pressed", String(active));
      });
      next.disabled = false;
      document.getElementById("question-status").textContent = "Вариант выбран. Нажмите «Продолжить».";
    });
    options.append(button);
  });
}

function showResult(kind) {
  if (!authenticatedUser) {
    showScreen("login");
    return;
  }
  if (currentRole === "employee") return;
  stopTimer();
  showScreen("dashboard");
  const panel = document.getElementById("result-panel");
  const detail = document.getElementById("result-detail");
  detail.replaceChildren();
  panel.hidden = false;
  if (kind === "basic") {
    document.getElementById("result-title").textContent = "Результат базового теста";
    document.getElementById("result-score").textContent = "85%";
    document.getElementById("result-description").textContent = "Вымышленный пример разбора. Эти вопросы не использовались в демотесте.";
    const heading = document.createElement("h3");
    heading.textContent = "Пример вопросов с ошибками";
    const list = document.createElement("ol");
    list.className = "basic-errors";
    ["Вопрос: Какой материал подготовить к учебной встрече? Ответ сотрудника: фотоподборку. Правильный ответ в этом вымышленном примере: план встречи.",
      "Вопрос: Где найти учебный график? Ответ сотрудника: в архиве. Правильный ответ в этом вымышленном примере: в расписании."].forEach(text => {
        const item = document.createElement("li");
        item.textContent = text;
        list.append(item);
      });
    detail.append(heading, list);
  } else {
    document.getElementById("result-title").textContent = "Результат полной аттестации";
    document.getElementById("result-score").textContent = "86%";
    document.getElementById("result-description").textContent = "Вымышленный пример: хорошее знание, пересдача через 7 суток. Выборы в демотесте на балл не влияют.";
    const grid = document.createElement("div");
    grid.className = "result-grid";
    topics.forEach(([topic, score]) => {
      const row = document.createElement("div");
      row.className = "result-topic";
      const label = document.createElement("span");
      label.textContent = `Тема «${topic}»`;
      const value = document.createElement("strong");
      value.textContent = score;
      row.append(label, value);
      grid.append(row);
    });
    const recommendation = document.createElement("p");
    recommendation.className = "recommendation";
    recommendation.append("Рекомендуем повторить темы: ");
    const colorLink = document.createElement("a");
    colorLink.href = `${ENCYCLOPEDIA_URL}#chapter-4`;
    colorLink.textContent = "Цвет";
    const shoeLink = document.createElement("a");
    shoeLink.href = `${ENCYCLOPEDIA_URL}#chapter-6`;
    shoeLink.textContent = "Фото обуви";
    recommendation.append(colorLink, " и ", shoeLink, ".");
    detail.append(grid, recommendation);
  }
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.querySelectorAll("[data-go]").forEach(button => {
  button.addEventListener("click", () => {
    if (button.dataset.go === "quiz") startQuiz();
    else showScreen(button.dataset.go);
  });
});
document.getElementById("basic-availability-action").addEventListener("click", () => {
  void handleBasicAction("basic");
});
document.getElementById("full-availability-action").addEventListener("click", () => {
  void handleBasicAction("full");
});
document.getElementById("basic-submit-answer").addEventListener("click", () => {
  void submitBasicAnswer();
});
document.getElementById("basic-result-retry").addEventListener("click", () => {
  if (basicResultAttemptId) void loadBasicResult(basicResultAttemptId, resultKind);
});
document.getElementById("basic-result-back").addEventListener("click", () => {
  showScreen("dashboard");
  void refreshBasicAvailability();
  void loadBasicHistory();
});
document.getElementById("basic-history-retry").addEventListener("click", () => {
  void loadBasicHistory();
});
document.getElementById("basic-history-more").addEventListener("click", () => {
  if (basicHistoryCursor) void loadBasicHistory(basicHistoryCursor);
});
document.getElementById("basic-back-dashboard").addEventListener("click", () => {
  showScreen("dashboard");
  void refreshBasicAvailability();
});
document.getElementById("login-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!authClient) {
    setAuthMessage("Supabase ещё не настроен. Укажите публичные параметры в testing/config.js.", true);
    return;
  }
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  loginInProgress = true;
  setLoginBusy(true);
  setAuthMessage("Проверяем email и пароль…");
  void (async () => {
    try {
      const { error } = await authClient.auth.signInWithPassword({ email, password });
      if (error) {
        setAuthMessage("Неверный email или пароль либо доступ к аккаунту не разрешён.", true);
        return;
      }
      const { data, error: userError } = await authClient.auth.getUser();
      if (userError || !data.user) {
        setAuthMessage("Не удалось подтвердить вход. Попробуйте ещё раз.", true);
        return;
      }
      const access = await loadUserAccess(data.user);
      ++authCheckSerial;
      applyAuthenticatedUser(data.user, access);
      setAuthMessage("");
    } catch (error) {
      applyAuthenticatedUser(null);
      setAuthMessage(error.message || "Не удалось связаться с Supabase. Проверьте интернет и попробуйте ещё раз.", true);
    } finally {
      loginInProgress = false;
      setLoginBusy(false);
    }
  })();
});
document.getElementById("forgot-password").addEventListener("click", event => {
  event.preventDefault();
  document.getElementById("reset-email").value = document.getElementById("email").value.trim();
  document.getElementById("login-form").hidden = true;
  document.getElementById("forgot-password").hidden = true;
  document.getElementById("reset-request-form").hidden = false;
  setAuthMessage("Укажите email учётной записи. Если она существует, мы отправим письмо восстановления.");
  document.getElementById("reset-email").focus();
});
document.getElementById("back-to-login").addEventListener("click", () => {
  document.getElementById("reset-request-form").hidden = true;
  document.getElementById("login-form").hidden = false;
  document.getElementById("forgot-password").hidden = false;
  setAuthMessage("Введите email и пароль.");
});
document.getElementById("reset-request-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!authClient) {
    setAuthMessage("Сервис авторизации пока недоступен. Попробуйте позже.", true);
    return;
  }
  const button = document.getElementById("send-reset");
  button.disabled = true;
  setAuthMessage("Отправляем запрос…");
  try {
    const email = document.getElementById("reset-email").value.trim();
    const redirectTo = new URL("reset-password.html", window.location.href).href;
    const { error } = await authClient.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
    setAuthMessage("Если учётная запись существует, письмо с инструкцией отправлено. Проверьте почту.");
  } catch {
    setAuthMessage("Не удалось отправить запрос. Проверьте подключение и попробуйте позже.", true);
  } finally {
    button.disabled = false;
  }
});
document.getElementById("logout-button").addEventListener("click", async () => {
  if (!authClient || !authenticatedUser) return;
  const button = document.getElementById("logout-button");
  button.disabled = true;
  try {
    const { error } = await authClient.auth.signOut({ scope: "local" });
    if (error) throw error;
    ++authCheckSerial;
    applyAuthenticatedUser(null);
    setAuthMessage("Вы вышли из аккаунта.");
  } catch {
    showToast("Не удалось завершить сеанс. Проверьте соединение и попробуйте снова.");
  } finally {
    button.disabled = false;
  }
});
document.querySelectorAll("[data-start]").forEach(button => button.addEventListener("click", startQuiz));
document.querySelectorAll("[data-result]").forEach(button => button.addEventListener("click", () => showResult(button.dataset.result)));
document.getElementById("next-question").addEventListener("click", () => {
  if (selectedOption < 0) return;
  if (questionIndex < questions.length - 1) {
    questionIndex += 1;
    renderQuestion();
  } else {
    showResult("full");
  }
});
document.getElementById("close-result").addEventListener("click", () => {
  document.getElementById("result-panel").hidden = true;
});
void initializeAuth();
