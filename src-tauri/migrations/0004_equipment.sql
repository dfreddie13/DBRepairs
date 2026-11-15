PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  device_type TEXT,
  brand TEXT,
  model TEXT,
  serial_number TEXT,
  imei TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS equipment_customer_id_idx
  ON equipment(customer_id);

CREATE INDEX IF NOT EXISTS equipment_serial_number_idx
  ON equipment(serial_number);

ALTER TABLE repairs ADD COLUMN equipment_id INTEGER
  REFERENCES equipment(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS repairs_equipment_id_idx
  ON repairs(equipment_id);
