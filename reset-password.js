"use strict";

const resetMessage = document.getElementById("reset-message");
const resetForm = document.getElementById("reset-password-form");
const returnToLogin = document.getElementById("return-to-login");
const resetMarkerKey = "testing-confirmed-password-recovery";
const authTimeoutMs = 10000;
let resetClient = null;
let recoveryUserId = null;

function withAuthTimeout(operation) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("auth_timeout")), authTimeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function showResetMessage(message, isError = false) {
  resetMessage.textContent = message;
  resetMessage.classList.toggle("auth-message--error", isError);
}

function clearRecoveryUrl() {
  if (location.search || location.hash) history.replaceState(null, "", location.pathname);
}

function clearRecoveryMarker() {
  sessionStorage.removeItem(resetMarkerKey);
}

function readRecoveryMarker() {
  try {
    const marker = JSON.parse(sessionStorage.getItem(resetMarkerKey) || "null");
    if (typeof marker?.userId === "string" && marker.expiresAt > Date.now()) return marker.userId;
  } catch {
    // Повреждённый маркер не открывает форму смены пароля.
  }
  clearRecoveryMarker();
  return null;
}

function showLinkError(expired = false) {
  clearRecoveryMarker();
  recoveryUserId = null;
  resetForm.hidden = true;
  returnToLogin.hidden = false;
  showResetMessage(expired
    ? "Срок действия ссылки восстановления истёк. Запросите новое письмо на странице входа."
    : "Ссылка восстановления недействительна или уже использована. Запросите новое письмо на странице входа.", true);
}

async function confirmRecovery() {
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const errorCode = query.get("error_code") || fragment.get("error_code");
  const hasLinkError = query.has("error") || fragment.has("error") || Boolean(errorCode);
  const linkType = query.get("type") || fragment.get("type");
  const tokenHash = query.get("token_hash");
  const code = query.get("code");
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  const hasImplicitTokens = Boolean(accessToken && refreshToken);
  const hasLink = Boolean(tokenHash || code || hasImplicitTokens);
  const markedUserId = hasLink ? null : readRecoveryMarker();
  const unexpectedParameters = !hasLink && (Boolean(location.search) || Boolean(location.hash));
  clearRecoveryUrl();

  if (hasLinkError) {
    clearRecoveryMarker();
    showLinkError(errorCode === "otp_expired" || errorCode === "token_expired");
    return;
  }
  if ((tokenHash || hasImplicitTokens) && linkType !== "recovery") {
    showLinkError();
    return;
  }
  if (linkType && linkType !== "recovery") {
    showLinkError();
    return;
  }
  if (unexpectedParameters || (!hasLink && !markedUserId)) {
    showLinkError();
    return;
  }

  try {
    resetClient = await withAuthTimeout(window.createTestingSupabaseClient({ detectSessionInUrl: false }));
    let sessionUserId = markedUserId;
    if (hasLink) {
      let result;
      if (tokenHash) {
        result = await withAuthTimeout(resetClient.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" }));
      } else if (hasImplicitTokens) {
        result = await withAuthTimeout(resetClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }));
      } else {
        result = await withAuthTimeout(resetClient.auth.exchangeCodeForSession(code));
      }
      if (result.error || !result.data?.session?.user?.id) {
        showLinkError(result.error?.code === "otp_expired" || result.error?.code === "token_expired");
        return;
      }
      sessionUserId = result.data.session.user.id;
    }
    const { data, error } = await withAuthTimeout(resetClient.auth.getUser());
    if (error || !data?.user || data.user.id !== sessionUserId) {
      clearRecoveryMarker();
      showLinkError();
      return;
    }
    recoveryUserId = data.user.id;
    sessionStorage.setItem(resetMarkerKey, JSON.stringify({
      userId: recoveryUserId,
      expiresAt: Date.now() + 10 * 60 * 1000
    }));
    resetForm.hidden = false;
    showResetMessage("Ссылка подтверждена. Придумайте пароль длиной не менее 12 символов.");
    document.getElementById("new-password").focus();
  } catch (error) {
    showResetMessage(error.message === "auth_timeout"
      ? "Превышено время ожидания Supabase. Проверьте подключение и обновите страницу."
      : "Не удалось проверить ссылку. Проверьте подключение и повторите попытку.", true);
  }
}

resetForm.addEventListener("submit", async event => {
  event.preventDefault();
  const password = document.getElementById("new-password").value;
  const repeatPassword = document.getElementById("repeat-password").value;
  if (password.length < 12) {
    showResetMessage("Пароль должен содержать не менее 12 символов.", true);
    return;
  }
  if (password !== repeatPassword) {
    showResetMessage("Пароли не совпадают. Повторите ввод.", true);
    return;
  }
  const button = document.getElementById("save-password");
  button.disabled = true;
  showResetMessage("Сохраняем пароль…");
  try {
    const markerUserId = readRecoveryMarker();
    const { data, error } = await withAuthTimeout(resetClient.auth.getUser());
    if (error || !data?.user || data.user.id !== recoveryUserId || markerUserId !== recoveryUserId) {
      clearRecoveryMarker();
      showLinkError();
      return;
    }
    const { error: updateError } = await withAuthTimeout(resetClient.auth.updateUser({ password }));
    if (updateError) {
      showResetMessage("Не удалось сохранить пароль. Проверьте его и повторите попытку.", true);
      return;
    }
    resetForm.reset();
    resetForm.hidden = true;
    clearRecoveryMarker();
    showResetMessage("Пароль сохранён. Переходим на страницу входа…");
    const { error: signOutError } = await withAuthTimeout(resetClient.auth.signOut({ scope: "local" }));
    if (signOutError) throw signOutError;
    location.assign("index.html");
  } catch {
    showResetMessage("Не удалось завершить восстановление. Если пароль уже сохранён, вернитесь ко входу; иначе повторите попытку.", true);
    returnToLogin.hidden = false;
  } finally {
    button.disabled = false;
  }
});

void confirmRecovery();
