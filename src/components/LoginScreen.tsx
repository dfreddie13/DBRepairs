import { FormEvent, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import LanguageDropdown from "./LanguageDropdown";
import ThemeSelect from "./ThemeSelect";
import { isValidUsername, MIN_PASSWORD_LENGTH } from "../data/auth";
import { useI18n } from "../i18n/I18nProvider";

export default function LoginScreen() {
  const { t, locale, setLocale, locales } = useI18n();
  const { setupRequired, login, setup } = useAuth();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isSetup = setupRequired;

  function message(cause: unknown): string {
    const code = cause instanceof Error ? cause.message : "";
    if (code === "invalid-credentials") return t("auth.loginError");
    if (code === "invalid-username") return t("auth.usernameInvalid");
    if (code === "weak-password") return t("auth.passwordTooShort");
    if (code === "setup-complete") return t("auth.setupComplete");
    return t(isSetup ? "auth.setupError" : "auth.loginError");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");

    if (!username.trim() || !password) {
      setError(t("auth.requiredFields"));
      return;
    }
    if (isSetup) {
      if (!displayName.trim()) {
        setError(t("auth.requiredFields"));
        return;
      }
      if (!isValidUsername(username)) {
        setError(t("auth.usernameInvalid"));
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(t("auth.passwordTooShort"));
        return;
      }
      if (password !== confirm) {
        setError(t("auth.passwordMismatch"));
        return;
      }
    }

    setBusy(true);
    try {
      if (isSetup) {
        await setup({ username: username.trim(), displayName: displayName.trim(), password });
      } else {
        await login(username.trim(), password);
      }
    } catch (cause) {
      console.error(cause);
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-topbar">
        <div className="auth-brand">
          <img src="/dbrepairs-icon-v2.png" alt="" />
          <strong>DBRepairs</strong>
        </div>
        <div className="auth-preferences">
          <ThemeSelect compact />
          <LanguageDropdown
            locale={locale}
            setLocale={setLocale}
            locales={locales}
            label={t("settings.language")}
            searchLabel={t("settings.searchLanguage")}
          />
        </div>
      </div>

      <section className="auth-card">
        <h1>{t(isSetup ? "auth.setupTitle" : "auth.loginTitle")}</h1>
        <p>{t(isSetup ? "auth.setupSubtitle" : "auth.loginSubtitle")}</p>

        {error && <div className="alert error auth-alert">{error}</div>}

        <form onSubmit={submit} className="auth-form">
          {isSetup && (
            <label className="field">
              <span>{t("auth.displayName")}</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                autoFocus
              />
            </label>
          )}

          <label className="field">
            <span>{t("auth.username")}</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus={!isSetup}
            />
          </label>

          <label className="field">
            <span>{t("auth.password")}</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isSetup ? "new-password" : "current-password"}
            />
          </label>

          {isSetup && (
            <label className="field">
              <span>{t("auth.confirmPassword")}</span>
              <input
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
              />
            </label>
          )}

          <button className="primary auth-submit" type="submit" disabled={busy}>
            {busy
              ? t(isSetup ? "auth.setupRunning" : "auth.loggingIn")
              : t(isSetup ? "auth.setupSubmit" : "auth.login")}
          </button>
        </form>

        {isSetup && <p className="auth-hint">{t("auth.setupHint")}</p>}
      </section>
    </div>
  );
}
