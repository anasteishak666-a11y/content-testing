"use strict";

// All employee data comes from the testing Edge Function. Private tables and
// answer keys are never queried by this page.
const adminUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let adminLoadSerial = 0;
let adminDetailSerial = 0;
let selectedAdminEmployee = null;
let adminHistoryCursor = null;
let adminRetakeRequest = null;
let adminRetakeInFlight = false;
let adminInviteInFlight = false;
let adminNameInFlight = false;
let adminVerified = false;
let adminReturnFocus = null;

function adminText(id, value) {
  document.getElementById(id).textContent = value;
}

function adminDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) :
    new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" }).format(date);
}

function adminScore(value) {
  return Number.isFinite(Number(value)) ? `${value}%` : "—";
}

function adminOutcome(value) {
  return ({ basic_passed: "Базовый тест пройден", basic_failed: "Базовый тест не пройден",
    attestation_passed: "Аттестация пройдена", attestation_failed: "Аттестация не пройдена",
    attestation_not_confirmed: "Аттестация не подтверждена" })[value] || "Результат не определён";
}

function adminTestStatus(test) {
  if (!test || typeof test !== "object") return "Нет данных";
  const labels = {
    available: "Доступен", in_progress: "Идёт попытка", cooldown: "Ожидает пересдачи",
    prerequisite_required: "Нужен базовый тест", passed: "Пройден",
    valid_until_due: "Действует", bank_unavailable: "Банк недоступен",
    disabled: "Доступ отключён"
  };
  const label = labels[test.state] || "Статус не определён";
  return test.latest_percentage == null ? label : `${label} · ${adminScore(test.latest_percentage)}`;
}

function adminEmployeeName(employee) {
  return [employee.first_name, employee.last_name].filter(Boolean).join(" ") ||
    employee.email || "Имя не указано";
}

