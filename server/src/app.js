import Fastify from "fastify";
import {
  bearerToken,
  clearLoginFailures,
  createSession,
  destroySession,
  hashPassword,
  isPublicRoute,
  loginAllowed,
  publicUser,
  recordLoginFailure,
  sessionTokenHash,
  userForToken,
  verifyPassword,
} from "./auth.js";
import { createPostgresBackup, isPostgresBackup, restorePostgresBackup } from "./backup.js";
import {
  changePasswordInput,
  customerInput,
  equipmentInput,
  loginInput,
  officeSettingsInput,
  pathId,
  repairInput,
  setupInput,
  userInput,
  userUpdateInput,
  ValidationError,
} from "./validation.js";
import { exportPortableBackup, importPortableBackup, PortableBackupError } from "./portable.js";

const repairSelect = `SELECT r.*, c.name customer_name, s.code status_code, s.label_key status_label_key,
  u.display_name created_by_name
  FROM repairs r
  JOIN customers c ON c.id = r.customer_id
  JOIN repair_statuses s ON s.id = r.status_id
  LEFT JOIN users u ON u.id = r.created_by`;

const DUMMY_PASSWORD_HASH = hashPassword("dbrepairs-timing-check");

const equipmentSelect = `SELECT e.*, c.name customer_name,
  (SELECT COUNT(*) FROM repairs r WHERE r.equipment_id = e.id)::integer repair_count,
  (SELECT MAX(r.opened_at) FROM repairs r WHERE r.equipment_id = e.id) last_repair_at
  FROM equipment e
  JOIN customers c ON c.id = e.customer_id`;

function replyNotFound(reply) {
  return reply.code(404).send({ error: "Not found" });
}

