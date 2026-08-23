# Indigo Cars — Lead Portal

Internal lead-management portal for Indigo Cars. A static frontend plus a set of
Vercel serverless functions backed by your **Microsoft SQL Server** database.
Managers see every lead and the operator workload; operators see only the leads
assigned to them. New leads are auto-assigned to operators round-robin.

Nothing runs on your own computer — the app lives on Vercel and talks to your
MSSQL server over the network.

```
indigo-cars-portal/
├── public/index.html      # the whole frontend (login + app), no build step
├── api/                   # Vercel serverless functions (the backend)
│   ├── _db.js             # cached MSSQL connection pool
│   ├── _auth.js           # JWT + request helpers
│   ├── setup.js           # one-time: creates tables + seeds users
│   ├── login.js           # POST /api/login
│   ├── me.js              # GET  /api/me
│   ├── operators.js       # GET  /api/operators
│   ├── dashboard.js       # GET  /api/dashboard
│   └── leads/
│       ├── index.js       # GET/POST /api/leads
│       └── [id].js        # GET/PATCH /api/leads/:id
├── db/schema.sql          # reference schema (setup.js applies this for you)
├── package.json
├── vercel.json
└── .env.example           # documents the environment variables
```

---

## 1. Prepare the database

You need a reachable Microsoft SQL Server (Azure SQL Database works well) and a
SQL login the app can use. Two things matter:

1. **Create an empty database**, e.g. `indigo_cars`. The tables are created for
   you in step 3 — you do not need to run any SQL by hand.
2. **Allow Vercel to connect.** Vercel's serverless functions call out from
   changing IP addresses, so:
   - **Azure SQL:** in the server's *Networking* settings, enable
     *"Allow Azure services and resources to access this server"*, or add
     Vercel's egress ranges. For a first test you may temporarily allow all IPs,
     then lock it down.
   - **On-prem / other host:** the SQL port (default **1433**) must be reachable
     from the public internet, or use a tunnel/private networking.

> Security note: create a dedicated SQL login for this app with rights limited to
> the `indigo_cars` database — not `sa`.

---

## 2. Deploy to Vercel

You can deploy from the Vercel dashboard (no terminal needed):

1. Put this folder in a Git repository (GitHub/GitLab/Bitbucket) and push it.
2. In Vercel, **Add New → Project**, import that repository.
3. Framework preset: **Other**. No build command; output is served as-is.
4. Before the first deploy, add the **Environment Variables** below
   (*Settings → Environment Variables*), then deploy.

### Environment variables

Set these in Vercel (see `.env.example` for the annotated list):

| Name | Example | Notes |
|------|---------|-------|
| `DB_SERVER` | `myserver.database.windows.net` | SQL host |
| `DB_NAME` | `indigo_cars` | database name |
| `DB_USER` | `indigo_app` | SQL login |
| `DB_PASSWORD` | *(secret)* | SQL password — you enter it in Vercel, never in code |
| `DB_PORT` | `1433` | default SQL port |
| `DB_ENCRYPT` | `true` | `true` for Azure SQL / most managed servers |
| `DB_TRUST_SERVER_CERTIFICATE` | `false` | `true` only for self-signed certs |
| `JWT_SECRET` | *(long random string)* | signs login tokens |
| `SETUP_TOKEN` | *(random string)* | needed once, for `/api/setup`; can be removed after |

You never share the DB password or these secrets with anyone — you type them
straight into Vercel's dashboard.

---

## 3. One-time setup (creates tables + first users)

After the first successful deploy, call the setup endpoint **once**. It creates
all tables and seeds the manager + five operators, hashing their passwords on the
server. Replace `YOUR_SETUP_TOKEN` and the URL:

```bash
curl -X POST https://your-app.vercel.app/api/setup \
  -H "x-setup-token: YOUR_SETUP_TOKEN"
```

The response lists each created user with a **one-time temporary password** —
save it and share each person's with them privately. Example:

```json
{
  "ok": true,
  "created": [
    { "name": "Nino Beridze", "email": "nino@indigocars.ge", "role": "manager", "tempPassword": "Kf7pQ2mXa9Rt" },
    ...
  ]
}
```

Want your own team instead of the defaults? Send them in the body:

```bash
curl -X POST https://your-app.vercel.app/api/setup \
  -H "x-setup-token: YOUR_SETUP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"users":[
    {"name":"Nino Beridze","email":"nino@indigocars.ge","role":"manager","branch":"Tbilisi · Avlabari","password":"choose-a-strong-one"},
    {"name":"Giorgi Kapanadze","email":"giorgi@indigocars.ge","role":"operator","branch":"Tbilisi · Avlabari"}
  ]}'
```

`setup` is safe to run again — it skips users that already exist. When you're
done, you can delete the `SETUP_TOKEN` variable so the endpoint can't be called.

---

## 4. Use it

Open `https://your-app.vercel.app`, sign in with an email + temp password.
Managers land on the full dashboard; operators see their own leads. The KA/EN
switch, search, filters, status changes, reassignment (managers), and the
activity log all read and write to your database.

---

## Roles & rules

- **Manager** — sees all leads, operator workload, can reassign leads, and
  manages the team (see below).
- **Operator** — sees and works only the leads assigned to them.
- Every status change and reassignment is written to the lead's activity history
  with who did it.
- New leads: an operator's new lead is assigned to themselves; a manager's new
  lead is auto-assigned round-robin across active operators.

## Passwords

- Everyone can change their own password from the **Change password** link in the
  sidebar (bottom-left, next to Log out).
- Users created by `setup` or by a manager get a **one-time temporary password**
  and are prompted to set their own the first time they sign in — they can't
  proceed until they do.

## Managing your team (managers only)

Open **Team** in the sidebar to:

- **Add a user** — enter name, email, role, and branch. The portal shows a
  one-time temporary password to share privately; the new user sets their own on
  first login.
- **Change a role or branch** — inline dropdowns per row, saved immediately.
- **Activate / deactivate** — a deactivated user keeps their assigned leads but
  can't sign in.
- **Reset a password** — issues a new one-time temporary password.

Safety rails: you can't deactivate or demote your own account, and the system
always keeps at least one active manager.

## API reference

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/login` | anyone | sign in, returns a token |
| `GET /api/me` | signed in | current user |
| `POST /api/password` | signed in | change own password |
| `GET /api/dashboard` | signed in | stats, pipeline, recent (scoped by role) |
| `GET/POST /api/leads` | signed in | list / create leads |
| `GET/PATCH /api/leads/:id` | signed in | view / update a lead |
| `GET /api/operators` | signed in | operators for assignment |
| `GET/POST /api/users` | manager | list / create users |
| `PATCH /api/users/:id` | manager | update role/branch/active, reset password |
| `POST /api/setup` | setup token | one-time bootstrap |

## Notes

- **Connection limits** — the pool is capped small (`max: 4`) to stay friendly
  with serverless. For very high traffic, consider Azure SQL's built-in pooling.
- **Role changes take effect on next sign-in** — a user's permissions live in
  their login token (valid 12h), so a role change applies when their token next
  refreshes.
- **Locking down networking** — after testing, restrict the SQL firewall to
  Vercel's egress ranges rather than all IPs.
