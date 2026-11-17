export class ValidationError extends Error {}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Expected a JSON object");
  }
  return value;
}

function text(value, field, { required = false, max = 10000 } = {}) {
  if (value == null) value = "";
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationError(`${field} is required`);
  if (trimmed.length > max) throw new ValidationError(`${field} is too long`);
  return trimmed || null;
}

function id(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ValidationError(`${field} must be a positive integer`);
  return parsed;
}

function optionalId(value, field) {
  if (value == null || value === "") return null;
  return id(value, field);
}

function money(value, field) {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new ValidationError(`${field} must be a positive number`);
  return parsed;
}

export function customerInput(value) {
  const body = object(value);
  return {
    name: text(body.name, "name", { required: true, max: 200 }),
    company: text(body.company, "company", { max: 200 }),
    taxNumber: text(body.taxNumber, "taxNumber", { max: 80 }),
    phone: text(body.phone, "phone", { max: 80 }),
    email: text(body.email, "email", { max: 254 }),
    address: text(body.address, "address", { max: 1000 }),
    notes: text(body.notes, "notes"),
  };
}

export function repairInput(value, update = false) {
  const body = object(value);
  const result = {
    customer_id: id(body.customer_id, "customer_id"),
    status_id: id(body.status_id, "status_id"),
    equipment_id: optionalId(body.equipment_id, "equipment_id"),
    device_type: text(body.device_type, "device_type", { max: 200 }),
    brand: text(body.brand, "brand", { max: 200 }),
    model: text(body.model, "model", { max: 200 }),
    serial_number: text(body.serial_number, "serial_number", { max: 200 }),
    imei: text(body.imei, "imei", { max: 200 }),
    reported_fault: text(body.reported_fault, "reported_fault", { required: true }),
    accessories: text(body.accessories, "accessories"),
    general_condition: text(body.general_condition, "general_condition"),
    estimated_value: money(body.estimated_value, "estimated_value"),
    internal_notes: text(body.internal_notes, "internal_notes"),
  };
  if (update) {
    result.diagnosis = text(body.diagnosis, "diagnosis");
    result.work_performed = text(body.work_performed, "work_performed");
    result.final_value = money(body.final_value, "final_value");
    result.statusNote = text(body.statusNote, "statusNote");
  }
  return result;
}

export function equipmentInput(value) {
  const body = object(value);
  return {
    customer_id: id(body.customer_id, "customer_id"),
    device_type: text(body.device_type, "device_type", { max: 200 }),
    brand: text(body.brand, "brand", { max: 200 }),
    model: text(body.model, "model", { max: 200 }),
    serial_number: text(body.serial_number, "serial_number", { max: 200 }),
    imei: text(body.imei, "imei", { max: 200 }),
    notes: text(body.notes, "notes"),
  };
}

function secret(value, field, { required = false } = {}) {
  if (value == null) value = "";
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  if (required && !value) throw new ValidationError(`${field} is required`);
  if (value.length > 200) throw new ValidationError(`${field} is too long`);
  return value;
}

function password(value, field = "password") {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  if (value.length < 8) throw new ValidationError(`${field} must be at least 8 characters`);
  if (value.length > 200) throw new ValidationError(`${field} is too long`);
  return value;
}

function role(value) {
  const parsed = text(value, "role", { max: 20 }) || "technician";
  if (!["admin", "technician"].includes(parsed)) {
    throw new ValidationError("role must be admin or technician");
  }
  return parsed;
}

function username(value) {
  const parsed = text(value, "username", { required: true, max: 32 });
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(parsed)) {
    throw new ValidationError("username must be 3-32 letters, numbers, dots, dashes or underscores");
  }
  return parsed;
}

export function userInput(value, { passwordRequired = true } = {}) {
  const body = object(value);
  const displayName = text(body.displayName, "displayName", { required: true, max: 80 });
  let userPassword = null;
  if (passwordRequired || (body.password != null && body.password !== "")) {
    userPassword = password(body.password);
  }
  return {
    username: username(body.username),
    displayName,
    role: role(body.role),
    password: userPassword,
  };
}

export function userUpdateInput(value) {
  const body = object(value);
  const result = {};
  if (body.displayName !== undefined) {
    result.displayName = text(body.displayName, "displayName", { required: true, max: 80 });
  }
  if (body.role !== undefined) result.role = role(body.role);
  if (body.active !== undefined) {
    result.active = body.active === true || body.active === 1 || body.active === "1";
  }
  if (body.password !== undefined && body.password !== null && body.password !== "") {
    result.password = password(body.password);
  }
  return result;
}

export function loginInput(value) {
  const body = object(value);
  return {
    username: username(body.username),
    password: secret(body.password, "password", { required: true }),
  };
}

export function setupInput(value) {
  const body = object(value);
  return {
    username: username(body.username),
    displayName: text(body.displayName, "displayName", { required: true, max: 80 }),
    password: password(body.password),
  };
}

export function changePasswordInput(value) {
  const body = object(value);
  return {
    currentPassword: secret(body.currentPassword, "currentPassword", { required: true }),
    newPassword: password(body.newPassword, "newPassword"),
  };
}

const officeFields = ["companyName", "taxNumber", "address", "phone", "email", "logoDataUrl"];

export function officeSettingsInput(value) {
  const body = object(value);
  return Object.fromEntries(officeFields.map((field) => [field, text(body[field], field, { max: field === "logoDataUrl" ? 3_000_000 : 1000 }) || ""]));
}

export function pathId(value, field = "id") {
  return id(value, field);
}
