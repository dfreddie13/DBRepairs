import { getDatabase } from "./database";
import { api } from "./api";
import { isServerMode } from "./runtime";

export type Equipment = {
  id: number;
  customer_id: number;
  customer_name: string;
  device_type: string | null;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  imei: string | null;
  notes: string | null;
  repair_count: number;
  last_repair_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EquipmentInput = {
  customer_id: number;
  device_type: string;
  brand: string;
  model: string;
  serial_number: string;
  imei: string;
  notes: string;
};

function clean(value: string) {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export async function listEquipment(search = "", customerId?: number): Promise<Equipment[]> {
  if (isServerMode) {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (customerId) params.set("customerId", String(customerId));
    const query = params.toString();
    return api(`/equipment${query ? `?${query}` : ""}`);
  }

  const db = await getDatabase();
  const term = `%${search.trim()}%`;
  return db.select<Equipment[]>(
    `SELECT e.*, c.name customer_name,
       (SELECT COUNT(*) FROM repairs r WHERE r.equipment_id = e.id) repair_count,
       (SELECT MAX(r.opened_at) FROM repairs r WHERE r.equipment_id = e.id) last_repair_at
     FROM equipment e
     JOIN customers c ON c.id = e.customer_id
     WHERE (
         ?1 = '%%'
         OR COALESCE(e.device_type, '') LIKE ?1 COLLATE NOCASE
         OR COALESCE(e.brand, '') LIKE ?1 COLLATE NOCASE
         OR COALESCE(e.model, '') LIKE ?1 COLLATE NOCASE
         OR COALESCE(e.serial_number, '') LIKE ?1 COLLATE NOCASE
         OR COALESCE(e.imei, '') LIKE ?1 COLLATE NOCASE
         OR COALESCE(e.notes, '') LIKE ?1 COLLATE NOCASE
         OR c.name LIKE ?1 COLLATE NOCASE
       )
       AND (?2 IS NULL OR e.customer_id = ?2)
     ORDER BY c.name COLLATE NOCASE,
       COALESCE(e.brand, '') COLLATE NOCASE,
       COALESCE(e.model, '') COLLATE NOCASE,
       e.id DESC`,
    [term, customerId ?? null],
  );
}

export async function getEquipment(id: number): Promise<Equipment | null> {
  if (isServerMode) {
    try { return await api(`/equipment/${id}`); }
    catch (error) { if (error instanceof Error && error.message === "Not found") return null; throw error; }
  }

  const db = await getDatabase();
  const rows = await db.select<Equipment[]>(
    `SELECT e.*, c.name customer_name,
       (SELECT COUNT(*) FROM repairs r WHERE r.equipment_id = e.id) repair_count,
       (SELECT MAX(r.opened_at) FROM repairs r WHERE r.equipment_id = e.id) last_repair_at
     FROM equipment e
     JOIN customers c ON c.id = e.customer_id
     WHERE e.id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createEquipment(input: EquipmentInput): Promise<number> {
  if (isServerMode) {
    const result = await api<{ id: number }>("/equipment", { method: "POST", body: JSON.stringify(input) });
    return result.id;
  }

  const db = await getDatabase();
  const result = await db.execute(
    `INSERT INTO equipment (customer_id, device_type, brand, model, serial_number, imei, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    [
      input.customer_id,
      clean(input.device_type),
      clean(input.brand),
      clean(input.model),
      clean(input.serial_number),
      clean(input.imei),
      clean(input.notes),
    ],
  );
  return Number(result.lastInsertId ?? 0);
}

export async function updateEquipment(id: number, input: EquipmentInput): Promise<void> {
  if (isServerMode) return api(`/equipment/${id}`, { method: "PUT", body: JSON.stringify(input) });

  const db = await getDatabase();
  await db.execute(
    `UPDATE equipment
     SET customer_id = ?1,
         device_type = ?2,
         brand = ?3,
         model = ?4,
         serial_number = ?5,
         imei = ?6,
         notes = ?7,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?8`,
    [
      input.customer_id,
      clean(input.device_type),
      clean(input.brand),
      clean(input.model),
      clean(input.serial_number),
      clean(input.imei),
      clean(input.notes),
      id,
    ],
  );
}

export async function deleteEquipment(id: number): Promise<void> {
  if (isServerMode) return api(`/equipment/${id}`, { method: "DELETE" });

  const db = await getDatabase();
  await db.execute("DELETE FROM equipment WHERE id = ?1", [id]);
}
