use std::{fs, path::Path, time::{SystemTime, UNIX_EPOCH}};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};
use rusqlite::{params, Connection};
use serde::Deserialize;


const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
fn is_sqlite_database(data: &[u8]) -> bool { data.len() >= 16 && &data[..16] == SQLITE_HEADER }
fn remove_if_exists(path: &Path) -> Result<(), String> { if path.exists(){fs::remove_file(path).map_err(|e|e.to_string())?;} Ok(()) }
fn apply_pending_restore(app: &tauri::AppHandle) -> Result<(), String> {
    let dir=app.path().app_config_dir().map_err(|e|e.to_string())?;
    let db=dir.join("dbrepairs.db"); let pending=dir.join("dbrepairs.restore.pending");
    if !pending.exists(){return Ok(());}
    let data=fs::read(&pending).map_err(|e|e.to_string())?;
    if !is_sqlite_database(&data){return Err("Invalid pending SQLite restore".into());}
    let rollback=dir.join("dbrepairs.restore.rollback"); remove_if_exists(&rollback)?;
    if db.exists(){fs::rename(&db,&rollback).map_err(|e|e.to_string())?;}
    if let Err(e)=fs::rename(&pending,&db){if rollback.exists()&&!db.exists(){let _=fs::rename(&rollback,&db);}return Err(e.to_string());}
    let _=remove_if_exists(&dir.join("dbrepairs.db-wal")); let _=remove_if_exists(&dir.join("dbrepairs.db-shm")); let _=remove_if_exists(&rollback); Ok(())
}

const PASSWORD_HASH_PREFIX: &str = "pbkdf2-sha256";
const PASSWORD_ITERATIONS: u32 = 210_000;
const PASSWORD_KEY_LENGTH: usize = 32;

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("Invalid hex value".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "Invalid hex value".to_string())
        })
        .collect()
}

fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32, length: usize) -> Vec<u8> {
    let mut result = Vec::with_capacity(length);
    let mut block: u32 = 1;
    while result.len() < length {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(password)
            .expect("HMAC accepts keys of any length");
        mac.update(salt);
        mac.update(&block.to_be_bytes());
        let mut u = [0u8; PASSWORD_KEY_LENGTH];
        u.copy_from_slice(&mac.finalize().into_bytes());
        let mut block_hash = u;
        for _ in 1..iterations {
            let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(password)
                .expect("HMAC accepts keys of any length");
            mac.update(&u);
            u.copy_from_slice(&mac.finalize().into_bytes());
            for index in 0..PASSWORD_KEY_LENGTH {
                block_hash[index] ^= u[index];
            }
        }
        result.extend_from_slice(&block_hash);
        block += 1;
    }
    result.truncate(length);
    result
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

fn password_hash(password: &str, salt: &str) -> Result<String, String> {
    let salt_bytes = from_hex(salt)?;
    if salt_bytes.len() < 8 {
        return Err("Salt is too short".into());
    }
    let hash = pbkdf2_sha256(
        password.as_bytes(),
        &salt_bytes,
        PASSWORD_ITERATIONS,
        PASSWORD_KEY_LENGTH,
    );
    Ok(format!(
        "{PASSWORD_HASH_PREFIX}${PASSWORD_ITERATIONS}${}${}",
        to_hex(&salt_bytes),
        to_hex(&hash)
    ))
}

fn password_matches(password: &str, stored: &str) -> Result<bool, String> {
    let mut parts = stored.split('$');
    if parts.next() != Some(PASSWORD_HASH_PREFIX) {
        return Ok(false);
    }
    let iterations: u32 = match parts.next().and_then(|value| value.parse().ok()) {
        Some(value) => value,
        None => return Ok(false),
    };
    if !(10_000..=1_000_000).contains(&iterations) {
        return Ok(false);
    }
    let salt = match parts.next().map(from_hex) {
        Some(Ok(value)) if !value.is_empty() => value,
        _ => return Ok(false),
    };
    let expected = match parts.next().map(from_hex) {
        Some(Ok(value)) if !value.is_empty() => value,
        _ => return Ok(false),
    };
    if parts.next().is_some() {
        return Ok(false);
    }
    let actual = pbkdf2_sha256(password.as_bytes(), &salt, iterations, expected.len());
    Ok(constant_time_eq(&actual, &expected))
}

#[tauri::command]
fn auth_hash_password(password: String, salt: String) -> Result<String, String> {
    password_hash(&password, &salt)
}

#[tauri::command]
fn auth_verify_password(password: String, hash: String) -> Result<bool, String> {
    password_matches(&password, &hash)
}

#[tauri::command]
fn backup_database(app: tauri::AppHandle) -> Result<String, String> {
    let source = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("dbrepairs.db");

    if !source.exists() {
        return Err("Database file not found".into());
    }

    let downloads = app.path().download_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();

    let destination = downloads.join(format!("DBRepairs-backup-{stamp}.db"));
    fs::copy(&source, &destination).map_err(|e| e.to_string())?;

    Ok(destination.to_string_lossy().into_owned())
}


#[tauri::command]
fn restore_database(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    if !is_sqlite_database(&data){return Err("Selected file is not a valid SQLite database".into());}
    let dir=app.path().app_config_dir().map_err(|e|e.to_string())?; fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let db=dir.join("dbrepairs.db"); if !db.exists(){return Err("Current database file not found".into());}
    let downloads=app.path().download_dir().map_err(|e|e.to_string())?; fs::create_dir_all(&downloads).map_err(|e|e.to_string())?;
    let stamp=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_secs();
    fs::copy(&db,downloads.join(format!("DBRepairs-before-restore-{stamp}.db"))).map_err(|e|e.to_string())?;
    fs::write(dir.join("dbrepairs.restore.pending"),&data).map_err(|e|e.to_string())?;
    if cfg!(debug_assertions) {
        app.exit(0);
        Ok(())
    } else {
        app.restart()
    }
}

#[tauri::command]
fn export_binary_file(
    app: tauri::AppHandle,
    filename: String,
    data: Vec<u8>,
) -> Result<String, String> {
    if filename.trim().is_empty()
        || filename.contains('/')
        || filename.contains('\\')
    {
        return Err("Invalid filename".into());
    }

    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| e.to_string())?;

    fs::create_dir_all(&downloads)
        .map_err(|e| e.to_string())?;

    let destination = downloads.join(filename);

    fs::write(&destination, data)
        .map_err(|e| e.to_string())?;

    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn export_text_file(app: tauri::AppHandle, filename: String, content: String) -> Result<String, String> {
    if filename.trim().is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid filename".into());
    }

    let downloads = app.path().download_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;

    let destination = downloads.join(filename);
    fs::write(&destination, content.as_bytes()).map_err(|e| e.to_string())?;

    Ok(destination.to_string_lossy().into_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableArchive { format: String, version: u32, data: PortableData }
#[derive(Deserialize)]
struct PortableData {
    settings: Vec<PortableSetting>,
    statuses: Vec<PortableStatus>,
    customers: Vec<PortableCustomer>,
    #[serde(default)]
    equipment: Vec<PortableEquipment>,
    repairs: Vec<PortableRepair>,
    history: Vec<PortableHistory>,
    #[serde(default, rename = "customerAttachments")]
    customer_attachments: Vec<PortableCustomerAttachment>,
    #[serde(default, rename = "repairAttachments")]
    repair_attachments: Vec<PortableRepairAttachment>,
}
#[derive(Deserialize)]
struct PortableSetting { key: String, value: String }
#[derive(Deserialize)]
struct PortableStatus { id: i64, code: String, label_key: String, sort_order: i64, active: bool }
#[derive(Deserialize)]
struct PortableCustomer { id: i64, name: String, company: Option<String>, tax_number: Option<String>, phone: Option<String>, email: Option<String>, address: Option<String>, notes: Option<String>, created_at: String, updated_at: String }
#[derive(Deserialize)]
struct PortableEquipment {
    id: i64, customer_id: i64, device_type: Option<String>, brand: Option<String>, model: Option<String>,
    serial_number: Option<String>, imei: Option<String>, notes: Option<String>, created_at: String, updated_at: String,
}
#[derive(Deserialize)]
struct PortableRepair {
    id: i64, repair_number: String, customer_id: i64, status_id: i64,
    #[serde(default)]
    equipment_id: Option<i64>,
    device_type: Option<String>, brand: Option<String>, model: Option<String>,
    serial_number: Option<String>, imei: Option<String>, reported_fault: Option<String>, accessories: Option<String>, general_condition: Option<String>,
    diagnosis: Option<String>, work_performed: Option<String>, estimated_value: Option<f64>, final_value: Option<f64>, internal_notes: Option<String>,
    opened_at: String, closed_at: Option<String>, created_at: String, updated_at: String,
}
#[derive(Deserialize)]
struct PortableHistory { id: i64, repair_id: i64, status_id: i64, changed_at: String, note: Option<String> }

#[derive(Deserialize)]
struct PortableCustomerAttachment {
    id: i64,
    customer_id: i64,
    filename: String,
    content_type: String,
    size: i64,
    data_base64: String,
    created_at: String,
}

#[derive(Deserialize)]
struct PortableRepairAttachment {
    id: i64,
    repair_id: i64,
    filename: String,
    content_type: String,
    size: i64,
    data_base64: String,
    created_at: String,
}

#[tauri::command]
fn restore_portable_database(app: tauri::AppHandle, archive: PortableArchive) -> Result<(), String> {
    if archive.format != "dbrepairs-portable"
        || (archive.version != 1 && archive.version != 2 && archive.version != 3)
        || archive.data.statuses.is_empty()
    {
        return Err("Unsupported or incomplete DBRepairs portable backup".into());
    }
    let path = app.path().app_config_dir().map_err(|e|e.to_string())?.join("dbrepairs.db");
    if !path.exists() { return Err("Database file not found".into()); }
    let mut connection = Connection::open(path).map_err(|e|e.to_string())?;
    restore_portable_connection(&mut connection, archive)
}

fn restore_portable_connection(connection: &mut Connection, archive: PortableArchive) -> Result<(), String> {
    connection.pragma_update(None, "foreign_keys", true).map_err(|e|e.to_string())?;
    let transaction = connection.transaction().map_err(|e|e.to_string())?;
    transaction.execute_batch(
        "DELETE FROM repair_attachments;
         DELETE FROM customer_attachments;
         DELETE FROM repair_status_history;
         DELETE FROM repairs;
         DELETE FROM equipment;
         DELETE FROM customers;
         DELETE FROM repair_statuses;
         DELETE FROM app_settings;"
    ).map_err(|e|e.to_string())?;
    for row in archive.data.settings {
        transaction.execute("INSERT INTO app_settings (key,value) VALUES (?1,?2)", params![row.key,row.value]).map_err(|e|e.to_string())?;
    }
    for row in archive.data.statuses {
        transaction.execute("INSERT INTO repair_statuses (id,code,label_key,sort_order,active) VALUES (?1,?2,?3,?4,?5)", params![row.id,row.code,row.label_key,row.sort_order,row.active]).map_err(|e|e.to_string())?;
    }
    for row in archive.data.customers {
        transaction.execute("INSERT INTO customers (id,name,company,tax_number,phone,email,address,notes,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![row.id,row.name,row.company,row.tax_number,row.phone,row.email,row.address,row.notes,row.created_at,row.updated_at]).map_err(|e|e.to_string())?;
    }
    for row in archive.data.equipment {
        transaction.execute("INSERT INTO equipment (id,customer_id,device_type,brand,model,serial_number,imei,notes,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![row.id,row.customer_id,row.device_type,row.brand,row.model,row.serial_number,row.imei,row.notes,row.created_at,row.updated_at]).map_err(|e|e.to_string())?;
    }
    for row in archive.data.repairs {
        transaction.execute("INSERT INTO repairs (id,repair_number,customer_id,status_id,equipment_id,device_type,brand,model,serial_number,imei,reported_fault,accessories,general_condition,diagnosis,work_performed,estimated_value,final_value,internal_notes,opened_at,closed_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)", params![row.id,row.repair_number,row.customer_id,row.status_id,row.equipment_id,row.device_type,row.brand,row.model,row.serial_number,row.imei,row.reported_fault,row.accessories,row.general_condition,row.diagnosis,row.work_performed,row.estimated_value,row.final_value,row.internal_notes,row.opened_at,row.closed_at,row.created_at,row.updated_at]).map_err(|e|e.to_string())?;
    }
    for row in archive.data.history {
        transaction.execute("INSERT INTO repair_status_history (id,repair_id,status_id,changed_at,note) VALUES (?1,?2,?3,?4,?5)", params![row.id,row.repair_id,row.status_id,row.changed_at,row.note]).map_err(|e|e.to_string())?;
    }

    for row in archive.data.customer_attachments {
        transaction.execute(
            "INSERT INTO customer_attachments
             (id,customer_id,filename,content_type,size,data_base64,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                row.id,
                row.customer_id,
                row.filename,
                row.content_type,
                row.size,
                row.data_base64,
                row.created_at
            ]
        ).map_err(|e|e.to_string())?;
    }

    for row in archive.data.repair_attachments {
        transaction.execute(
            "INSERT INTO repair_attachments
             (id,repair_id,filename,content_type,size,data_base64,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                row.id,
                row.repair_id,
                row.filename,
                row.content_type,
                row.size,
                row.data_base64,
                row.created_at
            ]
        ).map_err(|e|e.to_string())?;
    }
    transaction.execute("DELETE FROM sqlite_sequence WHERE name IN ('repair_statuses','customers','equipment','repairs','repair_status_history')", []).map_err(|e|e.to_string())?;
    for table in [
        "repair_statuses",
        "customers",
        "equipment",
        "repairs",
        "repair_status_history",
        "customer_attachments",
        "repair_attachments",
    ] {
        transaction.execute(&format!("INSERT INTO sqlite_sequence (name,seq) SELECT '{table}',COALESCE(MAX(id),0) FROM {table}"), []).map_err(|e|e.to_string())?;
    }
    transaction.commit().map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_restore_is_transactional_and_resets_sequences() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(include_str!("../migrations/0001_initial.sql")).unwrap();
        connection.execute_batch(include_str!("../migrations/0002_customer_attachments.sql")).unwrap();
        connection.execute_batch(include_str!("../migrations/0003_repair_attachments.sql")).unwrap();
        connection.execute_batch(include_str!("../migrations/0004_equipment.sql")).unwrap();
        connection.execute_batch(include_str!("../migrations/0005_auth.sql")).unwrap();
        connection.execute("INSERT INTO customers (name) VALUES ('Old data')", []).unwrap();
        connection.execute("INSERT INTO users (username,display_name,password_hash,role) VALUES ('admin','Admin','hash','admin')", []).unwrap();
        connection.execute("INSERT INTO sessions (token,user_id,expires_at) VALUES ('token',1,'2099-01-01 00:00:00')", []).unwrap();
        let archive = PortableArchive { format:"dbrepairs-portable".into(), version:1, data:PortableData {
            settings:vec![PortableSetting{key:"office.companyName".into(),value:"RepairsLab".into()}],
            statuses:vec![PortableStatus{id:4,code:"RECEIVED".into(),label_key:"status.received".into(),sort_order:10,active:true}],
            customers:vec![PortableCustomer{id:7,name:"Portable customer".into(),company:None,tax_number:None,phone:None,email:None,address:None,notes:None,created_at:"2026-08-21 12:00:00".into(),updated_at:"2026-08-21 12:00:00".into()}],
            equipment:vec![],
            repairs:vec![PortableRepair{id:9,repair_number:"2026-000009".into(),customer_id:7,status_id:4,equipment_id:None,device_type:Some("Laptop".into()),brand:None,model:None,serial_number:None,imei:None,reported_fault:Some("Test".into()),accessories:None,general_condition:None,diagnosis:None,work_performed:None,estimated_value:None,final_value:None,internal_notes:None,opened_at:"2026-08-21 12:00:00".into(),closed_at:None,created_at:"2026-08-21 12:00:00".into(),updated_at:"2026-08-21 12:00:00".into()}],
            history:vec![PortableHistory{id:11,repair_id:9,status_id:4,changed_at:"2026-08-21 12:00:00".into(),note:None}],
            customer_attachments:vec![],
            repair_attachments:vec![],
        }};
        restore_portable_connection(&mut connection, archive).unwrap();
        assert_eq!(connection.query_row("SELECT name FROM customers", [], |row| row.get::<_,String>(0)).unwrap(), "Portable customer");
        connection.execute("INSERT INTO customers (name) VALUES ('Next')", []).unwrap();
        assert_eq!(connection.query_row("SELECT MAX(id) FROM customers", [], |row| row.get::<_,i64>(0)).unwrap(), 8);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM users", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
    }

    #[test]
    fn password_hashing_matches_known_vector_and_verifies() {
        assert_eq!(
            to_hex(&pbkdf2_sha256(b"password", b"salt", 1, 32)),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        let hash = password_hash("workshop-pass", "00112233445566778899aabbccddeeff").unwrap();
        assert!(password_matches("workshop-pass", &hash).unwrap());
        assert!(!password_matches("wrong-pass", &hash).unwrap());
        assert!(!password_matches("workshop-pass", "not-a-hash").unwrap());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial_schema",
            sql: include_str!("../migrations/0001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "customer_attachments",
            sql: include_str!("../migrations/0002_customer_attachments.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "repair_attachments",
            sql: include_str!("../migrations/0003_repair_attachments.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "equipment",
            sql: include_str!("../migrations/0004_equipment.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "auth",
            sql: include_str!("../migrations/0005_auth.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:dbrepairs.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            backup_database,
            restore_database,
            export_text_file,
            export_binary_file,
            restore_portable_database,
            auth_hash_password,
            auth_verify_password
        ])
        .setup(|app| {
            apply_pending_restore(app.handle()).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run DBRepairs");
}