function renderAdminEmployees(employees) {
  const body = document.getElementById("employees-body");
  body.replaceChildren();
  for (const employee of employees) {
    if (!adminUuid.test(employee.employee_id || "")) throw new Error("Сервер вернул некорректный ID сотрудника.");
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "text-button admin-employee-open";
    open.textContent = adminEmployeeName(employee);
    open.setAttribute("aria-label", `Открыть карточку: ${adminEmployeeName(employee)}`);
    open.addEventListener("click", () => { void openAdminEmployee(employee, open); });
    nameCell.append(open);
    row.append(nameCell);
    for (const value of [employee.email || "—", adminTestStatus(employee.basic),
      adminTestStatus(employee.full), employee.full?.valid_until_moscow || "—"]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
}

window.resetAdminPanel = function resetAdminPanel() {
  ++adminLoadSerial;
  ++adminDetailSerial;
  selectedAdminEmployee = null;
  adminHistoryCursor = null;
  adminRetakeRequest = null;
  adminRetakeInFlight = false;
  adminInviteInFlight = false;
  adminNameInFlight = false;
  adminVerified = false;
  adminReturnFocus = null;
  document.getElementById("admin-invite-form").hidden = true;
  document.getElementById("employees-body").replaceChildren();
  document.getElementById("employee-detail").hidden = true;
  document.getElementById("detail-history-more").hidden = true;
  document.getElementById("detail-history-retry").hidden = true;
  document.getElementById("detail-history-heading").hidden = true;
  adminText("admin-invite-status", "");
  adminText("admin-name-status", "");
  adminText("admin-status", "Проверяем права администратора…");
};

window.loadAdminPanel = async function loadAdminPanel() {
  if (currentRole !== "admin" || !authenticatedUser) return;
  const serial = ++adminLoadSerial;
  const userId = authenticatedUser.id;
  ++adminDetailSerial;
  selectedAdminEmployee = null;
  adminVerified = false;
  adminReturnFocus = null;
  document.getElementById("admin-invite-form").hidden = true;
  document.getElementById("employee-detail").hidden = true;
  adminText("admin-status", "Загружаем сотрудников…");
  document.getElementById("employees-body").replaceChildren();
  try {
    const employees = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const path = `/admin/employees?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const payload = await testingRequest(path);
      if (serial !== adminLoadSerial || authenticatedUser?.id !== userId) return;
      if (!Array.isArray(payload.employees)) throw new Error("Сервер вернул неполный список сотрудников.");
      employees.push(...payload.employees);
      cursor = payload.next_cursor;
      if (cursor !== null && (!adminUuid.test(cursor) || seenCursors.has(cursor))) {
        throw new Error("Сервер вернул некорректную страницу списка.");
      }
      if (cursor) seenCursors.add(cursor);
      if (cursor) adminText("admin-status", `Загружено сотрудников: ${employees.length}…`);
    } while (cursor);
    renderAdminEmployees(employees);
    adminVerified = true;
    document.getElementById("admin-invite-form").hidden = false;
    adminText("admin-status", employees.length
      ? `Загружено сотрудников: ${employees.length}.` : "Сотрудников пока нет.");
  } catch (error) {
    if (serial !== adminLoadSerial || authenticatedUser?.id !== userId) return;
    adminText("admin-status", error.httpStatus === 401 || error.httpStatus === 403
      ? "Сервер не подтвердил права администратора. Данные сотрудников недоступны."
      : `Не удалось загрузить сотрудников: ${error.message}`);
  }
};

function addAdminHistoryItems(items) {
  const history = document.getElementById("detail-history");
  for (const item of items) {
    const line = document.createElement("div");
    line.className = "admin-history-item";
    const kind = item.kind === "full" ? "Итоговая аттестация" : "Базовый тест";
    const outcome = `${adminOutcome(item.outcome)}${item.state === "timed_out" ? " · время истекло" : ""}`;
    for (const value of [adminDate(item.finished_at), kind,
      adminScore(item.percentage), outcome]) {
      const cell = document.createElement("span");
      cell.textContent = value;
      line.append(cell);
    }
    history.append(line);
  }
}

async function loadAdminHistory(cursor = null) {
  const employee = selectedAdminEmployee;
  if (!employee || currentRole !== "admin" || !adminVerified) return;
  const serial = ++adminDetailSerial;
  const more = document.getElementById("detail-history-more");
  const retry = document.getElementById("detail-history-retry");
  more.disabled = true;
  retry.hidden = true;
  if (!cursor) {
    document.getElementById("detail-history").replaceChildren();
    document.getElementById("detail-history-heading").hidden = true;
    more.hidden = true;
    adminHistoryCursor = null;
  }
  adminText("detail-history-status", cursor ? "Загружаем ещё попытки…" : "Загружаем историю…");
  try {
    const path = `/admin/employees/${encodeURIComponent(employee.employee_id)}/attempts/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const payload = await testingRequest(path);
    if (serial !== adminDetailSerial || selectedAdminEmployee?.employee_id !== employee.employee_id) return;
    if (!Array.isArray(payload.items)) throw new Error("Сервер вернул неполную историю.");
    addAdminHistoryItems(payload.items);
    document.getElementById("detail-history-heading").hidden =
      document.getElementById("detail-history").childElementCount === 0;
    adminHistoryCursor = payload.next_cursor || null;
    more.hidden = !adminHistoryCursor;
    adminText("detail-history-status", document.getElementById("detail-history").childElementCount
      ? "Показаны завершённые попытки. Правильные ответы недоступны."
      : "Завершённых попыток пока нет.");
  } catch (error) {
    if (serial === adminDetailSerial) {
      adminText("detail-history-status", `Не удалось загрузить историю: ${error.message}`);
      if (cursor) more.hidden = false;
      else retry.hidden = false;
    }
  } finally {
    if (serial === adminDetailSerial) more.disabled = false;
  }
}

async function openAdminEmployee(employee, trigger = null) {
  if (currentRole !== "admin" || !adminVerified || !adminUuid.test(employee?.employee_id || "")) return;
  ++adminDetailSerial;
  adminReturnFocus = trigger;
  selectedAdminEmployee = employee;
  adminHistoryCursor = null;
  adminRetakeRequest = null;
  const card = document.getElementById("employee-detail");
  card.hidden = false;
  adminText("detail-name", adminEmployeeName(employee));
  adminText("detail-email", employee.email || `ID: ${employee.employee_id}`);
  const stats = document.getElementById("detail-results");
  stats.replaceChildren();
  const line = document.createElement("p");
  line.className = "muted";
  line.textContent = `Базовый тест: ${adminTestStatus(employee.basic)}. Итоговая аттестация: ${adminTestStatus(employee.full)}. Действует до: ${employee.full?.valid_until_moscow || "не установлено"}.`;
  stats.append(line);
  document.getElementById("detail-history").replaceChildren();
  document.getElementById("detail-history-heading").hidden = true;
  document.getElementById("detail-history-more").hidden = true;
  document.getElementById("detail-history-retry").hidden = true;
  document.getElementById("admin-retake-form").reset();
  const nameForm = document.getElementById("admin-name-form");
  nameForm.elements.firstName.value = employee.first_name || "";
  nameForm.elements.lastName.value = employee.last_name || "";
  adminText("admin-name-status", employee.first_name && employee.last_name
    ? "При необходимости исправьте имя или фамилию." : "Укажите имя и фамилию сотрудника.");
  adminText("detail-history-title", `История попыток: ${adminEmployeeName(employee)}`);
  adminText("admin-retake-status", "Разрешение создаётся сервером только при наличии основания для досрочной пересдачи.");
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  card.focus({ preventScroll: true });
  await loadAdminHistory();
}

document.getElementById("admin-refresh").addEventListener("click", () => { void window.loadAdminPanel(); });
document.getElementById("detail-history-retry").addEventListener("click", () => {
  void loadAdminHistory();
});
document.getElementById("detail-history-more").addEventListener("click", () => {
  if (adminHistoryCursor) void loadAdminHistory(adminHistoryCursor);
});
document.getElementById("detail-close").addEventListener("click", () => {
  ++adminDetailSerial;
  selectedAdminEmployee = null;
  document.getElementById("employee-detail").hidden = true;
  document.getElementById("admin-title").scrollIntoView({ behavior: "smooth", block: "start" });
  if (adminReturnFocus?.isConnected) adminReturnFocus.focus({ preventScroll: true });
  else document.getElementById("admin-refresh").focus({ preventScroll: true });
});
document.getElementById("admin-invite-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (currentRole !== "admin" || !adminVerified || adminInviteInFlight) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const firstName = form.elements.firstName.value.trim();
  const lastName = form.elements.lastName.value.trim();
  const email = form.elements.email.value.trim();
  if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100 || !email) {
    adminText("admin-invite-status", "Укажите имя, фамилию и email.");
    return;
  }
  adminInviteInFlight = true;
  button.disabled = true;
  adminText("admin-invite-status", "Отправляем приглашение…");
  try {
    const redirectTo = new URL("accept-invite.html", window.location.href).href;
    const result = await testingRequest("/admin/employees/invite", "POST", {
      email, first_name: firstName, last_name: lastName, redirect_to: redirectTo
    });
    if (result.state !== "invited") throw new Error("Сервер не подтвердил отправку приглашения.");
    form.reset();
    adminText("admin-invite-status", `Приглашение отправлено на ${email}. Сотрудник появится в списке после подтверждения адреса.`);
  } catch (error) {
    adminText("admin-invite-status", `Не удалось отправить приглашение: ${error.message}`);
  } finally {
    adminInviteInFlight = false;
    button.disabled = false;
  }
});
document.getElementById("admin-name-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (currentRole !== "admin" || !adminVerified || !selectedAdminEmployee || adminNameInFlight) return;
  const employee = selectedAdminEmployee;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const firstName = form.elements.firstName.value.trim();
  const lastName = form.elements.lastName.value.trim();
  if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100) {
    adminText("admin-name-status", "Укажите имя и фамилию длиной до 100 символов.");
    return;
  }
  adminNameInFlight = true;
  button.disabled = true;
  adminText("admin-name-status", "Сохраняем ФИО…");
  try {
    const result = await testingRequest(`/admin/employees/${encodeURIComponent(employee.employee_id)}/name`, "POST", {
      first_name: firstName, last_name: lastName
    });
    if (result.employee_id !== employee.employee_id) throw new Error("Сервер вернул другого сотрудника.");
    employee.first_name = result.first_name;
    employee.last_name = result.last_name;
    if (selectedAdminEmployee?.employee_id !== employee.employee_id) return;
    const name = adminEmployeeName(employee);
    adminText("detail-name", name);
    adminText("detail-history-title", `История попыток: ${name}`);
    if (adminReturnFocus?.isConnected) {
      adminReturnFocus.textContent = name;
      adminReturnFocus.setAttribute("aria-label", `Открыть карточку: ${name}`);
    }
    adminText("admin-name-status", "Имя и фамилия сохранены.");
  } catch (error) {
    if (selectedAdminEmployee?.employee_id === employee.employee_id) {
      adminText("admin-name-status", `Не удалось сохранить ФИО: ${error.message}`);
    }
  } finally {
    adminNameInFlight = false;
    button.disabled = false;
  }
});
document.getElementById("admin-retake-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (currentRole !== "admin" || !adminVerified || !selectedAdminEmployee || adminRetakeInFlight) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const employeeId = selectedAdminEmployee.employee_id;
  const kind = form.elements.kind.value;
  const note = form.elements.note.value.trim();
  if (!note || note.length > 500) {
    adminText("admin-retake-status", "Укажите краткую причину (до 500 символов).");
    return;
  }
  const employeeName = adminEmployeeName(selectedAdminEmployee);
  const kindName = kind === "full" ? "итоговой аттестации" : "базового теста";
  if (!window.confirm(`Разрешить ${employeeName} одну досрочную попытку ${kindName}?\n\nПричина: ${note}`)) return;
  const sameRequest = adminRetakeRequest?.employee_id === employeeId &&
    adminRetakeRequest.kind === kind && adminRetakeRequest.note === note;
  if (!sameRequest) adminRetakeRequest = { request_id: crypto.randomUUID(), employee_id: employeeId, kind, note };
  adminRetakeInFlight = true;
  button.disabled = true;
  adminText("admin-retake-status", "Проверяем основание и сохраняем разрешение…");
  try {
    const result = await testingRequest("/admin/retake-overrides", "POST", adminRetakeRequest);
    if (selectedAdminEmployee?.employee_id !== employeeId) return;
    adminText("admin-retake-status", `Разрешение на одну попытку создано ${adminDate(result.granted_at)}.`);
    adminRetakeRequest = null;
    form.elements.note.value = "";
  } catch (error) {
    if (selectedAdminEmployee?.employee_id !== employeeId) return;
    const messages = {
      override_not_needed: "Досрочная пересдача сейчас не требуется.",
      override_already_open: "Неиспользованное разрешение уже существует.",
      employee_not_found: "Сотрудник не найден.",
      admin_required: "Сервер не подтвердил права администратора."
    };
    adminText("admin-retake-status", messages[error.apiCode] || `Не удалось выдать разрешение: ${error.message}`);
  } finally {
    adminRetakeInFlight = false;
    button.disabled = false;
  }
});
