import { FormEvent, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { changePassword, MIN_PASSWORD_LENGTH } from "../data/auth";
import { useI18n } from "../i18n/I18nProvider";

export default function AccountMenu() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  if (!user) return null;

  function openDialog() {
    setOpen(true);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
    setDone(false);
  }

  function closeDialog() {
    if (busy) return;
    setOpen(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || done) return;
    setError("");
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(t("auth.passwordTooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("auth.passwordMismatch"));
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setDone(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (cause) {
      console.error(cause);
      const code = cause instanceof Error ? cause.message : "";
      setError(code === "wrong-password" ? t("auth.currentPasswordWrong") : t("auth.passwordChangeError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="account-card">
        <div className="account-identity">
          <strong>{user.displayName}</strong>
          <span>{t(`auth.role.${user.role}`)}</span>
        </div>
        <div className="account-actions">
          <button type="button" className="secondary small" onClick={openDialog}>
            {t("auth.changePassword")}
          </button>
          <button type="button" className="secondary small" onClick={() => void logout()}>
            {t("auth.logout")}
          </button>
        </div>
      </div>

      {open && (
        <div className="modal-backdrop">
          <section className="modal auth-modal">
            <div className="modal-head">
              <div>
                <h2>{t("auth.changePassword")}</h2>
                <p>{t("auth.changePasswordHint")}</p>
              </div>
              <button type="button" className="icon-button" onClick={closeDialog}>
                ×
              </button>
            </div>
            <form onSubmit={submit}>
              {error && <div className="alert error auth-alert">{error}</div>}
              {done && <div className="alert success auth-alert">{t("auth.passwordChanged")}</div>}
              <div className="form-grid">
                <label className="field full">
                  <span>{t("auth.currentPassword")}</span>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    autoComplete="current-password"
                    autoFocus
                  />
                </label>
                <label className="field full">
                  <span>{t("auth.newPassword")}</span>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                  />
                </label>
                <label className="field full">
                  <span>{t("auth.confirmPassword")}</span>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={closeDialog}>
                  {done ? t("common.close") : t("common.cancel")}
                </button>
                {!done && (
                  <button className="primary" type="submit" disabled={busy}>
                    {busy ? t("common.saving") : t("common.save")}
                  </button>
                )}
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
