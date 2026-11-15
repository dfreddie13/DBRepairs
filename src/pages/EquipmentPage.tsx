import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Customer, listCustomers } from "../data/customers";
import {
  createEquipment,
  deleteEquipment,
  Equipment,
  EquipmentInput,
  listEquipment,
  updateEquipment,
} from "../data/equipment";
import { listRepairsByEquipment, Repair } from "../data/repairs";
import { useI18n } from "../i18n/I18nProvider";

const emptyEquipment: EquipmentInput = {
  customer_id: 0,
  device_type: "",
  brand: "",
  model: "",
  serial_number: "",
  imei: "",
  notes: "",
};

function toInput(equipment: Equipment): EquipmentInput {
  return {
    customer_id: equipment.customer_id,
    device_type: equipment.device_type ?? "",
    brand: equipment.brand ?? "",
    model: equipment.model ?? "",
    serial_number: equipment.serial_number ?? "",
    imei: equipment.imei ?? "",
    notes: equipment.notes ?? "",
  };
}

export default function EquipmentPage() {
  const { t } = useI18n();
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [customerFilter, setCustomerFilter] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Equipment | null>(null);
  const [form, setForm] = useState<EquipmentInput>(emptyEquipment);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<Repair[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [items, customerList] = await Promise.all([
        listEquipment(),
        listCustomers(),
      ]);
      setEquipment(items);
      setCustomers(customerList);
    } catch (cause) {
      console.error(cause);
      setError(t("common.databaseError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredEquipment = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return equipment.filter((item) => {
      if (customerFilter && item.customer_id !== customerFilter) return false;
      if (!query) return true;
      return [
        item.customer_name,
        item.device_type,
        item.brand,
        item.model,
        item.serial_number,
        item.imei,
        item.notes,
      ].some((value) => (value ?? "").toLocaleLowerCase().includes(query));
    });
  }, [equipment, search, customerFilter]);

  function openCreate() {
    setEditing(null);
    setForm({ ...emptyEquipment, customer_id: customerFilter || customers[0]?.id || 0 });
    setHistory([]);
    setError("");
    setFormOpen(true);
  }

  async function openEdit(item: Equipment) {
    setEditing(item);
    setForm(toInput(item));
    setHistory([]);
    setHistoryLoading(true);
    setError("");
    setFormOpen(true);

    try {
      setHistory(await listRepairsByEquipment(item.id));
    } catch (cause) {
      console.error(cause);
      setError(t("common.databaseError"));
    } finally {
      setHistoryLoading(false);
    }
  }

  function closeForm() {
    if (saving) return;
    setFormOpen(false);
    setEditing(null);
    setHistory([]);
    setForm(emptyEquipment);
  }

  function updateField(field: keyof EquipmentInput, value: string | number) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.customer_id || saving) return;

    setSaving(true);
    setError("");
    try {
      if (editing) await updateEquipment(editing.id, form);
      else await createEquipment(form);
      setFormOpen(false);
      setEditing(null);
      setHistory([]);
      setForm(emptyEquipment);
      await refresh();
    } catch (cause) {
      console.error(cause);
      setError(t("common.saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(item: Equipment) {
    if (
      !window.confirm(
        t("equipment.deleteConfirm").replace("{name}", deviceName(item)),
      )
    ) {
      return;
    }

    setError("");
    try {
      await deleteEquipment(item.id);
      await refresh();
    } catch (cause) {
      console.error(cause);
      setError(t("equipment.deleteBlocked"));
    }
  }

  function deviceName(item: Equipment) {
    return (
      [item.device_type, item.brand, item.model].filter(Boolean).join(" · ") ||
      `#${item.id}`
    );
  }

  function serialLabel(item: Equipment) {
    return item.serial_number || item.imei || "—";
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t("equipment.title")}</h1>
          <p>{t("equipment.subtitle")}</p>
        </div>
        <button className="primary" onClick={openCreate}>+ {t("equipment.new")}</button>
      </header>

      {error && <div className="alert error">{error}</div>}

      <section className="panel customers-panel">
        <div className="repairs-toolbar">
          <input
            className="repair-search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("equipment.search")}
            aria-label={t("equipment.search")}
          />
          <select
            value={customerFilter}
            onChange={(event) => setCustomerFilter(Number(event.target.value))}
            aria-label={t("equipment.customer")}
          >
            <option value={0}>{t("equipment.allCustomers")}</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}</option>
            ))}
          </select>
          <span className="muted repair-results-count">
            {t("equipment.count").replace("{count}", String(filteredEquipment.length))}
          </span>
        </div>

        {loading ? (
          <div className="empty-state compact">{t("common.loading")}</div>
        ) : equipment.length === 0 ? (
          <div className="empty-state compact">
            <strong>{t("equipment.empty")}</strong>
            <span>{t("equipment.emptyHint")}</span>
          </div>
        ) : filteredEquipment.length === 0 ? (
          <div className="empty-state compact">{t("equipment.noResults")}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("equipment.device")}</th>
                  <th>{t("equipment.serialNumber")}</th>
                  <th>{t("equipment.customer")}</th>
                  <th>{t("equipment.repairs")}</th>
                  <th>{t("equipment.lastRepair")}</th>
                  <th className="actions-column">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredEquipment.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{deviceName(item)}</strong></td>
                    <td>{serialLabel(item)}</td>
                    <td>{item.customer_name}</td>
                    <td>{item.repair_count}</td>
                    <td>{item.last_repair_at ? new Date(item.last_repair_at).toLocaleDateString() : t("equipment.neverRepaired")}</td>
                    <td>
                      <div className="row-actions">
                        <button className="secondary small" onClick={() => void openEdit(item)}>{t("common.edit")}</button>
                        <button className="danger-link small" onClick={() => void remove(item)}>{t("common.delete")}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {formOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeForm();
        }}>
          <section className="modal equipment-detail-modal" role="dialog" aria-modal="true" aria-labelledby="equipment-form-title">
            <div className="modal-head">
              <div>
                <h2 id="equipment-form-title">{editing ? t("equipment.edit") : t("equipment.new")}</h2>
                <p>{t("equipment.formHint")}</p>
              </div>
              <button className="icon-button" type="button" onClick={closeForm} aria-label={t("common.close")}>×</button>
            </div>

            <form onSubmit={(event) => void submit(event)}>
              <div className="form-grid">
                <label className="field full">
                  <span>{t("equipment.customer")} *</span>
                  <select value={form.customer_id} onChange={(event) => updateField("customer_id", Number(event.target.value))} required>
                    <option value={0}>{t("equipment.selectCustomer")}</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>{customer.name}{customer.company ? ` — ${customer.company}` : ""}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t("equipment.deviceType")}</span>
                  <input value={form.device_type} onChange={(event) => updateField("device_type", event.target.value)} />
                </label>
                <label className="field">
                  <span>{t("equipment.brand")}</span>
                  <input value={form.brand} onChange={(event) => updateField("brand", event.target.value)} />
                </label>
                <label className="field">
                  <span>{t("equipment.model")}</span>
                  <input value={form.model} onChange={(event) => updateField("model", event.target.value)} />
                </label>
                <label className="field">
                  <span>{t("equipment.serialNumber")}</span>
                  <input value={form.serial_number} onChange={(event) => updateField("serial_number", event.target.value)} />
                </label>
                <label className="field">
                  <span>{t("equipment.imei")}</span>
                  <input value={form.imei} onChange={(event) => updateField("imei", event.target.value)} />
                </label>
                <label className="field full">
                  <span>{t("equipment.notes")}</span>
                  <textarea rows={3} value={form.notes} onChange={(event) => updateField("notes", event.target.value)} />
                </label>
              </div>

              {editing && (
                <section className="customer-repairs-section">
                  <div className="customer-repairs-head">
                    <div>
                      <h3>{t("equipment.historyTitle")}</h3>
                      <p>{t("equipment.historyHint")}</p>
                    </div>
                    {!historyLoading && <span className="muted">{t("equipment.repairCount").replace("{count}", String(history.length))}</span>}
                  </div>
                  {historyLoading ? (
                    <div className="customer-repairs-empty">{t("common.loading")}</div>
                  ) : history.length === 0 ? (
                    <div className="customer-repairs-empty">{t("equipment.historyEmpty")}</div>
                  ) : (
                    <div className="table-wrap customer-repairs-table">
                      <table>
                        <thead>
                          <tr>
                            <th>{t("print.repairNumber")}</th>
                            <th>{t("repair.status")}</th>
                            <th>{t("repair.openedAt")}</th>
                            <th>{t("repair.workPerformed")}</th>
                            <th>{t("repair.finalValue")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.map((repair) => (
                            <tr key={repair.id}>
                              <td><strong>{repair.repair_number}</strong></td>
                              <td><span className="status-pill">{t(repair.status_label_key)}</span></td>
                              <td>{new Date(repair.opened_at).toLocaleDateString()}</td>
                              <td className="equipment-history-text">{repair.work_performed || repair.reported_fault || "—"}</td>
                              <td>{repair.final_value != null ? repair.final_value.toFixed(2) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}

              <div className="modal-actions">
                <button type="button" className="secondary" onClick={closeForm}>{t("common.cancel")}</button>
                <button type="submit" className="primary" disabled={saving || !form.customer_id}>
                  {saving ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
