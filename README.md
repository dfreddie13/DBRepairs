# DBRepairs

DBRepairs is a simple, open-source repair-shop manager focused on the practical day-to-day workflow of repair workshops and service centres.

The project is a clean rewrite with a shared React/TypeScript interface. It can run as a Tauri 2 desktop application with local SQLite, or as a Docker server with a central PostgreSQL database.

## Features

### Customers

- Create, edit, search and delete customers.
- Name, company, tax number, phone, email, address and notes.
- View the complete repair history directly from the customer record.
- Create a new customer directly while opening a repair.

### Equipment

- Create, edit, search and delete equipment records linked to customers.
- Device type, brand, model, serial number (SN), IMEI and notes.
- View the complete repair history and last repair date for each equipment.
- Filter by customer and search by brand, model, SN, IMEI or customer.
- Link a repair to an existing equipment, or register the device automatically when opening a repair.

### Repairs

- Create and edit repair jobs.
- Repair number generated automatically.
- Device type, brand, model, serial number and IMEI.
- Reported fault, accessories and general condition.
- Diagnosis and work performed.
- Estimated and final values.
- Internal notes.
- Search and filter repairs by status and open/closed state.
- Suggestions for previously used device types, brands and models.

### Status workflow

Initial repair statuses:

- Received
- Diagnosis
- Waiting for customer
- Waiting for parts
- In repair
- Repaired
- Ready
- Delivered
- Cancelled

Every status change is stored with date and time. An optional note can be added to each status change.

### Printing

- A4 portrait repair intake sheet.
- Two copies on the same page:
  - workshop copy;
  - customer copy.
- Dashed cut line between copies.
- Company identity and custom logo.
- Save a repair and immediately open the print preview.

### Users and authentication

- Login is required in both the desktop and server editions.
- The first launch creates the administrator account.
- Two roles: **administrator** and **technician**.
- Administrators create, edit, deactivate and delete users, and reset passwords from Settings.
- Every user can change their own password and sign out.
- Repairs keep the account that created them.
- Sessions last 30 days and are stored securely hashed on the server.

### Appearance

- Selectable light, dark or system theme.
- Available from the login screen, the sidebar and Settings.
- The preference is stored per browser or desktop profile.

### Dashboard

Live overview with:

- open repairs;
- waiting for customer;
- ready for collection;
- closed today;
- latest repairs.

### Settings and data

- Global application language.
- Portuguese (Portugal), English, Spanish, French and Romanian.
- Light, dark or system theme.
- User accounts, roles, passwords and activation.
- Company name, tax number, address, phone, email and logo.
- Manual SQLite database backup.
- CSV export for customers.
- CSV export for repairs.

### Server edition

- One central PostgreSQL database for simultaneous use from multiple computers.
- Browser interface reusing the desktop workflow and translations.
- Multi-user login with administrator and technician roles.
- Transactional HTTP API and automatic schema migrations.
- Docker Compose stack for a server or Portainer.
- Manual and scheduled PostgreSQL backups with configurable retention.
- Portable `.dbrepairs` backups for two-way transfer between SQLite and PostgreSQL.

## Technology

- React
- TypeScript
- Vite
- Tauri 2
- Rust
- SQLite
- Node.js API and PostgreSQL (server edition)
- Docker Compose and nginx (server edition)

## Linux installation

### Debian / Ubuntu and derivatives

Download the `.deb` package and install it with:

```bash
sudo apt install ./DBRepairs_0.2.0_amd64.deb
```

### Fedora / RHEL compatible distributions

Download the `.rpm` package and install it with your distribution package manager, for example:

```bash
sudo dnf install ./DBRepairs-0.2.0-1.x86_64.rpm
```

## Development

Prerequisites: Node.js, Rust and the platform dependencies required by Tauri 2.

```bash
npm install
npm run tauri dev
```

Build:

```bash
npm run tauri build
```

Native packages should normally be built on the target operating system or through CI.

### Server / Docker

Copy `.env.example` to `.env`, set a strong `POSTGRES_PASSWORD`, then run:

```bash
docker compose up -d --build
```

Open `http://SERVER-IP:8080`. On the first visit, create the administrator account, then add the workshop staff from **Settings → Users**. See `docker/README.md` for authentication, Portainer, backup, restore and update instructions.

## Data location

The desktop edition uses a local SQLite database. Application data is stored in the platform-specific application configuration directory.

Use the built-in backup function before moving or reinstalling systems.

The server edition stores shared data in its PostgreSQL Docker volume. Desktop and server data remain independent until a portable `.dbrepairs` backup is explicitly restored. This format transfers settings, statuses, customers, equipment, repairs, status history and attachments in either direction between SQLite and PostgreSQL. Older portable backups remain compatible.

Native database backups include user accounts, password hashes and active sessions. Portable `.dbrepairs` backups intentionally exclude accounts and credentials, so restores never overwrite the users of the destination installation. Keep native backups private.

## Translation

See `TRANSLATING.md`.

The application uses one global language for the interface, forms, statuses and printed documents.

## Project principles

- Keep the workflow simple.
- Fast repair intake and lookup.
- Avoid unnecessary ERP complexity.
- SQLite by default.
- Desktop SQLite remains simple and independent.
- Docker/server edition reuses the same frontend and domain workflow.
- Easy community translations.

## License

DBRepairs is licensed under GPL-3.0. See `LICENSE`.