export function buildApp({ pool, config, logger = true, migrateDatabase }) {
  const app = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 3_200_000 });
  let restoring = false;

  app.decorateRequest("user", null);

  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 256 * 1024 * 1024 }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook("preHandler", async (request, reply) => {
    if (isPublicRoute(request.method, request.url)) return;
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: "Authentication required" });
    const user = await userForToken(pool, token);
    if (!user) return reply.code(401).send({ error: "Session expired" });
    request.user = user;
  });

  async function adminOnly(request, reply) {
    if (request.user?.role !== "admin") {
      return reply.code(403).send({ error: "Admin access required" });
    }
  }

  app.addHook("onRequest", async (request, reply) => {
    if (restoring && request.url !== "/api/health") {
      return reply.code(503).send({ error: "Database restore in progress" });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Referrer-Policy", "same-origin");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
    if (error instanceof PortableBackupError) return reply.code(400).send({ error: error.message });
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if (error.code === "23503") return reply.code(409).send({ error: "This record is still in use" });
    if (error.code === "23505") return reply.code(409).send({ error: "This value is already in use" });
    request.log.error(error);
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.get("/api/health", async () => {
    if (restoring) return { status: "restoring" };
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  app.get("/api/auth/status", async (request) => {
    const result = await pool.query("SELECT COUNT(*)::integer count FROM users");
    const setupRequired = Number(result.rows[0]?.count || 0) === 0;
    const token = bearerToken(request);
    const user = setupRequired || !token ? null : await userForToken(pool, token);
    return { setupRequired, user };
  });

  app.post("/api/auth/setup", async (request, reply) => {
    const input = setupInput(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(87234023)");
      const count = await client.query("SELECT COUNT(*)::integer count FROM users");
      if (Number(count.rows[0]?.count || 0) > 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "Setup has already been completed" });
      }
      const created = await client.query(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, $2, $3, 'admin')
         RETURNING id, username, display_name, role, active, created_at`,
        [input.username, input.displayName, hashPassword(input.password)],
      );
      const user = publicUser(created.rows[0]);
      const token = await createSession(client, user.id);
      await client.query("COMMIT");
      return reply.code(201).send({ token, user });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = loginInput(request.body);
    const key = `${request.ip}:${input.username.toLowerCase()}`;
    if (!loginAllowed(key)) {
      return reply.code(429).send({ error: "Too many login attempts. Try again later." });
    }
    const result = await pool.query(
      `SELECT id, username, display_name, role, active, password_hash
         FROM users WHERE lower(username) = lower($1) LIMIT 1`,
      [input.username],
    );
    const row = result.rows[0];
    const valid = verifyPassword(input.password, row?.password_hash || DUMMY_PASSWORD_HASH);
    if (!row || !valid || !row.active) {
      recordLoginFailure(key);
      return reply.code(401).send({ error: "Invalid username or password" });
    }
    clearLoginFailures(key);
    const token = await createSession(pool, row.id);
    return { token, user: publicUser(row) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await destroySession(pool, bearerToken(request));
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request) => request.user);

  app.post("/api/auth/password", async (request, reply) => {
    const input = changePasswordInput(request.body);
    const current = await pool.query("SELECT password_hash FROM users WHERE id = $1", [request.user.id]);
    if (!current.rowCount) return reply.code(401).send({ error: "Account not found" });
    if (!verifyPassword(input.currentPassword, current.rows[0].password_hash)) {
      return reply.code(400).send({ error: "Current password is incorrect" });
    }
    const token = bearerToken(request);
    await pool.query(
      "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
      [hashPassword(input.newPassword), request.user.id],
    );
    await pool.query(
      "DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2",
      [request.user.id, sessionTokenHash(token)],
    );
    return reply.code(204).send();
  });

  app.get("/api/users", { preHandler: adminOnly }, async () =>
    (await pool.query(
      "SELECT id, username, display_name, role, active, created_at FROM users ORDER BY lower(username), id",
    )).rows.map(publicUser));

  app.post("/api/users", { preHandler: adminOnly }, async (request, reply) => {
    const input = userInput(request.body);
    const result = await pool.query(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ($1,$2,$3,$4)
       RETURNING id, username, display_name, role, active, created_at`,
      [input.username, input.displayName, hashPassword(input.password), input.role],
    );
    return reply.code(201).send(publicUser(result.rows[0]));
  });

  app.put("/api/users/:id", { preHandler: adminOnly }, async (request, reply) => {
    const id = pathId(request.params.id);
    const input = userUpdateInput(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query("SELECT role, active FROM users WHERE id = $1 FOR UPDATE", [id]);
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        return replyNotFound(reply);
      }
      const existing = current.rows[0];
      if (id === request.user.id && (input.active === false || (input.role && input.role !== "admin"))) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "You cannot deactivate or demote your own account" });
      }
      if (existing.role === "admin" && existing.active && (input.role === "technician" || input.active === false)) {
        const remaining = await client.query(
          "SELECT COUNT(*)::integer count FROM users WHERE role = 'admin' AND active = true AND id <> $1",
          [id],
        );
        if (Number(remaining.rows[0]?.count || 0) === 0) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "At least one active administrator is required" });
        }
      }
      const fields = [];
      const values = [];
      const push = (column, value) => {
        values.push(value);
        fields.push(`${column} = $${values.length}`);
      };
      if (input.displayName !== undefined) push("display_name", input.displayName);
      if (input.role !== undefined) push("role", input.role);
      if (input.active !== undefined) push("active", input.active);
      if (input.password !== undefined) push("password_hash", hashPassword(input.password));
      if (fields.length) {
        values.push(id);
        await client.query(
          `UPDATE users SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length}`,
          values,
        );
      }
      await client.query("COMMIT");
      return reply.code(204).send();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/api/users/:id", { preHandler: adminOnly }, async (request, reply) => {
    const id = pathId(request.params.id);
    if (id === request.user.id) {
      return reply.code(400).send({ error: "You cannot delete your own account" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query("SELECT role, active FROM users WHERE id = $1 FOR UPDATE", [id]);
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        return replyNotFound(reply);
      }
      if (current.rows[0].role === "admin" && current.rows[0].active) {
        const remaining = await client.query(
          "SELECT COUNT(*)::integer count FROM users WHERE role = 'admin' AND active = true AND id <> $1",
          [id],
        );
        if (Number(remaining.rows[0]?.count || 0) === 0) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "At least one active administrator is required" });
        }
      }
      await client.query("DELETE FROM users WHERE id = $1", [id]);
      await client.query("COMMIT");
      return reply.code(204).send();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });


  app.get("/api/customers", async (request) => {
    const search = typeof request.query?.search === "string" ? request.query.search.trim() : "";
    const term = `%${search}%`;
    return (await pool.query(`SELECT id, name, company, tax_number, phone, email, address, notes, created_at, updated_at
      FROM customers
      WHERE $1 = '%%'
         OR name ILIKE $1
         OR COALESCE(company, '') ILIKE $1
         OR COALESCE(tax_number, '') ILIKE $1
         OR COALESCE(phone, '') ILIKE $1
         OR COALESCE(email, '') ILIKE $1
      ORDER BY lower(name), id`, [term])).rows;
  });

  app.post("/api/customers", async (request, reply) => {
    const input = customerInput(request.body);
    const result = await pool.query(`INSERT INTO customers (name, company, tax_number, phone, email, address, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.name, input.company, input.taxNumber, input.phone, input.email, input.address, input.notes]);
    return reply.code(201).send({ id: result.rows[0].id });
  });

  app.put("/api/customers/:id", async (request, reply) => {
    const id = pathId(request.params.id);
    const input = customerInput(request.body);
    const result = await pool.query(`UPDATE customers SET name=$1, company=$2, tax_number=$3, phone=$4, email=$5,
      address=$6, notes=$7, updated_at=now() WHERE id=$8`,
      [input.name, input.company, input.taxNumber, input.phone, input.email, input.address, input.notes, id]);
    if (!result.rowCount) return replyNotFound(reply);
    return reply.code(204).send();
  });

  app.delete("/api/customers/:id", async (request, reply) => {
    const result = await pool.query("DELETE FROM customers WHERE id=$1", [pathId(request.params.id)]);
    if (!result.rowCount) return replyNotFound(reply);
    return reply.code(204).send();
  });

  app.get("/api/equipment", async (request) => {
    const search = typeof request.query?.search === "string" ? request.query.search.trim() : "";
    const term = `%${search}%`;
    const customerId =
      request.query?.customerId != null && request.query.customerId !== ""
        ? pathId(request.query.customerId, "customerId")
        : null;

    return (await pool.query(`${equipmentSelect}
      WHERE ($1 = '%%'
         OR COALESCE(e.device_type, '') ILIKE $1
         OR COALESCE(e.brand, '') ILIKE $1
         OR COALESCE(e.model, '') ILIKE $1
         OR COALESCE(e.serial_number, '') ILIKE $1
         OR COALESCE(e.imei, '') ILIKE $1
         OR COALESCE(e.notes, '') ILIKE $1
         OR c.name ILIKE $1)
        AND ($2::bigint IS NULL OR e.customer_id = $2)
      ORDER BY lower(c.name), lower(COALESCE(e.brand, '')), lower(COALESCE(e.model, '')), e.id DESC`,
      [term, customerId])).rows;
  });

  app.get("/api/equipment/:id", async (request, reply) => {
    const result = await pool.query(`${equipmentSelect} WHERE e.id=$1 LIMIT 1`, [pathId(request.params.id)]);
    if (!result.rowCount) return replyNotFound(reply);
    return result.rows[0];
  });

  app.post("/api/equipment", async (request, reply) => {
    const input = equipmentInput(request.body);
    const result = await pool.query(`INSERT INTO equipment
      (customer_id, device_type, brand, model, serial_number, imei, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.customer_id, input.device_type, input.brand, input.model, input.serial_number, input.imei, input.notes]);
    return reply.code(201).send({ id: result.rows[0].id });
  });

  app.put("/api/equipment/:id", async (request, reply) => {
    const id = pathId(request.params.id);
    const input = equipmentInput(request.body);
    const result = await pool.query(`UPDATE equipment SET customer_id=$1, device_type=$2, brand=$3, model=$4,
      serial_number=$5, imei=$6, notes=$7, updated_at=now() WHERE id=$8`,
      [input.customer_id, input.device_type, input.brand, input.model, input.serial_number, input.imei, input.notes, id]);
    if (!result.rowCount) return replyNotFound(reply);
    return reply.code(204).send();
  });

  app.delete("/api/equipment/:id", async (request, reply) => {
    const result = await pool.query("DELETE FROM equipment WHERE id=$1", [pathId(request.params.id)]);
    if (!result.rowCount) return replyNotFound(reply);
    return reply.code(204).send();
  });


  app.get("/api/customers/:id/attachments", async (request) => {
    const customerId = pathId(request.params.id);

    return (
      await pool.query(
        `SELECT
           id,
           customer_id,
           filename,
           content_type,
           size,
           created_at
         FROM customer_attachments
         WHERE customer_id=$1
         ORDER BY id DESC`,
        [customerId],
      )
    ).rows;
  });

  app.post(
    "/api/customers/:id/attachments",
    { bodyLimit: 11 * 1024 * 1024 },
    async (request, reply) => {
      const customerId = pathId(request.params.id);
      const data = request.body;

      if (
        !Buffer.isBuffer(data) ||
        data.length === 0 ||
        data.length > 10 * 1024 * 1024
      ) {
        return reply
          .code(400)
          .send({ error: "Attachment must be between 1 byte and 10 MB" });
      }

      let filename = request.headers["x-dbrepairs-filename"];

      if (Array.isArray(filename)) {
        filename = filename[0];
      }

      try {
        filename = decodeURIComponent(String(filename || ""));
      } catch {
        filename = "";
      }

      filename = String(filename)
        .replace(/[\r\n]/g, "")
        .trim()
        .slice(0, 255);

      const extension =
        filename.split(".").pop()?.toLowerCase() || "";

      if (
        !filename ||
        !["pdf", "jpg", "jpeg", "png", "doc", "docx"].includes(extension)
      ) {
        return reply
          .code(400)
          .send({ error: "Unsupported attachment type" });
      }

      const contentType = String(
        request.headers["x-dbrepairs-content-type"] ||
        "application/octet-stream",
      ).slice(0, 200);

      const customer = await pool.query(
        "SELECT 1 FROM customers WHERE id=$1",
        [customerId],
      );

      if (!customer.rowCount) {
        return replyNotFound(reply);
      }

      const result = await pool.query(
        `INSERT INTO customer_attachments
           (customer_id, filename, content_type, size, data)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [
          customerId,
          filename,
          contentType,
          data.length,
          data,
        ],
      );

      return reply
        .code(201)
        .send({ id: result.rows[0].id });
    },
  );

  app.get(
    "/api/customers/:id/attachments/:attachmentId",
    async (request, reply) => {
      const customerId = pathId(request.params.id);
      const attachmentId = pathId(
        request.params.attachmentId,
        "attachmentId",
      );

      const result = await pool.query(
        `SELECT
           filename,
           content_type,
           data
         FROM customer_attachments
         WHERE id=$1
           AND customer_id=$2
         LIMIT 1`,
        [
          attachmentId,
          customerId,
        ],
      );

      if (!result.rowCount) {
        return replyNotFound(reply);
      }

      const row = result.rows[0];

      const safeName = String(row.filename)
        .replace(/["\r\n]/g, "_");

      return reply
        .header(
          "Content-Type",
          row.content_type || "application/octet-stream",
        )
        .header(
          "Content-Disposition",
          `attachment; filename="${safeName}"`,
        )
        .send(row.data);
    },
  );

  app.delete(
    "/api/customers/:id/attachments/:attachmentId",
    async (request, reply) => {
      const customerId = pathId(request.params.id);
      const attachmentId = pathId(
        request.params.attachmentId,
        "attachmentId",
      );

      const result = await pool.query(
        `DELETE FROM customer_attachments
         WHERE id=$1
           AND customer_id=$2`,
        [
          attachmentId,
          customerId,
        ],
      );

      if (!result.rowCount) {
        return replyNotFound(reply);
      }

      return reply.code(204).send();
    },
  );

  app.get("/api/statuses", async () =>
    (await pool.query("SELECT id, code, label_key, sort_order FROM repair_statuses WHERE active=true ORDER BY sort_order")).rows);

  app.get("/api/repairs", async (request) => {
    const customerId = request.query?.customerId;
    if (customerId != null && customerId !== "") {
      return (await pool.query(`${repairSelect} WHERE r.customer_id=$1 ORDER BY r.id DESC`, [pathId(customerId, "customerId")])).rows;
    }
    const equipmentId = request.query?.equipmentId;
    if (equipmentId != null && equipmentId !== "") {
      return (await pool.query(`${repairSelect} WHERE r.equipment_id=$1 ORDER BY r.id DESC`, [pathId(equipmentId, "equipmentId")])).rows;
    }
    return (await pool.query(`${repairSelect} ORDER BY r.id DESC`)).rows;
  });

  app.get("/api/repairs/:id", async (request, reply) => {
    const result = await pool.query(`${repairSelect} WHERE r.id=$1 LIMIT 1`, [pathId(request.params.id)]);
    if (!result.rowCount) return replyNotFound(reply);
    return result.rows[0];
  });

  app.get("/api/repairs/:id/history", async (request) =>
    (await pool.query(`SELECT h.id, h.status_id, s.code status_code, s.label_key status_label_key, h.changed_at, h.note
      FROM repair_status_history h JOIN repair_statuses s ON s.id=h.status_id
      WHERE h.repair_id=$1 ORDER BY h.id DESC`, [pathId(request.params.id)])).rows);


  app.get(
    "/api/repairs/:id/attachments",
    async (request) => {
      const repairId =
        pathId(request.params.id);

      return (
        await pool.query(
          `SELECT
             id,
             repair_id,
             filename,
             content_type,
             size,
             created_at
           FROM repair_attachments
           WHERE repair_id=$1
           ORDER BY id DESC`,
          [repairId],
        )
      ).rows;
    },
  );

  app.post(
    "/api/repairs/:id/attachments",
    { bodyLimit: 11 * 1024 * 1024 },
    async (request, reply) => {
      const repairId =
        pathId(request.params.id);

      const data = request.body;

      if (
        !Buffer.isBuffer(data) ||
        data.length === 0 ||
        data.length > 10 * 1024 * 1024
      ) {
        return reply
          .code(400)
          .send({
            error:
              "Attachment must be between 1 byte and 10 MB",
          });
      }

      let filename =
        request.headers["x-dbrepairs-filename"];

      if (Array.isArray(filename)) {
        filename = filename[0];
      }

      try {
        filename = decodeURIComponent(
          String(filename || ""),
        );
      } catch {
        filename = "";
      }

      filename = String(filename)
        .replace(/[\r\n]/g, "")
        .trim()
        .slice(0, 255);

      const extension =
        filename
          .split(".")
          .pop()
          ?.toLowerCase() || "";

      if (
        !filename ||
        ![
          "pdf",
          "jpg",
          "jpeg",
          "png",
          "doc",
          "docx",
        ].includes(extension)
      ) {
        return reply
          .code(400)
          .send({
            error:
              "Unsupported attachment type",
          });
      }

      const contentType = String(
        request.headers[
          "x-dbrepairs-content-type"
        ] ||
        "application/octet-stream",
      ).slice(0, 200);

      const repair =
        await pool.query(
          "SELECT 1 FROM repairs WHERE id=$1",
          [repairId],
        );

      if (!repair.rowCount) {
        return replyNotFound(reply);
      }

      const result =
        await pool.query(
          `INSERT INTO repair_attachments
             (
               repair_id,
               filename,
               content_type,
               size,
               data
             )
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id`,
          [
            repairId,
            filename,
            contentType,
            data.length,
            data,
          ],
        );

      return reply
        .code(201)
        .send({
          id: result.rows[0].id,
        });
    },
  );

  app.get(
    "/api/repairs/:id/attachments/:attachmentId",
    async (request, reply) => {
      const repairId =
        pathId(request.params.id);

      const attachmentId =
        pathId(
          request.params.attachmentId,
          "attachmentId",
        );

      const result =
        await pool.query(
          `SELECT
             filename,
             content_type,
             data
           FROM repair_attachments
           WHERE id=$1
             AND repair_id=$2
           LIMIT 1`,
          [
            attachmentId,
            repairId,
          ],
        );

      if (!result.rowCount) {
        return replyNotFound(reply);
      }

      const row = result.rows[0];

      const safeName =
        String(row.filename)
          .replace(/["\r\n]/g, "_");

      return reply
        .header(
          "Content-Type",
          row.content_type ||
            "application/octet-stream",
        )
        .header(
          "Content-Disposition",
          `attachment; filename="${safeName}"`,
        )
        .send(row.data);
    },
  );

  app.delete(
    "/api/repairs/:id/attachments/:attachmentId",
    async (request, reply) => {
      const repairId =
        pathId(request.params.id);

      const attachmentId =
        pathId(
          request.params.attachmentId,
          "attachmentId",
        );

      const result =
        await pool.query(
          `DELETE FROM repair_attachments
           WHERE id=$1
             AND repair_id=$2`,
          [
            attachmentId,
            repairId,
          ],
        );

      if (!result.rowCount) {
        return replyNotFound(reply);
      }

      return reply
        .code(204)
        .send();
    },
  );

  app.post("/api/repairs", async (request, reply) => {
    const input = repairInput(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const temporary = `TMP-${crypto.randomUUID()}`;
      const result = await client.query(`INSERT INTO repairs
        (repair_number,customer_id,status_id,equipment_id,device_type,brand,model,serial_number,imei,reported_fault,accessories,general_condition,estimated_value,internal_notes,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, EXTRACT(YEAR FROM opened_at)::integer opened_year`,
        [temporary,input.customer_id,input.status_id,input.equipment_id,input.device_type,input.brand,input.model,input.serial_number,input.imei,input.reported_fault,
          input.accessories,input.general_condition,input.estimated_value,input.internal_notes,request.user.id]);
      const { id, opened_year: openedYear } = result.rows[0];
      const repairNumber = `${openedYear}-${String(id).padStart(6, "0")}`;
      await client.query("UPDATE repairs SET repair_number=$1 WHERE id=$2", [repairNumber, id]);
      await client.query("INSERT INTO repair_status_history (repair_id,status_id) VALUES ($1,$2)", [id,input.status_id]);
      await client.query("COMMIT");
      return reply.code(201).send({ id });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.put("/api/repairs/:id", async (request, reply) => {
    const id = pathId(request.params.id);
    const input = repairInput(request.body, true);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query("SELECT status_id FROM repairs WHERE id=$1 FOR UPDATE", [id]);
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        return replyNotFound(reply);
      }
      await client.query(`UPDATE repairs SET customer_id=$1, status_id=$2, equipment_id=$3, device_type=$4, brand=$5, model=$6, serial_number=$7,
        imei=$8, reported_fault=$9, accessories=$10, general_condition=$11, diagnosis=$12, work_performed=$13, estimated_value=$14,
        final_value=$15, internal_notes=$16, updated_at=now(), closed_at=CASE
          WHEN (SELECT code FROM repair_statuses WHERE id=$2) IN ('DELIVERED','CANCELLED') THEN COALESCE(closed_at,now()) ELSE NULL END
        WHERE id=$17`, [input.customer_id,input.status_id,input.equipment_id,input.device_type,input.brand,input.model,input.serial_number,input.imei,
          input.reported_fault,input.accessories,input.general_condition,input.diagnosis,input.work_performed,input.estimated_value,
          input.final_value,input.internal_notes,id]);
      if (current.rows[0].status_id !== input.status_id) {
        await client.query("INSERT INTO repair_status_history (repair_id,status_id,note) VALUES ($1,$2,$3)", [id,input.status_id,input.statusNote]);
      }
      await client.query("COMMIT");
      return reply.code(204).send();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/api/dashboard", async () => {
    const [counts, recent] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE s.code NOT IN ('DELIVERED','CANCELLED'))::integer open_repairs,
        COUNT(*) FILTER (WHERE s.code='WAITING_CUSTOMER')::integer waiting_customer,
        COUNT(*) FILTER (WHERE s.code='READY')::integer ready,
        COUNT(*) FILTER (WHERE r.closed_at IS NOT NULL AND r.closed_at::date = CURRENT_DATE)::integer closed_today
        FROM repairs r JOIN repair_statuses s ON s.id=r.status_id`),
      pool.query(`SELECT r.id,r.repair_number,c.name customer_name,s.code status_code,s.label_key status_label_key,
        r.device_type,r.brand,r.model,r.opened_at FROM repairs r JOIN customers c ON c.id=r.customer_id
        JOIN repair_statuses s ON s.id=r.status_id ORDER BY r.id DESC LIMIT 5`),
    ]);
    const row = counts.rows[0];
    return { stats: { openRepairs: row.open_repairs, waitingCustomer: row.waiting_customer, ready: row.ready, closedToday: row.closed_today }, recent: recent.rows };
  });

  const settingKeys = {
    companyName: "office.companyName", taxNumber: "office.taxNumber", address: "office.address",
    phone: "office.phone", email: "office.email", logoDataUrl: "office.logoDataUrl",
  };

  app.get("/api/settings/office", async () => {
    const rows = (await pool.query("SELECT key,value FROM app_settings WHERE key=ANY($1)", [Object.values(settingKeys)])).rows;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return Object.fromEntries(Object.entries(settingKeys).map(([field, key]) => [field, values.get(key) || ""]));
  });

  app.put("/api/settings/office", { preHandler: adminOnly }, async (request, reply) => {
    const settings = officeSettingsInput(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [field, key] of Object.entries(settingKeys)) {
        await client.query(`INSERT INTO app_settings (key,value) VALUES ($1,$2)
          ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, settings[field]]);
      }
      await client.query("COMMIT");
      return reply.code(204).send();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/api/backups/database", { preHandler: adminOnly }, async (_request, reply) => {
    const backup = await createPostgresBackup(config.database);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename=DBRepairs-${stamp}.dump`)
      .send(backup);
  });

  app.put("/api/backups/database", { preHandler: adminOnly, bodyLimit: 256 * 1024 * 1024 }, async (request, reply) => {
    if (!isPostgresBackup(request.body)) return reply.code(400).send({ error: "Invalid PostgreSQL backup" });
    if (restoring) return reply.code(409).send({ error: "Another restore is already in progress" });
    restoring = true;
    try {
      await restorePostgresBackup(config.database, request.body);
      if (migrateDatabase) await migrateDatabase();
      return reply.code(204).send();
    } finally {
      restoring = false;
    }
  });

  app.get("/api/backups/portable", { preHandler: adminOnly }, async (_request, reply) => {
    const archive = await exportPortableBackup(pool);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return reply
      .header("Content-Type", "application/vnd.dbrepairs.backup+json")
      .header("Content-Disposition", `attachment; filename=DBRepairs-portable-${stamp}.dbrepairs`)
      .send(JSON.stringify(archive));
  });

  app.put("/api/backups/portable", { preHandler: adminOnly, bodyLimit: 256 * 1024 * 1024 }, async (request, reply) => {
    if (restoring) return reply.code(409).send({ error: "Another restore is already in progress" });
    restoring = true;
    try {
      await importPortableBackup(pool, request.body);
      return reply.code(204).send();
    } finally {
      restoring = false;
    }
  });

  return app;
}
