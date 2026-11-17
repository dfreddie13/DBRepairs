import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import {
  createUser,
  deleteUser,
  isValidUsername,
  listUsers,
  MIN_PASSWORD_LENGTH,
  updateUser,
  UserRecord,
  UserRole,
} from "../data/auth";
import { useI18n } from "../i18n/I18nProvider";

type UserForm = {
  id?: number;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  password: string;
};

function emptyForm(): UserForm {
  return { username: "", displayName: "", role: "technician", active: true, password: "" };
}

export default function UsersPanel() {
  const { t } = useI18n();
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<UserForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      setUsers(await listUsers());
    } catch (cause) {
      console.error(cause);
      setError(t("settings.userError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openNew() {
    setError("");
    setFormError("");
    setNotice("");
    setForm(emptyForm());
  }

  function openEdit(user: UserRecord) {
    setError("");
    setFormError("");
    setNotice("");
    setForm({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      active: user.active,
      password: "",
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form || saving) return;
    setFormError("");

    if (!form.displayName.trim()) {
      setFormError(t("auth.requiredFields"));
      return;
    }
    if (!form.id && !isValidUsername(form.username)) {
      setFormError(t("auth.usernameInvalid"));
      return;
    }
    if (!form.id && form.password.length < MIN_PASSWORD_LENGTH) {
      setFormError(t("auth.passwordTooShort"));
      return;
    }
    if (form.id && form.password && form.password.length < MIN_PASSWORD_LENGTH) {
      setFormError(t("auth.passwordTooShort"));
      return;
    }

    setSaving(true);
    try {
      if (form.id) {
        await updateUser(form.id, {
          displayName: form.displayName.trim(),
          role: form.role,
          active: form.active,
          ...(form.password ? { password: form.password } : {}),
        });
        setNotice(t("settings.userUpdated"));
      } else {
        await createUser({
          username: form.username.trim(),
          displayName: form.displayName.trim(),
          role: form.role,
          password: form.password,
        });
        setNotice(t("settings.userCreated"));
      }
      setForm(null);
      await load();
    } catch (cause) {
      console.error(cause);
      const code = cause instanceof Error ? cause.message : "";
      if (
        code === "cannot-change-self" ||
        code === "cannot-delete-self" ||
        code === "You cannot deactivate or demote your own account"
      ) {
        setFormError(t("settings.cannotChangeSelf"));
      } else if (code === "last-admin" || code === "At least one active administrator is required") {
        setFormError(t("settings.lastAdmin"));
      } else if (code === "invalid-username") {
        setFormError(t("auth.usernameInvalid"));
      } else if (code === "weak-password") {
        setFormError(t("auth.passwordTooShort"));
      } else {
        setFormError(t("settings.userError"));
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(user: UserRecord) {
    if (deletingId === user.id) return;
    if (!window.confirm(t("settings.deleteUserConfirm").replace("{name}", user.displayName))) return;
    setError("");
    setNotice("");
    setDeletingId(user.id);
    try {
      await deleteUser(user.id);
      setNotice(t("settings.userDeleted"));
      await load();
    } catch (cause) {
      console.error(cause);
      const code = cause instanceof Error ? cause.message : "";
      if (code === "cannot-delete-self") setError(t("settings.cannotDeleteSelf"));
      else if (code === "last-admin" || code === "At least one active administrator is required") setError(t("settings.lastAdmin"));
      else setError(t("settings.userError"));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="panel settings-panel">
      <div className="panel-head">
        <div>
          <h2>{t("settings.users")}</h2>
          <p>{t("settings.usersHint")}</p>
        </div>
        <button type="button" className="primary" onClick={openNew}>
          + {t("settings.addUser")}
        </button>
      </div>

      {error && <div className="alert error settings-alert">{error}</div>}
      {notice && <div className="alert success settings-alert">{notice}</div>}

      {loading ? (
        <div className="empty-state compact">{t("common.loading")}</div>
      ) : users.length === 0 ? (
        <div className="empty-state compact">{t("settings.usersEmpty")}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("settings.username")}</th>
                <th>{t("settings.displayName")}</th>
                <th>{t("settings.role")}</th>
                <th>{t("settings.status")}</th>
                <th className="actions-column">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.username}</strong>
                    {currentUser?.id === user.id && <span className="muted"> · {t("settings.you")}</span>}
                  </td>
                  <td>{user.displayName}</td>
                  <td>
                    <span className="status-pill">{t(`auth.role.${user.role}`)}</span>
                  </td>
                  <td>{user.active ? t("settings.active") : t("settings.inactive")}</td>
                  <td className="actions-column">
                    <div className="row-actions">
                      <button type="button" className="secondary small" onClick={() => openEdit(user)}>
                        {t("common.edit")}
                      </button>
                      <button
                        type="button"
                        className="danger-link"
                        disabled={deletingId === user.id}
                        onClick={() => void remove(user)}
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form && (
        <div className="modal-backdrop">
          <section className="modal auth-modal">
            <div className="modal-head">
              <div>
                <h2>{t(form.id ? "settings.editUser" : "settings.newUser")}</h2>
                <p>{t("settings.userFormHint")}</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setForm(null)}>
                ×
              </button>
            </div>
            <form onSubmit={submit}>
              {formError && <div className="alert error auth-alert">{formError}</div>}
              <div className="form-grid">
                <label className="field">
                  <span>{t("settings.username")}</span>
                  <input
                    value={form.username}
                    disabled={Boolean(form.id)}
                    onChange={(event) => setForm({ ...form, username: event.target.value })}
                    autoCapitalize="none"
                    spellCheck={false}
                    autoFocus={!form.id}
                  />
                </label>
                <label className="field">
                  <span>{t("settings.displayName")}</span>
                  <input
                    value={form.displayName}
                    onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                    autoFocus={Boolean(form.id)}
                  />
                </label>
                <label className="field">
                  <span>{t("settings.role")}</span>
                  <select
                    value={form.role}
                    onChange={(event) => setForm({ ...form, role: event.target.value as UserRole })}
                  >
                    <option value="technician">{t("auth.role.technician")}</option>
                    <option value="admin">{t("auth.role.admin")}</option>
                  </select>
                </label>
                <label className="field">
                  <span>{t("settings.password")}</span>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(event) => setForm({ ...form, password: event.target.value })}
                    autoComplete="new-password"
                    placeholder={form.id ? t("settings.passwordKeep") : ""}
                  />
                  <small>{form.id ? t("settings.passwordResetHint") : t("settings.passwordCreateHint")}</small>
                </label>
                {form.id && (
                  <label className="field full checkbox-field">
                    <span className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={form.active}
                        onChange={(event) => setForm({ ...form, active: event.target.checked })}
                      />
                      {t("settings.active")}
                    </span>
                  </label>
                )}
              </div>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setForm(null)}>
                  {t("common.cancel")}
                </button>
                <button className="primary" type="submit" disabled={saving}>
                  {saving ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
